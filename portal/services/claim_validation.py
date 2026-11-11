"""Claim and Expense rules shared by live feedback, review and acceptance.

No storage reads or writes. Errors use Claim field names or stable browser Expense
field IDs. Both entry points return all errors; callers decide which ones to show.
"""

import uuid
from dataclasses import dataclass, field
from decimal import Decimal

from django.conf import settings
from django.utils.dateparse import parse_date

from portal.forms import ClaimForm
from portal.intake import (
    EXPENSE_FIELD_LENGTHS,
    MAX_CLAIM_TOTAL,
    IntakeError,
    message,
    mileage_amount,
    parse_amount,
    parse_distance,
)
from portal.models import Expense

CONSENT = frozenset({"declaration", "privacy_acknowledged"})
REQUIRED_MESSAGES = {
    "merchant": "Bitte gib den Geschäftspartner an.",
    "vehicle_registration": "Bitte gib das Kennzeichen des Fahrzeugs an.",
    "route_from": "Bitte gib den Startort der Fahrt an.",
    "route_to": "Bitte gib das Ziel der Fahrt an.",
}


@dataclass
class Validation:
    errors: dict = field(default_factory=dict)
    payload: dict | None = None
    total: Decimal | None = None

    def add(self, key, text):
        self.errors.setdefault(key, []).append({"message": text, "code": "invalid"})

    def require_valid(self):
        if self.errors:
            summary = self.errors.get(
                "__all__", [{"message": "Bitte prüfe die markierten Angaben."}]
            )
            raise IntakeError(summary[0]["message"], errors=self.errors)
        return self.payload, self.total


def _uuid(value):
    return str(uuid.UUID(value))


def _text(value, key, *, required=True):
    if not isinstance(value, str) or len(value.strip()) > EXPENSE_FIELD_LENGTHS[key]:
        raise ValueError("Ungültige Angabe.")
    value = value.strip()
    if required and not value:
        raise ValueError(REQUIRED_MESSAGES[key])
    return value


def _date(value):
    value = parse_date(value or "")
    if value is None:
        raise ValueError
    return value


class _Row:
    def __init__(self, row, key, result):
        self.row, self.key, self.result = row, key, result
        self.valid = True

    def error(self, name, text):
        self.result.add(f"expense-{self.key}-{name}", text)
        self.valid = False

    def read(self, name, parse, error=None):
        try:
            return parse(self.row.get(name, ""))
        except (TypeError, ValueError, AttributeError) as exc:
            self.error(name, error or str(exc) or "Ungültige Angabe.")
            return None

    def text(self, name, *, required=True):
        return self.read(name, lambda value: _text(value, name, required=required))


