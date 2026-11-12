"""Audited operator actions on claims, shared by the admin area and management commands."""

import logging
from dataclasses import dataclass

from django.db import transaction

from portal import job_kinds
from portal.models import Claim, Operation
from portal.services import delivery, queue, retention

logger = logging.getLogger(__name__)


class ActionRefused(Exception):
    """The action is not possible now. `code` names the reason; the message is for operators."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


RENDER, RESEND = "render", "resend"


@dataclass(frozen=True)
class Retry:
    """What processing a claim again does now.

    `action` is RENDER, building a PDF that was never produced, or RESEND, sending the PDF
    to Finance again. A resend with `duplicate_risk` needs the operator's acknowledgment,
    because Finance may already hold the PDF.
    """

    action: str
    duplicate_risk: bool = False


def plan_retry(claim):
    """What a retry of `claim` would do now. Raises ActionRefused when it cannot run."""
    if queue.claim_has_active_job(claim):
        raise ActionRefused("active_job", "This claim is already being processed.")
    if claim.state == Claim.State.READY:
        if not claim.pdf_key:
            raise ActionRefused(
                "pdf_removed",
                "The PDF has already been deleted and cannot be sent again.",
            )
        return Retry(RESEND, duplicate_risk=delivery.may_have_reached_finance(claim))
    if claim.state == Claim.State.FAILED and not claim.pdf_key:
        return Retry(RENDER)
    raise ActionRefused(
        "not_retryable",
        "This claim cannot be processed again in its current state.",
    )


@transaction.atomic
def retry(claim_id, *, actor, reason, acknowledge_duplicate_risk=False):
    """Carry out `plan_retry`. A resend that may duplicate needs acknowledgment."""
    claim = Claim.objects.select_for_update().for_reference(claim_id).get()
    if not reason.strip():
        raise ActionRefused("reason_missing", "Please give a reason.")
    plan = plan_retry(claim)
    if plan.duplicate_risk and not acknowledge_duplicate_risk:
        raise ActionRefused(
            "duplicate_risk",
            "The email may already have arrived. Check the delivery first, then "
            "acknowledge the risk of a duplicate delivery.",
        )
    if plan.action == RESEND:
        delivery.resend(claim)
    else:
        job_kinds.RENDER.requeue(claim)
    Operation.objects.create(claim=claim, action="retry", actor=actor, reason=reason.strip()[:500])
    return claim


def delete(claim_id, *, actor, reason):
    """Delete a claim now instead of at its retention date.

    Pending processing and sending stop, and the claim's record is deleted with its
    content. The audited operation remains without a link to the claim. A copy Finance
    already received stays with Finance. Returns True once the claim is gone, or False
    when the purge began but could not finish now: the claim stays purging and the
    worker's cleanup finishes it.
    """
    with transaction.atomic():
        claim = Claim.objects.select_for_update().for_reference(claim_id).first()
        if not reason.strip():
            raise ActionRefused("reason_missing", "Please give a reason.")
        if claim is None or claim.state == Claim.State.PURGING:
            raise ActionRefused("already_deleted", "This claim has already been deleted.")
        try:
            retention.begin_purge(claim)
        except retention.ClaimBusy as exc:
            raise ActionRefused(
                "busy",
                "The claim is being processed or sent right now. Try again in a few minutes.",
            ) from exc
        Operation.objects.create(
            claim=claim, action="delete", actor=actor, reason=reason.strip()[:500]
        )
    # Evidence outside the database, so a restored backup can be purged again.
    logger.info("claim_deleted reference=%s", claim.pk)
    try:
        retention.purge_claim(claim.pk)
    except (OSError, retention.ClaimBusy):
        logger.error("purge_failed reference=%s", claim.pk)
        return False
    return True
