"""Regression coverage for the simplified participant intake and bookkeeping reference."""

import io
import re
from datetime import datetime
from email import policy
from email.parser import BytesParser
from zoneinfo import ZoneInfo

import pytest
from django.core.management import call_command
from django.template.loader import render_to_string
from pypdf import PdfReader

from portal.constants import PAYMENT_TIMING
from portal.i18n import t
from portal.jobs import run_one
from portal.models import Claim, ClaimReferenceCounter
from portal.services.capacity import temporary_workspace
from portal.services.documents import build_claim_pdf
from portal.services.references import allocate_reference
from tests.test_forms import mileage_row, post, reopened

pytestmark = pytest.mark.django_db


@pytest.mark.parametrize(
    "purpose_options",
    [
        "Teilnahme an der Werkstatt",
        "\r\n Teilnahme an der Werkstatt \r\n\r\n",
        "Teilnahme an der Werkstatt\nTeilnahme an der Werkstatt",
        " Teilnahme an der Werkstatt \r\n\r\nTeilnahme an der Werkstatt\t",
    ],
    ids=["single", "whitespace", "duplicate", "duplicate-whitespace"],
)
def test_fixed_purpose_is_text_and_cannot_be_overridden(prepared, purpose_options):
    form = prepared["form"]
    form.purpose_options = purpose_options
    form.save()
    reopened(prepared)
    response = prepared["client"].get("/f/test/")
    page = response.content.decode()
    assert response.context["claim_form"].fields["purpose"].widget.is_hidden
    assert response.context["configuration"]["fixed_purpose"] == "Teilnahme an der Werkstatt"
    assert 'type="radio"' not in page
    assert 'name="purpose"' in page
    assert "Anlass/Bezug zum Projekt oder der Veranstaltung" in page
    assert "satzungsmäßiger" not in page
    assert 'data-field="purpose"' not in page
    prepared["data"]["purpose"] = "Manipulated purpose"
    assert post(prepared).status_code == 202
    claim = Claim.objects.get()
    assert claim.purpose == claim.expenses.get().purpose == "Teilnahme an der Werkstatt"


@pytest.mark.parametrize(
    "purpose_options",
    ["Teilnahme\nMitwirkung", "Teilnahme\nMitwirkung\n Teilnahme \nMitwirkung\n"],
    ids=["distinct", "duplicates"],
)
def test_multiple_purposes_remain_selectable(client, form, purpose_options):
    form.purpose_options = purpose_options
    form.save()
    response = client.get("/f/test/")
    page = response.content.decode()
    assert list(response.context["claim_form"].fields["purpose"].choices) == [
        ("Teilnahme", "Teilnahme"),
        ("Mitwirkung", "Mitwirkung"),
    ]
    assert page.count('type="radio"') == 2
    assert 'name="is_trip"' not in page
    assert "Meine Auslagen gehören zu einer Reise" not in page
    assert "Weitere Dateien sind optional" in page


def test_receipt_expenses_inherit_the_entire_claim_purpose(prepared):
    prepared["data"]["purpose"] = "Workshop " * 100
    del prepared["data"]["expenses"][0]["purpose"]
    assert post(prepared).status_code == 202
    claim = Claim.objects.get()
    assert claim.expenses.get().purpose == claim.purpose


@pytest.mark.parametrize("round_trip", [False, True])
def test_mileage_only_needs_no_receipt_or_duplicate_trip_fields(prepared, round_trip):
    prepared["data"].update(
        is_trip=False,
        trip_destination="",
        trip_start="",
        trip_end="",
        expenses=[mileage_row(round_trip=round_trip, vehicle_registration="b-ab 123")],
    )
    if not round_trip:
        prepared["data"]["expenses"][0]["return_date"] = "stale invalid date"
    assert post(prepared).status_code == 202
    claim = Claim.objects.get()
    row = claim.expenses.get()
    assert claim.uploads.count() == 1
    assert row.vehicle_registration == "B-AB 123"
    assert row.purpose == claim.purpose
    assert bool(row.return_date) == round_trip
    assert row.billed_km == 289 * (2 if round_trip else 1)


