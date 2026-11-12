"""Evidence: what the provider says about a sent email, applied to that email's record.

Every outbound email has one record: a Finance delivery attempt or a participant
confirmation. The MailerSend adapter turns webhooks and lookups into `Evidence`. This
module stores each piece once, finds the email it is about by provider message ID or by
the record ID the email was tagged with, and moves the record's state. Evidence that
arrives before its email's record is retried, and dropped after `UNMATCHED_LIFETIME`.
Evidence never causes a send.
"""

import hashlib
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta

from django.db import models, transaction
from django.db.models import F
from django.utils import timezone

from portal.models import Confirmation, DeliveryAttempt, DeliveryEvent
from portal.services import confirmations, delivery, mailersend
from portal.services.transport import ACCEPTED, DELIVERED, FAILED, FINAL, PAUSED, UNKNOWN

# Emails the provider can tell us more about.
RECONCILABLE = frozenset({ACCEPTED, PAUSED, UNKNOWN})
UNMATCHED_LIFETIME = timedelta(days=30)


@dataclass(frozen=True)
class Sender:
    """Where one kind of email keeps its records.

    `settle(record_id, apply)` locks the record in a transaction and calls
    `apply(record, recipient)` with the address the email went to, unless the claim is
    being deleted. `apply` returns whether it changed the record.
    """

    model: type[models.Model]
    settle: Callable


SENDERS = (Sender(DeliveryAttempt, delivery.settle), Sender(Confirmation, confirmations.settle))


def _recipient_hash(address):
    return hashlib.sha256(address.lower().encode()).hexdigest()


@transaction.atomic
def record(evidence):
    """Store what the provider says about an email; it applies once the email is known."""
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


def _find(event):
    """The sender and record ID of the email `event` is about, or None."""
    if event.message_id:
        for sender in SENDERS:
            emails = sender.model.objects.filter(message_id=event.message_id)
            if found := emails.values_list("pk", flat=True).first():
                return sender, found
    try:
        tagged = uuid.UUID(event.attempt_tag)
    except (ValueError, TypeError):
        return None
    for sender in SENDERS:
        if sender.model.objects.filter(pk=tagged).exists():
            return sender, tagged
    return None


def _apply(event):
    if event.applied or not (found := _find(event)):
        return
    sender, record_id = found
    sender.settle(record_id, lambda email, recipient: _settle(email, recipient, event))


def _settle(email, recipient, event):
    """Apply `event` to the locked record of an email sent to `recipient`."""
    if _recipient_hash(recipient) != event.recipient_hash:
        return False
    if email.message_id and event.message_id and email.message_id != event.message_id:
        return False
    if not email.message_id and event.message_id:
        email.message_id = event.message_id
    state, error_code, resolves_unknown_only = mailersend.outcome(event.kind)
    if resolves_unknown_only and email.state != UNKNOWN:
        state = None
    # Terminal success/failure cannot regress on a late sent/deferred callback.
    if state and (state in FINAL or email.state not in FINAL):
        if not (email.state == FAILED and state == DELIVERED):
            email.state, email.error_code = state, error_code
    email.save()
    event.applied = True
    event.save(update_fields=["applied"])
    return True


@transaction.atomic
def reconcile_unmatched():
    """Retry evidence that arrived before its email's record; drop what stays unmatched."""
    now = timezone.now()
    DeliveryEvent.objects.filter(applied=False, received_at__lt=now - UNMATCHED_LIFETIME).delete()
    events = DeliveryEvent.objects.filter(applied=False).order_by(
        F("last_checked_at").asc(nulls_first=True), "received_at", "pk"
    )[:100]
    for event in list(events):
        event.last_checked_at = now
        event.save(update_fields=["last_checked_at"])
        _apply(event)


def _unsettled(model, limit):
    """Unsettled emails with a message ID: never checked first, then the least recent."""
    return (
        model.objects.exclude(message_id__isnull=True)
        .exclude(message_id="")
        .filter(state__in=RECONCILABLE)
        .order_by(F("last_checked_at").asc(nulls_first=True), "updated_at", "pk")[:limit]
    )


def _due(email):
    return (email.last_checked_at is not None, email.last_checked_at or email.updated_at)


def reconcile(batch_size):
    """Ask the provider about unsettled emails of every sender. Never resends.

    Returns counts of checked emails, deferred answers and failed lookups.
    """
    reconcile_unmatched()
    emails = sorted(
        (email for sender in SENDERS for email in _unsettled(sender.model, batch_size)), key=_due
    )[:batch_size]
    counts = {"checked": 0, "deferred": 0, "failed": 0}
    for email in emails:
        type(email).objects.filter(pk=email.pk).update(last_checked_at=timezone.now())
        counts["checked"] += 1
        try:
            evidence = mailersend.lookup(email.pk, email.message_id)
        except mailersend.LookupFailed:
            counts["failed"] += 1
            continue
        if evidence is None:
            counts["deferred"] += 1
            continue
        record(evidence)
    return counts
