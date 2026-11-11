import json
import uuid
from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError

from portal import roles
from portal.intake import MAX_CLAIM_TOTAL
from portal.models import Claim, Draft, Form, FormTemplate, PrivacyNotice, TemplateField

pytestmark = pytest.mark.django_db


def post(prepared, data=None):
    return prepared["client"].post(
        "/f/test/submit/",
        data=json.dumps(data or prepared["data"]),
        content_type="application/json",
    )


def reopened(prepared):
    """The participant reloads after a configuration change and works on the new revision."""
    revision = Form.objects.get(pk=prepared["form"].pk).revision()
    Draft.objects.filter(pk=prepared["draft"].pk).update(revision=revision)
    prepared["data"]["revision"] = revision


def rejected(prepared, field):
    response = post(prepared)
    assert response.status_code == 400, response.content
    assert field in response.json()["fields"]
    assert not Claim.objects.exists()


def test_landing_page_does_not_list_forms(client, form):
    response = client.get("/")
    assert response.status_code == 200
    assert form.name.encode() not in response.content
    assert client.get("/forms/test/").status_code == 404


def test_landing_page_redirects_to_the_open_primary_form(client, form, template):
    form.primary = True
    form.save()
    assert client.get("/").headers["Location"] == "/f/test/"
    form.status = Form.Status.DRAFT
    form.save()
    assert client.get("/").status_code == 200
    other = Form.objects.create(
        template=template,
        slug="allgemein",
        name="Allgemein",
        field_values=form.field_values,
        recipient=form.recipient,
        support_email=form.support_email,
        status=Form.Status.PUBLISHED,
        primary=True,
    )
    form.refresh_from_db()
    assert not form.primary
    assert client.get("/").headers["Location"] == f"/f/{other.slug}/"


def test_footer_uses_operator_configuration(client, settings):
    assert b"Impressum" not in client.get("/").content
    settings.PORTAL_OPERATOR = "Beispielverein"
    settings.PORTAL_LEGAL_URL = "https://example.invalid/legal/"
    page = client.get("/").content.decode()
    assert "Meldgrove Reimbursement" in page and "Beispielverein" in page
    assert 'href="https://example.invalid/legal/"' in page


def test_submitted_form_link_starts_a_new_claim(client, accepted):
    first = Draft.objects.get()
    response = client.get("/f/test/")
    assert response.status_code == 200
    assert Draft.objects.exclude(pk=first.pk).filter(claim__isnull=True).count() == 1


def test_draft_form_is_closed_but_owners_can_preview(client, form):
    form.status = Form.Status.DRAFT
    form.save()
    assert client.get("/f/test/").status_code == 403
    user = get_user_model().objects.create_user("editor-subject", email="editor@example.invalid")
    roles.assign(user, {roles.FORM_EDITOR})
    client.force_login(user, backend="django.contrib.auth.backends.ModelBackend")
    assert client.get("/f/test/").status_code == 403
    form.owners.add(user)
    response = client.get("/f/test/")
    assert response.status_code == 200 and b"Vorschau" in response.content
    assert not Draft.objects.exists()


def test_form_shows_private_person_note_and_privacy_notice(client, form):
    page = client.get("/f/test/").content.decode()
    assert "Nur für Privatpersonen." in page and "Rechnung" in page
    assert "Synthetic privacy notice for tests." in page or "Datenschutzhinweis" in page
    assert "Zielort" in page and "Ort der Reise" not in page
    assert "Währung" not in page
    privacy = client.get("/datenschutz/").content.decode()
    assert PrivacyNotice.current().text.splitlines()[0].lstrip("# ") in privacy


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("full_name", "Alex Beispiel 2"),
        ("account_holder", "<script>"),
        ("postal_code", "1234"),
        ("country", "XX"),
        ("street", ""),
        ("bic", "NOTABIC"),
    ],
)
def test_participant_fields_are_validated(prepared, field, value):
    prepared["data"][field] = value
    rejected(prepared, field)


def test_names_in_any_script_and_joint_accounts_are_accepted(prepared):
    prepared["data"]["full_name"] = "Zoë O’Neil-Łukasiewicz"
    prepared["data"]["account_holder"] = "Zoë O’Neil & Jan Nowak"
    prepared["data"]["country"], prepared["data"]["postal_code"] = "GB", "SW1A 1AA"
    assert post(prepared).status_code == 202
    claim = Claim.objects.get()
    assert claim.account_holder == "Zoë O’Neil & Jan Nowak"
    assert claim.postal_address.endswith("Vereinigtes Königreich")


