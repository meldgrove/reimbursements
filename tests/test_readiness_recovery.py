import subprocess
from datetime import timedelta
from types import SimpleNamespace

import pytest
from django.utils import timezone

from portal.models import Job
from portal.services.documents import SandboxedRunner

pytestmark = pytest.mark.django_db


@pytest.mark.parametrize(
    "state,due_seconds,expected_age,status",
    [
        ("pending", 3600, 0, 200),
        ("pending", -2, 2, 200),
        ("running", -2, 2, 200),
        ("pending", -901, 901, 503),
        ("running", -901, 901, 503),
    ],
)
def test_queue_health_measures_time_since_eligible(
    accepted, client, settings, monkeypatch, state, due_seconds, expected_age, status
):
    now = timezone.now()
    settings.MAX_JOB_AGE_SECONDS = 900
    monkeypatch.setattr("portal.services.readiness.timezone.now", lambda: now)
    Job.objects.update(
        state=state,
        created_at=now - timedelta(days=1),
        run_after=now + timedelta(seconds=due_seconds),
    )
    response = client.get("/-/readyz")
    assert response.status_code == status
    assert response.json()["oldest_job_age_seconds"] == expected_age
    assert response.json()["checks"]["queue"] is (status == 200)


@pytest.mark.parametrize("failure", ["timeout", "os_error", "exit", "invalid_output"])
def test_failed_sandbox_probe_can_recover(tmp_path, monkeypatch, failure):
    calls = []

    def probe(*args, **kwargs):
        calls.append(True)
        if len(calls) == 1:
            if failure == "timeout":
                raise subprocess.TimeoutExpired("probe", 5)
            if failure == "os_error":
                raise OSError("synthetic transient failure")
            return SimpleNamespace(
                returncode=1 if failure == "exit" else 0,
                stdout=b"invalid",
            )
        return SimpleNamespace(returncode=0, stdout=b"sandbox_ok\n")

    monkeypatch.setattr("portal.services.documents.subprocess.run", probe)
    root = str(tmp_path / "work")
    runner = SandboxedRunner()
    assert runner.ready(root) is False
    assert runner.ready(root) is True
    assert runner.ready(root) is True
    assert len(calls) == 2
