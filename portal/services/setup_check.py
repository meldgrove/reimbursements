"""The setup check: one synthetic claim through this installation's own services.

`manage.py verify_setup` runs it after a deployment, an upgrade or a credential change.
It checks the database, private storage, the worker, the document sandbox, the malware
scanner and the Keycloak realm. Then it submits a claim the way a participant does:
receipt and signature uploads, scanning and normalization, the PDF, the Finance email,
the participant confirmation and, with MailerSend, the signed delivery webhook.

The claim goes through a temporary form and template. It takes no bookkeeping reference,
so Finance's numbering has no gap, and it is deleted with them when the check ends.
"""

import io
import secrets
import time
import uuid
from datetime import timedelta

import httpx
from django.conf import settings
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import DatabaseError, connection
from django.db.models import ProtectedError, Q
from django.utils import timezone
from PIL import Image, ImageDraw

from portal import app_settings, intake
from portal.intake import IntakeError
from portal.models import (
    AppSettings,
    Claim,
    Confirmation,
    Delivery,
    DeliveryAttempt,
    DeliveryEvent,
    Draft,
    Form,
    FormTemplate,
    PrivacyNotice,
    Upload,
)
from portal.services import drafts, operations, outbound, retention, uploads
from portal.services.capacity import storage_available
from portal.services.documents import sandbox_ready
from portal.services.readiness import queue_age_seconds
from portal.services.scanner import ScanError, scan_file, scanner_ready
from portal.services.storage import check_writable, heartbeat_age, path_for
from portal.services.submissions import submit_claim
from portal.services.transport import (
    ACCEPTED,
    DELIVERED,
    FAILED,
    PAUSED,
    PENDING,
    SENDING,
    UNKNOWN,
    LocalOutbox,
)

OK, FAIL, SKIP = "ok", "FAIL", "skip"
ACTOR = "verify_setup"
FORM_NAME = "Setup check (not a real claim)"
# The EICAR antivirus test file, in two parts so that this source is not detected itself.
EICAR = b"X5O!P%@AP[4\\PZX54(P^)7CC)7}$" + b"EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
# How long the clean-up waits for a job that still holds the claim or an upload.
CLEANUP_SECONDS = 120
SEND_PROBLEMS = {
    "provider_rejected": (
        "MailerSend refused the email. Check MAILERSEND_API_TOKEN and that "
        "MAIL_FROM_ADDRESS is on a verified MailerSend domain."
    ),
    "recipient_suppressed": "MailerSend suppresses this recipient after an earlier bounce.",
    "test_recipient_blocked": "TEST_RECIPIENT_ALLOWLIST does not include the recipient.",
    "unapproved_recipient": "APPROVED_DELIVERY_RECIPIENTS does not include the recipient.",
}


def pause():
    """Wait between polls. Tests replace it and `clock` to run the worker's jobs in-process."""
    time.sleep(1)


def clock():
    return time.monotonic()


def oidc_client():
    return httpx.Client(timeout=httpx.Timeout(10))


class Participant:
    """The check's participant (see portal.participants), with its own admission budget."""

    network = "setup-check"

    def __init__(self):
        self.session, self.memory = None, {}

    def binding(self, *, create=False):
        if self.session is None and create:
            self.session = secrets.token_hex(32)
        return self.session

    def remembered(self, form_slug):
        return self.memory.get(form_slug)

    def remember(self, form_slug, draft_id, token):
        self.memory[form_slug] = (str(draft_id), token)


def image(*, signature=False):
    picture = Image.new("RGB", (800, 240) if signature else (1000, 1400), "white")
    draw = ImageDraw.Draw(picture)
    if signature:
        line = [(80, 160), (150, 60), (210, 170), (300, 80), (440, 150), (600, 100)]
        draw.line(line, fill="#134e4a", width=5)
    else:
        draw.text((60, 60), "SETUP CHECK - NOT A REAL RECEIPT", fill="black")
        draw.text((60, 110), "Total EUR 1.00", fill="black")
    output = io.BytesIO()
    picture.save(output, "PNG")
    return output.getvalue()


