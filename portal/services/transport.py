"""The transport seam for outbound email.

Adapters: `LocalOutbox` (development, captures .eml files),
`portal.services.mailersend.MailerSendTransport` and `portal.services.smtp.SmtpTransport`;
`portal.services.outbound` chooses one. An adapter returns a `SendResult`; an exception
from `send` means the outcome is unknown.
"""

from dataclasses import dataclass
from email import policy
from email.message import EmailMessage

from portal.services.storage import outbox_key, write_bytes

# States of a sent email's record. `PENDING` from a transport means "retry later, nothing
# was accepted".
PENDING, SENDING = "pending", "sending"
ACCEPTED, PAUSED = "provider_accepted", "paused"
DELIVERED, FAILED, UNKNOWN = "delivered", "failed", "send_unknown"
# Outcomes that neither a late send result nor later provider evidence can regress.
FINAL = frozenset({DELIVERED, FAILED})


@dataclass(frozen=True)
class Message:
    attempt_id: str
    sender: str
    reply_to: str
    recipient: str
    subject: str
    text: str
    attachment: bytes | None = None
    filename: str = ""


@dataclass(frozen=True)
class SendResult:
    state: str
    message_id: str = ""
    error_code: str = ""
    retry_after: int = 0


def mime(message, *, sender=None, email_policy=policy.default):
    """`message` as an email; `sender` replaces its From header."""
    email = EmailMessage(policy=email_policy)
    email["From"], email["To"], email["Subject"] = (
        sender or message.sender,
        message.recipient,
        message.subject,
    )
    email["Reply-To"] = message.reply_to
    email.set_content(message.text)
    if message.attachment is not None:
        email.add_attachment(
            message.attachment, maintype="application", subtype="pdf", filename=message.filename
        )
    return email


class LocalOutbox:
    """Local development: store the complete email privately and send nothing."""

    def send(self, message):
        write_bytes(outbox_key(message.attempt_id), mime(message).as_bytes())
        return SendResult(DELIVERED, f"local-{message.attempt_id}")


class NotSetUp:
    """No provider is set up: nothing is sent, and the email waits for one."""

    def send(self, message):
        return SendResult(PENDING, error_code="email_not_set_up", retry_after=900)
