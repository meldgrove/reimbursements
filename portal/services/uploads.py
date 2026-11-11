"""Uploads: receipts and signatures from intake through validation to a claim or expiry.

An upload is busy while a validation runs or an execution workspace holds it. Busy
uploads are never discarded, and their files are removed only through this module.
"""

import uuid
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path

from django.db import transaction
from django.db.models import Q, Sum

from portal import intake
from portal.i18n import t
from portal.intake import IntakeError
from portal.models import Draft, Job, Upload
from portal.services import drafts, queue
from portal.services.capacity import (
    CapacityError,
    admit_upload,
    release_upload,
    storage_available,
)
from portal.services.storage import path_for, remove_keys, save_upload, upload_source_key

# Capacity refusals a participant caused; the others mean the service is busy (503).
CAPACITY_TOO_MANY = frozenset({"draft_work_limit", "network_work_limit"})
UNACCEPTED_LIFETIME = timedelta(hours=24)


def _busy(query):
    return query.filter(
        Q(job__state=queue.RUNNING) | Q(workspacereservation__isnull=False)
    ).exists()


def remove_files(upload):
    remove_keys(upload.source_key, upload.normalized_key)


def accept(participant, form_slug, *, file, kind, expense_id, draft_id, token, truncated=False):
    """Store a source file for the participant's accepting draft and queue its validation.

    Upload admission: every limit is checked here, with its message from intake. First
    free storage, the file's kind, type and size, then the Draft gate, the draft's files
    and receipt total, and finally the draft's and network's work budgets and disk
    capacity. `truncated` means the request's upload handler stopped the file at the
    receipt limit.
    """
    if not storage_available():
        raise IntakeError(intake.message("upload_unavailable"), status=503)
    if kind not in {"receipt", "signature"}:
        raise IntakeError(t("Please choose a receipt file or signature."))
    if truncated:
        raise IntakeError(intake.message(f"{kind}_too_large"), status=413)
    if not file:
        raise IntakeError(t("Please choose a receipt file or signature."))
    extension = Path(file.name).suffix.lower()
    if extension not in (
        intake.SIGNATURE_EXTENSIONS if kind == "signature" else intake.RECEIPT_EXTENSIONS
    ):
        raise IntakeError(intake.message("unsupported_type"))
    try:
        expense_id = uuid.UUID(expense_id) if kind == "receipt" else None
    except (ValueError, TypeError, AttributeError) as exc:
        raise IntakeError(t("The expense item is missing.")) from exc
    limits = intake.limits()
    key = ""
    try:
        with transaction.atomic():
            draft, _ = drafts.gate(participant, form_slug, draft_id, token, drafts.UPLOAD)
            count = draft.uploads.filter(kind=kind, expense_id=expense_id).count()
            if (
                count
                >= (limits.files_per_expense if kind == "receipt" else intake.MAX_SIGNATURE_FILES)
                or draft.uploads.count() >= limits.draft_files
            ):
                raise IntakeError(t("Please remove an existing file first."))
            if kind == "receipt":
                ensure_receipts_fit(_receipt_bytes(draft) + file.size)
            try:
                reservation = admit_upload(participant.network, draft, file.size)
            except CapacityError as exc:
                code = str(exc)
                raise IntakeError(
                    intake.message(code, intake.message("upload_capacity")),
                    status=429 if code in CAPACITY_TOO_MANY else 503,
                ) from exc
            upload_id = uuid.uuid4()
            key = upload_source_key(upload_id, extension)
            try:
                size, checksum = save_upload(
                    file,
                    key,
                    limits.signature_bytes if kind == "signature" else limits.receipt_bytes,
                )
            except ValueError as exc:
                raise IntakeError(intake.message(f"{kind}_too_large"), status=413) from exc
            if not size:
                raise IntakeError(t("The file is empty."))
            upload = Upload.objects.create(
                id=upload_id,
                draft=draft,
                expense_id=expense_id,
                kind=kind,
                original_name=Path(file.name).name[:200],
                source_key=key,
                size=size,
                checksum=checksum,
                reserved_bytes=reservation,
            )
            queue.enqueue("validate", upload)
    except Exception:
        if key:
            remove_keys(key)
        raise
    return upload


def _receipt_bytes(draft):
    return draft.uploads.filter(kind="receipt").aggregate(total=Sum("size"))["total"] or 0


def ensure_receipts_fit(receipt_bytes, receipt_pages=0):
    """The receipts of one claim stay within its size and page limits."""
    limits = intake.limits()
    if receipt_bytes > limits.submission_bytes:
        raise IntakeError(intake.message("submission_too_large"), status=413)
    if receipt_pages > limits.claim_pages:
        raise IntakeError(intake.message("claim_pages"), status=413)


def _gate(participant, form_slug, upload_id, token, action):
    """Pass the Draft gate for the upload's draft; the upload, or None if it is gone since."""
    draft_id = (
        Upload.objects.filter(pk=upload_id, draft__form__slug=form_slug)
        .values_list("draft_id", flat=True)
        .first()
    )
    if draft_id is None:
        raise IntakeError(t("The file was not found."), status=404)
    drafts.gate(participant, form_slug, draft_id, token, action)
    return Upload.objects.filter(pk=upload_id).first()