def _expense(row, template, purpose, key, result):
    fields = _Row(row, key, result)
    kind = row.get("kind", Expense.Kind.RECEIPT)
    item = {"kind": kind, "purpose": purpose}
    if kind == Expense.Kind.RECEIPT:
        item["merchant"] = fields.text("merchant")
        item["receipt_reference"] = fields.text("receipt_reference", required=False)
        item["amount"] = fields.read("amount", parse_amount)
    elif kind == Expense.Kind.MILEAGE and template.mileage_enabled:
        start = fields.read("travel_date", _date, "Bitte gib das Datum der Fahrt an.")
        returning = row.get("round_trip", False)
        if not isinstance(returning, bool):
            fields.error("round_trip", "Ungültige Angabe zu Hin- und Rückfahrt.")
            returning = False
        end = None
        if returning:
            end = fields.read("return_date", _date, "Bitte gib das Rückfahrtdatum an.")
            if start and end and end < start:
                fields.error(
                    "return_date", "Das Rückfahrtdatum darf nicht vor der Hinfahrt liegen."
                )
        distance = fields.read("distance_km", parse_distance)
        registration = fields.text("vehicle_registration")
        if registration is not None:
            registration = registration.upper()
            if len(registration) > EXPENSE_FIELD_LENGTHS["vehicle_registration"]:
                fields.error(
                    "vehicle_registration", "Das Kennzeichen darf höchstens 20 Zeichen haben."
                )
        item.update(
            merchant="",
            receipt_reference="",
            travel_date=start,
            return_date=end,
            vehicle_registration=registration,
            route_from=fields.text("route_from"),
            route_to=fields.text("route_to"),
            distance_km=distance,
            round_trip=returning,
            mileage_rate=template.mileage_rate,
            amount=mileage_amount(distance, returning, template.mileage_rate)
            if distance is not None
            else None,
        )
    else:
        fields.error("__all__", "Diese Art von Position ist für das Formular nicht freigegeben.")
    ids = row.get("uploads")
    minimum = 1 if kind == Expense.Kind.RECEIPT else 0
    if not isinstance(ids, list) or not minimum <= len(ids) <= settings.MAX_FILES_PER_EXPENSE:
        fields.error("__all__", message("files_per_expense" if minimum else "mileage_files"))
        ids = []
    else:
        try:
            ids = [_uuid(value) for value in ids]
        except (ValueError, TypeError, AttributeError):
            fields.error("__all__", "Ungültige Belegdatei.")
            ids = []
    return item, ids, fields.valid


def _check(data, form, *, submitting):
    result = Validation()
    if not isinstance(data, dict):
        result.add("__all__", "Ungültige Anfrage.")
        return result
    expenses = data.get("expenses")
    if not isinstance(expenses, list) or not 1 <= len(expenses) <= settings.MAX_EXPENSES:
        result.add("__all__", message("expense_count"))
        expenses = []
    has_mileage = any(
        isinstance(row, dict) and row.get("kind") == Expense.Kind.MILEAGE for row in expenses
    )
    claim_form = ClaimForm(data, form=form, has_mileage=has_mileage)
    claim_form.is_valid()
    result.errors.update(
        {
            key: value
            for key, value in claim_form.errors.get_json_data().items()
            if submitting or key not in CONSENT
        }
    )
    cleaned, row_ids, upload_ids, total = [], set(), set(), Decimal(0)
    for position, row in enumerate(expenses):
        try:
            row_id = _uuid(row["id"])
            if row_id in row_ids:
                raise ValueError
        except (KeyError, TypeError, ValueError, AttributeError):
            result.add("__all__", f"Position {position + 1}: Ungültige Positionskennung.")
            continue
        row_ids.add(row_id)
        item, ids, valid = _expense(
            row, form.template, claim_form.cleaned_data.get("purpose", ""), row_id, result
        )
        if len(set(ids)) != len(ids) or upload_ids.intersection(ids):
            result.add(
                f"expense-{row_id}-__all__", "Eine Belegdatei darf nur einmal zugeordnet werden."
            )
        upload_ids.update(ids)
        if item.get("amount") is not None:
            total += item["amount"]
        if valid:
            cleaned.append({**item, "id": row_id, "position": position, "uploads": ids})
    if total > MAX_CLAIM_TOTAL:
        result.add("__all__", "Die Summe aller Positionen ist zu hoch. Bitte prüfe die Beträge.")
    payload = dict(claim_form.cleaned_data)
    if not submitting:
        for key in CONSENT:
            payload.pop(key, None)
    else:
        try:
            payload["signature"] = _uuid(data.get("signature"))
        except (ValueError, TypeError, AttributeError):
            result.add("signature", "Bitte zeichne oder lade eine Unterschrift hoch.")
    if not result.errors:
        result.payload, result.total = {**payload, "expenses": cleaned}, total
    return result


def review(data, form):
    """All Claim/Expense errors, or normalized values and exact total. No consent required."""
    return _check(data, form, submitting=False)


def submission(data, form):
    """The same rules plus consent and a Signature ID. Stored Uploads are checked at acceptance."""
    return _check(data, form, submitting=True)
