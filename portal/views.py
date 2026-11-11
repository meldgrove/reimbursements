import json
import secrets
from functools import wraps

from django.conf import settings
from django.db import connection
from django.http import Http404, HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt, ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from portal import app_settings, dates, intake
from portal.constants import PAYMENT_TIMING
from portal.forms import ClaimForm
from portal.i18n import t
from portal.intake import IntakeError
from portal.models import Claim, Form, PrivacyNotice
from portal.participants import RequestParticipant
from portal.roles import manages
from portal.services import claim_status, claim_validation, delivery, drafts, uploads
from portal.services.capacity import storage_available
from portal.services.drafts import open_draft
from portal.services.mailersend import verify_webhook, webhook_evidence
from portal.services.readiness import dependencies
from portal.services.storage import check_writable
from portal.services.submissions import submit_claim


def api_errors(view):
    @wraps(view)
    def wrapped(request, *args, **kwargs):
        try:
            return view(request, *args, **kwargs)
        except IntakeError as exc:
            return JsonResponse({"error": exc.message, "fields": exc.errors}, status=exc.status)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return JsonResponse({"error": t("Invalid request.")}, status=400)

    return wrapped


@require_GET
def index(request):
    primary = Form.objects.select_related("template").filter(primary=True).first()
    if primary and primary.is_open():
        return redirect("form_page", form_slug=primary.slug)
    return render(request, "portal/index.html")


@require_GET
def privacy(request):
    return render(request, "portal/privacy.html", {"notice": PrivacyNotice.current()})


@require_GET
@ensure_csrf_cookie
def form_page(request, form_slug):
    form = get_object_or_404(Form.objects.select_related("template"), slug=form_slug)
    # Owners can look at a form before it opens; nothing can be uploaded or submitted.
    preview = not form.is_open() and manages(request.user, form)
    if not form.is_open() and not preview:
        return render(request, "portal/closed.html", {"form": form}, status=403)
    draft, token = None, ""
    if not preview:
        try:
            draft, token = open_draft(RequestParticipant(request), form)
        except IntakeError as exc:
            return render(
                request,
                "portal/closed.html",
                {"form": form, "message": exc.message},
                status=exc.status,
            )
    template = form.template
    notice = PrivacyNotice.current()
    claim_form = ClaimForm(
        form=form, initial={"trip_start": form.trip_start, "trip_end": form.trip_end}
    )
    configuration = {
        "draft_id": str(draft.id) if draft else "",
        "token": token,
        "preview": preview,
        "travel": template.travel,
        "mileage_rate": str(template.mileage_rate) if template.mileage_enabled else None,
        "purpose_options": bool(form.purpose_choices()),
        "fixed_purpose": claim_form.fixed_purpose,
        "trip_start": form.trip_start.isoformat() if form.trip_start else "",
        "trip_end": form.trip_end.isoformat() if form.trip_end else "",
        "upload_url": reverse("upload", kwargs={"form_slug": form.slug}),
        "submit_url": reverse("submit", kwargs={"form_slug": form.slug}),
        "validate_url": reverse("validate_claim", kwargs={"form_slug": form.slug}),
        "date_format": dates.active().script,
        **intake.client_config(),
    }
    return render(
        request,
        "portal/form.html",
        {
            "form": form,
            "template": template,
            "claim_form": claim_form,
            "privacy_notice": notice,
            "configuration": configuration,
            "intake_messages": intake.messages(),
            "amount_pattern": intake.AMOUNT_PATTERN,
            "field_lengths": intake.EXPENSE_FIELD_LENGTHS,
            "max_distance_km": intake.MAX_DISTANCE_KM,
            "development": settings.DEBUG,
            "preview": preview,
        },
    )


@require_POST
@api_errors
def upload(request, form_slug):
    # Parsing the body sets the flag when the bounded upload handler stopped it.
    file = request.FILES.get("file")
    item = uploads.accept(
        RequestParticipant(request),
        form_slug,
        file=file,
        truncated=getattr(request, "upload_limit_exceeded", False),
        kind=request.POST.get("kind", "receipt"),
        expense_id=request.POST.get("expense_id"),
        draft_id=request.POST.get("draft_id"),
        token=request.POST.get("token"),
    )
    return JsonResponse(
        {
            "id": str(item.id),
            "state": item.state,
            "name": item.original_name,
            "size": item.size,
            "status_url": reverse(
                "upload_status", kwargs={"form_slug": form_slug, "upload_id": item.id}
            ),
            "delete_url": reverse(
                "upload_remove", kwargs={"form_slug": form_slug, "upload_id": item.id}
            ),
        },
        status=202,
    )


