"""Delivery of a claim's authoritative PDF to its approved Finance inbox.

A Delivery's state is derived from its attempts. Attempts change only through send
results and provider evidence (webhooks and reconciliation lookups, which the
MailerSend adapter translates) recorded here. A send whose
outcome is unknown is never repeated automatically: an operator retry has to
acknowledge the duplicate risk. Failures before transmission are definite, because
nothing reached the provider.
"""

import hashlib
import logging
import uuid

from django.conf import settings
from django.db import transaction
from django.db.models import F
from django.utils import timezone

from portal import app_settings
from portal.i18n import t
from portal.models import Claim, Delivery, DeliveryAttempt, DeliveryEvent
from portal.services import mailersend, outbound, queue, retention
from portal.services.storage import path_for
from portal.services.transport import (
    ACCEPTED,
    DELIVERED,
    FAILED,
    PAUSED,
    PENDING,
    SENDING,
    UNKNOWN,
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


class DuplicateRisk(Exception):
    """The previous send may have reached the provider."""


class Undeliverable(Exception):
    """The message cannot be sent; nothing was transmitted."""


def _recipient_hash(address):
    return hashlib.sha256(address.lower().encode()).hexdigest()


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
    """Derive the delivery's state from its attempts, and report it to retention."""
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
    retention.follow_delivery(claim, current.state, delivery.delivered_at)
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
    if not outbound.recipient_approved(delivery.recipient):
        raise Undeliverable("unapproved_recipient")
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

    Anything that fails while composing is a definite failure. An exception from
    `outbound.send` propagates: the provider may have accepted the message.
    """
    try:
        message = compose(attempt)
    except Undeliverable as exc:
        return SendResult(FAILED, error_code=str(exc))
    except Exception:
        logger.exception("delivery_compose_failed attempt=%s", attempt.pk)
        return SendResult(FAILED, error_code="message_unavailable")
    return outbound.send(message)


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


def mark_unknown(delivery_id, error_code):
    """In a transaction: a send ended without a result, so its outcome is unknown."""
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
def record_evidence(evidence):
    """Record what the provider says about an attempt; it applies once the attempt is known."""
    event, _ = DeliveryEvent.objects.get_or_create(
        provider_id=evidence.provider_id,
        defaults={
            "kind": evidence.kind,
            "provider_timestamp": evidence.timestamp,
            "message_id": evidence.message_id,
            "recipient_hash": _recipient_hash(evidence.recipient),
            "attempt_tag": evidence.attempt_id,
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
    state, error_code, resolves_unknown_only = mailersend.outcome(event.kind)
    if resolves_unknown_only and attempt.state != UNKNOWN:
        state = None
    # Terminal success/failure cannot regress on a late sent/deferred callback.
    if state and (state in FINAL_ATTEMPT or attempt.state not in FINAL_ATTEMPT):
        if not (attempt.state == FAILED and state == DELIVERED):
            attempt.state, attempt.error_code = state, error_code
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
        try:
            evidence = mailersend.lookup(attempt.id, attempt.message_id)
        except mailersend.LookupFailed:
            counts["failed"] += 1
            continue
        if evidence is None:
            counts["deferred"] += 1
            continue
        record_evidence(evidence)
    return counts
