import io
import json
import os
import subprocess
import sys

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import override_settings
from django.utils import timezone

from portal.models import Claim, Delivery, DeliveryAttempt, DeliveryEvent, Job
from portal.services.drafts import digest
from portal.services.evidence import reconcile_unmatched

pytestmark = pytest.mark.django_db


@pytest.mark.parametrize(
    "mode,debug,accepted",
    [
        ("production", None, False),
        ("production", "1", False),
        ("staging", "1", False),
        ("development", "1", True),
    ],
)
def test_production_cannot_silently_use_development_defaults(tmp_path, mode, debug, accepted):
    environment = {
        "PATH": os.defpath,
        "PRIVATE_STORAGE_ROOT": str(tmp_path / "private"),
        "DEPLOYMENT_ENV": mode,
    }
    if debug is not None:
        environment["DJANGO_DEBUG"] = debug
    result = subprocess.run(
        [sys.executable, "-c", "import config.settings"],
        env=environment,
        capture_output=True,
        text=True,
    )
    assert (result.returncode == 0) is accepted


@pytest.mark.parametrize(
    "override",
    [
        {"DATABASE_URL": "sqlite:///:memory:"},
        {"UPLOAD_SCANNER": "disabled"},
        {"DOCUMENT_SANDBOX_ENABLED": "0"},
        {"MAIL_DELIVERY_MODE": "local"},
        {"REQUIRE_WORKER_HEARTBEAT": "0"},
        {"DJANGO_SECRET_KEY": "development-secret"},
        {"KEYCLOAK_BASE_URL": ""},
        {"KEYCLOAK_REALM": ""},
        {"MAIL_FROM_ADDRESS": ""},
        {"MAIL_REPLY_TO_ADDRESS": ""},
        {},
    ],
)
def test_unsafe_production_settings_refuse_startup(tmp_path, override):
    environment = {
        "PATH": os.defpath,
        "PRIVATE_STORAGE_ROOT": str(tmp_path / "private"),
        "DEPLOYMENT_ENV": "production",
        "DJANGO_DEBUG": "0",
        "DJANGO_SECRET_KEY": "synthetic-key-" * 8,
        "DATABASE_URL": "postgresql://test:test@localhost/test",
        "ALLOWED_HOSTS": "test.invalid",
        "MAILERSEND_API_TOKEN": "synthetic",
        "MAILERSEND_WEBHOOK_SIGNING_SECRET": "synthetic",
        "APPROVED_DELIVERY_RECIPIENTS": "test@example.invalid",
        "HEALTHCHECK_TOKEN": "synthetic",
        "OIDC_CLIENT_ID": "synthetic-client",
        "OIDC_CLIENT_SECRET": "synthetic-secret",
        "KEYCLOAK_BASE_URL": "https://auth.example.invalid",
        "KEYCLOAK_REALM": "reimbursements",
        "MAIL_FROM_ADDRESS": "no-reply@example.invalid",
        "MAIL_REPLY_TO_ADDRESS": "finance@example.invalid",
        **override,
    }
    result = subprocess.run(
        [sys.executable, "-c", "import config.settings"],
        env=environment,
        capture_output=True,
        text=True,
    )
    assert (result.returncode == 0) is (override == {})


def test_http_500_has_redacted_diagnostics_and_correlation(client, monkeypatch):
    import logging

    from django.urls import path

    from portal.logging import RedactedExceptionFormatter

    def fail(request):
        raise ValueError("SYNTHETIC_PRIVATE_IBAN_AND_RECEIPT")

    globals()["urlpatterns"] = [path("private-url-value/", fail, name="failure_probe")]
    output = io.StringIO()
    logger = logging.getLogger("django.request")
    assert logger.isEnabledFor(logging.ERROR)
    handlers = [
        handler
        for handler in logger.handlers
        if isinstance(handler.formatter, RedactedExceptionFormatter)
    ]
    assert handlers
    for handler in handlers:
        monkeypatch.setattr(handler, "stream", output)
    client.raise_request_exception = False
    with override_settings(ROOT_URLCONF=__name__, DEBUG=False):
        response = client.get(
            "/private-url-value/", headers={"X-Request-ID": "SYNTHETIC_PRIVATE_HEADER"}
        )
    assert response.status_code == 500
    logs = output.getvalue()
    assert "http_failure request=" in logs and "ValueError" in logs
    assert response.headers["X-Request-ID"] in logs
    assert "SYNTHETIC_PRIVATE" not in logs and "private-url-value" not in logs
    assert "failure_probe" in logs


