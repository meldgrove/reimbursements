import pytest
from django.utils import timezone

from portal.jobs import run_one
from portal.models import Claim, Delivery, DeliveryAttempt, Draft, Expense, Job, Operation, Upload
from portal.services import delivery as deliveries
from portal.services import operations
from portal.services.retention import cleanup
from portal.services.storage import path_for

pytestmark = pytest.mark.django_db


def stored_files(claim):
    return [path_for(upload.source_key) for upload in claim.uploads.all()]


def test_operator_deletion_removes_the_claim_for_good_and_is_audited(accepted):
    files = stored_files(accepted)
    assert files and all(path.exists() for path in files)
    assert Job.objects.filter(state="pending").exists()

    assert operations.delete(accepted.pk, actor="admin@example.invalid", reason=" Testeinreichung ")

    assert not Claim.objects.exists()
    assert not any(path.exists() for path in files)
    assert not Expense.objects.exists() and not Upload.objects.exists()
    assert not Job.objects.exists()
    draft = Draft.objects.get()
    assert draft.claim_id is None and not draft.session_hash and not draft.token_hash
    assert not Draft.objects.filter(claim__isnull=True, expires_at__gt=timezone.now()).exists()
    operation = Operation.objects.get()
    assert (operation.claim_id, operation.action) == (None, "delete")
    assert (operation.actor, operation.reason) == ("admin@example.invalid", "Testeinreichung")
    cleanup(execute=True)
    assert not Draft.objects.exists() and Operation.objects.exists()


def test_deletion_requires_a_reason(accepted):
    with pytest.raises(operations.ActionRefused) as refused:
        operations.delete(accepted.pk, actor="admin", reason="  ")
    assert refused.value.code == "reason_missing"
    accepted.refresh_from_db()
    assert accepted.state == Claim.State.RECEIVED and accepted.iban
    assert not Operation.objects.exists()


def test_deletion_waits_for_running_work(accepted):
    Job.objects.filter(kind="render").update(state="running")
    with pytest.raises(operations.ActionRefused) as refused:
        operations.delete(accepted.pk, actor="admin", reason="Test")
    assert refused.value.code == "busy"
    accepted.refresh_from_db()
    assert accepted.state == Claim.State.RECEIVED and accepted.uploads.exists()
    assert Job.objects.filter(kind="render", state="running").exists()
    assert not Operation.objects.exists()


def test_a_deleted_claim_cannot_be_deleted_again(accepted):
    operations.delete(accepted.pk, actor="admin", reason="Test")
    with pytest.raises(operations.ActionRefused) as refused:
        operations.delete(accepted.pk, actor="admin", reason="Again")
    assert refused.value.code == "already_deleted"
    assert Operation.objects.count() == 1


def test_interrupted_deletion_is_finished_by_cleanup(accepted):
    directory = path_for(accepted.uploads.first().source_key).parent
    directory.chmod(0o500)
    try:
        assert operations.delete(accepted.pk, actor="admin", reason="Test") is False
    finally:
        directory.chmod(0o700)
    accepted.refresh_from_db()
    assert accepted.state == Claim.State.PURGING
    assert Operation.objects.get().action == "delete"
    cleanup(execute=True)
    assert not Claim.objects.exists()
    assert Operation.objects.get().action == "delete"


def test_a_deleted_claim_is_never_sent(delivery):
    Job.objects.create(key="send-test", kind="send", delivery=delivery)
    operations.delete(delivery.claim_id, actor="admin", reason="Test")
    assert not path_for("pdf/test.pdf").exists()
    assert not Job.objects.exists() and not Delivery.objects.exists()
    assert not run_one()
    assert not DeliveryAttempt.objects.exists()


@pytest.mark.parametrize(
    ("states", "reached"),
    [
        ([], False),
        (["failed"], False),
        (["failed", "send_unknown"], True),
        (["provider_accepted"], True),
        (["delivered"], True),
    ],
)
def test_finance_may_hold_a_copy_unless_every_send_failed(delivery, states, reached):
    for state in states:
        DeliveryAttempt.objects.create(delivery=delivery, state=state)
    claim = Claim.objects.select_related("delivery").get(pk=delivery.claim_id)
    assert deliveries.may_have_reached_finance(claim) is reached


def test_a_claim_without_delivery_has_not_reached_finance(accepted):
    assert not deliveries.may_have_reached_finance(accepted)
