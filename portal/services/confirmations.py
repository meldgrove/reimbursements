"""Participant receipt emails. Never attach receipts or banking details."""

from django.conf import settings
from django.utils import timezone

from portal.constants import PAYMENT_TIMING
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
    message = Message(
        attempt_id=str(confirmation.pk),
        sender=settings.MAIL_FROM_ADDRESS,
        reply_to=claim.snapshot["support_email"],
        recipient=claim.email,
        subject=f"Eingangsbestätigung: Erstattungsantrag {claim.reference}",
        text=(
            f"Hallo {claim.full_name},\n\n"
            f"dein Erstattungsantrag für {claim.snapshot['name']} ist eingegangen.\n\n"
            f"Deine Referenz: {claim.reference}\n"
            "Bitte gib diese Referenz bei Rückfragen an.\n\n"
            "Die Eingangsbestätigung ist noch keine Zusage zur Erstattung.\n"
            f"{PAYMENT_TIMING}\n\n"
            f"Bei Fragen erreichst du uns unter {claim.snapshot['support_email']}.\n\n"
            "Viele Grüße\nDein Erstattungsportal-Team\n"
        ),
    )
    return configured_transport().send(message)


def mark(claim_id, state, error_code="", message_id=""):
    Confirmation.objects.filter(claim_id=claim_id).update(
        state=state, error_code=error_code, message_id=message_id, updated_at=timezone.now()
    )
