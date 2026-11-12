"""Finance deliveries and participant confirmations follow one send-at-most-once protocol,
and the provider's evidence settles either."""

import io
from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta

import pytest
from django.core.management import call_command
from django.utils import timezone

from portal.jobs import BACKOFF, run_one
from portal.models import Claim, Confirmation, DeliveryEvent, Job
from portal.services import evidence, mailersend, outbound, queue
from portal.services.retention import purge_claim
from portal.services.storage import outbox_key, path_for
from portal.services.transport import ACCEPTED, PENDING, SendResult

pytestmark = pytest.mark.django_db


class Recorder:
    """An in-memory transport adapter."""

    def __init__(self):
        self.sent, self.results = [], []

    def send(self, message):
        self.sent.append(message)
        result = self.results.pop(0) if self.results else SendResult(ACCEPTED, "message-1")
        if isinstance(result, Exception):
            raise result
        return result(message) if callable(result) else result


@pytest.fixture
def transport(monkeypatch):
    adapter = Recorder()
    monkeypatch.setattr(outbound, "configured_transport", lambda: adapter)
    return adapter


@dataclass(frozen=True)
class Email:
    """A queued email: its record, read fresh, and the address it goes to."""

    record: Callable
    recipient: str


def finance(delivery):
    Job.objects.all().delete()
    queue.enqueue("send", delivery)
    return Email(lambda: delivery.attempts.order_by("created_at").last(), delivery.recipient)


def confirmation(delivery):
    Job.objects.all().delete()
    claim = delivery.claim
    Confirmation.objects.filter(claim=claim).update(state=PENDING)
    queue.enqueue("confirm", claim)
    return Email(lambda: Confirmation.objects.get(claim=claim), claim.email)


SENDERS = [finance, confirmation]


def run_until_idle():
    while Job.objects.filter(state=queue.PENDING).exists():
        Job.objects.update(run_after=timezone.now())
        run_one()


@pytest.mark.parametrize("sender", SENDERS)
def test_an_accepted_send_is_recorded_once(delivery, transport, sender):
    record = sender(delivery).record
    run_until_idle()
    assert len(transport.sent) == 1
    assert (record().state, record().message_id) == ("provider_accepted", "message-1")


@pytest.mark.parametrize("sender", SENDERS)
def test_a_throttled_send_retries_until_attempts_run_out(delivery, transport, sender):
    record = sender(delivery).record
    transport.results = [SendResult(PENDING, error_code="provider_throttled")] * 10
    run_until_idle()
    assert len(transport.sent) == len(BACKOFF) + 1
    assert (record().state, record().error_code) == ("failed", "retry_exhausted")
    assert Job.objects.get().error_code == "retry_exhausted"


@pytest.mark.parametrize("sender", SENDERS)
def test_a_send_that_raises_is_never_repeated(delivery, transport, sender):
    record = sender(delivery).record
    transport.results = [TimeoutError("synthetic")]
    run_until_idle()
    assert len(transport.sent) == 1
    assert (record().state, record().error_code) == ("send_unknown", "unexpected_send_failure")


@pytest.mark.parametrize("sender", SENDERS)
def test_the_test_allowlist_blocks_every_sender(delivery, transport, settings, sender):
    settings.TEST_RECIPIENT_ALLOWLIST = ["nobody@example.invalid"]
    record = sender(delivery).record
    run_until_idle()
    assert not transport.sent
    assert (record().state, record().error_code) == ("failed", "test_recipient_blocked")


def test_local_copies_go_with_their_messages(tmp_path):
    for message_id in ("attempt-1", "confirmation-1"):
        path = path_for(outbox_key(message_id))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"synthetic")
    outbound.remove_copies("attempt-1")
    assert not path_for(outbox_key("attempt-1")).exists()
    assert path_for(outbox_key("confirmation-1")).exists()


