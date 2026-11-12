import hashlib
import hmac
import io
import itertools
import json

import httpx
import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.utils import timezone

from portal.jobs import run_one
from portal.models import (
    Claim,
    ClaimReferenceCounter,
    DeliveryAttempt,
    Draft,
    Form,
    FormTemplate,
    Operation,
    Upload,
)
from portal.services import outbound, setup_check
from portal.services.storage import write_heartbeat
from tests.test_delivery import mock_provider
from tests.test_scanner import FakeClamAV

pytestmark = pytest.mark.django_db


class Worker:
    """Each wait of the check runs the worker's next job and counts as one second."""

    def __init__(self, monkeypatch):
        self.now, self.after_job = 0, lambda: None
        monkeypatch.setattr(setup_check, "clock", lambda: self.now)
        monkeypatch.setattr(setup_check, "pause", self.pause)
        write_heartbeat()

    def pause(self):
        run_one()
        self.after_job()
        self.now += 1


@pytest.fixture
def worker(monkeypatch, privacy_notice):
    return Worker(monkeypatch)


@pytest.fixture
def sent(monkeypatch):
    messages, send = [], outbound.send
    monkeypatch.setattr(outbound, "send", lambda message: messages.append(message) or send(message))
    return messages


def verify(**options):
    output = io.StringIO()
    try:
        call_command("verify_setup", stdout=output, **options)
    except CommandError as exc:
        return output.getvalue(), str(exc)
    return output.getvalue(), None


def nothing_left():
    return not (
        Claim.objects.exists()
        or Draft.objects.exists()
        or Upload.objects.exists()
        or Form.objects.filter(slug__startswith="setup-check-").exists()
        or FormTemplate.objects.filter(name__startswith="Setup check").exists()
    )


def test_a_synthetic_claim_passes_every_step_and_is_deleted(worker, sent, settings):
    output, error = verify(to="finance@example.invalid", confirmation_to="kim@example.invalid")
    assert error is None, output
    for step in [
        "ok    Receipt and signature checked and normalized",
        "submitted, without a bookkeeping number",
        "ok    PDF created (",
        "ok    Finance email to finance@example.invalid kept in the local outbox",
        "ok    Participant confirmation to kim@example.invalid kept in the local outbox",
        "ok    Test claim, form and template deleted",
    ]:
        assert step in output
    finance, confirmation = sorted(sent, key=lambda message: message.attachment is None)
    assert finance.recipient == "finance@example.invalid"
    assert setup_check.FORM_NAME in finance.subject and "Erst/" not in finance.subject
    assert finance.attachment.startswith(b"%PDF")
    assert (confirmation.recipient, confirmation.attachment) == ("kim@example.invalid", None)
    assert nothing_left()
    # Finance's numbering continues without a gap.
    assert not ClaimReferenceCounter.objects.filter(value__gt=0).exists()
    assert Operation.objects.get().actor == "verify_setup"
    assert not any((settings.PRIVATE_STORAGE_ROOT / "outbox").glob("*"))


@pytest.mark.parametrize(
    ("options", "allowlist", "message"),
    [
        ({"to": "someone@example.invalid"}, [], "APPROVED_DELIVERY_RECIPIENTS"),
        (
            {"to": "finance@example.invalid", "confirmation_to": "kim@example.invalid"},
            ["finance@example.invalid"],
            "TEST_RECIPIENT_ALLOWLIST does not include kim@example.invalid",
        ),
        ({"to": "not an address"}, [], "is not an email address"),
    ],
)
def test_recipients_are_checked_before_anything_is_created(
    worker, settings, options, allowlist, message
):
    settings.TEST_RECIPIENT_ALLOWLIST = allowlist
    output, error = verify(**options)
    assert message in error and output == ""
    assert nothing_left()


def test_without_a_running_worker_no_claim_is_submitted(privacy_notice, settings, monkeypatch):
    monkeypatch.setattr(setup_check, "sandbox_ready", lambda: True)
    output, error = verify(to="finance@example.invalid")
    assert error == "Setup check failed: 1 problem."
    assert "FAIL  Worker\n        No recent heartbeat." in output
    assert "skip  Test claim" in output
    assert nothing_left()


def signed_webhook(client, settings, attempt, kind):
    body = json.dumps(
        {
            "type": f"activity.{kind}",
            "created_at": timezone.now().isoformat(),
            "data": {
                "id": f"event-{attempt.pk}-{kind}",
                "message_id": attempt.message_id,
                "recipient": attempt.delivery.recipient,
                "tags": [],
            },
        }
    ).encode()
    secret = settings.MAILERSEND_WEBHOOK_SIGNING_SECRET.encode()
    response = client.post(
        "/webhooks/mailersend/",
        data=body,
        content_type="application/json",
        headers={"Signature": hmac.new(secret, body, hashlib.sha256).hexdigest()},
    )
    assert response.status_code == 200


@pytest.fixture
def mailersend(settings, monkeypatch):
    settings.MAIL_DELIVERY_MODE = "mailersend"
    settings.MAILERSEND_WEBHOOK_SIGNING_SECRET = "synthetic-test-secret"
    settings.CSRF_TRUSTED_ORIGINS = ["https://reimbursements.example.invalid"]
    numbers = itertools.count(1)
    mock_provider(
        monkeypatch,
        lambda request: httpx.Response(202, headers={"x-message-id": f"message-{next(numbers)}"}),
    )


