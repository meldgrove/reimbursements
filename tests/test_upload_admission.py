from datetime import timedelta

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone

from portal import intake
from portal.intake import IntakeError
from portal.models import DraftAdmission, Upload
from portal.services import network_budget, uploads
from portal.services.drafts import open_draft
from tests.conftest import Participant, image_bytes

pytestmark = pytest.mark.django_db


@pytest.fixture
def opened(form):
    participant = Participant()
    draft, token = open_draft(participant, form)
    return participant, draft, token


def accept(opened, *, kind="receipt", file=None, **options):
    participant, draft, token = opened
    return uploads.accept(
        participant,
        "test",
        file=file or SimpleUploadedFile(f"{kind}.png", image_bytes(signature=kind == "signature")),
        kind=kind,
        expense_id="6f6d3e0a-6a5f-4d3b-9d64-1d2d0f6a1c11" if kind == "receipt" else None,
        draft_id=draft.pk,
        token=token,
        **options,
    )


def refused(opened, status, message, **options):
    with pytest.raises(IntakeError) as caught:
        accept(opened, **options)
    assert (caught.value.status, caught.value.message) == (status, intake.message(message))
    assert not Upload.objects.exists()


@pytest.mark.parametrize("kind", ["receipt", "signature"])
def test_a_file_stopped_by_the_upload_handler_gets_its_kinds_limit(opened, kind):
    refused(opened, 413, f"{kind}_too_large", kind=kind, truncated=True)


def test_a_signature_above_its_limit_is_named_as_a_signature(opened, settings):
    settings.MAX_SIGNATURE_BYTES = 10
    refused(opened, 413, "signature_too_large", kind="signature")


def test_receipts_of_a_draft_stay_within_the_submission_size(opened, settings):
    settings.MAX_SUBMISSION_BYTES = 10
    refused(opened, 413, "submission_too_large")


def test_work_budgets_refuse_with_intake_messages(opened, settings):
    settings.MAX_UPLOADS_PER_NETWORK = 0
    refused(opened, 429, "network_work_limit")
    settings.MAX_UPLOADS_PER_NETWORK, settings.MAX_UPLOADS_PER_DRAFT = 10, 0
    refused(opened, 429, "draft_work_limit")


def test_a_busy_service_refuses_with_the_capacity_message(opened, settings):
    settings.MAX_PENDING_VALIDATIONS = 0
    refused(opened, 503, "upload_capacity")


def test_a_refused_upload_does_not_spend_the_network_budget(opened, settings):
    settings.MAX_PENDING_VALIDATIONS = 0
    refused(opened, 503, "upload_capacity")
    assert DraftAdmission.objects.get().upload_count == 0
    settings.MAX_PENDING_VALIDATIONS = 10
    accept(opened)
    assert DraftAdmission.objects.get().upload_count == 1


def test_the_network_budget_owns_both_of_its_windows(settings):
    settings.MAX_UPLOADS_PER_NETWORK_PER_MINUTE, settings.MAX_DRAFTS_PER_NETWORK = 1, 1
    network = "198.51.100.0/32"
    assert network_budget.charge_upload(network, 5)
    assert not network_budget.charge_upload(network, 5)
    DraftAdmission.objects.update(upload_window_start=timezone.now() - timedelta(minutes=2))
    assert network_budget.charge_upload(network, 5)
    assert network_budget.charge_draft(network) and not network_budget.charge_draft(network)
    DraftAdmission.objects.update(window_start=timezone.now() - timedelta(hours=25))
    assert network_budget.charge_draft(network)
    assert DraftAdmission.objects.get().upload_bytes == 0


def test_an_oversized_request_is_refused_with_the_intake_message(client, form):
    response = client.post(
        "/f/test/submit/", data="{}", content_type="application/json", CONTENT_LENGTH=200_000
    )
    assert response.status_code == 413
    assert response.json()["error"] == intake.message("request_too_large")


def test_uploads_wait_while_private_storage_is_unavailable(opened, monkeypatch):
    monkeypatch.setattr("portal.services.uploads.storage_available", lambda: False)
    refused(opened, 503, "upload_unavailable")
