import hashlib
import hmac
import io
import json
from datetime import timedelta

import httpx
import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.utils import timezone

from portal.jobs import reclaim_stale_jobs, run_one
from portal.models import Claim, Delivery, DeliveryAttempt, DeliveryEvent, Job, Operation
from portal.services import delivery as deliveries
from portal.services import evidence, mailersend, outbound
from portal.services.storage import path_for

pytestmark = pytest.mark.django_db


def ingest_event(data):
    """A verified webhook, as the view hands it on."""
    if provided := mailersend.webhook_evidence(data):
        evidence.record(provided)


def mock_provider(monkeypatch, handler):
    monkeypatch.setattr(
        mailersend,
        "client",
        lambda: httpx.Client(
            transport=httpx.MockTransport(handler), base_url="https://api.mailersend.com/v1/"
        ),
    )


@pytest.mark.parametrize(
    ("response", "state", "code"),
    [
        (httpx.Response(202, headers={"x-message-id": "message-123"}), "provider_accepted", ""),
        (
            httpx.Response(202, headers={"x-message-id": "message-123", "x-send-paused": "true"}),
            "paused",
            "",
        ),
        (
            httpx.Response(202, json={"warnings": [{"type": "ALL_SUPPRESSED"}]}),
            "failed",
            "recipient_suppressed",
        ),
        (httpx.Response(429, headers={"retry-after": "120"}), "pending", "provider_throttled"),
        (
            httpx.Response(422, json={"errors": {"sender": "invalid"}}),
            "failed",
            "provider_rejected",
        ),
        (httpx.Response(500), "send_unknown", "provider_outcome_unknown"),
    ],
)
def test_provider_outcomes(delivery, settings, monkeypatch, response, state, code):
    settings.MAIL_DELIVERY_MODE = "mailersend"
    mock_provider(monkeypatch, lambda request: response)
    attempt = DeliveryAttempt.objects.create(delivery=delivery)
    result = outbound.send(deliveries.compose, attempt)
    assert (result.state, result.error_code) == (state, code)


def test_timeout_after_transmission_is_not_automatically_resent(delivery, settings, monkeypatch):
    settings.MAIL_DELIVERY_MODE = "mailersend"
    calls = []

    def timeout(request):
        calls.append(request)
        payload = json.loads(request.content)
        assert payload["to"] == [{"email": "finance@example.invalid"}]
        assert payload["from"]["email"] == "no-reply@example.invalid"
        assert payload["reply_to"] == {"email": "finance@example.invalid"}
        assert payload["settings"] == {
            "track_opens": False,
            "track_clicks": False,
            "track_content": False,
        }
        raise httpx.ReadTimeout("synthetic timeout", request=request)

    mock_provider(monkeypatch, timeout)
    Job.objects.create(key="send-test", kind="send", delivery=delivery)
    assert run_one()
    assert not run_one()
    delivery.refresh_from_db()
    assert delivery.state == "send_unknown"
    assert len(calls) == 1


def event_payload(
    delivery, *, kind="delivered", provider_id="event-1", message_id="message-1", tags=None
):
    return {
        "type": f"activity.{kind}",
        "created_at": timezone.now().isoformat(),
        "data": {
            "id": provider_id,
            "message_id": message_id,
            "recipient": delivery.recipient,
            "tags": tags or [],
        },
    }


def test_duplicate_and_late_events_do_not_regress_delivery(delivery):
    DeliveryAttempt.objects.create(
        delivery=delivery, state="provider_accepted", message_id="message-1"
    )
    event = event_payload(delivery)
    ingest_event(event)
    ingest_event(event)
    ingest_event(event_payload(delivery, kind="sent", provider_id="event-2"))
    delivery.refresh_from_db()
    assert delivery.state == "delivered"
    assert DeliveryEvent.objects.count() == 2
    ingest_event(event_payload(delivery, kind="hard_bounced", provider_id="event-3"))
    delivery.refresh_from_db()
    delivery.claim.refresh_from_db()
    assert delivery.state == "failed"
    assert delivery.claim.retention_due is None


def test_event_before_send_response_correlates_by_attempt_tag(delivery):
    attempt = DeliveryAttempt.objects.create(delivery=delivery)
    ingest_event(event_payload(delivery, tags=[f"attempt-{attempt.pk}"]))
    attempt.refresh_from_db()
    delivery.refresh_from_db()
    assert attempt.message_id == "message-1"
    assert delivery.state == "delivered"


def test_unknown_message_or_wrong_recipient_does_not_change_claim(delivery):
    DeliveryAttempt.objects.create(
        delivery=delivery, state="provider_accepted", message_id="message-1"
    )
    ingest_event(event_payload(delivery, message_id="other"))
    payload = event_payload(delivery, provider_id="event-2")
    payload["data"]["recipient"] = "other@example.invalid"
    ingest_event(payload)
    delivery.refresh_from_db()
    assert delivery.state == "pending"
    assert DeliveryEvent.objects.filter(applied=False).count() == 2


