import socket
from datetime import timedelta

import pytest
from django.utils import timezone

from portal.jobs import BACKOFF, reclaim_stale_jobs, run_one
from portal.models import Claim, Job, Upload

pytestmark = pytest.mark.django_db


def unreachable_scanner(settings):
    settings.UPLOAD_SCANNER, settings.CLAMAV_HOST = "clamav", "127.0.0.1"
    with socket.socket() as unused:
        unused.bind(("127.0.0.1", 0))
        settings.CLAMAV_PORT = unused.getsockname()[1]


def test_scanner_outage_retries_with_backoff_then_fails_and_releases(
    prepared, uploaded_file, settings
):
    unreachable_scanner(settings)
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
    upload = Upload.objects.get(pk=response.json()["id"])
    job = Job.objects.get(upload=upload)
    for attempt, delay in enumerate(BACKOFF, start=1):
        before = timezone.now()
        assert run_one()
        job.refresh_from_db()
        upload.refresh_from_db()
        assert (job.state, job.attempts) == ("pending", attempt)
        assert delay <= (job.run_after - before).total_seconds() <= delay + 16
        assert upload.state == "pending" and upload.reserved_bytes > 0
        Job.objects.filter(pk=job.pk).update(run_after=timezone.now())
    assert run_one()
    job.refresh_from_db()
    upload.refresh_from_db()
    assert (job.state, job.error_code) == ("failed", "scanner_unavailable")
    assert (upload.state, upload.reserved_bytes) == ("failed", 0)


@pytest.mark.parametrize(
    ("attempts", "job_state", "claim_state"),
    [(4, "pending", "received"), (5, "failed", "processing_failed")],
)
def test_interrupted_render_keeps_its_place_until_attempts_run_out(
    accepted, attempts, job_state, claim_state
):
    job = Job.objects.get(kind="render")
    original = job.run_after
    Job.objects.filter(pk=job.pk).update(
        state="running", attempts=attempts, lease_until=timezone.now() - timedelta(seconds=1)
    )
    reclaim_stale_jobs()
    job.refresh_from_db()
    accepted.refresh_from_db()
    assert (job.state, job.error_code, job.run_after) == (job_state, "worker_interrupted", original)
    assert accepted.state == claim_state
    if claim_state == Claim.State.FAILED:
        assert accepted.error_code == "worker_interrupted"
