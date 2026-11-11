"""Drafts: session-bound, token-authorized forms that become one claim on acceptance.

`open_draft` gives a participant their editable draft of a form, or admits a new one.
`gate` decides whether a participant may act on a draft now. Every participant action
passes it, and its `Action` says which checks run:

| Action | session, token, expiry | unsubmitted | form accepting | locks            |
|--------|------------------------|-------------|----------------|------------------|
| READ   | yes                    |             |                |                  |
| REMOVE | yes                    | yes         |                | draft            |
| UPLOAD | yes                    | yes         | yes            | draft            |
| SUBMIT | yes                    | yes         | yes            | draft, then form |

A form is accepting while it is open, available (an approved recipient and a privacy
notice) and on the draft's revision. A draft is accepting while it is unsubmitted and its
form is.
"""

import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import timedelta

from django.conf import settings
from django.utils import timezone
from django.utils.crypto import constant_time_compare

from portal.i18n import t
from portal.intake import IntakeError
from portal.models import Draft, Form, PrivacyNotice
from portal.services import network_budget
from portal.services.delivery import recipient_approved

# New drafts one browser session may open per day.
MAX_DRAFTS_PER_SESSION = 10


@dataclass(frozen=True)
class Action:
    # The draft must still be unsubmitted; it stays locked until the transaction ends.
    edits: bool
    # The form must be accepting: open, available and on the draft's revision.
    accepts: bool
    # The form cannot change until the transaction ends.
    locks_form: bool


READ = Action(edits=False, accepts=False, locks_form=False)
REMOVE = Action(edits=True, accepts=False, locks_form=False)
UPLOAD = Action(edits=True, accepts=True, locks_form=False)
SUBMIT = Action(edits=True, accepts=True, locks_form=True)


class AlreadySubmitted(IntakeError):
    """The draft is already a claim. Submit replays it; every other edit is refused."""

    def __init__(self, draft):
        super().__init__(t("This form has already been submitted."), status=409)
        self.draft = draft


class Outdated(IntakeError):
    """The form is on another revision than the draft: the participant must reload."""

    def __init__(self):
        super().__init__(
            t("The form was updated. Please reload it and check your details again."),
            status=409,
        )


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def _ensure_accepting(form, revision):
    """`revision` is the draft's; None checks a form before a draft exists."""
    if not form.is_open():
        raise IntakeError(t("This form is closed for new claims."), status=409)
    if not recipient_approved(form.recipient) or PrivacyNotice.current() is None:
        raise IntakeError(t("The form is currently unavailable."), status=503)
    if revision is not None and form.revision() != revision:
        raise Outdated()


def gate(participant, form_slug, draft_id, token, action):
    """The participant's draft and its form, if `action` is allowed now.

    Raises IntakeError: 404 for another session or a wrong token, 410 for an expired
    unsubmitted draft, AlreadySubmitted (409) when an editing action meets a claim, and
    409 or 503 when an accepting action meets a form that is closed, unavailable or on
    another revision. Locks need an atomic transaction.
    """
    try:
        draft_id = uuid.UUID(str(draft_id))
        # Lock only the draft: the form slug join must not lock the form row as well.
        drafts = Draft.objects.select_for_update(of=("self",)) if action.edits else Draft.objects
        draft = drafts.get(pk=draft_id, form__slug=form_slug, session_hash=participant.binding())
    except (Draft.DoesNotExist, ValueError, TypeError) as exc:
        raise IntakeError(t("The form was not found."), status=404) from exc
    if not isinstance(token, str) or not constant_time_compare(draft.token_hash, digest(token)):
        raise IntakeError(t("The form was not found."), status=404)
    if not draft.claim_id and draft.expires_at <= timezone.now():
        raise IntakeError(t("The form has expired. Please open the form again."), status=410)
    forms = Form.objects.select_related("template")
    if action.locks_form:
        forms = forms.select_for_update(of=("self",))
    form = forms.get(pk=draft.form_id)
    if action.edits and draft.claim_id:
        raise AlreadySubmitted(draft)
    if action.accepts:
        _ensure_accepting(form, draft.revision)
    return draft, form


def open_draft(participant, form):
    """The participant's draft of an accepting form, or a newly admitted one, with its token.

    A submitted, expired or outdated draft starts a new one. Never call inside a
    transaction: a session started for a new draft must persist (see `portal.participants`).
    """
    _ensure_accepting(form, None)
    revision, now = form.revision(), timezone.now()
    binding = participant.binding()
    remembered = participant.remembered(form.slug)
    if remembered:
        draft = Draft.objects.filter(
            pk=remembered[0],
            form=form,
            session_hash=binding,
            claim__isnull=True,
            expires_at__gt=now,
            revision=revision,
        ).first()
        if draft:
            return draft, remembered[1]
    if (
        Draft.objects.filter(claim__isnull=True, expires_at__gt=now).count()
        >= settings.MAX_ACTIVE_DRAFTS
    ):
        raise IntakeError(t("The form is busy right now. Please try again later."), status=503)
    if (
        binding
        and Draft.objects.filter(
            session_hash=binding, created_at__gt=now - timedelta(days=1)
        ).count()
        >= MAX_DRAFTS_PER_SESSION
    ):
        raise IntakeError(t("Too many new forms. Please try again later."), status=429)
    if not network_budget.charge_draft(participant.network):
        raise IntakeError(
            t("Too many new forms from this network. Please try again later."),
            status=429,
        )
    # Only admitted visitors get a session.
    token = secrets.token_urlsafe(32)
    draft = Draft.objects.create(
        form=form,
        session_hash=participant.binding(create=True),
        token_hash=digest(token),
        revision=revision,
    )
    participant.remember(form.slug, draft.id, token)
    return draft, token
