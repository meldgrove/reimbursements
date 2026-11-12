import io
import socket
from datetime import timedelta
from unittest.mock import patch

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone
from PIL import Image

from portal.jobs import run_one
from portal.models import Claim, Confirmation, Delivery, DeliveryEvent, Expense, Form, Job, Upload
from portal.services.retention import cleanup, purge_claim
from portal.services.storage import path_for
from tests.conftest import camera_jpeg_bytes, image_bytes

pytestmark = pytest.mark.django_db


def test_real_upload_is_validated_asynchronously(prepared, uploaded_file):
    data = {
        "draft_id": str(prepared["draft"].id),
        "token": prepared["data"]["token"],
        "kind": "receipt",
        "expense_id": prepared["data"]["expenses"][0]["id"],
        "file": uploaded_file,
    }
    response = prepared["client"].post("/f/test/uploads/", data)
    assert response.status_code == 202, response.content
    result = response.json()
    upload = Upload.objects.get(pk=result["id"])
    assert upload.state == "pending"
    assert run_one()
    upload.refresh_from_db()
    assert upload.state == "ready", upload.error_code
    assert upload.normalized_key.endswith(".jpg")
    assert (
        prepared["client"]
        .get(result["status_url"], headers={"X-Draft-Token": prepared["data"]["token"]})
        .json()["pages"]
        == 1
    )


@pytest.mark.parametrize("kind", ["receipt", "signature"])
def test_camera_jpeg_with_auxiliary_picture_is_normalized(prepared, kind):
    content = camera_jpeg_bytes()
    with Image.open(io.BytesIO(content)) as source:
        assert source.format == "MPO" and source.n_frames == 2
        assert source.getexif()[274] == 6
    response = prepared["client"].post(
        "/f/test/uploads/",
        {
            "draft_id": str(prepared["draft"].id),
            "token": prepared["data"]["token"],
            "kind": kind,
            "expense_id": prepared["data"]["expenses"][0]["id"] if kind == "receipt" else "",
            "file": SimpleUploadedFile("camera.jpg", content, content_type="image/jpeg"),
        },
    )
    assert response.status_code == 202, response.content
    assert run_one()
    upload = Upload.objects.get(pk=response.json()["id"])
    assert upload.state == "ready", upload.error_code
    assert upload.pages == 1
    with Image.open(path_for(upload.normalized_key)) as clean:
        assert clean.format == ("JPEG" if kind == "receipt" else "PNG")
        assert getattr(clean, "n_frames", 1) == 1
        assert clean.size == (180, 320)
        assert not clean.getexif()
        assert not {"mp", "exif", "xmp", "icc_profile"}.intersection(clean.info)
        red, green, _ = clean.getpixel((90, 160))
        assert green > red + 50  # Primary green picture, never the auxiliary red picture.


def test_scanner_failure_keeps_file_pending(prepared, uploaded_file, settings):
    settings.UPLOAD_SCANNER, settings.CLAMAV_HOST = "clamav", "127.0.0.1"
    with socket.socket() as unused:
        unused.bind(("127.0.0.1", 0))
        settings.CLAMAV_PORT = unused.getsockname()[1]
    response = prepared["client"].post(
        "/f/test/uploads/",
        {
            "draft_id": str(prepared["draft"].id),
            "token": prepared["data"]["token"],
            "kind": "receipt",
            "expense_id": prepared["data"]["expenses"][0]["id"],
            "file": uploaded_file,
        },
    )
    run_one()
    upload = Upload.objects.get(pk=response.json()["id"])
    assert upload.state == "pending"
    assert upload.error_code == "scanner_unavailable"
    assert Job.objects.get(upload=upload).state == "pending"


def test_original_single_file_limit_is_enforced(prepared):
    response = prepared["client"].post(
        "/f/test/uploads/",
        {
            "draft_id": str(prepared["draft"].id),
            "token": prepared["data"]["token"],
            "kind": "receipt",
            "expense_id": prepared["data"]["expenses"][0]["id"],
            "file": SimpleUploadedFile("large.png", b"x" * 10_000_001, content_type="image/png"),
        },
    )
    assert response.status_code == 413
    assert Upload.objects.count() == 2


def test_spoofed_image_never_becomes_ready(prepared):
    response = prepared["client"].post(
        "/f/test/uploads/",
        {
            "draft_id": str(prepared["draft"].id),
            "token": prepared["data"]["token"],
            "kind": "receipt",
            "expense_id": prepared["data"]["expenses"][0]["id"],
            "file": SimpleUploadedFile("receipt.png", b"not an image", content_type="image/png"),
        },
    )
    assert response.status_code == 202
    run_one()
    assert Upload.objects.get(pk=response.json()["id"]).state == "failed"


def test_purge_deletes_the_claim_with_all_its_records_and_files(accepted):
    while run_one():
        pass
    accepted.refresh_from_db()
    assert accepted.delivery.attempts.exists()
    DeliveryEvent.objects.create(
        provider_id="synthetic",
        attempt=accepted.delivery.attempts.get(),
        kind="delivered",
        recipient_hash="0" * 64,
        provider_timestamp=timezone.now(),
    )
    files = [path_for(accepted.pdf_key)] + [
        path_for(upload.source_key) for upload in accepted.uploads.all()
    ]
    purge_claim(accepted.pk)
    assert all(not path.exists() for path in files)
    assert not Claim.objects.exists() and not Delivery.objects.exists()
    assert not Expense.objects.exists() and not Upload.objects.exists()
    assert not Confirmation.objects.exists() and not DeliveryEvent.objects.exists()
    assert not Job.objects.exists()
    purge_claim(accepted.pk)  # A claim that is already gone needs nothing more.


