"""Participant receipt emails. Never attach receipts or banking details.

Admins turn the confirmation off, or write its subject and text per language, under
Admin > Email (`EmailSettings`); without their own text it uses the standard one. A
claim accepted while confirmations are off gets none.

A confirmation changes through its send result and provider evidence, which the Evidence
module applies through `settle`. It is never sent twice.
"""

import string

from django.utils import translation

from portal import app_settings
from portal.constants import APP_NAME, PAYMENT_TIMING
from portal.i18n import language, t
from portal.models import Claim, Confirmation, EmailSettings
from portal.services import email_connection, queue
from portal.services.transport import FINAL, PENDING, SENDING, Message

# What admins may write in braces, and what each placeholder becomes.
PLACEHOLDERS = {
    "name": "the participant's name",
    "form": "the form's name",
    "reference": "the claim's reference",
    "payment_timing": "when reimbursements are usually paid",
    "support": "the form's contact for questions",
    "app_name": f"“{APP_NAME}”",
}
MAX_SUBJECT_LENGTH, MAX_BODY_LENGTH = 200, 5000


def enabled():
    return EmailSettings.load().confirmation_enabled


def standard_texts(code):
    """The standard subject and text in language `code`, with their placeholders."""
    with translation.override(code):
        return (
            t("Confirmation of receipt: reimbursement claim {reference}"),
            t(
                "Hello {name},\n\n"
                "your reimbursement claim for {form} has been received.\n\n"
                "Your reference: {reference}\n"
                "Please quote this reference with any questions.\n\n"
                "This confirmation of receipt is not yet an approval of the reimbursement.\n"
                "{payment_timing}\n\n"
                "If you have questions, you can reach us at {support}.\n\n"
                "Best regards\nYour {app_name} team\n"
            ),
        )


def texts(saved, code):
    """The subject and text a confirmation in language `code` uses, with placeholders."""
    own = saved.confirmation_texts.get(code) or {}
    subject, body = standard_texts(code)
    return own.get("subject") or subject, own.get("body") or body


def placeholder_problem(text):
    """Why `text` cannot be a confirmation's subject or text, or "" when it can."""
    try:
        fields = [
            (field, spec, conversion)
            for _, field, spec, conversion in string.Formatter().parse(text)
            if field is not None
        ]
    except ValueError:
        return "Write a single brace as {{ or }}; braces otherwise enclose a placeholder."
    for field, spec, conversion in fields:
        if field not in PLACEHOLDERS:
            known = ", ".join(f"{{{name}}}" for name in PLACEHOLDERS)
            return f"{{{field}}} is not a placeholder. Use {known}."
        if spec or conversion:
            return f"Write the placeholder as {{{field}}}, without “:” or “!”."
    return ""


def schedule(claim):
    if not enabled():
        return
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
        subject, text = texts(EmailSettings.load(), language())
        values = {
            "name": claim.full_name,
            "form": claim.snapshot["name"],
            "reference": claim.reference,
            "payment_timing": t(PAYMENT_TIMING),
            "support": claim.snapshot["support_email"],
            "app_name": APP_NAME,
        }
        subject, text = subject.format(**values), text.format(**values)
    return Message(
        attempt_id=str(confirmation.pk),
        sender=email_connection.current().sender,
        reply_to=claim.snapshot["support_email"],
        recipient=claim.email,
        subject=" ".join(subject.split()),
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
