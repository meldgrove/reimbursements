import copy
import json
import uuid
from datetime import timedelta
from decimal import Decimal

import pytest
from django.test import Client
from django.utils import timezone

from portal.models import Claim, Form, Job, Upload

pytestmark = pytest.mark.django_db


def post(prepared, data=None):
    return prepared["client"].post(
        "/f/test/submit/",
        data=json.dumps(data or prepared["data"]),
        content_type="application/json",
    )


def test_acceptance_snapshots_form_and_uses_exact_decimal_totals(prepared):
    prepared["data"]["total"] = "999999"
    response = post(prepared)
    assert response.status_code == 202
    claim = Claim.objects.get()
    assert claim.total == Decimal("12.50")
    assert claim.iban == "DE89370400440532013000"
    assert claim.account_holder == "Alex Beispiel"
    assert claim.postal_address == "Teststraße 1\n12345 Berlin\nDeutschland"
    assert claim.snapshot["internal_values"] == [
        ["Kostenstelle (KST)", "TEST-KST"],
        ["Kostenträger (KTR)", "TEST-KTR"],
    ]
    assert claim.snapshot["privacy_version"] is not None
    assert claim.snapshot["declaration_version"] == "reimbursement-v1"
    assert claim.expenses.get().merchant == "Belegverkauf"
    assert claim.uploads.count() == 2
    assert Job.objects.filter(kind="render", claim=claim).count() == 1


def test_repeated_post_returns_one_claim_even_after_form_closes(prepared):
    first = post(prepared)
    Form.objects.filter(pk=prepared["form"].pk).update(
        status=Form.Status.DRAFT, purpose_options="Neue Vorgabe"
    )
    second = post(prepared)
    assert first.json() == second.json()
    assert Claim.objects.count() == 1
    changed = copy.deepcopy(prepared["data"])
    changed["full_name"] = "Changed name"
    assert post(prepared, changed).status_code == 409
    assert Claim.objects.get().full_name == "Alex Beispiel"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("iban", "DE89370400440532013001"),
        ("full_name", " "),
        ("purpose", ""),
        ("declaration", False),
        ("privacy_acknowledged", False),
        ("trip_end", "2026-10-19"),
    ],
)
def test_invalid_claim_never_creates_records(prepared, field, value):
    prepared["data"][field] = value
    assert post(prepared).status_code == 400
    assert not Claim.objects.exists()


@pytest.mark.parametrize("amount", [12.5, "1.234", "1,234.56", "NaN", "-1", "0", "1e3"])
def test_ambiguous_or_inexact_amounts_rejected(prepared, amount):
    prepared["data"]["expenses"][0]["amount"] = amount
    assert post(prepared).status_code == 400


def test_cross_session_files_receipt_and_form_token_are_private(prepared):
    other = Client()
    assert (
        other.post(
            "/f/test/submit/",
            data=json.dumps(prepared["data"]),
            content_type="application/json",
        ).status_code
        == 404
    )
    upload_id = prepared["data"]["expenses"][0]["uploads"][0]
    assert other.get(f"/f/test/uploads/{upload_id}/status/").status_code == 404
    response = post(prepared)
    assert other.get(response.json()["receipt_url"]).status_code == 404
    assert prepared["client"].get(response.json()["receipt_url"]).status_code == 200


def test_stale_configuration_requires_review_again(prepared):
    Form.objects.filter(pk=prepared["form"].pk).update(purpose_options="Neue Vorgabe")
    assert post(prepared).status_code == 409
    assert not Claim.objects.exists()


def test_closed_form_rejects_new_submission(prepared):
    Form.objects.filter(pk=prepared["form"].pk).update(
        closes_at=timezone.now() - timedelta(seconds=1)
    )
    assert post(prepared).status_code == 409


def test_receipt_cannot_move_to_another_expense_by_forging_uuid(prepared):
    prepared["data"]["expenses"][0]["id"] = str(uuid.uuid4())
    assert post(prepared).status_code == 400
    assert not Claim.objects.exists()
    assert not Job.objects.filter(kind="render").exists()


def test_pending_missing_or_oversized_receipts_block_acceptance(prepared):
    upload = Upload.objects.get(kind="receipt")
    upload.state = "pending"
    upload.save()
    assert post(prepared).status_code == 400
    upload.state, upload.pages = "ready", 101
    upload.save()
    response = post(prepared)
    assert response.status_code == 413 and "Seiten" in response.json()["error"]


def test_no_anonymous_attachment_or_staff_routes(client, accepted):
    for path in ["/staff/", "/accounts/login/", "/media/receipt.png"]:
        assert client.get(path).status_code == 404
    response = client.get("/admin/portal/claim/")
    assert response.status_code == 302 and response.url.startswith("/admin/login/")


def test_bad_draft_uuid_is_a_client_error(prepared):
    prepared["data"]["draft_id"] = "invalid"
    assert post(prepared).status_code == 404


def test_csrf_is_required_for_upload_and_submission(form):
    client = Client(enforce_csrf_checks=True)
    client.get("/f/test/")
    assert (
        client.post("/f/test/submit/", data="{}", content_type="application/json").status_code
        == 403
    )
