"""Delivery of a claim's authoritative PDF to its approved Finance inbox.

A Delivery's state is derived from its attempts. Attempts change only through send
results, provider webhooks and reconciliation lookups recorded here. A send whose
outcome is unknown is never repeated automatically: an operator retry has to
acknowledge the duplicate risk. Failures before transmission are definite, because
nothing reached the provider.
"""

import hashlib
import logging
import uuid
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.db.models import F
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from portal import app_settings
from portal.i18n import t
from portal.models import Claim, Delivery, DeliveryAttempt, DeliveryEvent
from portal.services import mailersend, queue
from portal.services.storage import path_for
from portal.services.transport import (
    ACCEPTED,
    DELIVERED,
    FAILED,
    PAUSED,
    PENDING,
    SENDING,
    UNKNOWN,
    LocalOutbox,
    Message,
    SendResult,
)

logger = logging.getLogger(__name__)

# The provider holds or delivered the message: never send again automatically.
NO_AUTOMATIC_SEND = frozenset({DELIVERED, ACCEPTED, PAUSED, UNKNOWN})
# Attempt outcomes that later provider evidence cannot regress.
FINAL_ATTEMPT = frozenset({DELIVERED, FAILED})
# Attempts the provider can tell us more about.
RECONCILABLE = frozenset({ACCEPTED, PAUSED, UNKNOWN})

EVIDENCE_STATES = {
    "activity.sent": ACCEPTED,
    "activity.delivered": DELIVERED,
    "activity.deferred": ACCEPTED,
    "activity.soft_bounced": ACCEPTED,
    "activity.hard_bounced": FAILED,
    "activity.suppressed": FAILED,
    "reconciliation.queued": ACCEPTED,
    "reconciliation.sent": ACCEPTED,
    "reconciliation.delivered": DELIVERED,
    "reconciliation.soft_bounced": ACCEPTED,
    "reconciliation.hard_bounced": FAILED,
    "reconciliation.suppressed": FAILED,
    "reconciliation.rejected": FAILED,
}
# Evidence that the provider has the message, without saying more than that.
RESOLVES_UNKNOWN_ONLY = frozenset({"reconciliation.queued"})


class DuplicateRisk(Exception):
    """The previous send may have reached the provider."""


class Undeliverable(Exception):
    """The message cannot be sent; nothing was transmitted."""


def _recipient_hash(address):
    return hashlib.sha256(address.lower().encode()).hexdigest()


def recipient_approved(address):
    return address.lower() in settings.APPROVED_DELIVERY_RECIPIENTS


def configured_transport():
    if settings.MAIL_DELIVERY_MODE == "local" and settings.DEBUG:
        return LocalOutbox()
    return mailersend.MailerSendTransport()


def schedule(claim):
    """Queue delivery of a claim whose PDF is ready. Idempotent."""
    delivery, _ = Delivery.objects.get_or_create(
        claim=claim, defaults={"recipient": claim.snapshot["recipient"]}
    )
    queue.enqueue("send", delivery)
    return delivery


def _lock_delivery(**lookup):
    """In a transaction, lock Claim before Delivery, then any delivery attempts."""
    claim_id = Delivery.objects.values_list("claim_id", flat=True).get(**lookup)
    claim = Claim.objects.select_for_update().get(pk=claim_id)
    delivery = Delivery.objects.select_for_update().get(**lookup)
    delivery.claim = claim
    return delivery


def refresh(delivery):
    """Derive the delivery's state from its attempts, and the claim's retention from it."""
    attempts = list(delivery.attempts.order_by("created_at"))
    if not attempts:
        return
    successful = [attempt for attempt in attempts if attempt.state == DELIVERED]
    current = successful[-1] if successful else attempts[-1]
    delivery.state = current.state
    delivery.message_id = current.message_id or ""
    delivery.error_code = current.error_code
    claim = Claim.objects.select_for_update().get(pk=delivery.claim_id)
    if current.state == DELIVERED:
        delivery.delivered_at = delivery.delivered_at or timezone.now()
        claim.pdf_due = delivery.delivered_at + timedelta(days=settings.PDF_RETENTION_DAYS)
        claim.retention_due = max(
            claim.submitted_at + timedelta(days=settings.CONTENT_RETENTION_DAYS), claim.pdf_due
        )
    elif current.state in {FAILED, UNKNOWN}:
        claim.pdf_due = claim.retention_due = None
    claim.save(update_fields=["pdf_due", "retention_due"])
    delivery.save()


def start_attempt(delivery_id):
    """In a transaction: a new attempt, or None when no automatic send may happen."""
    delivery = _lock_delivery(pk=delivery_id)
    if delivery.state in NO_AUTOMATIC_SEND or delivery.claim.state != Claim.State.READY:
        return None
    attempt = DeliveryAttempt.objects.create(delivery=delivery, state=SENDING)
    refresh(delivery)
    return attempt