def test_iban_outside_sepa_requires_a_bic(prepared):
    prepared["data"]["iban"] = "BR1800360305000010009795493C1"
    rejected(prepared, "bic")
    prepared["data"]["bic"] = "BOFA US 3N"
    assert post(prepared).status_code == 202
    assert Claim.objects.get().bic == "BOFAUS3N"


def test_foreign_sepa_iban_needs_no_bic(prepared):
    prepared["data"]["iban"] = "CH93 0076 2011 6238 5295 7"
    assert post(prepared).status_code == 202


def test_reference_is_optional_and_amounts_are_euros(prepared):
    row = prepared["data"]["expenses"][0]
    row["receipt_reference"], row["currency"] = "", "USD"
    assert post(prepared).status_code == 202
    claim = Claim.objects.get()
    assert claim.expenses.get().receipt_reference == ""
    assert claim.total == Decimal("12.50")


def test_purpose_options_restrict_the_choice_and_keep_details(prepared):
    form = prepared["form"]
    form.purpose_options = "Teilnahme an der Werkstatt\nMitwirkung als Referent:in"
    form.save()
    reopened(prepared)
    rejected(prepared, "purpose")
    prepared["data"]["purpose"] = "Mitwirkung als Referent:in"
    prepared["data"]["purpose_details"] = "Workshop zu Engagement"
    assert post(prepared).status_code == 202
    claim = Claim.objects.get()
    assert (claim.purpose, claim.purpose_details) == (
        "Mitwirkung als Referent:in",
        "Workshop zu Engagement",
    )


def test_optional_travel_details_are_dropped_when_not_a_trip(prepared):
    prepared["data"].update(is_trip=False, trip_destination="Ignored", trip_end="")
    assert post(prepared).status_code == 202
    claim = Claim.objects.get()
    assert claim.trip_destination == "" and claim.trip_start is None


@pytest.mark.parametrize("missing", ["trip_destination", "trip_start"])
def test_trip_needs_destination_and_dates(prepared, missing):
    prepared["data"][missing] = ""
    response = post(prepared)
    assert response.status_code == 400
    assert not Claim.objects.exists()


def test_required_travel_ignores_the_participant_choice(prepared):
    FormTemplate.objects.filter(pk=prepared["form"].template_id).update(travel="required")
    reopened(prepared)
    prepared["data"].update(is_trip=False, trip_destination="")
    rejected(prepared, "trip_destination")


def mileage_row(**changes):
    return {
        "id": str(uuid.uuid4()),
        "kind": "mileage",
        "travel_date": "2026-10-20",
        "return_date": "2026-10-21",
        "vehicle_registration": "B-AB 123",
        "route_from": "Hamburg",
        "route_to": "Berlin",
        "distance_km": "289",
        "round_trip": True,
        "purpose": "Fahrt zur Werkstatt",
        "uploads": [],
        **changes,
    }


def test_mileage_is_calculated_on_the_server_without_receipts(prepared):
    prepared["data"]["expenses"].append(mileage_row(amount="9999"))
    assert post(prepared).status_code == 202
    claim = Claim.objects.get()
    mileage = claim.expenses.get(kind="mileage")
    assert (mileage.billed_km, mileage.mileage_rate, mileage.amount) == (
        578,
        Decimal("0.30"),
        Decimal("173.40"),
    )
    assert claim.total == Decimal("185.90")
    assert claim.snapshot["mileage_rate"] == "0.30"


def test_mileage_uses_its_own_travel_details_without_duplicate_claim_fields(prepared):
    prepared["data"]["expenses"].append(mileage_row())
    prepared["data"].update(is_trip=False, trip_destination="", trip_start="", trip_end="")
    assert post(prepared).status_code == 202
    claim = Claim.objects.get()
    assert claim.trip_destination == "" and claim.trip_start is None
    assert claim.expenses.get(kind="mileage").return_date.isoformat() == "2026-10-21"


