import json
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from django.utils.crypto import constant_time_compare

from portal.i18n import t
from portal.intake import IntakeError
from portal.models import Claim, Expense
from portal.services import claim_validation, confirmations, drafts, queue, uploads
from portal.services.drafts import digest
from portal.services.references import allocate_reference


@transaction.atomic
def submit_claim(participant, form_slug, data):
    """Accept the participant's draft as a claim; a repeated identical request returns it."""
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
    payload, total = claim_validation.submission(data, form).require_valid()
    all_ids = [file_id for row in payload["expenses"] for file_id in row["uploads"]] + [
        payload["signature"]
    ]
    files = uploads.claimable(draft, all_ids)
    signature = files[payload["signature"]]
    if signature.kind != "signature":
        raise IntakeError(t("A file is unavailable. Please upload it again."))
    if Expense.objects.filter(id__in=[row["id"] for row in payload["expenses"]]).exists():
        raise IntakeError(t("Invalid item ID. Please open a new form."), status=409)
    fields = {
        key: value
        for key, value in payload.items()
        if key not in {"signature", "expenses", "declaration", "privacy_acknowledged", "is_trip"}
    }
    submitted_at = timezone.now()
    claim = Claim.objects.create(
        form=form,
        submitted_at=submitted_at,
        bookkeeping_reference=allocate_reference(form.slug, fields["full_name"], submitted_at),
        snapshot=snapshot,
        total=total,
        resolution_due=timezone.now() + timedelta(days=settings.CONTENT_RETENTION_DAYS),
        **fields,
    )
    for row in payload["expenses"]:
        for position, file_id in enumerate(row["uploads"]):
            uploads.attach(files[file_id], claim, expense_id=row["id"], position=position)
        Expense.objects.create(
            claim=claim, **{key: value for key, value in row.items() if key != "uploads"}
        )
    uploads.attach(signature, claim)
    draft.claim, draft.payload_hash = claim, payload_hash
    draft.expires_at = timezone.now() + timedelta(days=7)
    draft.save(update_fields=["claim", "payload_hash", "expires_at"])
    queue.enqueue("render", claim)
    confirmations.schedule(claim)
    return claim