def compose(attempt):
    delivery, claim = attempt.delivery, attempt.delivery.claim
    if not recipient_approved(delivery.recipient):
        raise Undeliverable("unapproved_recipient")
    if (
        settings.TEST_RECIPIENT_ALLOWLIST
        and delivery.recipient.lower() not in settings.TEST_RECIPIENT_ALLOWLIST
    ):
        raise Undeliverable("test_recipient_blocked")
    try:
        content = path_for(claim.pdf_key).read_bytes()
    except (OSError, ValueError) as exc:
        raise Undeliverable("attachment_unavailable") from exc
    if (
        len(content) > settings.MAX_FINAL_PDF_BYTES
        or hashlib.sha256(content).hexdigest() != claim.pdf_hash
    ):
        raise Undeliverable("attachment_integrity")
    values = {"reference": claim.reference, "form": claim.snapshot["name"]}
    with app_settings.for_claim(claim):
        subject = t("Reimbursement claim {reference} | {form}", **values)
        text = t(
            "Reimbursement claim {reference}\nForm: {form}\n\n"
            "The complete reimbursement form and all receipts are in the attached PDF.\n",
            **values,
        )
    return Message(
        attempt_id=str(attempt.id),
        sender=settings.MAIL_FROM_ADDRESS,
        reply_to=settings.MAIL_REPLY_TO_ADDRESS,
        recipient=delivery.recipient,
        subject=subject,
        text=text,
        attachment=content,
        filename=f"reimbursement_{claim.reference.replace('/', '_')}.pdf",
    )


def send(attempt):
    """Compose and transmit one attempt. No database writes; call outside a transaction.

    Anything that fails while composing is a definite failure. An exception from the
    transport itself propagates: the provider may have accepted the message.
    """
    try:
        message = compose(attempt)
    except Undeliverable as exc:
        return SendResult(FAILED, error_code=str(exc))
    except Exception:
        logger.exception("delivery_compose_failed attempt=%s", attempt.pk)
        return SendResult(FAILED, error_code="message_unavailable")
    return configured_transport().send(message)


def record_result(attempt_id, result):
    """In a transaction: store a send result unless provider evidence already settled it."""
    attempt = DeliveryAttempt.objects.get(pk=attempt_id)
    delivery = _lock_delivery(pk=attempt.delivery_id)
    attempt = DeliveryAttempt.objects.select_for_update().get(pk=attempt_id)
    if attempt.state not in FINAL_ATTEMPT:
        attempt.state, attempt.error_code = result.state, result.error_code
    if result.message_id:
        attempt.message_id = result.message_id
    attempt.save()
    refresh(delivery)


def abandon(attempt_id, error_code):
    """In a transaction: a retryable attempt that will not be retried has failed."""
    attempt = DeliveryAttempt.objects.get(pk=attempt_id)
    delivery = _lock_delivery(pk=attempt.delivery_id)
    DeliveryAttempt.objects.filter(pk=attempt_id).update(state=FAILED, error_code=error_code)
    refresh(delivery)


def mark_interrupted(delivery_id, error_code):
    """In a transaction: a sender died mid-attempt, so the outcome is unknown."""
    delivery = _lock_delivery(pk=delivery_id)
    delivery.attempts.filter(state=SENDING).update(state=UNKNOWN, error_code=error_code)
    refresh(delivery)


def has_duplicate_risk(delivery):
    """Sending again could reach Finance twice: only a definite failure is safe to repeat."""
    return delivery.state != FAILED


def duplicate_risk(claim):
    """A retry of the claim's delivery has to acknowledge that Finance may get it twice."""
    delivery = getattr(claim, "delivery", None)
    return bool(delivery and has_duplicate_risk(delivery))


def may_have_reached_finance(claim):
    """Some send of the claim's PDF did not definitely fail, so Finance may hold a copy."""
    delivery = getattr(claim, "delivery", None)
    return bool(delivery and delivery.attempts.exclude(state=FAILED).exists())


def retry(claim, *, acknowledge_duplicate_risk=False):
    """Operator retry. Only a definite failure is retried without acknowledgment."""
    delivery = _lock_delivery(claim=claim)
    if has_duplicate_risk(delivery) and not acknowledge_duplicate_risk:
        raise DuplicateRisk
    delivery.state, delivery.error_code = PENDING, ""
    delivery.save()
    queue.enqueue("send", delivery, again=True)


