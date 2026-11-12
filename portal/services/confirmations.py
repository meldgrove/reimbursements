"""Participant receipt emails. Never attach receipts or banking details.

A confirmation changes through its send result and provider evidence, which the Evidence
module applies through `settle`. It is never sent twice.
"""

from django.conf import settings

from portal import app_settings
from portal.constants import APP_NAME, PAYMENT_TIMING
from portal.i18n import t
from portal.models import Claim, Confirmation
from portal.services import queue
from portal.services.transport import FINAL, PENDING, SENDING, Message


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


def compose(confirmation):
    claim = confirmation.claim
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
    return Message(
        attempt_id=str(confirmation.pk),
        sender=settings.MAIL_FROM_ADDRESS,
        reply_to=claim.snapshot["support_email"],
        recipient=claim.email,
        subject=subject,
        text=text,
    )


def record(claim_id, result):
    """In a transaction: store a send result unless provider evidence already settled it."""
    confirmation = Confirmation.objects.select_for_update().get(claim_id=claim_id)
    if confirmation.state not in FINAL:
        confirmation.state, confirmation.error_code = result.state, result.error_code
    if result.message_id:
        confirmation.message_id = result.message_id
    confirmation.save()


def settle(confirmation_id, apply):
    """In a transaction: let provider evidence change a confirmation.

    `apply(confirmation, recipient)` runs on the locked confirmation unless its claim is
    being deleted.
    """
    claim_id = Confirmation.objects.values_list("claim_id", flat=True).get(pk=confirmation_id)
    claim = Claim.objects.select_for_update().get(pk=claim_id)
    confirmation = Confirmation.objects.select_for_update().get(pk=confirmation_id)
    if claim.state != Claim.State.PURGING:
        apply(confirmation, claim.email)