def owned(participant, form_slug, upload_id, token):
    """The upload, if the participant may read it; IntakeError otherwise."""
    upload = _gate(participant, form_slug, upload_id, token, drafts.READ)
    if upload is None:
        raise IntakeError(t("The file was not found."), status=404)
    return upload


def status(upload):
    return {
        "id": str(upload.id),
        "state": upload.state,
        "pages": upload.pages,
        "message": intake.message(upload.error_code, intake.message("upload_unchecked"))
        if upload.error_code
        else "",
    }


@transaction.atomic
def discard(participant, form_slug, upload_id, token):
    """Remove an upload of the participant's unsubmitted draft unless it is busy."""
    try:
        upload = _gate(participant, form_slug, upload_id, token, drafts.REMOVE)
    except drafts.AlreadySubmitted as exc:
        raise IntakeError(t("Submitted receipts cannot be changed."), status=409) from exc
    if upload is None:
        return  # A concurrent removal of the same upload got the draft lock first.
    list(Job.objects.select_for_update().filter(upload=upload))
    if _busy(Upload.objects.filter(pk=upload.pk)):
        raise IntakeError(t("The file is being checked. Please try again shortly."), status=409)
    remove_files(upload)
    upload.delete()


@dataclass(frozen=True)
class ClaimFiles:
    """The checked files of a claim, ready to attach once the claim exists."""

    # (upload, expense ID, position) in row order.
    receipts: list
    signature: Upload

    def attach(self, claim):
        for upload, _expense_id, position in self.receipts:
            upload.claim, upload.position = claim, position
            upload.save(update_fields=["claim", "position"])
        self.signature.claim = claim
        self.signature.save(update_fields=["claim"])


def claimable(draft, expenses, signature_id):
    """Lock and check the draft's files for a claim before anything is written.

    Each expense row's files are receipts of that row, the signature is a signature, all
    are ready, unattached and on disk, and the receipts fit one claim's limits. Caller
    holds the draft lock in an atomic transaction.
    """
    ids = [file_id for row in expenses for file_id in row["uploads"]] + [signature_id]
    found = {
        str(upload.id): upload
        for upload in Upload.objects.select_for_update().filter(
            draft=draft, id__in=ids, claim__isnull=True
        )
    }
    if found.keys() != set(ids):
        raise IntakeError(t("A file is unavailable. Please upload it again."))
    receipts = [
        (found[file_id], row["id"], position)
        for row in expenses
        for position, file_id in enumerate(row["uploads"])
    ]
    if any(
        upload.kind != "receipt" or str(upload.expense_id) != expense_id
        for upload, expense_id, _position in receipts
    ):
        raise IntakeError(t("A receipt does not belong to this expense item."))
    signature = found[signature_id]
    if signature.kind != "signature":
        raise IntakeError(t("Please draw or upload a signature."))
    if any(upload.state != Upload.State.READY for upload in found.values()):
        raise IntakeError(t("Please wait until all receipts and the signature have been checked."))
    if any(not path_for(upload.normalized_key).is_file() for upload in found.values()):
        raise IntakeError(t("A file is unavailable. Please upload it again."))
    ensure_receipts_fit(
        sum(upload.size for upload, *_ in receipts), sum(upload.pages for upload, *_ in receipts)
    )
    return ClaimFiles(receipts, signature)


def mark_ready(upload_id, output):
    """Record a validation's `NormalizedUpload`. False when the upload was discarded meanwhile."""
    upload = Upload.objects.select_for_update().filter(pk=upload_id).first()
    if not upload:
        return False
    upload.normalized_key, upload.normalized_size = output.key, output.size
    upload.media_type, upload.pages = output.media_type, output.pages
    upload.state, upload.error_code = Upload.State.READY, ""
    upload.save()
    release_upload(upload.pk)
    return True


def mark_retrying(upload_id, error_code):
    """Validation will run again; the pending output reservation stays admitted."""
    Upload.objects.filter(pk=upload_id).update(state=Upload.State.PENDING, error_code=error_code)


def mark_failed(upload_id, error_code):
    Upload.objects.filter(pk=upload_id).update(state=Upload.State.FAILED, error_code=error_code)
    release_upload(upload_id)


def expire_draft(draft_id):
    """Delete an expired, unsubmitted draft and its files unless an upload is busy."""
    with transaction.atomic():
        draft = Draft.objects.select_for_update().filter(pk=draft_id, claim__isnull=True).first()
        if not draft or _busy(draft.uploads.all()):
            return
        for upload in draft.uploads.all():
            remove_files(upload)
        draft.delete()


def expire_unattached(now):
    """Accepted drafts can hold uploads left out of the claim. Each goes 24 hours after its
    upload.

    Returns the number of uploads whose files could not be removed.
    """
    failures = 0
    unused = Upload.objects.filter(
        claim__isnull=True, draft__claim__isnull=False, created_at__lt=now - UNACCEPTED_LIFETIME
    )
    for upload in unused:
        if _busy(Upload.objects.filter(pk=upload.pk)):
            continue
        try:
            remove_files(upload)
            upload.delete()
        except OSError:
            failures += 1
    return failures