def draft_token(request):
    """The form script sends the draft token with every request about an upload."""
    return request.headers.get("X-Draft-Token")


@require_GET
@api_errors
def upload_status(request, form_slug, upload_id):
    upload = uploads.owned(RequestParticipant(request), form_slug, upload_id, draft_token(request))
    return JsonResponse(uploads.status(upload))


@require_http_methods(["DELETE"])
@api_errors
def upload_remove(request, form_slug, upload_id):
    uploads.discard(RequestParticipant(request), form_slug, upload_id, draft_token(request))
    return JsonResponse({"removed": True})


@require_POST
@api_errors
def validate_claim(request, form_slug):
    """Validate current entries without saving them or requiring a signature."""
    data = json.loads(request.body)
    if not isinstance(data, dict):
        raise IntakeError(t("Invalid request."))
    _draft, form = drafts.gate(
        RequestParticipant(request),
        form_slug,
        data.get("draft_id"),
        draft_token(request),
        drafts.REVIEW,
    )
    return JsonResponse({"fields": claim_validation.review(data, form).errors})


@require_POST
@api_errors
def submit(request, form_slug):
    data = json.loads(request.body)
    claim = submit_claim(RequestParticipant(request), form_slug, data)
    return JsonResponse(
        {
            "reference": claim.reference,
            "receipt_url": reverse("received", kwargs={"claim_id": claim.id}),
        },
        status=202,
    )


@require_GET
def received(request, claim_id):
    claim = get_object_or_404(
        claim_status.annotate(Claim.objects.select_related("form", "delivery")),
        pk=claim_id,
        accepted_draft__session_hash=RequestParticipant(request).binding(),
    )
    current = claim_status.of(claim)
    status, final = current.outcome, current.final
    if request.GET.get("format") == "json":
        return JsonResponse({"reference": claim.reference, "state": status, "final": final})
    return render(
        request,
        "portal/received.html",
        {
            "claim": claim,
            "status": status,
            "final": final,
            "form": claim.form,
            "payment_timing": t(PAYMENT_TIMING),
            "status_text": {
                "processing": t("Your claim is being processed and sent to Finance."),
                "problem": t(
                    "There was a problem processing your claim. It stays saved; please do not "
                    "submit it again, but contact us with your reference."
                ),
                "delivered": t("Your claim was sent to Finance."),
                "unavailable": t(
                    "The status is unavailable right now. Your claim stays saved; please do "
                    "not submit it again."
                ),
                "reload": t("Reload this page later to check the current status."),
            },
        },
    )


@require_GET
def favicon(request, digest):
    """The favicon from the General settings. Its link names the digest of its content."""
    general = app_settings.current(request)
    if not general.favicon_digest:
        raise Http404
    response = HttpResponse(bytes(general.favicon), content_type=general.favicon_type)
    # An SVG favicon opened on its own must not run anything.
    response["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    if digest == general.favicon_digest:
        response["Cache-Control"] = "public, max-age=31536000, immutable"
    else:
        response["Cache-Control"] = "public, no-cache"
    return response


@csrf_exempt
@require_POST
def mailersend_webhook(request):
    try:
        raw = request.body
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError
        test = data.get("type") == "webhook.test"
        if not verify_webhook(raw, request.headers.get("Signature", ""), test=test):
            return JsonResponse({"error": "invalid_signature"}, status=401)
        if not test and (evidence := webhook_evidence(data)):
            delivery.record_evidence(evidence)
    except (ValueError, TypeError, AttributeError, KeyError):
        return JsonResponse({"error": "invalid_event"}, status=400)
    return JsonResponse({"received": True})


def health_authorized(request):
    return settings.DEBUG or bool(
        settings.HEALTHCHECK_TOKEN
        and secrets.compare_digest(
            request.headers.get("X-Health-Token", ""), settings.HEALTHCHECK_TOKEN
        )
    )


@require_GET
def healthz(request):
    if not health_authorized(request):
        raise Http404
    return JsonResponse({"status": "OK", "timestamp": timezone.now().isoformat()})


@require_GET
def readyz(request):
    if not health_authorized(request):
        raise Http404
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
        if not storage_available():
            raise OSError
        check_writable()
        checks, age = dependencies()
        if not all(checks.values()):
            return JsonResponse(
                {"status": "unavailable", "checks": checks, "oldest_job_age_seconds": age},
                status=503,
            )
    except Exception:
        return JsonResponse({"status": "unavailable"}, status=503)
    return JsonResponse({"status": "OK", "checks": checks, "oldest_job_age_seconds": age})