def test_webhook_signatures_and_setup_ping(client, settings, delivery):
    settings.MAILERSEND_WEBHOOK_SIGNING_SECRET = "synthetic-test-secret"
    DeliveryAttempt.objects.create(
        delivery=delivery, state="provider_accepted", message_id="message-1"
    )
    data = json.dumps(event_payload(delivery)).encode()
    assert (
        client.post("/webhooks/mailersend/", data=data, content_type="application/json").status_code
        == 401
    )
    signature = hmac.new(b"synthetic-test-secret", data, hashlib.sha256).hexdigest()
    assert (
        client.post(
            "/webhooks/mailersend/",
            data=data,
            content_type="application/json",
            headers={"Signature": signature},
        ).status_code
        == 200
    )
    ping = json.dumps({"type": "webhook.test"}).encode()
    signature = hmac.new(mailersend.WEBHOOK_TEST_SECRET.encode(), ping, hashlib.sha256).hexdigest()
    assert (
        client.post(
            "/webhooks/mailersend/",
            data=ping,
            content_type="application/json",
            headers={"Signature": signature},
        ).status_code
        == 200
    )
    assert DeliveryEvent.objects.count() == 1


def test_stale_send_lease_becomes_unknown(delivery):
    DeliveryAttempt.objects.create(delivery=delivery)
    Job.objects.create(
        key="stale-send",
        kind="send",
        delivery=delivery,
        state="running",
        lease_until=timezone.now() - timedelta(seconds=1),
    )
    reclaim_stale_jobs()
    delivery.refresh_from_db()
    assert delivery.state == "send_unknown"
    assert Job.objects.get().state == "failed"
    assert not run_one()


def test_staging_recipient_guard_blocks_even_configured_address(delivery, settings):
    settings.TEST_RECIPIENT_ALLOWLIST = ["test-only@example.invalid"]
    result = outbound.send(deliveries.compose, DeliveryAttempt.objects.create(delivery=delivery))
    assert result.error_code == "test_recipient_blocked"


@pytest.mark.parametrize("initial_state", ["provider_accepted", "paused", "send_unknown"])
@pytest.mark.parametrize(
    ("details", "code"),
    [
        ({}, "provider_rejected"),
        ({"suppression_reason": "blocklisted"}, "provider_suppressed"),
        ({"suppression_reason": "hard_bounced"}, "provider_hard_bounced"),
        ({"activity": [{"type": "suppressed"}]}, "provider_suppressed"),
    ],
)
def test_reconciliation_marks_rejected_messages_failed_without_resending(
    delivery, monkeypatch, initial_state, details, code
):
    attempt = DeliveryAttempt.objects.create(
        delivery=delivery, message_id="rejected-message", state=initial_state
    )
    calls = []

    def provider(request):
        calls.append(request)
        assert request.method == "GET"
        assert request.url.path == "/v1/messages/rejected-message"
        return httpx.Response(
            200,
            json={
                "data": {
                    "emails": [
                        {
                            "id": "rejected-email",
                            "to": delivery.recipient,
                            "status": "rejected",
                            **details,
                        }
                    ]
                }
            },
        )

    mock_provider(monkeypatch, provider)
    call_command("reconcile_deliveries")
    call_command("reconcile_deliveries")
    attempt.refresh_from_db()
    delivery.refresh_from_db()
    delivery.claim.refresh_from_db()
    assert (attempt.state, attempt.error_code) == ("failed", code)
    assert (delivery.state, delivery.error_code) == ("failed", code)
    assert delivery.claim.retention_due is None
    assert path_for(delivery.claim.pdf_key).is_file()
    assert len(calls) == 1
    assert DeliveryEvent.objects.get().applied
    assert DeliveryAttempt.objects.count() == 1
    assert not Job.objects.exists()


def test_rejected_snapshot_cannot_fail_another_recipient(delivery, monkeypatch):
    attempt = DeliveryAttempt.objects.create(
        delivery=delivery, message_id="rejected-message", state="provider_accepted"
    )
    mock_provider(
        monkeypatch,
        lambda request: httpx.Response(
            200, json={"data": {"emails": [{"status": "rejected", "to": "other@example.invalid"}]}}
        ),
    )
    call_command("reconcile_deliveries")
    attempt.refresh_from_db()
    assert attempt.state == "provider_accepted"
    assert not DeliveryEvent.objects.get().applied


def test_failure_before_transmission_is_definite_and_retryable(delivery, settings, monkeypatch):
    settings.MAIL_DELIVERY_MODE = "mailersend"
    calls = []
    mock_provider(monkeypatch, lambda request: calls.append(request))
    path_for(delivery.claim.pdf_key).unlink()
    Job.objects.create(key="send-test", kind="send", delivery=delivery)
    assert run_one()
    delivery.refresh_from_db()
    attempt = delivery.attempts.get()
    assert (attempt.state, attempt.error_code) == ("failed", "attachment_unavailable")
    assert delivery.state == "failed" and not calls
    call_command(
        "retry_claim", delivery.claim.reference, reason="restored PDF", stdout=io.StringIO()
    )
    delivery.refresh_from_db()
    assert delivery.state == "pending"
    assert Job.objects.filter(kind="send", state="pending").count() == 1


