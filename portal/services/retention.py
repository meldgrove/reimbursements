"""Retention: when a claim's PDF and content are deleted, and deleting them.

A claim is resolved once Finance has its PDF. The PDF then goes after PDF_RETENTION_DAYS,
everything else CONTENT_RETENTION_DAYS after submission, never before the PDF. An
unresolved claim keeps everything until an operator resolves or deletes it.
"""

import logging
from datetime import timedelta
from importlib import import_module

from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from portal.models import (
    Claim,
    Confirmation,
    DeliveryAttempt,
    Draft,
    DraftAdmission,
    Upload,
    WorkspaceReservation,
)
from portal.services import outbound, queue, uploads
from portal.services.capacity import recover_abandoned_workspaces
from portal.services.storage import remove_keys, sweep_orphans
from portal.services.transport import DELIVERED, FAILED, UNKNOWN

logger = logging.getLogger(__name__)


def resolution_due(submitted_at):
    """When an unresolved claim becomes overdue for an operator."""
    return submitted_at + timedelta(days=settings.CONTENT_RETENTION_DAYS)


def follow_delivery(claim, state, delivered_at):
    """Set the deletion dates of a claim the caller locked from its Finance delivery's state.

    A delivered claim is resolved. A failed or unclear delivery holds everything until an
    operator resolves it. Any other state changes nothing.
    """
    if state == DELIVERED:
        claim.pdf_due = delivered_at + timedelta(days=settings.PDF_RETENTION_DAYS)
        claim.retention_due = max(
            claim.submitted_at + timedelta(days=settings.CONTENT_RETENTION_DAYS), claim.pdf_due
        )
    elif state in {FAILED, UNKNOWN}:
        claim.pdf_due = claim.retention_due = None
    else:
        return
    claim.save(update_fields=["pdf_due", "retention_due"])


class ClaimBusy(Exception):
    """A job or execution workspace still uses the claim; purge later."""


def _in_use(claim):
    return (
        queue.claim_has_running_job(claim)
        or WorkspaceReservation.objects.filter(Q(claim=claim) | Q(upload__claim=claim)).exists()
    )


def _finance_emails(claim):
    """The claim's emails to Finance: they carry its PDF."""
    return DeliveryAttempt.objects.filter(delivery__claim=claim)


def _emails(claim):
    return [*_finance_emails(claim), *Confirmation.objects.filter(claim=claim)]


def begin_purge(claim):
    """Mark a claim the caller has locked as purging and cancel its jobs.

    Raises ClaimBusy while a job or execution workspace still uses it. Once marked, the
    worker's cleanup finishes the purge even if the caller is interrupted.
    """
    if _in_use(claim):
        raise ClaimBusy
    claim.state = Claim.State.PURGING
    claim.save(update_fields=["state"])
    queue.cancel_claim_jobs(claim)


def purge_claim(claim_id):
    """Delete a claim with its files and every record that belongs to it.

    Nothing of the claim remains in the database. Only operator actions stay in the
    log, without a link to the claim.
    """
    with transaction.atomic():
        claim = Claim.objects.select_for_update().filter(pk=claim_id).first()
        if claim is None:
            return
        begin_purge(claim)
    # Leave the manifest intact until every deletion succeeds, so a crash resumes safely.
    for upload in claim.uploads.all():
        uploads.remove_files(upload)
    remove_keys(claim.pdf_key)
    with transaction.atomic():
        claim = Claim.objects.select_for_update().filter(pk=claim_id).first()
        if claim is None:
            return
        if _in_use(claim):
            raise ClaimBusy
        # Evidence names emails, not the claim; the claim's other records cascade.
        outbound.forget(*_emails(claim))
        # Released and expired, the accepted draft goes with the next cleanup, together
        # with any uploads it kept; it no longer counts as an active draft.
        Draft.objects.filter(claim=claim).update(
            session_hash="", token_hash="", payload_hash="", expires_at=timezone.now()
        )
        claim.delete()


def remove_pdf(claim_id):
    """Delete a delivered claim's PDF and local email copies; the content stays."""
    with transaction.atomic():
        # The row lock keeps operator retries out until the PDF is gone.
        claim = Claim.objects.select_for_update().filter(pk=claim_id).first()
        if claim is None or not claim.pdf_key or claim.state == Claim.State.PURGING:
            return
        if queue.claim_has_active_job(claim):
            raise ClaimBusy
        remove_keys(claim.pdf_key)
        outbound.remove_copies(*_finance_emails(claim).values_list("pk", flat=True))
        claim.pdf_key, claim.pdf_removed_at = "", timezone.now()
        claim.save(update_fields=["pdf_key", "pdf_removed_at"])


def cleanup(*, execute=False):
    now = timezone.now()
    pdfs = list(
        Claim.objects.filter(pdf_due__lte=now)
        .exclude(pdf_key="")
        .exclude(state=Claim.State.PURGING)
        .values_list("pk", flat=True)
    )
    due = list(
        Claim.objects.filter(Q(retention_due__lte=now) | Q(state=Claim.State.PURGING)).values_list(
            "pk", flat=True
        )
    )
    drafts = list(
        Draft.objects.filter(claim__isnull=True, expires_at__lt=now).values_list("pk", flat=True)
    )
    unresolved = (
        Claim.objects.filter(
            resolution_due__lte=now + timedelta(days=3), retention_due__isnull=True
        )
        .exclude(state=Claim.State.PURGING)
        .count()
    )
    result = {
        "pdfs_due": len(pdfs),
        "claims_due": len(due),
        "drafts_due": len(drafts),
        "unresolved_near_expiry": unresolved,
        "failures": 0,
    }
    if not execute:
        return result
    # Session expiry denies access but does not remove stored tokens or metadata.
    import_module(settings.SESSION_ENGINE).SessionStore.clear_expired()
    DraftAdmission.objects.filter(window_start__lt=now - timedelta(days=2)).delete()
    for claim_id in pdfs:
        try:
            remove_pdf(claim_id)
        except (OSError, ClaimBusy):
            result["failures"] += 1
            logger.error("pdf_removal_failed reference=%s", claim_id)
    for claim_id in due:
        try:
            purge_claim(claim_id)
        except (OSError, ClaimBusy):
            result["failures"] += 1
            logger.error("purge_failed reference=%s", claim_id)
    for draft_id in drafts:
        try:
            uploads.expire_draft(draft_id)
        except OSError:
            result["failures"] += 1
    result["failures"] += uploads.expire_unattached(now)
    orphan_cleanup()
    return result


class StoredOwners:
    """Database ownership of stored artifacts, for the storage orphan sweep."""

    def upload_keys(self, upload_id):
        upload = Upload.objects.filter(pk=upload_id).first()
        return {upload.source_key, upload.normalized_key} if upload else None

    def workspace_reserved(self, key):
        return WorkspaceReservation.objects.filter(directory=key).exists()

    def pdf_referenced(self, key):
        return Claim.objects.filter(pdf_key=key).exists()


def orphan_cleanup():
    recover_abandoned_workspaces()
    sweep_orphans(timezone.now() - timedelta(hours=24), StoredOwners())
