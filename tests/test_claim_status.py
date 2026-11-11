import io
import json
from datetime import timedelta

import pytest
from django.core.management import call_command

from portal.models import Claim, Delivery
from portal.services import claim_status

pytestmark = pytest.mark.django_db

# Claim state, delivery state (None: no delivery yet), shown status, participant outcome.
CASES = [
    (Claim.State.RECEIVED, None, "received", "processing"),
    (Claim.State.RENDERING, None, "rendering", "processing"),
    (Claim.State.READY, None, "ready", "processing"),
    (Claim.State.FAILED, None, "processing_failed", "problem"),
    (Claim.State.READY, "pending", "pending", "processing"),
    (Claim.State.READY, "sending", "sending", "processing"),
    (Claim.State.READY, "provider_accepted", "provider_accepted", "processing"),
    (Claim.State.READY, "paused", "paused", "processing"),
    (Claim.State.READY, "send_unknown", "send_unknown", "processing"),
    (Claim.State.READY, "failed", "failed", "problem"),
    (Claim.State.READY, "delivered", "delivered", "delivered"),
    (Claim.State.PURGING, None, "purging", "processing"),
    (Claim.State.PURGING, "delivered", "purging", "processing"),
]


def claim_in(form, claim_state, delivery_state):
    claim = Claim.objects.create(form=form, snapshot={}, state=claim_state)
    if delivery_state:
        Delivery.objects.create(
            claim=claim, recipient="finance@example.invalid", state=delivery_state
        )
    return claim


@pytest.mark.parametrize(("claim_state", "delivery_state", "code", "outcome"), CASES)
def test_one_rule_decides_what_operators_and_participants_see(
    form, claim_state, delivery_state, code, outcome
):
    claim = claim_in(form, claim_state, delivery_state)
    annotated = claim_status.annotate(Claim.objects.select_related("delivery")).get()
    status = claim_status.of(annotated)
    assert (status.code, status.outcome, status.final) == (code, outcome, outcome != "processing")
    assert status.label == claim_status.LABELS[code]
    assert claim_status.of(Claim.objects.get(pk=claim.pk)) == status
    assert status.deleted == (claim_state == Claim.State.PURGING)


def test_filtering_by_a_status_lists_exactly_the_claims_showing_it(form):
    shown = {claim_in(form, *case[:2]).pk: case[2] for case in CASES}
    claims = claim_status.annotate(Claim.objects.all())
    for code, _label in claim_status.CHOICES:
        listed = set(claims.filter(status=code).values_list("pk", flat=True))
        assert listed == {pk for pk, status in shown.items() if status == code}, code
    assert set(shown.values()) <= {code for code, _label in claim_status.CHOICES}


def test_error_comes_from_the_claim_before_its_delivery(form):
    claim = claim_in(form, Claim.State.FAILED, None)
    Claim.objects.filter(pk=claim.pk).update(error_code="document_process_failed")
    assert claim_status.of(Claim.objects.get()).error_code == "document_process_failed"
    Claim.objects.filter(pk=claim.pk).update(state=Claim.State.READY, error_code="")
    Delivery.objects.create(
        claim=claim, recipient="finance@example.invalid", state="failed", error_code="hard_bounce"
    )
    assert claim_status.of(Claim.objects.get()).error_code == "hard_bounce"


def test_unresolved_claims_are_overdue_until_delivered_or_deleted(accepted):
    later = accepted.resolution_due + timedelta(seconds=1)
    assert not claim_status.of(accepted, now=accepted.resolution_due - timedelta(1)).overdue
    assert claim_status.of(accepted, now=later).overdue
    accepted.retention_due = later
    assert not claim_status.of(accepted, now=later).overdue
    accepted.retention_due, accepted.state = None, Claim.State.PURGING
    assert not claim_status.of(accepted, now=later).overdue


def test_claim_status_command_filters_by_the_shown_status(form):
    for case in CASES:
        claim_in(form, *case[:2])
    output = io.StringIO()
    call_command("claim_status", status="purging", stdout=output)
    rows = [json.loads(line) for line in output.getvalue().splitlines()][:-1]
    assert [row["status"] for row in rows] == ["purging", "purging"]
