"""Finance deliveries and participant confirmations follow one send-at-most-once protocol."""

import pytest
from django.utils import timezone

from portal.jobs import BACKOFF, run_one
from portal.models import Confirmation, Job
from portal.services import outbound, queue
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
        return result


@pytest.fixture
def transport(monkeypatch):
    adapter = Recorder()
    monkeypatch.setattr(outbound, "configured_transport", lambda: adapter)
    return adapter


def finance(delivery):
    Job.objects.all().delete()
    queue.enqueue("send", delivery)
    return lambda: delivery.attempts.order_by("created_at").last()


def confirmation(delivery):
    Job.objects.all().delete()
    claim = delivery.claim
    Confirmation.objects.filter(claim=claim).update(state=PENDING)
    queue.enqueue("confirm", claim)
    return lambda: Confirmation.objects.get(claim=claim)


SENDERS = [finance, confirmation]


def run_until_idle():
    while Job.objects.filter(state=queue.PENDING).exists():
        Job.objects.update(run_after=timezone.now())
        run_one()


@pytest.mark.parametrize("sender", SENDERS)
def test_an_accepted_send_is_recorded_once(delivery, transport, sender):
    record = sender(delivery)
    run_until_idle()
    assert len(transport.sent) == 1
    assert (record().state, record().message_id) == ("provider_accepted", "message-1")


@pytest.mark.parametrize("sender", SENDERS)
def test_a_throttled_send_retries_until_attempts_run_out(delivery, transport, sender):
    record = sender(delivery)
    transport.results = [SendResult(PENDING, error_code="provider_throttled")] * 10
    run_until_idle()
    assert len(transport.sent) == len(BACKOFF) + 1
    assert (record().state, record().error_code) == ("failed", "retry_exhausted")
    assert Job.objects.get().error_code == "retry_exhausted"


@pytest.mark.parametrize("sender", SENDERS)
def test_a_send_that_raises_is_never_repeated(delivery, transport, sender):
    record = sender(delivery)
    transport.results = [TimeoutError("synthetic")]
    run_until_idle()
    assert len(transport.sent) == 1
    assert (record().state, record().error_code) == ("send_unknown", "unexpected_send_failure")


@pytest.mark.parametrize("sender", SENDERS)
def test_the_test_allowlist_blocks_every_sender(delivery, transport, settings, sender):
    settings.TEST_RECIPIENT_ALLOWLIST = ["nobody@example.invalid"]
    record = sender(delivery)
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
