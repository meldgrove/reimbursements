from datetime import timedelta

import pytest
from django.utils import timezone

from portal.intake import IntakeError
from portal.models import Draft, Form, PrivacyNotice
from portal.services import drafts
from portal.services.drafts import READ, REMOVE, REVIEW, SUBMIT, UPLOAD
from tests.conftest import Participant

pytestmark = pytest.mark.django_db
# Actions on unsubmitted drafts only, and actions that need an accepting form.
EDITS = [REVIEW, REMOVE, UPLOAD, SUBMIT]
ACCEPTS = [REVIEW, UPLOAD, SUBMIT]


@pytest.fixture
def participant():
    return Participant()


@pytest.fixture
def opened(participant, form):
    draft, token = drafts.open_draft(participant, form)
    return {"participant": participant, "draft": draft, "token": token}


def gate(opened, action, **changes):
    values = {"participant": opened["participant"], "token": opened["token"], **changes}
    return drafts.gate(values["participant"], "test", opened["draft"].pk, values["token"], action)


def refused(opened, action, status, **changes):
    with pytest.raises(IntakeError) as caught:
        gate(opened, action, **changes)
    assert caught.value.status == status
    return caught.value


def test_opening_starts_a_session_only_for_an_admitted_draft(participant, form, settings):
    settings.MAX_ACTIVE_DRAFTS = 0
    with pytest.raises(IntakeError):
        drafts.open_draft(participant, form)
    assert participant.session is None
    settings.MAX_ACTIVE_DRAFTS = 10
    draft, token = drafts.open_draft(participant, form)
    assert draft.session_hash == participant.session and draft.revision == form.revision()
    assert participant.remembered("test") == (str(draft.pk), token)


def test_opening_again_reuses_the_draft_until_its_revision_changes(opened, form):
    participant = opened["participant"]
    assert drafts.open_draft(participant, form) == (opened["draft"], opened["token"])
    PrivacyNotice.objects.create(text="Neue Fassung.")
    draft, _ = drafts.open_draft(participant, form)
    assert draft != opened["draft"] and Draft.objects.count() == 2


def test_opening_refuses_a_form_that_cannot_accept_claims(participant, form, settings):
    settings.APPROVED_DELIVERY_RECIPIENTS = ["other@example.invalid"]
    with pytest.raises(IntakeError) as caught:
        drafts.open_draft(participant, form)
    assert caught.value.status == 503 and not Draft.objects.exists()


@pytest.mark.parametrize("action", [READ, *EDITS])
def test_every_action_needs_the_session_and_the_token(opened, action):
    refused(opened, action, 404, participant=Participant(session="other"))
    refused(opened, action, 404, token="wrong")
    assert gate(opened, action) == (opened["draft"], opened["draft"].form)


@pytest.mark.parametrize("action", [READ, *EDITS])
def test_an_expired_draft_is_gone_for_every_action(opened, action):
    Draft.objects.filter(pk=opened["draft"].pk).update(expires_at=timezone.now())
    refused(opened, action, 410)


@pytest.mark.parametrize("action", EDITS)
def test_a_submitted_draft_accepts_no_edits_but_can_be_read(accepted, action):
    draft = Draft.objects.get()
    Draft.objects.filter(pk=draft.pk).update(expires_at=timezone.now() - timedelta(days=1))
    participant = Participant(session=draft.session_hash)
    opened = {"participant": participant, "draft": draft, "token": "unused"}
    Draft.objects.filter(pk=draft.pk).update(token_hash=drafts.digest("unused"))
    error = refused(opened, action, 409)
    assert isinstance(error, drafts.AlreadySubmitted) and error.draft == draft
    assert gate(opened, READ)[0] == draft


@pytest.mark.parametrize("action", ACCEPTS)
def test_accepting_actions_need_an_open_form(opened, form, action):
    Form.objects.filter(pk=form.pk).update(status=Form.Status.DRAFT)
    assert "geschlossen" in refused(opened, action, 409).message
    gate(opened, REMOVE)


@pytest.mark.parametrize("action", ACCEPTS)
def test_accepting_actions_need_an_approved_recipient(opened, settings, action):
    settings.APPROVED_DELIVERY_RECIPIENTS = ["other@example.invalid"]
    refused(opened, action, 503)
    gate(opened, REMOVE)


@pytest.mark.parametrize("action", ACCEPTS)
def test_accepting_actions_need_the_drafts_revision(opened, form, action):
    Form.objects.filter(pk=form.pk).update(purpose_options="Neu")
    assert "aktualisiert" in refused(opened, action, 409).message
    gate(opened, REMOVE)


def test_a_privacy_notice_published_during_submit_sends_the_draft_back(prepared, monkeypatch):
    import json

    from portal.models import Claim

    original = drafts.gate

    def racing(*args):
        result = original(*args)
        PrivacyNotice.objects.create(text="Neu veröffentlicht.")
        return result

    monkeypatch.setattr(drafts, "gate", racing)
    response = prepared["client"].post(
        "/f/test/submit/", data=json.dumps(prepared["data"]), content_type="application/json"
    )
    assert response.status_code == 409 and "aktualisiert" in response.json()["error"]
    assert not Claim.objects.exists()