@pytest.mark.parametrize(
    "changes",
    [
        {"distance_km": "0"},
        {"distance_km": "12.5"},
        {"travel_date": ""},
        {"route_to": ""},
        {"return_date": ""},
        {"return_date": "2026-10-19"},
        {"return_date": "2026-99-99"},
        {"vehicle_registration": ""},
        {"vehicle_registration": "X" * 21},
        {"vehicle_registration": "ß" * 20},
    ],
)
def test_invalid_mileage_rows_are_rejected(prepared, changes):
    prepared["data"]["expenses"].append(mileage_row(**changes))
    assert post(prepared).status_code == 400
    assert not Claim.objects.exists()


def test_mileage_needs_a_template_that_allows_it(prepared):
    FormTemplate.objects.filter(pk=prepared["form"].template_id).update(mileage_enabled=False)
    reopened(prepared)
    prepared["data"]["expenses"].append(mileage_row())
    assert post(prepared).status_code == 400


def test_edits_that_change_nothing_a_participant_agreed_to_keep_drafts_open(prepared):
    form, template = prepared["form"], prepared["form"].template
    form.instructions, form.name, form.support_email = "Neu", "Umbenannt", "neu@example.invalid"
    form.field_values["kst"] = "4321"
    form.save()
    template.intro, template.description = "Neue Hinweise", "Intern"
    template.save()
    TemplateField.objects.create(template=template, key="id", label="ID", required=False)
    assert post(prepared).status_code == 202
    assert ["Kostenstelle (KST)", "4321"] in Claim.objects.get().snapshot["internal_values"]


@pytest.mark.parametrize(
    "change",
    [
        lambda form: setattr(form.template, "declaration", "Neue Erklärung."),
        lambda form: setattr(form.template, "declaration_version", "2"),
        lambda form: setattr(form.template, "travel", FormTemplate.Travel.REQUIRED),
        lambda form: setattr(form.template, "mileage_rate", Decimal("0.35")),
        lambda form: setattr(form.template, "mileage_enabled", False),
        lambda form: setattr(form, "purpose_options", "Teilnahme"),
    ],
)
def test_changes_a_participant_agreed_to_make_open_drafts_reload(prepared, change):
    form = prepared["form"]
    change(form)
    form.template.save()
    form.save()
    response = post(prepared)
    assert response.status_code == 409 and "aktualisiert" in response.json()["error"]
    assert not Claim.objects.exists()


def test_a_new_privacy_notice_makes_open_drafts_reload(prepared):
    PrivacyNotice.objects.create(text="Neue Fassung.")
    assert post(prepared).status_code == 409


def test_privacy_notices_are_versions_not_edits(privacy_notice):
    newer = PrivacyNotice.objects.create(text="Neue Fassung.")
    assert newer.version == privacy_notice.version + 1
    assert PrivacyNotice.current() == newer
    newer.text = "Geändert"
    with pytest.raises(ValidationError):
        newer.save()


def test_template_fields_validate_internal_values(template):
    field = TemplateField(template=template, key="kst2", label="KST", pattern=r"\d{4}")
    field.full_clean()
    assert field.validate(" 1234 ") == "1234"
    with pytest.raises(ValidationError):
        field.validate("12345")
    with pytest.raises(ValidationError):
        field.validate("")
    choice = TemplateField(template=template, key="art", label="Art", kind="choice", choices="A\nB")
    assert choice.validate("B") == "B"
    with pytest.raises(ValidationError):
        choice.validate("C")
    with pytest.raises(ValidationError):
        TemplateField(template=template, key="bad", label="Bad", pattern="(").full_clean()


def test_form_closes_when_its_template_gains_a_required_value(prepared):
    form = prepared["form"]
    TemplateField.objects.create(template=form.template, key="id", label="ID")
    form.refresh_from_db()
    assert form.internal_value_errors() == ["ID"] and not form.is_open()
    assert post(prepared).status_code == 409
    assert prepared["client"].get("/f/test/").status_code == 403
    form.field_values["id"] = "WS-1"
    form.save()
    assert form.is_open()
    assert ("ID", "WS-1") in form.internal_values()


def test_claim_total_cannot_exceed_the_stored_precision(prepared, monkeypatch):
    assert MAX_CLAIM_TOTAL == Decimal("9999999999.99")
    monkeypatch.setattr("portal.services.claim_validation.MAX_CLAIM_TOTAL", Decimal("10"))
    response = post(prepared)
    assert response.status_code == 400
    assert "Summe" in response.json()["error"]
    assert not Claim.objects.exists()
