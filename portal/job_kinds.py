"""Job kinds. Each owns its target's transitions for every outcome.

A kind runs with a `portal.jobs.Lease` and answers:
- `failure(exc)`: what an exception from `run` means (code, retryable, expected).
- `retrying(job, code)` / `failed(job, code)`: the target's state for that outcome.
- `interrupted(job)`: the target's state after a worker died; returns the job's error code.
- `resumable`: whether an interrupted job may run again.
"""

from dataclasses import dataclass

from django.conf import settings
from django.db import transaction

from portal.models import Claim, Upload
from portal.services import confirmations, delivery, queue, uploads
from portal.services.capacity import temporary_workspace
from portal.services.documents import ProcessingError, build_claim_pdf, validate_upload
from portal.services.scanner import ScanError, scan_file
from portal.services.storage import claim_pdf_key, path_for, publish_file, remove_keys
from portal.services.transport import FAILED, PENDING, UNKNOWN

INTERRUPTED = "worker_interrupted"


@dataclass(frozen=True)
class Failure:
    code: str
    retryable: bool = False
    expected: bool = True


UNEXPECTED = Failure("processing_error", expected=False)


class Validate:
    """Scan and normalize an upload. Scanner outages retry; the upload stays pending."""

    resumable = True

    def run(self, job, lease):
        upload = Upload.objects.get(pk=job.upload_id)
        with transaction.atomic():
            if not lease.live():
                return
        scan_file(path_for(upload.source_key))
        with validate_upload(upload) as result:
            with transaction.atomic():
                if not lease.live() or not uploads.mark_ready(upload.pk, result):
                    uploads.discard_output(upload, result)
                    return
                lease.finish()

    def failure(self, exc):
        if isinstance(exc, ScanError):
            return Failure(exc.code, retryable=exc.retryable)
        if isinstance(exc, ProcessingError):
            return Failure(str(exc))
        return UNEXPECTED

    def retrying(self, job, code):
        uploads.mark_retrying(job.upload_id, code)

    def failed(self, job, code):
        uploads.mark_failed(job.upload_id, code)

    def interrupted(self, job):
        self.failed(job, INTERRUPTED)
        return INTERRUPTED


class Render:
    """Build and publish a claim's authoritative PDF, then schedule its delivery."""

    resumable = True
    WITHDRAWN = (Claim.State.PURGING, Claim.State.PURGED)

    def run(self, job, lease):
        with transaction.atomic():
            if not lease.live():
                return
            claim = Claim.objects.select_for_update().get(pk=job.claim_id)
            if claim.state in self.WITHDRAWN:
                lease.cancel()
                return
            claim.state = Claim.State.RENDERING
            claim.save(update_fields=["state"])
        with temporary_workspace(claim=claim) as workspace:
            source, result = build_claim_pdf(claim, workspace)
            with transaction.atomic():
                if not lease.live():
                    return
                claim = Claim.objects.select_for_update().get(pk=claim.pk)
                if claim.state in self.WITHDRAWN:
                    lease.cancel()
                    return
                self._publish(claim, source, result, claim_pdf_key(claim.id, lease.token))
                delivery.schedule(claim)
                lease.finish()

    def _publish(self, claim, source, result, key):
        size, checksum = publish_file(source, key, settings.MAX_FINAL_PDF_BYTES)
        if checksum != result["checksum"] or size != result["size"]:
            remove_keys(key)
            raise ProcessingError("invalid_processing_output")
        claim.pdf_key, claim.pdf_hash = key, result["checksum"]
        claim.pdf_size, claim.pdf_page_count = result["size"], result["pages"]
        claim.state, claim.error_code = Claim.State.READY, ""
        claim.save()

    def failure(self, exc):
        return Failure(str(exc)) if isinstance(exc, ProcessingError) else UNEXPECTED

    def retrying(self, job, code):
        raise AssertionError("Rendering failures are not retried automatically")

    def failed(self, job, code):
        Claim.objects.filter(pk=job.claim_id).update(state=Claim.State.FAILED, error_code=code)

    def interrupted(self, job):
        self.failed(job, INTERRUPTED)
        return INTERRUPTED

    def requeue(self, claim):
        """Operator retry of a claim whose PDF was never produced. False otherwise."""
        if claim.state != Claim.State.FAILED or claim.pdf_key:
            return False
        claim.state, claim.error_code = Claim.State.RECEIVED, ""
        claim.save()
        queue.enqueue("render", claim, again=True)
        return True


class Send:
    """One delivery attempt. Never retried when the provider may have the message."""

    resumable = False

    def run(self, job, lease):
        with transaction.atomic():
            if not lease.live():
                return
            attempt = delivery.start_attempt(job.delivery_id)
            if not attempt:
                lease.cancel()
                return
        result = delivery.send(attempt)
        with transaction.atomic():
            delivery.record_result(attempt.pk, result)
            if result.state == PENDING:
                if not lease.retry(result.error_code, minimum_delay=result.retry_after):
                    delivery.abandon(attempt.pk, "retry_exhausted")
                    lease.finish(queue.FAILED, "retry_exhausted")
            elif result.state in {FAILED, UNKNOWN}:
                lease.finish(queue.FAILED, result.error_code)
            else:
                lease.finish(queue.DONE, result.error_code)
        delivery.reconcile_unmatched()

    def failure(self, exc):
        # Any exception around a provider call leaves the outcome unknown.
        return UNEXPECTED

    def retrying(self, job, code):
        raise AssertionError("Sends are not retried after an unexpected failure")

    def failed(self, job, code):
        delivery.mark_interrupted(job.delivery_id, "unexpected_send_failure")

    def interrupted(self, job):
        delivery.mark_interrupted(job.delivery_id, INTERRUPTED)
        return UNKNOWN


VALIDATE, RENDER, SEND = Validate(), Render(), Send()


class Confirm:
    """Send a receipt independently. Retry only known failures before acceptance."""

    resumable = False

    def run(self, job, lease):
        with transaction.atomic():
            if not lease.live():
                return
            confirmation = confirmations.start(job.claim_id)
            if not confirmation:
                lease.cancel()
                return
        result = confirmations.send(confirmation)
        with transaction.atomic():
            confirmations.mark(job.claim_id, result.state, result.error_code, result.message_id)
            if result.state == PENDING:
                if not lease.retry(result.error_code, minimum_delay=result.retry_after):
                    confirmations.mark(job.claim_id, FAILED, "retry_exhausted")
                    lease.finish(queue.FAILED, "retry_exhausted")
            else:
                lease.finish(
                    queue.FAILED if result.state in {FAILED, UNKNOWN} else queue.DONE,
                    result.error_code,
                )

    def failure(self, exc):
        return UNEXPECTED

    def retrying(self, job, code):
        raise AssertionError("Confirmation outcome is unknown after an unexpected failure")

    def failed(self, job, code):
        confirmations.mark(job.claim_id, UNKNOWN, code)

    def interrupted(self, job):
        self.failed(job, INTERRUPTED)
        return UNKNOWN


KINDS = {"validate": VALIDATE, "render": RENDER, "send": SEND, "confirm": Confirm()}
