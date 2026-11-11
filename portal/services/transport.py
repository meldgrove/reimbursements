"""The transport seam for delivery attempts.

Adapters: `LocalOutbox` (development, captures .eml files) and
`portal.services.mailersend.MailerSendTransport`. An adapter returns a
`SendResult`; an exception from `send` means the outcome is unknown.
"""

from dataclasses import dataclass
from email.message import EmailMessage

from portal.services.storage import outbox_key, write_bytes

# Attempt states. `PENDING` from a transport means "retry later, nothing was accepted".
PENDING, SENDING = "pending", "sending"
ACCEPTED, PAUSED = "provider_accepted", "paused"
DELIVERED, FAILED, UNKNOWN = "delivered", "failed", "send_unknown"


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


class LocalOutbox:
    """Local development: store the complete email privately and send nothing."""

    def send(self, message):
        email = EmailMessage()
        email["From"], email["To"], email["Subject"] = (
            message.sender,
            message.recipient,
            message.subject,
        )
        email["Reply-To"] = message.reply_to
        email.set_content(message.text)
        if message.attachment is not None:
            email.add_attachment(
                message.attachment, maintype="application", subtype="pdf", filename=message.filename
            )
        write_bytes(outbox_key(message.attempt_id), email.as_bytes())
        return SendResult(DELIVERED, f"local-{message.attempt_id}")