class SetupCheck:
    """`report(status, title, detail)` receives each result; `run()` is True without failures."""

    def __init__(self, *, finance, participant, timeout, report):
        self.finance, self.participant = finance, participant
        self.timeout, self._report = timeout, report
        self.local = isinstance(outbound.configured_transport(), LocalOutbox)
        self.failures, self.deadline, self.claim_id = 0, 0.0, None

    def report(self, status, title, detail=""):
        self.failures += status == FAIL
        self._report(status, title, detail)
        return status != FAIL

    def run(self):
        if not self.database():
            return False
        ready = [self.storage(), self.worker(), self.sandbox(), self.scanner()]
        self.keycloak()
        if all(ready):
            self.claim()
        else:
            self.report(SKIP, "Test claim", "Fix the problems above first.")
        return not self.failures

    def database(self):
        try:
            connection.ensure_connection()
        except DatabaseError as exc:
            return self.report(FAIL, "Database", f"No connection: {exc}".strip())
        return self.report(OK, "Database")

    def storage(self):
        try:
            check_writable()
        except OSError as exc:
            return self.report(FAIL, "Private storage", f"Not writable: {exc}")
        if not storage_available():
            return self.report(
                FAIL,
                "Private storage",
                f"Less than MIN_FREE_STORAGE_BYTES ({settings.MIN_FREE_STORAGE_BYTES}) free.",
            )
        return self.report(OK, "Private storage")

    def worker(self):
        age = heartbeat_age()
        if age is None or not 0 <= age < settings.JOB_LEASE_SECONDS + 60:
            return self.report(
                FAIL,
                "Worker",
                "No recent heartbeat. Start the worker (manage.py run_jobs) and check its log.",
            )
        backlog = queue_age_seconds()
        if backlog > settings.MAX_JOB_AGE_SECONDS:
            return self.report(
                FAIL, "Worker", f"The oldest waiting job is {backlog} s old: the worker is behind."
            )
        return self.report(OK, f"Worker (heartbeat {age:.0f} s ago)")

    def sandbox(self):
        if not sandbox_ready():
            return self.report(
                FAIL,
                "Document sandbox",
                "Needs Linux with Landlock ABI 3 or newer and libseccomp2; see docs/operations.md.",
            )
        if not settings.DOCUMENT_SANDBOX_ENABLED:
            return self.report(SKIP, "Document sandbox", "Disabled in development.")
        return self.report(OK, "Document sandbox")

    def scanner(self):
        if settings.UPLOAD_SCANNER == "disabled" and settings.DEBUG:
            return self.report(SKIP, "Malware scanner", "Disabled in development.")
        if settings.UPLOAD_SCANNER != "clamav":
            return self.report(FAIL, "Malware scanner", "Set UPLOAD_SCANNER=clamav.")
        if not scanner_ready():
            return self.report(
                FAIL,
                "Malware scanner",
                f"ClamAV at {settings.CLAMAV_HOST}:{settings.CLAMAV_PORT} does not answer. "
                "Its first start can take several minutes.",
            )
        probe = path_for(f"checks/{uuid.uuid4()}")
        probe.parent.mkdir(exist_ok=True, mode=0o700)
        probe.write_bytes(EICAR)
        try:
            scan_file(probe)
        except ScanError as exc:
            if exc.code == "malware_detected":
                return self.report(OK, "Malware scanner detects the EICAR test file")
            return self.report(FAIL, "Malware scanner", f"The scan failed: {exc.code}.")
        finally:
            probe.unlink(missing_ok=True)
        return self.report(
            FAIL,
            "Malware scanner",
            "ClamAV did not detect the EICAR test file. Check that its signatures are current.",
        )

    def keycloak(self):
        if not settings.OIDC_ENABLED:
            return self.report(SKIP, "Keycloak", "Not configured; development uses passwords.")
        realm = settings.KEYCLOAK_REALM_URL
        expected = {
            "issuer": realm,
            "authorization_endpoint": settings.OIDC_OP_AUTHORIZATION_ENDPOINT,
            "token_endpoint": settings.OIDC_OP_TOKEN_ENDPOINT,
            "userinfo_endpoint": settings.OIDC_OP_USER_ENDPOINT,
            "jwks_uri": settings.OIDC_OP_JWKS_ENDPOINT,
            "end_session_endpoint": settings.OIDC_OP_LOGOUT_ENDPOINT,
        }
        try:
            with oidc_client() as client:
                response = client.get(f"{realm}/.well-known/openid-configuration")
                response.raise_for_status()
                discovery = response.json()
                differing = [key for key, value in expected.items() if discovery.get(key) != value]
                response = client.get(settings.OIDC_OP_JWKS_ENDPOINT)
                response.raise_for_status()
                keys = response.json().get("keys")
        except (httpx.HTTPError, ValueError, AttributeError) as exc:
            return self.report(
                FAIL,
                "Keycloak",
                f"{realm} gave no OpenID configuration ({exc}). "
                "Check KEYCLOAK_BASE_URL and KEYCLOAK_REALM.",
            )
        if differing:
            return self.report(
                FAIL,
                "Keycloak",
                f"The realm reports a different {', '.join(differing)}: its issuer is "
                f"{discovery.get('issuer')!r}, this app expects {realm!r}. Set "
                "KEYCLOAK_BASE_URL to the URL Keycloak uses for itself.",
            )
        if not isinstance(keys, list) or not any(
            isinstance(key, dict) and key.get("kty") == "RSA" and key.get("use", "sig") == "sig"
            for key in keys
        ):
            return self.report(FAIL, "Keycloak", "The realm has no RSA key to sign ID tokens.")
        return self.report(
            OK,
            f"Keycloak realm {realm}",
            "Sign in at /admin/ once to check the group mapping.",
        )

    def claim(self):
        if PrivacyNotice.current() is None:
            return self.report(FAIL, "Test claim", "Publish a privacy notice in the admin area.")
        self.deadline = clock() + self.timeout
        suffix = secrets.token_hex(6)
        template = FormTemplate.objects.create(
            name=f"Setup check {suffix}",
            description="Created by verify_setup; deleted when the check ends.",
            travel=FormTemplate.Travel.OFF,
        )
        # Closes by itself should the clean-up fail.
        form = Form.objects.create(
            template=template,
            slug=f"setup-check-{suffix}",
            name=FORM_NAME,
            recipient=self.finance,
            support_email=self.finance,
            status=Form.Status.PUBLISHED,
            closes_at=timezone.now() + timedelta(seconds=self.timeout + CLEANUP_SECONDS),
        )
        try:
            if self.submit(form):
                self.follow()
        finally:
            self.remove(form, template)

    def until(self, condition):
        """Poll `condition` until it returns a true value; None after the deadline."""
        while not (value := condition()):
            if clock() >= self.deadline:
                return None
            pause()
        return value

    def submit(self, form):
        participant, row = Participant(), str(uuid.uuid4())
        general = AppSettings.load()
        # The claim, its PDF and emails use the app language, as a participant's would.
        with app_settings.applied(general, general.language):
            try:
                draft, token = drafts.open_draft(participant, form)
                files = [
                    uploads.accept(
                        participant,
                        form.slug,
                        file=SimpleUploadedFile(
                            f"setup-check-{kind}.png", image(signature=kind == "signature")
                        ),
                        kind=kind,
                        expense_id=row,
                        draft_id=str(draft.id),
                        token=token,
                    )
                    for kind in ["receipt", "signature"]
                ]
            except IntakeError as exc:
                return self.report(FAIL, "Uploads", f"Refused: {exc.message}")
            if not self.checked([upload.pk for upload in files]):
                return False
            data = {
                "draft_id": str(draft.id),
                "token": token,
                "full_name": "Setup Check",
                "email": self.participant,
                "street": "Setup check 1",
                "postal_code": "12345",
                "city": "Setup check",
                "country": "DE",
                "account_holder": "Setup Check",
                # The standard example IBAN; no real account.
                "iban": "DE89370400440532013000",
                "bic": "",
                "purpose": "Setup check, not a real claim: do not pay",
                "purpose_details": "",
                "declaration": True,
                "privacy_acknowledged": True,
                "signature": str(files[1].pk),
                "expenses": [
                    {
                        "id": row,
                        "merchant": "Setup check",
                        "receipt_reference": "SETUP-CHECK",
                        "amount": "1,00",
                        "uploads": [str(files[0].pk)],
                    }
                ],
            }
            try:
                claim = submit_claim(participant, form.slug, data, numbered=False)
            except IntakeError as exc:
                return self.report(FAIL, "Test claim", f"Refused: {exc.message} {exc.errors}")
        self.claim_id = claim.pk
        return self.report(OK, f"Test claim {claim.pk} submitted, without a bookkeeping number")

    def checked(self, upload_ids):
        def settled():
            found = list(Upload.objects.filter(pk__in=upload_ids))
            done = len(found) == len(upload_ids)
            return found if done and all(u.state != Upload.State.PENDING for u in found) else None

        found = self.until(settled)
        if found is None:
            codes = set(
                Upload.objects.filter(pk__in=upload_ids)
                .exclude(error_code="")
                .values_list("error_code", flat=True)
            )
            return self.report(
                FAIL,
                "Receipt and signature checks",
                f"Not finished within {self.timeout} s"
                + (f" ({', '.join(sorted(codes))})." if codes else ". Is the worker running jobs?"),
            )
        failed = [upload for upload in found if upload.state == Upload.State.FAILED]
        if failed:
            return self.report(
                FAIL,
                "Receipt and signature checks",
                "; ".join(
                    f"{upload.kind}: {upload.error_code} "
                    f"({intake.message(upload.error_code, intake.message('upload_unchecked'))})"
                    for upload in failed
                ),
            )
        return self.report(OK, "Receipt and signature checked and normalized")

    def follow(self):
        claim = self.until(
            lambda: Claim.objects.filter(
                pk=self.claim_id, state__in=[Claim.State.READY, Claim.State.FAILED]
            ).first()
        )
        if claim is None:
            return self.report(FAIL, "PDF", f"Not created within {self.timeout} s.")
        if claim.state == Claim.State.FAILED:
            return self.report(FAIL, "PDF", f"Creating the PDF failed: {claim.error_code}.")
        pages = claim.pdf_page_count
        self.report(OK, f"PDF created ({pages} page{'s' if pages != 1 else ''})")
        self.finance_email(claim)
        self.confirmation(claim)

    def sent(self, model, claim):
        return self.until(
            lambda: model.objects.filter(claim=claim).exclude(state__in=[PENDING, SENDING]).first()
        )

    def send_problem(self, title, record):
        if record is None:
            return self.report(FAIL, title, f"Not sent within {self.timeout} s.")
        if record.state == PAUSED:
            detail = "MailerSend paused sending for this account; see its dashboard."
        elif record.state == UNKNOWN:
            detail = f"MailerSend gave no clear answer ({record.error_code})."
        else:
            detail = SEND_PROBLEMS.get(record.error_code, f"Sending failed: {record.error_code}.")
        return self.report(FAIL, title, detail)

    def finance_email(self, claim):
        delivery = self.sent(Delivery, claim)
        if delivery is None or delivery.state not in {ACCEPTED, DELIVERED}:
            return self.send_problem("Finance email", delivery)
        if self.local:
            return self.report(OK, f"Finance email to {self.finance} kept in the local outbox")
        self.report(OK, f"MailerSend accepted the Finance email to {self.finance}")
        if not self.until(lambda: self.webhook_received(claim)):
            origin = next(iter(settings.CSRF_TRUSTED_ORIGINS), "https://<your host>")
            return self.report(
                FAIL,
                "MailerSend webhook",
                f"No signed delivery event within {self.timeout} s. Check that the "
                f"webhook URL is {origin}/webhooks/mailersend/ and that "
                "MAILERSEND_WEBHOOK_SIGNING_SECRET is its signing secret.",
            )
        self.report(OK, "MailerSend webhook received, signature verified")
        delivery = self.until(
            lambda: Delivery.objects.filter(claim=claim, state__in=[DELIVERED, FAILED]).first()
        )
        if delivery is None:
            return self.report(FAIL, "Finance inbox", f"No delivery within {self.timeout} s.")
        if delivery.state == FAILED:
            return self.report(FAIL, "Finance inbox", f"MailerSend reports {delivery.error_code}.")
        return self.report(OK, "Finance inbox received the email")

    def webhook_received(self, claim):
        attempts = list(
            DeliveryAttempt.objects.filter(delivery__claim=claim).values_list("pk", "message_id")
        )
        return DeliveryEvent.objects.filter(
            Q(attempt_id__in=[pk for pk, _ in attempts])
            | Q(message_id__in=[message_id for _, message_id in attempts if message_id])
            | Q(attempt_tag__in=[str(pk) for pk, _ in attempts]),
            kind__startswith="activity.",
        ).exists()

    def confirmation(self, claim):
        confirmation = self.sent(Confirmation, claim)
        if confirmation is None or confirmation.state not in {ACCEPTED, DELIVERED}:
            return self.send_problem("Participant confirmation", confirmation)
        where = "kept in the local outbox" if self.local else "accepted by MailerSend"
        return self.report(OK, f"Participant confirmation to {self.participant} {where}")

    def remove(self, form, template):
        deadline = clock() + CLEANUP_SECONDS
        while True:
            try:
                if self.removed(form):
                    form.delete()
                    template.delete()
                    return self.report(OK, "Test claim, form and template deleted")
            except (operations.ActionRefused, retention.ClaimBusy, OSError, ProtectedError):
                pass
            if clock() >= deadline:
                return self.report(
                    FAIL,
                    "Clean-up",
                    f"A job still uses the test claim or form {form.slug}. The worker "
                    "finishes deleting the claim; then delete the form and its template in "
                    "the admin area.",
                )
            pause()

    def removed(self, form):
        """Delete the claim and drafts; True once only the form and template are left."""
        claim = Claim.objects.filter(pk=self.claim_id).first() if self.claim_id else None
        if claim is not None and claim.state == Claim.State.PURGING:
            retention.purge_claim(claim.pk)
        elif claim is not None:
            operations.delete(claim.pk, actor=ACTOR, reason="Setup check finished")
        for draft_id in Draft.objects.filter(form=form).values_list("pk", flat=True):
            uploads.expire_draft(draft_id)
        return not (
            Draft.objects.filter(form=form).exists() or Claim.objects.filter(form=form).exists()
        )
