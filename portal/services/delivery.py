"""Delivery of a claim's authoritative PDF to its approved Finance inbox.

A Delivery's state is derived from its attempts. Attempts change only through send
results recorded here and provider evidence, which the Evidence module applies through
`settle`. A send whose outcome is unknown is never repeated automatically: an operator
retry has to acknowledge the duplicate risk. Failures before transmission are definite,
because nothing reached the provider.
"""

import hashlib

from django.conf import settings
from django.utils import timezone

from portal import app_settings
from portal.i18n import t
from portal.models import Claim, Delivery, DeliveryAttempt
from portal.services import outbound, queue, retention
from portal.services.outbound import Undeliverable
from portal.services.storage import path_for
from portal.services.transport import (
    ACCEPTED,
    DELIVERED,
    FAILED,
    FINAL,
    PAUSED,
    PENDING,
    SENDING,
    UNKNOWN,
    Message,
)

# The provider holds or delivered the message: never send again automatically.
NO_AUTOMATIC_SEND = frozenset({DELIVERED, ACCEPTED, PAUSED, UNKNOWN})


class DuplicateRisk(Exception):
    """The previous send may have reached the provider."""


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


def record_result(attempt_id, result):
    """In a transaction: store a send result unless provider evidence already settled it."""
    attempt = DeliveryAttempt.objects.get(pk=attempt_id)
    delivery = _lock_delivery(pk=attempt.delivery_id)
    attempt = DeliveryAttempt.objects.select_for_update().get(pk=attempt_id)
    if attempt.state not in FINAL:
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


def settle(attempt_id, apply):
    """In a transaction: let provider evidence change an attempt, then refresh its delivery.

    `apply(attempt, recipient)` runs on the locked attempt unless its claim is being deleted,
    and returns whether it changed the attempt.
    """
    delivery_id = DeliveryAttempt.objects.values_list("delivery_id", flat=True).get(pk=attempt_id)
    delivery = _lock_delivery(pk=delivery_id)
    attempt = DeliveryAttempt.objects.select_for_update().get(pk=attempt_id)
    if delivery.claim.state != Claim.State.PURGING and apply(attempt, delivery.recipient):
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
