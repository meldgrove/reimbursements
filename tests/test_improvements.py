import json
from datetime import timedelta
from email import policy
from email.parser import BytesParser

import httpx
import pytest
from django.test import Client
from django.utils import timezone

from portal.constants import FORM_DESCRIPTION, FORM_TITLE, PAYMENT_TIMING
from portal.i18n import t
from portal.jobs import reclaim_stale_jobs, run_one
from portal.models import Claim, Confirmation, Job
from portal.services import confirmations, publication
from portal.services.retention import purge_claim
from portal.services.storage import outbox_key, path_for
from tests.test_delivery import mock_provider
from tests.test_forms import mileage_row, post

pytestmark = pytest.mark.django_db


def test_admin_can_save_individual_form_title_and_description(client, form, django_user_model):
    admin = django_user_model.objects.create_superuser("admin", "admin@example.invalid", "test")
    client.force_login(admin, backend="django.contrib.auth.backends.ModelBackend")
    url = f"/admin/portal/form/{form.pk}/change/"
    page = client.get(url).content.decode()
    assert 'name="title"' in page and 'name="description"' in page
    response = client.post(
        url,
        {
            "name": form.name,
            "slug": form.slug,
            "title": "Deine Reisekosten",
            "description": "Für die Werkstatt.\nBitte halte deine Belege bereit.",
            "value_kst": "TEST-KST",
            "recipient": form.recipient,
            "support_email": form.support_email,
            "_save": "Speichern",
        },
    )
    assert response.status_code == 302
    form.refresh_from_db()
    assert form.title == "Deine Reisekosten"
    page = client.get("/f/test/").content.decode()
    assert form.title in page and "Für die Werkstatt.<br>Bitte halte deine Belege bereit." in page


def test_blank_form_copy_uses_existing_defaults_and_does_not_invalidate_drafts(client, form):
    revision = form.revision()
    data = publication.settings_form(form.template, form.status)(
        {
            "name": form.name,
            "slug": form.slug,
            "title": "",
            "description": "",
            "value_kst": "TEST-KST",
            "recipient": form.recipient,
            "support_email": form.support_email,
        },
        instance=form,
    )
    assert data.is_valid(), data.errors
    data.save()
    assert form.revision() == revision
    page = client.get("/f/test/").content.decode()
    assert t(FORM_TITLE) in page and t(FORM_DESCRIPTION) in page
    assert (
        "Eine Rechnung, Quittung oder ein Ticket, aus dem der Betrag, Zweck und Geschäftspartner hervorgehen."
        in page
    )


def validate(prepared, **changes):
    return prepared["client"].post(
        "/f/test/validate/",
        data=json.dumps({**prepared["data"], **changes}),
        content_type="application/json",
        HTTP_X_DRAFT_TOKEN=prepared["data"]["token"],
    )


def test_live_validation_uses_submission_rules_without_creating_claims(prepared):
    response = validate(
        prepared, iban="DE89 3704 0044 0532 0130 01", postal_code="123", full_name="Alex123"
    )
    assert response.status_code == 200
    assert set(response.json()["fields"]) == {"iban", "postal_code", "full_name"}
    assert not Claim.objects.exists() and not Job.objects.exists()
    assert validate(prepared).json() == {"fields": {}}


def test_live_validation_checks_dependencies_and_omits_review_requirements(prepared):
    response = validate(
        prepared,
        country="AT",
        postal_code="1010",
        iban="AE070331234567890123456",
        bic="",
        declaration=False,
        privacy_acknowledged=False,
    )
    assert set(response.json()["fields"]) == {"bic"}
    assert "SEPA" in response.json()["fields"]["bic"][0]["message"]
    assert "trip_end" in validate(prepared, trip_end="2026-01-01").json()["fields"]
    assert validate(prepared, trip_end="", expenses=[mileage_row()]).json() == {"fields": {}}
    # A browser-supplied flag cannot disable travel rules for receipt-only claims.
    assert "trip_end" in validate(prepared, trip_end="", has_mileage=True).json()["fields"]


def test_live_validation_requires_the_owning_session_token_and_current_draft(prepared):
    assert validate(prepared, draft_id="missing").status_code == 404
    response = Client().post(
        "/f/test/validate/",
        data=json.dumps(prepared["data"]),
        content_type="application/json",
        HTTP_X_DRAFT_TOKEN=prepared["data"]["token"],
    )
    assert response.status_code == 404
    form = prepared["form"]
    form.purpose_options = "Changed purpose"
    form.save()
    assert validate(prepared).status_code == 409


def test_live_validation_refuses_submitted_drafts(accepted, prepared):
    assert validate(prepared).status_code == 409


