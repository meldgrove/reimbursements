"""Review and submission share the same rules without accepting or reserving work."""

from copy import deepcopy
from decimal import Decimal

import pytest

from portal.forms import ClaimForm
from portal.intake import IntakeError
from portal.models import Claim, Job
from portal.services import claim_validation
from tests.test_forms import mileage_row, post
from tests.test_improvements import validate

pytestmark = pytest.mark.django_db


@pytest.mark.parametrize(
    "changes,field",
    [
        ({"return_date": "2026-10-19"}, "return_date"),
        ({"travel_date": "wrong"}, "travel_date"),
        ({"distance_km": "1.5"}, "distance_km"),
        ({"route_to": ""}, "route_to"),
        ({"vehicle_registration": "ß" * 20}, "vehicle_registration"),
        ({"round_trip": "true"}, "round_trip"),
    ],
)
def test_expense_errors_agree_through_both_http_paths(prepared, changes, field):
    row = mileage_row(**changes)
    prepared["data"]["expenses"] = [row]
    reviewed = validate(prepared)
    submitted = post(prepared)
    key = f"expense-{row['id']}-{field}"
    assert reviewed.status_code == 200 and submitted.status_code == 400
    assert reviewed.json()["fields"] == submitted.json()["fields"]
    assert key in reviewed.json()["fields"]
    assert not Claim.objects.exists() and not Job.objects.exists()


def test_checks_collect_fields_from_multiple_rows_even_when_claim_fields_fail(prepared):
    first, second = mileage_row(route_from=""), mileage_row(return_date="")
    result = claim_validation.review(
        {**prepared["data"], "full_name": "", "expenses": [first, second]}, prepared["form"]
    )
    assert set(result.errors) == {
        "full_name",
        f"expense-{first['id']}-route_from",
        f"expense-{second['id']}-return_date",
    }
    assert result.entries is None
    with pytest.raises(IntakeError):
        result.require_valid()


def test_valid_review_returns_exact_values_without_consent_or_signature_or_io(
    prepared, django_assert_num_queries
):
    data = deepcopy(prepared["data"])
    data.update(
        expenses=[mileage_row(distance_km="123", vehicle_registration="b-ab 123", amount="999")]
    )
    for key in ("signature", "declaration", "privacy_acknowledged"):
        data.pop(key)
    original = deepcopy(data)
    with django_assert_num_queries(0):
        reviewed = claim_validation.review(data, prepared["form"])
    entries = reviewed.require_valid()
    assert entries.total == Decimal("73.80") and entries.signature is None
    assert entries.expenses[0]["vehicle_registration"] == "B-AB 123"
    assert entries.claim["trip_destination"] == "" and entries.claim["trip_start"] is None
    assert not entries.claim.keys() & {"declaration", "privacy_acknowledged", "is_trip"}
    assert data == original
    assert set(claim_validation.submission(data, prepared["form"]).errors) == {
        "signature",
        "declaration",
        "privacy_acknowledged",
    }
    assert not Claim.objects.exists() and not Job.objects.exists()


def test_total_and_receipt_association_rules_agree(prepared, monkeypatch):
    monkeypatch.setattr(claim_validation, "MAX_CLAIM_TOTAL", Decimal("10"))
    assert validate(prepared).json()["fields"] == post(prepared).json()["fields"]
    assert "__all__" in validate(prepared).json()["fields"]
    # An unrelated invalid field must not suppress the total check.
    prepared["data"]["expenses"][0]["merchant"] = ""
    assert "__all__" in validate(prepared).json()["fields"]
    prepared["data"]["expenses"][0]["merchant"] = "Belegverkauf"
    monkeypatch.setattr(claim_validation, "MAX_CLAIM_TOTAL", Decimal("100"))
    first = prepared["data"]["expenses"][0]
    second = {**first, "id": mileage_row()["id"]}
    prepared["data"]["expenses"].append(second)
    assert validate(prepared).json()["fields"] == post(prepared).json()["fields"]
    assert f"expense-{second['id']}-__all__" in validate(prepared).json()["fields"]


@pytest.mark.parametrize(
    "rows", [None, {}, [], [None], ["invalid"], [{"id": 1}], [mileage_row(uploads=[None])]]
)
def test_malformed_rows_are_rejections_in_both_paths(prepared, rows):
    prepared["data"]["expenses"] = rows
    assert validate(prepared).json()["fields"] == post(prepared).json()["fields"]
    assert not Claim.objects.exists()


def test_reordered_rows_keep_their_error_identity(prepared):
    row = mileage_row(route_to="")
    prepared["data"]["expenses"].append(row)
    errors = validate(prepared).json()["fields"]
    prepared["data"]["expenses"].reverse()
    assert validate(prepared).json()["fields"] == errors


def test_every_stored_claim_form_field_is_a_claim_column(form):
    columns = {field.name for field in Claim._meta.concrete_fields}
    stored = set(ClaimForm(form=form).fields) - claim_validation.NOT_STORED
    assert stored <= columns, stored - columns