@pytest.mark.parametrize(
    ("initial", "expected"), [("send_unknown", "provider_accepted"), ("paused", "paused")]
)
def test_queued_snapshot_resolves_only_an_unknown_outcome(delivery, monkeypatch, initial, expected):
    attempt = DeliveryAttempt.objects.create(
        delivery=delivery, message_id="queued-message", state=initial
    )
    monkeypatch.setattr(
        "portal.services.mailersend.retrieve_message",
        lambda message_id: {"emails": [{"status": "queued", "to": delivery.recipient}]},
    )
    call_command("reconcile_deliveries", stdout=io.StringIO())
    attempt.refresh_from_db()
    assert attempt.state == expected
    assert DeliveryEvent.objects.get().applied


@pytest.mark.parametrize("state", ["send_unknown", "provider_accepted", "delivered"])
def test_operator_resend_requires_duplicate_risk_acknowledgment(delivery, state):
    DeliveryAttempt.objects.create(delivery=delivery, state=state, message_id="message-1")
    deliveries.refresh(delivery)
    reference = delivery.claim.reference
    with pytest.raises(CommandError, match="acknowledge-duplicate-risk"):
        call_command("retry_claim", reference, reason="check", stdout=io.StringIO())
    assert not Job.objects.exists()
    call_command(
        "retry_claim",
        reference,
        reason="provider confirmed no delivery",
        actor="operator",
        acknowledge_duplicate_risk=True,
        stdout=io.StringIO(),
    )
    delivery.refresh_from_db()
    assert delivery.state == "pending"
    assert Operation.objects.get().actor == "operator"
    with pytest.raises(CommandError, match="active job"):
        call_command("retry_claim", reference, reason="again", stdout=io.StringIO())


def test_failed_render_is_requeued_without_duplicate_risk(accepted):
    Job.objects.all().delete()
    accepted.state, accepted.error_code = Claim.State.FAILED, "document_timeout"
    accepted.save()
    call_command("retry_claim", accepted.reference, reason="timeout", stdout=io.StringIO())
    accepted.refresh_from_db()
    assert (accepted.state, accepted.error_code) == (Claim.State.RECEIVED, "")
    assert Job.objects.get().kind == "render"


@pytest.mark.parametrize(
    ("claim_state", "delivery_state", "status", "final"),
    [
        (Claim.State.RENDERING, None, "processing", False),
        (Claim.State.FAILED, None, "problem", True),
        (Claim.State.READY, "send_unknown", "processing", False),
        (Claim.State.READY, "failed", "problem", True),
        (Claim.State.READY, "delivered", "delivered", True),
    ],
)
def test_participant_sees_three_outcomes(prepared, claim_state, delivery_state, status, final):
    client = prepared["client"]
    response = client.post(
        "/f/test/submit/", data=json.dumps(prepared["data"]), content_type="application/json"
    )
    claim = Claim.objects.get()
    Claim.objects.filter(pk=claim.pk).update(state=claim_state)
    if delivery_state:
        Delivery.objects.create(
            claim=claim, recipient="finance@example.invalid", state=delivery_state
        )
    result = client.get(f"{response.json()['receipt_url']}?format=json").json()
    assert (result["state"], result["final"]) == (status, final)


@pytest.mark.parametrize("state", ["pending", "provider_accepted", "send_unknown", "delivered"])
def test_duplicate_risk_is_what_a_retry_refuses_without_acknowledgment(delivery, state):
    Delivery.objects.filter(pk=delivery.pk).update(state=state)
    claim = Claim.objects.select_related("delivery").get(pk=delivery.claim_id)
    assert deliveries.duplicate_risk(claim)
    with pytest.raises(deliveries.DuplicateRisk):
        deliveries.retry(claim)


def test_mailersend_reads_back_the_attempt_tag_it_sends(delivery, settings, monkeypatch):
    settings.MAIL_DELIVERY_MODE = "mailersend"
    sent = []

    def provider(request):
        sent.append(json.loads(request.content))
        return httpx.Response(202, headers={"x-message-id": "message-9"})

    mock_provider(monkeypatch, provider)
    attempt = DeliveryAttempt.objects.create(delivery=delivery)
    outbound.send(deliveries.compose, attempt)
    webhook = {
        "type": "activity.delivered",
        "created_at": "2026-11-11T10:00:00Z",
        "data": {"id": "event-9", "recipient": delivery.recipient, "tags": sent[0]["tags"]},
    }
    provided = mailersend.webhook_evidence(webhook)
    assert (provided.attempt_id, provided.message_id) == (str(attempt.pk), "")
    evidence.record(provided)
    attempt.refresh_from_db()
    assert attempt.state == "delivered"
