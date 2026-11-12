"""Outbound email: who may receive it, how one message is sent, and what is left of it.

Finance deliveries and participant confirmations both send through `send`. While a test
allowlist is configured, nobody else receives email. In local development `LocalOutbox`
keeps a private copy of each message instead of sending it. `forget` removes the copies
and the provider's evidence of sent messages.
"""

import logging

from django.conf import settings
from django.db.models import Q

from portal.models import DeliveryEvent
from portal.services import mailersend
from portal.services.storage import outbox_key, remove_keys
from portal.services.transport import FAILED, LocalOutbox, SendResult

logger = logging.getLogger(__name__)


class Undeliverable(Exception):
    """The message cannot be composed, so nothing was transmitted. Holds the error code."""


def recipient_approved(address):
    """A Finance inbox that forms may send claims to."""
    return address.lower() in settings.APPROVED_DELIVERY_RECIPIENTS


def configured_transport():
    if settings.MAIL_DELIVERY_MODE == "local" and settings.DEBUG:
        return LocalOutbox()
    return mailersend.MailerSendTransport()


def send(compose, email):
    """Compose the message for `email`, a sender's record, and transmit it.

    No database writes; call outside a transaction. Returns a `SendResult`. Anything that
    fails while composing, or a recipient the test allowlist excludes, is a definite failure:
    nothing reached the provider. An exception from the transport propagates, because the
    provider may have accepted the message.
    """
    try:
        message = compose(email)
    except Undeliverable as exc:
        return SendResult(FAILED, error_code=str(exc))
    except Exception:
        logger.exception("email_compose_failed email=%s", email.pk)
        return SendResult(FAILED, error_code="message_unavailable")
    allowlist = settings.TEST_RECIPIENT_ALLOWLIST
    if allowlist and message.recipient.lower() not in allowlist:
        return SendResult(FAILED, error_code="test_recipient_blocked")
    return configured_transport().send(message)


def remove_copies(*message_ids):
    """Delete any local copies of these messages, by their `Message.attempt_id`."""
    remove_keys(*(outbox_key(message_id) for message_id in message_ids))


def forget(*emails):
    """Delete the local copies and the recorded provider evidence of these sent emails.

    `emails` are senders' records. Evidence goes whether or not it was applied: it names an
    email by the record it was tagged with or by its provider message ID.
    """
    remove_copies(*(email.pk for email in emails))
    message_ids = [email.message_id for email in emails if email.message_id]
    DeliveryEvent.objects.filter(
        Q(attempt_tag__in=[str(email.pk) for email in emails]) | Q(message_id__in=message_ids)
    ).delete()