def test_references_use_berlin_submission_date_and_a_unique_sequence():
    submitted = datetime(2026, 10, 22, 23, 30, tzinfo=ZoneInfo("UTC"))
    first = allocate_reference("werkstatt", "Alex Beispiel", submitted)
    second = allocate_reference("werkstatt", "Alex Beispiel", submitted)
    assert first == "Erst/2026-10-23/werkstatt/beispiel/000001"
    assert second.endswith("/000002")


def test_reference_is_stable_searchable_and_used_on_confirmation(prepared):
    response = post(prepared)
    claim = Claim.objects.get()
    reference = claim.reference
    assert re.fullmatch(r"Erst/\d{4}-\d{2}-\d{2}/test/beispiel/\d{6}", reference)
    assert Claim.objects.for_reference(reference).get() == claim
    assert Claim.objects.for_reference(claim.pk).get() == claim
    form = prepared["form"]
    form.slug, form.name = "renamed", "Renamed"
    form.save()
    claim.refresh_from_db()
    assert claim.reference == reference
    page = prepared["client"].get(response.json()["receipt_url"]).content.decode()
    assert reference in page
    assert t(PAYMENT_TIMING) in page
    assert "Kontaktadresse im Formular" in page
    # The status script's messages aside, the page promises no timing or retention.
    page = re.sub(r'<script id="status-text".*?</script>', "", page, flags=re.S)
    assert "Woche" not in page
    assert "gespeichert" not in page and "gelöscht" not in page
    assert "Finance" not in page
    output = io.StringIO()
    call_command("claim_status", reference, stdout=output)
    assert reference in output.getvalue()


def test_rejected_and_replayed_submissions_do_not_consume_more_numbers(prepared):
    prepared["data"]["expenses"][0]["amount"] = "0"
    assert post(prepared).status_code == 400
    assert not ClaimReferenceCounter.objects.exists()
    prepared["data"]["expenses"][0]["amount"] = "12,50"
    assert post(prepared).status_code == 202
    assert post(prepared).status_code == 202
    assert ClaimReferenceCounter.objects.get().value == 1


def test_historical_claims_keep_their_uuid_reference(accepted):
    accepted.bookkeeping_reference = None
    accepted.save(update_fields=["bookkeeping_reference"])
    assert accepted.reference == str(accepted.pk)
    assert Claim.objects.for_reference(accepted.pk).get() == accepted


def test_mileage_details_and_reference_reach_pdf_and_email(prepared, settings):
    prepared["data"]["expenses"].append(mileage_row())
    assert post(prepared).status_code == 202
    claim = Claim.objects.get()
    html = render_to_string(
        "portal/summary.html",
        {"claim": claim, "expenses": claim.expenses.all(), "signature_uri": ""},
    )
    assert "B-AB 123" in html and "21.10.2026" in html
    with temporary_workspace() as workspace:
        output, _ = build_claim_pdf(claim, workspace)
        text = "".join(page.extract_text() for page in PdfReader(output).pages)
        assert claim.reference in text
        assert "B-AB 123" in text and "21.10.2026" in text
    while run_one():
        pass
    claim.refresh_from_db()
    assert claim.delivery.state == "delivered"
    from portal.services.storage import outbox_key, path_for

    mail = path_for(outbox_key(claim.delivery.attempts.get().id))
    message = BytesParser(policy=policy.default).parsebytes(mail.read_bytes())
    assert claim.reference in message["Subject"]
    attachment = next(message.iter_attachments())
    assert attachment.get_filename() == f"reimbursement_{claim.reference.replace('/', '_')}.pdf"


def test_drafts_opened_before_the_intake_change_must_reload(prepared):
    from importlib import import_module

    from portal.models import Draft, PrivacyNotice

    old_revision = import_module("portal.migrations.0005_form_revision").revision(
        prepared["form"], PrivacyNotice.current()
    )
    Draft.objects.filter(pk=prepared["draft"].pk).update(revision=old_revision)
    response = post(prepared)
    assert response.status_code == 409
    assert "aktualisiert" in response.json()["error"]
    assert not Claim.objects.exists()
    assert prepared["client"].get("/f/test/").status_code == 200
    assert Draft.objects.filter(revision=prepared["form"].revision()).exists()