def confirmation_job(accepted):
    # Exercise receipt sending independently of PDF processing.
    Job.objects.exclude(kind="confirm").update(state="done")
    return Job.objects.get(kind="confirm", claim=accepted)


def test_receipt_is_sent_once_with_reference_and_no_sensitive_attachments(accepted, prepared):
    confirmation_job(accepted)
    assert post(prepared).status_code == 202
    assert Confirmation.objects.count() == Job.objects.filter(kind="confirm").count() == 1
    assert run_one() and not run_one()
    confirmation = Confirmation.objects.get(claim=accepted)
    assert confirmation.state == "delivered"
    message = BytesParser(policy=policy.default).parsebytes(
        path_for(outbox_key(confirmation.pk)).read_bytes()
    )
    assert message["To"] == accepted.email
    assert message["Reply-To"] == accepted.snapshot["support_email"]
    text = message.get_content()
    assert accepted.reference in message["Subject"] and accepted.reference in text
    assert accepted.snapshot["name"] in text and t(PAYMENT_TIMING) in text
    assert not list(message.iter_attachments()) and accepted.iban not in text
    confirmations.schedule(accepted)
    assert not run_one()
    accepted.refresh_from_db()
    assert accepted.state == Claim.State.RECEIVED and not hasattr(accepted, "delivery")


def test_confirmation_uses_mailersend_and_preserves_finance_recipient_restrictions(
    accepted, settings, monkeypatch
):
    settings.MAIL_DELIVERY_MODE = "mailersend"
    confirmation_job(accepted)
    calls = []

    def provider(request):
        payload = json.loads(request.content)
        calls.append(payload)
        assert payload["to"] == [{"email": accepted.email}]
        assert payload["from"]["email"] == settings.MAIL_FROM_ADDRESS
        assert payload["reply_to"]["email"] == accepted.snapshot["support_email"]
        assert accepted.reference in payload["text"]
        assert "attachments" not in payload
        assert not any(payload["settings"].values())
        return httpx.Response(202, headers={"x-message-id": "receipt-1"})

    mock_provider(monkeypatch, provider)
    assert run_one() and not run_one()
    confirmation = Confirmation.objects.get(claim=accepted)
    assert (confirmation.state, confirmation.message_id) == ("provider_accepted", "receipt-1")
    assert len(calls) == 1


def test_confirmation_retries_throttling_without_duplicate_emails(accepted, settings, monkeypatch):
    settings.MAIL_DELIVERY_MODE = "mailersend"
    job = confirmation_job(accepted)
    mock_provider(monkeypatch, lambda request: httpx.Response(429, headers={"retry-after": "120"}))
    assert run_one()
    job.refresh_from_db()
    assert job.state == "pending" and Confirmation.objects.get(claim=accepted).state == "pending"
    assert job.run_after >= timezone.now() + timedelta(seconds=119)
    Job.objects.filter(pk=job.pk).update(run_after=timezone.now())
    mock_provider(
        monkeypatch, lambda request: httpx.Response(202, headers={"x-message-id": "receipt-2"})
    )
    assert run_one() and not run_one()
    assert Confirmation.objects.get(claim=accepted).state == "provider_accepted"


def test_unknown_confirmation_outcome_is_not_resent(accepted, settings, monkeypatch):
    settings.MAIL_DELIVERY_MODE = "mailersend"
    confirmation_job(accepted)

    def timeout(request):
        raise httpx.ReadTimeout("synthetic timeout", request=request)

    mock_provider(monkeypatch, timeout)
    assert run_one() and not run_one()
    assert Confirmation.objects.get(claim=accepted).state == "send_unknown"


def test_interrupted_confirmation_is_not_resent(accepted):
    job = confirmation_job(accepted)
    Job.objects.filter(pk=job.pk).update(
        state="running", lease_until=timezone.now() - timedelta(seconds=1)
    )
    Confirmation.objects.filter(claim=accepted).update(state="sending")
    reclaim_stale_jobs()
    assert not run_one()
    assert Confirmation.objects.get(claim=accepted).state == "send_unknown"


def test_confirmation_respects_test_recipient_allowlist(accepted, settings):
    settings.TEST_RECIPIENT_ALLOWLIST = ["finance@example.invalid"]
    confirmation_job(accepted)
    assert run_one()
    assert Confirmation.objects.get(claim=accepted).error_code == "test_recipient_blocked"
    assert not path_for(outbox_key(accepted.confirmation.pk)).exists()


def test_content_purge_removes_confirmation_and_its_local_email(accepted):
    confirmation_job(accepted)
    assert run_one()
    email = path_for(outbox_key(accepted.confirmation.pk))
    assert email.exists()
    purge_claim(accepted.pk)
    assert not email.exists() and not Confirmation.objects.exists()
