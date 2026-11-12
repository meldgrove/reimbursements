import logging
import os
import subprocess
import sys

import httpx
import pytest
import sentry_sdk
from django.test import override_settings
from django.urls import path
from sentry_sdk.transport import Transport

from portal import error_reporting
from portal.services.documents import child_environment

DSN = "https://public@sentry.example.invalid/1"
PRIVATE = "SYNTHETIC_PRIVATE_IBAN_AND_RECEIPT"


class Recorder(Transport):
    """Keeps events in memory instead of sending them."""

    def __init__(self, options=None):
        super().__init__(options)
        self.events = []

    def capture_envelope(self, envelope):
        event = envelope.get_event()
        if event is not None:
            self.events.append(event)


@pytest.fixture
def reports():
    error_reporting.start(DSN, "test")
    client = sentry_sdk.get_client()
    client.transport = Recorder(client.options)
    yield client.transport.events
    client.close()
    scope = sentry_sdk.get_global_scope()
    scope.remove_tag("process")
    scope.set_client(None)


def fail(request, reference):
    raise ValueError(PRIVATE)


urlpatterns = [path("claims/<str:reference>/", fail)]


@pytest.mark.django_db
def test_request_failure_reports_route_and_stack_without_request_data(client, reports):
    client.raise_request_exception = False
    with override_settings(ROOT_URLCONF=__name__, DEBUG=False):
        response = client.get(
            "/claims/SYNTHETIC_PRIVATE_PATH/?iban=SYNTHETIC_PRIVATE_QUERY",
            headers={"X-Request-ID": "SYNTHETIC_PRIVATE_HEADER"},
            cookies={"sessionid": "SYNTHETIC_PRIVATE_COOKIE"},
        )
    assert response.status_code == 500
    [event] = reports
    [exception] = event["exception"]["values"]
    assert exception["type"] == "ValueError"
    assert "value" not in exception
    assert exception["stacktrace"]["frames"][-1]["function"] == "fail"
    assert event["transaction"] == "/claims/{reference}/"
    assert event["tags"]["process"] == "web"
    assert "request" not in event and "user" not in event
    assert "SYNTHETIC_PRIVATE" not in repr(event)


def test_application_log_errors_keep_their_message_and_drop_exception_values(reports):
    try:
        raise OSError(PRIVATE)
    except OSError:
        logging.getLogger("portal.jobs").exception("job_failed job=%s kind=%s", 7, "render")
    [event] = reports
    assert event["logentry"]["formatted"] == "job_failed job=7 kind=render"
    assert event["exception"]["values"][0]["type"] == "OSError"
    assert PRIVATE not in repr(event)


def test_library_log_errors_keep_only_the_message_template(reports):
    logging.getLogger("weasyprint").error("Failed to load %s", PRIVATE)
    [event] = reports
    assert event["logentry"] == {"message": "Failed to load %s"}


def test_client_mistakes_logged_by_django_are_not_reported(reports):
    logging.getLogger("django.security.DisallowedHost").error("Invalid HTTP_HOST: %s", PRIVATE)
    assert reports == []


def test_document_children_get_no_tracing_variables(reports, tmp_path):
    probe = "import os; print(sorted(os.environ))"
    result = subprocess.run(
        [sys.executable, "-c", probe],
        env=child_environment(tmp_path),
        capture_output=True,
        text=True,
        check=True,
    )
    assert "SENTRY" not in result.stdout.upper()


def test_outgoing_requests_get_no_tracing_headers(reports):
    sent = {}

    def respond(request):
        sent.update(request.headers)
        return httpx.Response(204)

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        client.get("https://auth.example.invalid/")
    assert sent and "sentry-trace" not in sent and "baggage" not in sent


@pytest.mark.parametrize(
    "argv,name",
    [
        (["/app/.venv/bin/gunicorn", "config.wsgi"], "web"),
        (["manage.py", "run_jobs"], "run_jobs"),
        (["/app/manage.py", "reconcile_deliveries"], "reconcile_deliveries"),
    ],
)
def test_reports_name_the_process(argv, name):
    assert error_reporting.process_name(argv) == name


@pytest.mark.parametrize(
    "variables,expected",
    [
        ({}, "inactive"),
        # Without SENTRY_RELEASE, the SDK may fall back to the checkout's git commit.
        ({"SENTRY_DSN": DSN}, "development "),
        # Release images name their version.
        ({"SENTRY_DSN": DSN, "APP_VERSION": "1.2.3"}, "development reimbursements@1.2.3"),
        (
            {
                "SENTRY_DSN": DSN,
                "SENTRY_ENVIRONMENT": "staging",
                "SENTRY_RELEASE": "abc123",
                "APP_VERSION": "1.2.3",
            },
            "staging abc123",
        ),
    ],
)
def test_settings_start_error_reporting_only_with_a_dsn(tmp_path, variables, expected):
    environment = {
        "PATH": os.defpath,
        "PRIVATE_STORAGE_ROOT": str(tmp_path / "private"),
        "DJANGO_DEBUG": "1",
        "DEPLOYMENT_ENV": "development",
    } | variables
    probe = (
        "import config.settings, sentry_sdk\n"
        "client = sentry_sdk.get_client()\n"
        "options = client.options if client.is_active() else None\n"
        "print(f\"{options['environment']} {options['release']}\" if options else 'inactive')"
    )
    result = subprocess.run(
        [sys.executable, "-c", probe], env=environment, capture_output=True, text=True
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.startswith(expected)
