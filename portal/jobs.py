"""The single worker's job runner: lease a job, dispatch it to its kind, record the outcome.

Job kinds (`portal.job_kinds`) own their target's transitions. The runner owns leases,
capacity waits and the one retry policy. Every lease counts as an attempt, except one
that ends waiting for capacity: only processing uses up retries.

A job whose database connection drops is handed on like one whose worker died
(`interrupt`): as soon as the database is back, or when its lease expires if the
connection dropped while the lease itself was committed.
"""

import logging
import random
import uuid
from datetime import timedelta

from django.conf import settings
from django.db import DatabaseError, connection, transaction
from django.db.models import F
from django.utils import timezone

from portal import database
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

    def finish(self, state=DONE, error_code="", delay=0, **changes):
        Job.objects.filter(pk=self.job.pk, state=RUNNING, lease_token=self.token).update(
            state=state,
            error_code=error_code,
            run_after=timezone.now() + timedelta(seconds=delay),
            lease_token=None,
            lease_until=None,
            **changes,
        )

    def cancel(self):
        self.finish(CANCELLED)

    def wait_for_capacity(self):
        """Run again shortly. Waiting is not an attempt, so this lease's attempt is returned."""
        self.finish(PENDING, "storage_capacity", CAPACITY_WAIT_SECONDS, attempts=F("attempts") - 1)

    def retry(self, error_code, *, minimum_delay=0):
        """Schedule another attempt with backoff. False once attempts are exhausted."""
        if not can_retry(self.job):
            return False
        self.finish(PENDING, error_code, backoff(self.job, minimum_delay))
        return True

    def abandon(self):
        """The worker lost this job with its database connection. Hand it on as
        `reclaim_stale_jobs` would once the lease expired, without waiting for that."""
        with transaction.atomic():
            job = (
                Job.objects.select_for_update()
                .filter(pk=self.job.pk, state=RUNNING, lease_token=self.token)
                .first()
            )
            if job:
                interrupt(job)


class Interrupted(Exception):
    """The database connection dropped while a job ran. Its lease still holds the job:
    call `lease.abandon()` once the database is back."""

    def __init__(self, lease):
        super().__init__(f"job={lease.job.pk}")
        self.lease = lease


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


def interrupt(job):
    """In a transaction, on a locked running job whose worker stopped. Resumable kinds keep
    their place in the queue."""
    kind = KINDS[job.kind]
    if kind.resumable and can_retry(job):
        job.state, job.error_code = PENDING, "worker_interrupted"
    else:
        job.state, job.error_code = FAILED, kind.interrupted(job)
    job.lease_token, job.lease_until = None, None
    job.save()


@transaction.atomic
def reclaim_stale_jobs():
    """Expired leases mean a dead worker."""
    for job in Job.objects.select_for_update().filter(
        state=RUNNING, lease_until__lt=timezone.now()
    ):
        interrupt(job)


def run_one():
    """Run the next due job; False when none is due. Raises `Interrupted` when the database
    connection drops during the job."""
    job = acquire_job()
    if not job:
        return False
    lease = Lease(job)
    try:
        _run(KINDS[job.kind], job, lease)
    except DatabaseError as exc:
        if database.connection_lost(exc):
            raise Interrupted(lease) from exc
        raise
    return True


def _run(kind, job, lease):
    try:
        kind.run(job, lease)
    except CapacityError:
        with transaction.atomic():
            if lease.live():
                lease.wait_for_capacity()
        logger.warning("document_capacity_wait job=%s", job.pk)
    except Exception as exc:
        if database.connection_lost(exc):
            # Not the job's failure: nothing about it could be recorded now.
            raise
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
