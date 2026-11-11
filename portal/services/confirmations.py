"""Participant receipt emails. Never attach receipts or banking details."""

from django.conf import settings
from django.utils import timezone

from portal import app_settings
from portal.constants import APP_NAME, PAYMENT_TIMING
from portal.i18n import t
from portal.models import Claim, Confirmation
from portal.services import queue
from portal.services.delivery import configured_transport
from portal.services.transport import FAILED, PENDING, SENDING, Message, SendResult


def schedule(claim):
    Confirmation.objects.get_or_create(claim=claim)
    queue.enqueue("confirm", claim)


def start(claim_id):
    """Inside a transaction, reserve a pending email before contacting the provider."""
    claim = Claim.objects.select_for_update().get(pk=claim_id)
    if claim.state == Claim.State.PURGING:
        return None
    confirmation = Confirmation.objects.select_for_update().get(claim=claim)
    if confirmation.state != PENDING:
        return None
    confirmation.state = SENDING
    confirmation.save(update_fields=["state", "updated_at"])
    return confirmation


def send(confirmation):
    claim = confirmation.claim
    if (
        settings.TEST_RECIPIENT_ALLOWLIST
        and claim.email.lower() not in settings.TEST_RECIPIENT_ALLOWLIST
    ):
        return SendResult(FAILED, error_code="test_recipient_blocked")
    with app_settings.for_claim(claim):
        subject = t(
            "Confirmation of receipt: reimbursement claim {reference}", reference=claim.reference
        )
        text = t(
            "Hello {name},\n\n"
            "your reimbursement claim for {form} has been received.\n\n"
            "Your reference: {reference}\n"
            "Please quote this reference with any questions.\n\n"
            "This confirmation of receipt is not yet an approval of the reimbursement.\n"
            "{payment_timing}\n\n"
            "If you have questions, you can reach us at {support}.\n\n"
            "Best regards\nYour {app_name} team\n",
            name=claim.full_name,
            form=claim.snapshot["name"],
            reference=claim.reference,
            payment_timing=t(PAYMENT_TIMING),
            support=claim.snapshot["support_email"],
            app_name=APP_NAME,
        )
    message = Message(
        attempt_id=str(confirmation.pk),
        sender=settings.MAIL_FROM_ADDRESS,
        reply_to=claim.snapshot["support_email"],
        recipient=claim.email,
        subject=subject,
        text=text,
    )
    return configured_transport().send(message)


def mark(claim_id, state, error_code="", message_id=""):
    Confirmation.objects.filter(claim_id=claim_id).update(
        state=state, error_code=error_code, message_id=message_id, updated_at=timezone.now()
    )
