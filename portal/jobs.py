"""The single worker's job runner: lease a job, dispatch it to its kind, record the outcome.

Job kinds (`portal.job_kinds`) own their target's transitions. The runner owns leases,
capacity waits and the one retry policy.
"""

import logging
import random
import uuid
from datetime import timedelta

from django.conf import settings
from django.db import connection, transaction
from django.utils import timezone

from portal.job_kinds import KINDS
from portal.models import Job
from portal.services.capacity import CapacityError
from portal.services.queue import CANCELLED, DONE, FAILED, PENDING, RUNNING

logger = logging.getLogger(__name__)
BACKOFF = [60, 300, 900, 3600]
CAPACITY_WAIT_SECONDS = 60


def can_retry(job):
    return job.attempts <= len(BACKOFF)


def backoff(job, minimum=0):
    return max(minimum, BACKOFF[min(job.attempts, len(BACKOFF)) - 1]) + random.randint(0, 15)


class Lease:
    """A running job's exclusive claim. Writes after expiry are silently dropped."""

    def __init__(self, job):
        self.job = job

    @property
    def token(self):
        return self.job.lease_token

    def live(self):
        """Inside a transaction: lock the job and confirm this lease still holds it."""
        return (
            Job.objects.select_for_update()
            .filter(
                pk=self.job.pk,
                state=RUNNING,
                lease_token=self.token,
                lease_until__gt=timezone.now(),
            )
            .exists()
        )

    def finish(self, state=DONE, error_code="", delay=0):
        Job.objects.filter(pk=self.job.pk, state=RUNNING, lease_token=self.token).update(
            state=state,
            error_code=error_code,
            run_after=timezone.now() + timedelta(seconds=delay),
            lease_token=None,
            lease_until=None,
        )

    def cancel(self):
        self.finish(CANCELLED)

    def retry(self, error_code, *, minimum_delay=0):
        """Schedule another attempt with backoff. False once attempts are exhausted."""
        if not can_retry(self.job):
            return False
        self.finish(PENDING, error_code, backoff(self.job, minimum_delay))
        return True


@transaction.atomic
def acquire_job():
    # Later public intake cannot overtake already accepted work. run_after also
    # keeps backoff retries behind work that was ready before their retry time.
    query = Job.objects.filter(state=PENDING, run_after__lte=timezone.now()).order_by(
        "run_after", "id"
    )
    if connection.features.has_select_for_update_skip_locked:
        query = query.select_for_update(skip_locked=True)
    else:
        query = query.select_for_update()
    job = query.first()
    if job:
        job.state, job.lease_token = RUNNING, uuid.uuid4()
        job.lease_until = timezone.now() + timedelta(seconds=settings.JOB_LEASE_SECONDS)
        job.attempts += 1
        job.save()
    return job


@transaction.atomic
def reclaim_stale_jobs():
    """Expired leases mean a dead worker. Resumable kinds keep their place in the queue."""
    for job in Job.objects.select_for_update().filter(
        state=RUNNING, lease_until__lt=timezone.now()
    ):
        kind = KINDS[job.kind]
        if kind.resumable and can_retry(job):
            job.state, job.error_code = PENDING, "worker_interrupted"
        else:
            job.state, job.error_code = FAILED, kind.interrupted(job)
        job.lease_token, job.lease_until = None, None
        job.save()


def run_one():
    job = acquire_job()
    if not job:
        return False
    kind, lease = KINDS[job.kind], Lease(job)
    try:
        kind.run(job, lease)
    except CapacityError:
        with transaction.atomic():
            if lease.live():
                lease.finish(PENDING, "storage_capacity", CAPACITY_WAIT_SECONDS)
        logger.warning("document_capacity_wait job=%s", job.pk)
    except Exception as exc:
        failure = kind.failure(exc)
        with transaction.atomic():
            if lease.live():
                if failure.retryable and lease.retry(failure.code):
                    kind.retrying(job, failure.code)
                else:
                    kind.failed(job, failure.code)
                    lease.finish(FAILED, failure.code)
        if failure.expected:
            logger.warning("document_job_failed job=%s code=%s", job.pk, failure.code)
        else:
            logger.exception("job_failed job=%s kind=%s", job.pk, job.kind)
    return True