def test_reconciliation_rotates_past_stuck_records(accepted, monkeypatch):
    Job.objects.all().delete()
    delivery = Delivery.objects.create(claim=accepted, recipient="finance@example.invalid")
    attempts = [
        DeliveryAttempt(delivery=delivery, state="provider_accepted", message_id=f"message-{i}")
        for i in range(101)
    ]
    DeliveryAttempt.objects.bulk_create(attempts)
    seen = []

    def retrieve(message_id):
        seen.append(message_id)
        return {
            "emails": [
                {
                    "status": "delivered" if message_id == "message-100" else "queued",
                    "to": delivery.recipient,
                }
            ]
        }

    monkeypatch.setattr("portal.services.mailersend.retrieve_message", retrieve)
    for _ in range(3):
        call_command("reconcile_deliveries", batch_size=50, stdout=io.StringIO())
    assert "message-100" in seen
    attempts[-1].refresh_from_db()
    assert attempts[-1].state == "delivered"
    assert not Job.objects.exists()


def test_reconciliation_failure_is_visible_and_does_not_pin_batch(accepted, monkeypatch):
    Job.objects.all().delete()
    delivery = Delivery.objects.create(claim=accepted, recipient="finance@example.invalid")
    first = DeliveryAttempt.objects.create(delivery=delivery, state="paused", message_id="first")
    second = DeliveryAttempt.objects.create(delivery=delivery, state="paused", message_id="second")
    monkeypatch.setattr("portal.services.mailersend.retrieve_message", lambda value: None)
    output = io.StringIO()
    with pytest.raises(CommandError, match="Provider lookup failed"):
        call_command("reconcile_deliveries", batch_size=1, stdout=output)
    assert json.loads(output.getvalue())["failed"] == 1
    first.refresh_from_db()
    second.refresh_from_db()
    assert first.last_checked_at and second.last_checked_at is None
    with pytest.raises(CommandError):
        call_command("reconcile_deliveries", batch_size=1, stdout=io.StringIO())
    second.refresh_from_db()
    assert second.last_checked_at


def test_unmatched_event_batches_do_not_starve_later_matches(accepted):
    delivery = Delivery.objects.create(claim=accepted, recipient="finance@example.invalid")
    DeliveryAttempt.objects.create(delivery=delivery, state="provider_accepted", message_id="known")
    DeliveryEvent.objects.bulk_create(
        [
            DeliveryEvent(
                provider_id=f"unknown-{i}",
                message_id=f"unknown-{i}",
                kind="activity.delivered",
                recipient_hash=digest(delivery.recipient),
                provider_timestamp=timezone.now(),
            )
            for i in range(100)
        ]
    )
    known = DeliveryEvent.objects.create(
        provider_id="known-event",
        message_id="known",
        kind="activity.delivered",
        recipient_hash=digest(delivery.recipient),
        provider_timestamp=timezone.now(),
    )
    reconcile_unmatched()
    reconcile_unmatched()
    known.refresh_from_db()
    assert known.applied


def test_claim_status_streams_beyond_100_without_n_plus_one(form, django_assert_num_queries):
    Claim.objects.bulk_create([Claim(form=form, snapshot={}) for _ in range(101)])
    output = io.StringIO()
    with django_assert_num_queries(4):
        call_command("claim_status", stdout=output)
    records = [json.loads(line) for line in output.getvalue().splitlines()]
    assert sum("reference" in row for row in records) == 101
    assert "oldest_job_age_seconds" in records[-1]


def test_readiness_detects_dead_worker_and_old_queue(client, settings):
    settings.REQUIRE_WORKER_HEARTBEAT = True
    assert client.get("/-/readyz").status_code == 503
    heartbeat = settings.PRIVATE_STORAGE_ROOT / "worker-heartbeat"
    heartbeat.write_text("synthetic")
    assert client.get("/-/readyz").status_code == 200
    os.utime(heartbeat, (0, 0))
    response = client.get("/-/readyz")
    assert response.status_code == 503 and not response.json()["checks"]["worker"]


def test_storage_verification_detects_missing_and_corrupted_files(accepted):
    from portal.jobs import run_one
    from portal.services.storage import path_for

    while run_one():
        pass
    accepted.refresh_from_db()
    output = io.StringIO()
    call_command("verify_storage", stdout=output)
    assert json.loads(output.getvalue())["failures"] == 0
    original = accepted.uploads.first()
    path_for(original.source_key).write_bytes(b"corrupted synthetic receipt")
    with pytest.raises(CommandError, match="storage verification failed"):
        call_command("verify_storage", stdout=io.StringIO())
    path_for(accepted.pdf_key).unlink()
    with pytest.raises(CommandError):
        call_command("verify_storage", stdout=io.StringIO())
