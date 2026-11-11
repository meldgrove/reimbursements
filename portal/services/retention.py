import logging
from datetime import timedelta
from importlib import import_module

from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from portal.models import (
    Claim,
    DeliveryEvent,
    Draft,
    DraftAdmission,
    Upload,
    WorkspaceReservation,
)
from portal.services import queue, uploads
from portal.services.capacity import recover_abandoned_workspaces
from portal.services.storage import outbox_key, remove_keys, sweep_orphans

logger = logging.getLogger(__name__)


class ClaimBusy(Exception):
    """A job or execution workspace still uses the claim; purge later."""


def _in_use(claim):
    return (
        queue.claim_has_running_job(claim)
        or WorkspaceReservation.objects.filter(Q(claim=claim) | Q(upload__claim=claim)).exists()
    )


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
    confirmation = getattr(claim, "confirmation", None)
    if confirmation:
        remove_keys(outbox_key(confirmation.pk))
    delivery = getattr(claim, "delivery", None)
    if delivery:
        for attempt in delivery.attempts.all():
            remove_keys(outbox_key(attempt.id))
    with transaction.atomic():
        claim = Claim.objects.select_for_update().filter(pk=claim_id).first()
        if claim is None:
            return
        if _in_use(claim):
            raise ClaimBusy
        # Events would outlive their attempt; the claim's other records cascade.
        DeliveryEvent.objects.filter(attempt__delivery__claim=claim).delete()
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
        delivery = getattr(claim, "delivery", None)
        if delivery:
            for attempt in delivery.attempts.all():
                remove_keys(outbox_key(attempt.id))
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
    DeliveryEvent.objects.filter(
        attempt__isnull=True, received_at__lt=now - timedelta(days=30)
    ).delete()
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
