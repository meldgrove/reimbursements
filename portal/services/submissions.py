import json

from django.db import transaction
from django.utils import timezone
from django.utils.crypto import constant_time_compare

from portal.i18n import t
from portal.intake import IntakeError
from portal.models import Claim, Expense
from portal.services import claim_validation, confirmations, drafts, queue, retention, uploads
from portal.services.drafts import digest
from portal.services.references import allocate_reference


@transaction.atomic
def submit_claim(participant, form_slug, data, *, numbered=True):
    """Accept the participant's draft as a claim; a repeated identical request returns it.

    `numbered=False` is for the setup check: its claim takes no bookkeeping reference,
    so the sequence Finance books has no gap, and goes by its ID instead.
    """
    if not isinstance(data, dict) or data.get("website"):
        raise IntakeError(t("Invalid request."))
    # Compare an exact canonical request on replay, even if the form changed or closed later.
    replay_data = {key: value for key, value in data.items() if key not in {"token", "website"}}
    payload_hash = digest(
        json.dumps(replay_data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    )
    try:
        draft, form = drafts.gate(
            participant, form_slug, data.get("draft_id"), data.get("token"), drafts.SUBMIT
        )
    except drafts.AlreadySubmitted as submitted:
        if not constant_time_compare(submitted.draft.payload_hash, payload_hash):
            raise IntakeError(
                t("This form has already been submitted with different details."), status=409
            ) from None
        return submitted.draft.claim
    # A privacy notice published since the gate's check must not enter this claim.
    snapshot = form.snapshot()
    if snapshot["revision"] != draft.revision:
        raise drafts.Outdated()
    entries = claim_validation.submission(data, form).require_valid()
    files = uploads.claimable(draft, entries.expenses, entries.signature)
    if Expense.objects.filter(id__in=[row["id"] for row in entries.expenses]).exists():
        raise IntakeError(t("Invalid item ID. Please open a new form."), status=409)
    submitted_at = timezone.now()
    claim = Claim.objects.create(
        form=form,
        submitted_at=submitted_at,
        bookkeeping_reference=allocate_reference(
            form.slug, entries.claim["full_name"], submitted_at
        )
        if numbered
        else None,
        snapshot=snapshot,
        total=entries.total,
        resolution_due=retention.resolution_due(submitted_at),
        **entries.claim,
    )
    for row in entries.expenses:
        Expense.objects.create(
            claim=claim, **{key: value for key, value in row.items() if key != "uploads"}
        )
    files.attach(claim)
    # A replay returns this claim until it is deleted; the draft no longer expires.
    draft.claim, draft.payload_hash = claim, payload_hash
    draft.save(update_fields=["claim", "payload_hash"])
    queue.enqueue("render", claim)
    confirmations.schedule(claim)
    return claim
