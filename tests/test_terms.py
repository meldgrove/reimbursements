"""A form's terms: what a participant agrees to, and the revision drafts are opened against."""

from dataclasses import fields, replace
from decimal import Decimal

import pytest

from portal.models import FormTemplate, PrivacyNotice
from portal.services import terms
from portal.services.terms import Terms

pytestmark = pytest.mark.django_db

AGREED = Terms(
    declaration="Ich bestätige die Angaben.",
    declaration_version="2026-1",
    privacy_notice=PrivacyNotice(version=3),
    purpose_options=("Workshop", "Reise"),
    travel=FormTemplate.Travel.OPTIONAL,
    mileage_rate=Decimal("0.30"),
)
# Another value for every field; a new field needs one too.
CHANGED = {
    "declaration": "Neue Erklärung.",
    "declaration_version": "2026-2",
    "privacy_notice": PrivacyNotice(version=4),
    "purpose_options": ("Workshop",),
    "travel": FormTemplate.Travel.REQUIRED,
    "mileage_rate": Decimal("0.35"),
}


def test_the_revision_stays_the_digest_open_drafts_were_opened_with():
    # Digests of earlier releases: a changed digest sends every open draft back.
    assert AGREED.revision == "a4e9c99bcbacafbf"
    no_mileage = Terms(
        declaration="I confirm.",
        declaration_version="1",
        privacy_notice=None,
        purpose_options=(),
        travel=FormTemplate.Travel.OFF,
        mileage_rate=None,
    )
    assert no_mileage.revision == "10b14802a889d26f"


@pytest.mark.parametrize("name", [field.name for field in fields(Terms)])
def test_every_term_is_part_of_the_revision(name):
    assert set(CHANGED) == {field.name for field in fields(Terms)}
    assert replace(AGREED, **{name: CHANGED[name]}).revision != AGREED.revision


@pytest.mark.parametrize(
    "name,value",
    [("privacy_notice", None), ("purpose_options", ()), ("mileage_rate", None)],
)
def test_a_missing_term_changes_the_revision_too(name, value):
    assert replace(AGREED, **{name: value}).revision != AGREED.revision


def test_a_form_offers_its_templates_terms_and_the_current_privacy_notice(form, privacy_notice):
    form.purpose_options = " Workshop \r\n\r\nReise\nWorkshop"
    offered = terms.of(form)
    template = form.template
    assert offered == Terms(
        declaration=template.declaration,
        declaration_version=template.declaration_version,
        privacy_notice=PrivacyNotice.current(),
        purpose_options=("Workshop", "Reise"),
        travel=template.travel,
        mileage_rate=template.mileage_rate,
    )
    template.mileage_enabled = False
    assert terms.of(form).mileage_rate is None


def test_only_terms_change_the_revision(form):
    revision = terms.of(form).revision
    form.name, form.instructions, form.field_values = "Neu", "Hinweis", {"kst": "4321"}
    form.recipient = form.support_email = "neu@example.invalid"
    form.template.intro = "Neue Hinweise"
    assert terms.of(form).revision == revision


def test_a_single_preset_fixes_the_purpose():
    assert replace(AGREED, purpose_options=("Workshop",)).fixed_purpose == "Workshop"
    assert AGREED.fixed_purpose is None
    assert replace(AGREED, purpose_options=()).fixed_purpose is None


def test_the_snapshot_keeps_its_keys_and_records_the_accepted_terms(form):
    offered = terms.of(form)
    snapshot = terms.snapshot(form, offered)
    assert list(snapshot) == [
        "name",
        "slug",
        "template",
        "internal_values",
        "recipient",
        "support_email",
        "declaration",
        "declaration_version",
        "privacy_version",
        "mileage_rate",
        "revision",
        "language",
    ]
    assert snapshot["mileage_rate"] == "0.30" and snapshot["revision"] == offered.revision
    assert snapshot["privacy_version"] == offered.privacy_notice.version
    assert snapshot["internal_values"] == [
        ("Kostenstelle (KST)", "TEST-KST"),
        ("Kostenträger (KTR)", "TEST-KTR"),
    ]
    assert terms.snapshot(form, replace(offered, mileage_rate=None))["mileage_rate"] is None


def test_the_form_script_gets_the_terms_it_applies():
    assert AGREED.script_configuration() == {
        "travel": "optional",
        "mileage_rate": "0.30",
        "purpose_options": True,
        "fixed_purpose": None,
    }
    assert replace(
        AGREED, mileage_rate=None, purpose_options=("Workshop",)
    ).script_configuration() == {
        "travel": "optional",
        "mileage_rate": None,
        "purpose_options": True,
        "fixed_purpose": "Workshop",
    }