def test_with_mailersend_the_signed_webhook_must_arrive(worker, mailersend, client, settings):
    def deliver():
        for attempt in DeliveryAttempt.objects.filter(state="provider_accepted"):
            signed_webhook(client, settings, attempt, "delivered")

    worker.after_job = deliver
    output, error = verify(to="finance@example.invalid")
    assert error is None, output
    for step in [
        "ok    MailerSend accepted the Finance email to finance@example.invalid",
        "ok    MailerSend webhook received, signature verified",
        "ok    Finance inbox received the email",
        "ok    Participant confirmation to finance@example.invalid accepted by MailerSend",
    ]:
        assert step in output
    assert nothing_left()


def test_a_missing_webhook_names_the_url_to_configure(worker, mailersend):
    output, error = verify(to="finance@example.invalid", timeout=30)
    assert error == "Setup check failed: 1 problem."
    assert "FAIL  MailerSend webhook\n        No signed delivery event within 30 s." in output
    assert "https://reimbursements.example.invalid/webhooks/mailersend/" in output
    assert "ok    Test claim, form and template deleted" in output
    assert nothing_left()


def test_a_bounce_reported_by_webhook_fails_the_check(worker, mailersend, client, settings):
    sent = set()

    def bounce():
        for attempt in DeliveryAttempt.objects.filter(state="provider_accepted"):
            signed_webhook(
                client, settings, attempt, "hard_bounced" if attempt.pk in sent else "sent"
            )
            sent.add(attempt.pk)

    worker.after_job = bounce
    output, error = verify(to="finance@example.invalid")
    assert error == "Setup check failed: 1 problem."
    assert "FAIL  Finance inbox\n        MailerSend reports provider_hard_bounced." in output
    assert nothing_left()


def results(method):
    reports = []
    check = setup_check.SetupCheck(
        finance="finance@example.invalid",
        participant="finance@example.invalid",
        timeout=10,
        report=lambda *report: reports.append(report),
    )
    getattr(check, method)()
    return reports


@pytest.mark.parametrize(
    ("reply", "status"),
    [(b"stream: Win.Test.EICAR_HDB-1 FOUND\0", "ok"), (b"stream: OK\0", "FAIL")],
)
def test_the_scanner_must_detect_the_eicar_test_file(settings, monkeypatch, reply, status):
    clamd = FakeClamAV(reply)
    settings.UPLOAD_SCANNER, settings.CLAMAV_HOST = "clamav", "127.0.0.1"
    settings.CLAMAV_PORT = clamd.port
    monkeypatch.setattr(setup_check, "scanner_ready", lambda: True)
    [(reported, _title, _detail)] = results("scanner")
    clamd.close()
    assert reported == status
    assert setup_check.EICAR in clamd.received
    assert not any((settings.PRIVATE_STORAGE_ROOT / "checks").iterdir())


@pytest.fixture
def realm(settings, monkeypatch):
    settings.OIDC_ENABLED = True
    discovery = {
        "issuer": settings.KEYCLOAK_REALM_URL,
        "authorization_endpoint": settings.OIDC_OP_AUTHORIZATION_ENDPOINT,
        "token_endpoint": settings.OIDC_OP_TOKEN_ENDPOINT,
        "userinfo_endpoint": settings.OIDC_OP_USER_ENDPOINT,
        "jwks_uri": settings.OIDC_OP_JWKS_ENDPOINT,
        "end_session_endpoint": settings.OIDC_OP_LOGOUT_ENDPOINT,
    }
    answers = {"discovery": discovery, "keys": [{"kty": "RSA", "use": "sig", "alg": "RS256"}]}
    configuration = f"{settings.KEYCLOAK_REALM_URL}/.well-known/openid-configuration"

    def keycloak(request):
        if str(request.url) == configuration:
            return httpx.Response(200, json=answers["discovery"])
        if str(request.url) == settings.OIDC_OP_JWKS_ENDPOINT:
            return httpx.Response(200, json={"keys": answers["keys"]})
        return httpx.Response(404)

    monkeypatch.setattr(
        setup_check, "oidc_client", lambda: httpx.Client(transport=httpx.MockTransport(keycloak))
    )
    return answers


def test_the_keycloak_realm_must_match_the_configured_urls(realm, settings):
    [(status, title, _detail)] = results("keycloak")
    assert (status, title) == ("ok", f"Keycloak realm {settings.KEYCLOAK_REALM_URL}")
    realm["discovery"] = {
        **realm["discovery"],
        "issuer": "http://auth.example.invalid/realms/reimbursements",
    }
    [(status, _title, detail)] = results("keycloak")
    assert status == "FAIL" and "different issuer" in detail
    assert "'http://auth.example.invalid/realms/reimbursements'" in detail


def test_the_keycloak_realm_needs_a_signing_key_and_an_answer(realm, settings):
    realm["keys"] = [{"kty": "oct", "use": "sig"}]
    [(status, _title, detail)] = results("keycloak")
    assert status == "FAIL" and "no RSA key" in detail
    settings.KEYCLOAK_REALM_URL = "https://auth.example.invalid/realms/missing"
    [(status, _title, detail)] = results("keycloak")
    assert status == "FAIL" and "gave no OpenID configuration" in detail


def test_keycloak_is_skipped_without_sign_in_settings(settings):
    settings.OIDC_ENABLED = False
    assert results("keycloak")[0][0] == "skip"
