"""The persistent job queue: states, keys and active-job queries.

Domain modules enqueue work here; the worker in `portal.jobs` runs it.
"""

import uuid

from django.db.models import Q

from portal.models import Job

PENDING, RUNNING, DONE, FAILED, CANCELLED = "pending", "running", "done", "failed", "cancelled"
ACTIVE = (PENDING, RUNNING)
TARGETS = {"validate": "upload", "render": "claim", "send": "delivery", "confirm": "claim"}


def enqueue(kind, target, *, again=False):
    """Queue `kind` for its target. The first job per target is idempotent;
    `again` adds a further job, for an operator retry."""
    key = f"{kind}:{target.pk}" + (f":{uuid.uuid4()}" if again else "")
    job, _ = Job.objects.get_or_create(key=key, defaults={"kind": kind, TARGETS[kind]: target})
    return job


def _for_claim(claim):
    return Job.objects.filter(Q(claim=claim) | Q(delivery__claim=claim))


def claim_has_active_job(claim):
    return _for_claim(claim).filter(state__in=ACTIVE).exists()


def claim_has_running_job(claim):
    return _for_claim(claim).filter(state=RUNNING).exists()


def cancel_claim_jobs(claim):
    _for_claim(claim).update(state=CANCELLED)


def validation_backlog():
    return Job.objects.filter(kind="validate", state__in=ACTIVE).count()
