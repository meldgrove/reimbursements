"""Audited operator actions on claims, shared by the admin area and management commands."""

import logging

from django.db import transaction

from portal.job_kinds import RENDER
from portal.models import Claim, Operation
from portal.services import delivery, queue, retention

logger = logging.getLogger(__name__)


class ActionRefused(Exception):
    """The action is not possible now. `code` names the reason; the message is German."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


@transaction.atomic
def retry(claim_id, *, actor, reason, acknowledge_duplicate_risk=False):
    """Retry a failed render, or send again. Possible duplicates need acknowledgment."""
    claim = Claim.objects.select_for_update().for_reference(claim_id).get()
    if not reason.strip():
        raise ActionRefused("reason_missing", "Bitte gib einen Grund an.")
    if queue.claim_has_active_job(claim):
        raise ActionRefused("active_job", "Für diesen Antrag läuft bereits eine Verarbeitung.")
    if claim.state == Claim.State.READY:
        if not claim.pdf_key:
            raise ActionRefused(
                "pdf_removed",
                "Die PDF wurde bereits gelöscht und kann nicht erneut gesendet werden.",
            )
        try:
            delivery.retry(claim, acknowledge_duplicate_risk=acknowledge_duplicate_risk)
        except delivery.DuplicateRisk as exc:
            raise ActionRefused(
                "duplicate_risk",
                "Die E-Mail könnte bereits angekommen sein. Prüfe zuerst den Versand und "
                "bestätige dann das Risiko eines doppelten Versands.",
            ) from exc
    elif not RENDER.requeue(claim):
        raise ActionRefused(
            "not_retryable",
            "Dieser Antrag kann im aktuellen Zustand nicht erneut verarbeitet werden.",
        )
    Operation.objects.create(claim=claim, action="retry", actor=actor, reason=reason.strip()[:500])
    return claim


def delete(claim_id, *, actor, reason):
    """Delete a claim now instead of at its retention date.

    Pending processing and sending stop, and the claim's record is deleted with its
    content. The audited operation remains without a link to the claim. A copy Finance
    already received stays with Finance. An OSError or ClaimBusy after the purge has
    begun leaves the claim purging, and the worker's cleanup finishes it.
    """
    with transaction.atomic():
        claim = Claim.objects.select_for_update().for_reference(claim_id).first()
        if not reason.strip():
            raise ActionRefused("reason_missing", "Bitte gib einen Grund an.")
        if claim is None or claim.state == Claim.State.PURGING:
            raise ActionRefused("already_deleted", "Dieser Antrag wurde bereits gelöscht.")
        try:
            retention.begin_purge(claim)
        except retention.ClaimBusy as exc:
            raise ActionRefused(
                "busy",
                "Der Antrag wird gerade verarbeitet oder versendet. "
                "Versuche es in einigen Minuten erneut.",
            ) from exc
        Operation.objects.create(
            claim=claim, action="delete", actor=actor, reason=reason.strip()[:500]
        )
    # Evidence outside the database, so a restored backup can be purged again.
    logger.info("claim_deleted reference=%s", claim.pk)
    retention.purge_claim(claim.pk)
    return claim