def test_interrupted_purge_resumes_from_manifest(accepted):
    directory = path_for(accepted.uploads.first().source_key).parent
    directory.chmod(0o500)
    try:
        with pytest.raises(OSError):
            purge_claim(accepted.pk)
    finally:
        directory.chmod(0o700)
    accepted.refresh_from_db()
    assert accepted.state == "purging"
    assert accepted.uploads.count() == 2
    cleanup(execute=True)
    assert not Claim.objects.exists() and not Upload.objects.exists()


def test_unresolved_claim_is_alerted_not_silently_deleted(accepted):
    accepted.resolution_due = timezone.now() - timedelta(days=1)
    accepted.save()
    result = cleanup(execute=True)
    accepted.refresh_from_db()
    assert result["unresolved_near_expiry"] == 1
    assert accepted.state == "received"
    assert accepted.uploads.exists()


def test_unused_upload_expires_after_claim_acceptance(accepted):
    import uuid

    key = f"uploads/{uuid.uuid4()}/source.png"
    path = path_for(key)
    path.parent.mkdir(parents=True)
    path.write_bytes(image_bytes())
    extra = Upload.objects.create(
        draft=accepted.accepted_draft,
        kind="receipt",
        original_name="unused.png",
        source_key=key,
        size=path.stat().st_size,
        checksum="synthetic",
        created_at=timezone.now() - timedelta(hours=25),
    )
    cleanup(execute=True)
    assert not Upload.objects.filter(pk=extra.pk).exists()
    assert not path.exists()
    assert accepted.uploads.count() == 2


def test_liveness_is_independent_of_database(client):
    with patch(
        "portal.views.connection.cursor", side_effect=RuntimeError("synthetic database outage")
    ):
        assert client.get("/-/healthz").status_code == 200
        assert client.get("/-/readyz").status_code == 503


def test_content_is_deleted_once_due_without_any_setting(accepted):
    accepted.retention_due = timezone.now() - timedelta(seconds=1)
    accepted.save()
    cleanup(execute=True)
    assert not Claim.objects.exists()


def test_purged_claim_does_not_match_an_anonymous_session(accepted):
    from django.test import Client

    purge_claim(accepted.pk)
    assert Client().get(f"/received/{accepted.pk}/").status_code == 404


def test_liveness_reports_the_release_version(client, settings):
    settings.APP_VERSION = "1.2.3"
    assert client.get("/-/healthz").json()["version"] == "1.2.3"
    settings.APP_VERSION = ""
    assert client.get("/-/healthz").json()["version"] is None


def test_public_health_requires_deployment_token(client, settings):
    settings.DEBUG = False
    settings.HEALTHCHECK_TOKEN = "synthetic-health-token"
    assert client.get("/-/healthz").status_code == 404
    assert (
        client.get("/-/healthz", headers={"X-Health-Token": "synthetic-health-token"}).status_code
        == 200
    )


@pytest.mark.parametrize(
    ("change", "message"),
    [("closed", "geschlossen"), ("revised", "aktualisiert")],
)
def test_uploads_and_submission_share_the_editable_draft_rule(
    prepared, uploaded_file, change, message
):
    form = prepared["form"]
    if change == "closed":
        form.status = Form.Status.DRAFT
    else:
        form.purpose_options = "Neue Vorgabe"
    form.save()
    upload = prepared["client"].post(
        "/f/test/uploads/",
        {
            "draft_id": str(prepared["draft"].id),
            "token": prepared["data"]["token"],
            "kind": "receipt",
            "expense_id": prepared["data"]["expenses"][0]["id"],
            "file": uploaded_file,
        },
    )
    submit = prepared["client"].post(
        "/f/test/submit/", data=prepared["data"], content_type="application/json"
    )
    for response in [upload, submit]:
        assert response.status_code == 409
        assert message in response.json()["error"]


def test_upload_status_and_removal_need_the_draft_token(prepared, uploaded_file):
    client = prepared["client"]
    response = client.post(
        "/f/test/uploads/",
        {
            "draft_id": str(prepared["draft"].id),
            "token": prepared["data"]["token"],
            "kind": "receipt",
            "expense_id": prepared["data"]["expenses"][0]["id"],
            "file": uploaded_file,
        },
    )
    result = response.json()
    assert client.get(result["status_url"]).status_code == 404
    assert client.delete(result["delete_url"], headers={"X-Draft-Token": "x"}).status_code == 404
    assert Upload.objects.filter(pk=result["id"]).exists()
    headers = {"X-Draft-Token": prepared["data"]["token"]}
    assert client.delete(result["delete_url"], headers=headers).status_code == 200
    assert not Upload.objects.filter(pk=result["id"]).exists()


def test_a_form_whose_recipient_is_no_longer_approved_closes_before_any_upload(
    client, form, settings
):
    settings.APPROVED_DELIVERY_RECIPIENTS = ["other@example.invalid"]
    response = client.get("/f/test/")
    assert response.status_code == 503
    assert "nicht verfügbar" in response.content.decode()
    assert not form.draft_set.exists()


@pytest.mark.parametrize(("method", "status"), [("get", 404), ("delete", 200)])
def test_an_upload_removed_concurrently_is_gone_not_an_error(prepared, monkeypatch, method, status):
    from portal.services import drafts

    upload = Upload.objects.get(kind="receipt")
    original = drafts.gate

    def racing(*args):
        result = original(*args)
        Upload.objects.filter(pk=upload.pk).delete()
        return result

    monkeypatch.setattr(drafts, "gate", racing)
    path = f"/f/test/uploads/{upload.pk}/" + ("status/" if method == "get" else "")
    headers = {"X-Draft-Token": prepared["data"]["token"]}
    assert getattr(prepared["client"], method)(path, headers=headers).status_code == status
