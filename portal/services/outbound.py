"""Outbound email: who may receive it, which transport sends it, and its local copies.

Finance deliveries and participant confirmations both send through `send`. While a test
allowlist is configured, nobody else receives email. In local development `LocalOutbox`
keeps a private copy of each message instead of sending it; `remove_copies` deletes them.
"""

from django.conf import settings

from portal.services import mailersend
from portal.services.storage import outbox_key, remove_keys
from portal.services.transport import FAILED, LocalOutbox, SendResult


def recipient_approved(address):
    """A Finance inbox that forms may send claims to."""
    return address.lower() in settings.APPROVED_DELIVERY_RECIPIENTS


def configured_transport():
    if settings.MAIL_DELIVERY_MODE == "local" and settings.DEBUG:
        return LocalOutbox()
    return mailersend.MailerSendTransport()


def send(message):
    """Transmit `message`, unless the test allowlist excludes its recipient.

    Returns a `SendResult`. An exception from the transport means the outcome is unknown.
    """
    allowlist = settings.TEST_RECIPIENT_ALLOWLIST
    if allowlist and message.recipient.lower() not in allowlist:
        return SendResult(FAILED, error_code="test_recipient_blocked")
    return configured_transport().send(message)


def remove_copies(*message_ids):
    """Delete any local copies of these messages, by their `Message.attempt_id`."""
    remove_keys(*(outbox_key(message_id) for message_id in message_ids))
