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
from portal.services import confirmations, delivery, evidence, outbound, queue, uploads
from portal.services.capacity import temporary_workspace
from portal.services.documents import ProcessingError, build_claim_pdf, validate_upload
from portal.services.scanner import ScanError, scan_file
from portal.services.storage import claim_pdf_key, path_for, publish_file, remove_keys
from portal.services.transport import FAILED, PENDING, UNKNOWN, SendResult

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
        with validate_upload(upload) as output:
            with transaction.atomic():
                if not lease.live() or not uploads.mark_ready(upload.pk, output):
                    return
                lease.finish()
            output.keep()

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
    WITHDRAWN = (Claim.State.PURGING,)

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


class _Email:
    """Send one email at most once: reserve it, transmit it outside any transaction, then
    record the result. Only a send the provider refused before acceptance (PENDING) is
    retried. Once the provider may hold the message, nothing is sent again automatically.

    A sender names its record: `reserve(job)` returns the record of the email to send, or
    None when nothing may be sent now; `compose(reserved)` its message;
    `record(job, reserved, result)`; and `unknown(job, code)` for a send that ended without
    a result.
    """

    resumable = False

    def run(self, job, lease):
        with transaction.atomic():
            if not lease.live():
                return
            reserved = self.reserve(job)
            if not reserved:
                lease.cancel()
                return
        result = outbound.send(self.compose, reserved)
        with transaction.atomic():
            self.record(job, reserved, result)
            if result.state == PENDING:
                if not lease.retry(result.error_code, minimum_delay=result.retry_after):
                    self.record(job, reserved, SendResult(FAILED, error_code="retry_exhausted"))
                    lease.finish(queue.FAILED, "retry_exhausted")
            elif result.state in {FAILED, UNKNOWN}:
                lease.finish(queue.FAILED, result.error_code)
            else:
                lease.finish(queue.DONE, result.error_code)
        self.sent()

    def sent(self):
        """After a send's result is recorded."""

    def failure(self, exc):
        # Any exception around a provider call leaves the outcome unknown.
        return UNEXPECTED

    def retrying(self, job, code):
        raise AssertionError("Emails are not retried after an unexpected failure")

    def failed(self, job, code):
        self.unknown(job, "unexpected_send_failure")

    def interrupted(self, job):
        self.unknown(job, INTERRUPTED)
        return UNKNOWN


class Send(_Email):
    """One attempt to deliver a claim's PDF to Finance."""

    def reserve(self, job):
        return delivery.start_attempt(job.delivery_id)

    def compose(self, attempt):
        return delivery.compose(attempt)

    def record(self, job, attempt, result):
        delivery.record_result(attempt.pk, result)

    def unknown(self, job, code):
        delivery.mark_unknown(job.delivery_id, code)

    def sent(self):
        # Provider evidence can arrive before its attempt's send result.
        evidence.reconcile_unmatched()


class Confirm(_Email):
    """The participant's confirmation of receipt, independent of Finance delivery."""

    def reserve(self, job):
        return confirmations.start(job.claim_id)

    def compose(self, confirmation):
        return confirmations.compose(confirmation)

    def record(self, job, confirmation, result):
        confirmations.record(job.claim_id, result)

    def unknown(self, job, code):
        confirmations.record(job.claim_id, SendResult(UNKNOWN, error_code=code))


VALIDATE, RENDER, SEND = Validate(), Render(), Send()

KINDS = {"validate": VALIDATE, "render": RENDER, "send": SEND, "confirm": Confirm()}