@transaction.atomic
def ingest_event(data):
    """Record a verified MailerSend webhook as delivery evidence."""
    body = data.get("data", {})
    timestamp = parse_datetime(data.get("created_at", ""))
    provider_id = body.get("id")
    recipient = body.get("recipient")
    if data.get("type") not in EVIDENCE_STATES or data["type"].startswith("reconciliation."):
        return
    if (
        not isinstance(provider_id, str)
        or not 1 <= len(provider_id) <= 100
        or not isinstance(recipient, str)
        or len(recipient) > 254
        or not timestamp
        or timezone.is_naive(timestamp)
    ):
        raise ValueError("invalid_event")
    tags = body.get("tags", [])
    attempt_tag = (
        next(
            (
                tag[8:]
                for tag in tags
                if isinstance(tag, str) and tag.startswith("attempt-") and len(tag) == 44
            ),
            "",
        )
        if isinstance(tags, list)
        else ""
    )
    message_id = body.get("message_id", "")
    if not isinstance(message_id, str) or len(message_id) > 100:
        raise ValueError("invalid_event")
    _record_evidence(
        kind=data["type"],
        provider_id=provider_id,
        timestamp=timestamp,
        message_id=message_id,
        recipient=recipient,
        attempt_tag=attempt_tag,
    )


def _record_evidence(*, kind, provider_id, timestamp, message_id, recipient, attempt_tag=""):
    event, _ = DeliveryEvent.objects.get_or_create(
        provider_id=provider_id,
        defaults={
            "kind": kind,
            "provider_timestamp": timestamp,
            "message_id": message_id,
            "recipient_hash": _recipient_hash(recipient),
            "attempt_tag": attempt_tag,
        },
    )
    _apply(event)


def _apply(event):
    if event.applied:
        return
    query = (
        DeliveryAttempt.objects.filter(message_id=event.message_id)
        if event.message_id
        else DeliveryAttempt.objects.none()
    )
    attempt = query.first()
    if not attempt and event.attempt_tag:
        try:
            attempt = DeliveryAttempt.objects.filter(pk=uuid.UUID(event.attempt_tag)).first()
        except (ValueError, TypeError):
            return
    if not attempt:
        return
    delivery = _lock_delivery(pk=attempt.delivery_id)
    attempt = DeliveryAttempt.objects.select_for_update().get(pk=attempt.pk)
    if (
        _recipient_hash(delivery.recipient) != event.recipient_hash
        or delivery.claim.state == Claim.State.PURGING
    ):
        return
    if attempt.message_id and event.message_id and attempt.message_id != event.message_id:
        return
    if not attempt.message_id and event.message_id:
        attempt.message_id = event.message_id
    state = EVIDENCE_STATES[event.kind]
    if event.kind in RESOLVES_UNKNOWN_ONLY and attempt.state != UNKNOWN:
        state = None
    # Terminal success/failure cannot regress on a late sent/deferred callback.
    if state and (state in FINAL_ATTEMPT or attempt.state not in FINAL_ATTEMPT):
        if not (attempt.state == FAILED and state == DELIVERED):
            attempt.state = state
            attempt.error_code = (
                f"provider_{event.kind.rsplit('.', 1)[-1]}" if state == FAILED else ""
            )
    attempt.save()
    event.attempt, event.applied = attempt, True
    event.save(update_fields=["attempt", "applied"])
    refresh(delivery)


@transaction.atomic
def reconcile_unmatched():
    """Retry correlating evidence that arrived before its attempt was recorded."""
    events = DeliveryEvent.objects.filter(applied=False).order_by(
        F("last_checked_at").asc(nulls_first=True), "received_at", "pk"
    )[:100]
    for event in list(events):
        event.last_checked_at = timezone.now()
        event.save(update_fields=["last_checked_at"])
        _apply(event)


def reconcile(batch_size):
    """Ask the provider about unsettled attempts. Never resends.

    Returns counts of checked attempts, deferred answers and failed lookups.
    """
    reconcile_unmatched()
    attempts = (
        DeliveryAttempt.objects.exclude(message_id__isnull=True)
        .filter(state__in=RECONCILABLE)
        .order_by(F("last_checked_at").asc(nulls_first=True), "created_at", "pk")[:batch_size]
    )
    counts = {"checked": 0, "deferred": 0, "failed": 0}
    for attempt in list(attempts):
        DeliveryAttempt.objects.filter(pk=attempt.pk).update(last_checked_at=timezone.now())
        counts["checked"] += 1
        message = mailersend.retrieve_message(attempt.message_id)
        if message is None:
            counts["failed"] += 1
            continue
        snapshot = mailersend.message_snapshot(message)
        if not snapshot or not snapshot.get("recipient"):
            counts["deferred"] += 1
            continue
        with transaction.atomic():
            _record_evidence(
                kind=f"reconciliation.{snapshot['status']}",
                provider_id=f"reconcile-{attempt.id}-{snapshot['status']}",
                timestamp=timezone.now(),
                message_id=attempt.message_id,
                recipient=snapshot["recipient"],
            )
    return counts