def webhook(recipient, kind, provider_id, **data):
    """Verified MailerSend webhook evidence."""
    return mailersend.webhook_evidence(
        {
            "type": f"activity.{kind}",
            "created_at": timezone.now().isoformat(),
            "data": {"id": provider_id, "recipient": recipient, **data},
        }
    )


@pytest.mark.parametrize("sender", SENDERS)
def test_provider_evidence_settles_every_sender(delivery, transport, sender):
    email = sender(delivery)
    run_until_idle()
    evidence.record(webhook(email.recipient, "delivered", "event-1", message_id="message-1"))
    evidence.record(webhook(email.recipient, "sent", "event-2", message_id="message-1"))
    assert email.record().state == "delivered"
    assert not DeliveryEvent.objects.filter(applied=False).exists()


@pytest.mark.parametrize("sender", SENDERS)
def test_evidence_that_arrives_before_the_send_result_stands(delivery, transport, sender):
    email = sender(delivery)

    def delivered_first(message):
        tags = [f"attempt-{message.attempt_id}"]
        evidence.record(webhook(email.recipient, "delivered", "event-1", tags=tags))
        return SendResult(ACCEPTED, "message-1")

    transport.results = [delivered_first]
    run_until_idle()
    assert (email.record().state, email.record().message_id) == ("delivered", "message-1")


@pytest.mark.parametrize("sender", SENDERS)
def test_evidence_for_another_recipient_changes_nothing(delivery, transport, sender):
    email = sender(delivery)
    run_until_idle()
    evidence.record(
        webhook("other@example.invalid", "hard_bounced", "event-1", message_id="message-1")
    )
    assert email.record().state == "provider_accepted"


@pytest.mark.parametrize("sender", SENDERS)
def test_a_message_that_cannot_be_composed_is_a_definite_failure(delivery, transport, sender):
    email = sender(delivery)
    Claim.objects.filter(pk=delivery.claim_id).update(snapshot={})
    run_until_idle()
    assert not transport.sent
    assert (email.record().state, email.record().error_code) == ("failed", "message_unavailable")


@pytest.mark.parametrize("sender", SENDERS)
def test_reconciliation_looks_up_every_sender(delivery, transport, sender, monkeypatch):
    email = sender(delivery)
    run_until_idle()
    looked_up = []

    def retrieve(message_id):
        looked_up.append(message_id)
        return {"emails": [{"status": "delivered", "to": email.recipient}]}

    monkeypatch.setattr(mailersend, "retrieve_message", retrieve)
    call_command("reconcile_deliveries", stdout=io.StringIO())
    assert looked_up == ["message-1"]
    assert email.record().state == "delivered"


def test_deleting_a_claim_forgets_the_evidence_of_its_emails(delivery, transport):
    claim = delivery.claim
    finance(delivery)
    run_until_idle()
    confirmation(delivery)
    transport.results = [SendResult(ACCEPTED, "message-2")]
    run_until_idle()
    evidence.record(webhook(delivery.recipient, "delivered", "finance", message_id="message-1"))
    evidence.record(webhook(claim.email, "delivered", "confirmation", message_id="message-2"))
    # Evidence that names the claim's email but never applied goes as well.
    evidence.record(webhook("other@example.invalid", "sent", "unapplied", message_id="message-2"))
    evidence.record(webhook(claim.email, "delivered", "another-email", message_id="message-3"))
    purge_claim(claim.pk)
    assert list(DeliveryEvent.objects.values_list("provider_id", flat=True)) == ["another-email"]


def test_unmatched_evidence_is_dropped_after_thirty_days():
    for provider_id, age in [("recent", 29), ("old", 31)]:
        DeliveryEvent.objects.create(
            provider_id=provider_id,
            message_id=provider_id,
            kind="activity.delivered",
            recipient_hash="0" * 64,
            provider_timestamp=timezone.now(),
            received_at=timezone.now() - timedelta(days=age),
        )
    evidence.reconcile_unmatched()
    assert list(DeliveryEvent.objects.values_list("provider_id", flat=True)) == ["recent"]
