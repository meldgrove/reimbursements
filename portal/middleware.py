import uuid
from datetime import datetime

from django.conf import settings
from django.contrib.auth import BACKEND_SESSION_KEY, SESSION_KEY
from django.core.files.uploadhandler import StopUpload, TemporaryFileUploadHandler
from django.http import JsonResponse
from django.utils import timezone

from portal import app_settings, intake
from portal.i18n import t
from portal.models import AppSettings

CONTENT_SECURITY_POLICY = (
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; "
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
)
# Responses anyone may cache: static files and the favicon.
PUBLIC_PATHS = ("/static/", "/favicon/")


class AdminSessionMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.session.get(SESSION_KEY) and request.session.get(BACKEND_SESSION_KEY) == (
            "portal.auth.KeycloakBackend"
        ):
            try:
                expiry = datetime.fromisoformat(request.session.get("_session_expiry"))
            except (TypeError, ValueError):
                expiry = None
            if expiry is None or timezone.is_naive(expiry) or expiry <= timezone.now():
                # Old inactivity-based sessions must reauthenticate before any session write.
                request.session.flush()
        return self.get_response(request)


class BoundedUploadHandler(TemporaryFileUploadHandler):
    def receive_data_chunk(self, raw_data, start):
        if start + len(raw_data) > settings.MAX_RECEIPT_BYTES:
            self.request.upload_limit_exceeded = True
            raise StopUpload(connection_reset=True)
        return super().receive_data_chunk(raw_data, start)


class RequestLimitsMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        try:
            length = int(request.META.get("CONTENT_LENGTH") or 0)
        except ValueError:
            return JsonResponse({"error": t("Invalid request.")}, status=400)
        if request.path.endswith("/uploads/"):
            cap = settings.MAX_RECEIPT_BYTES + 128_000
        elif request.path.startswith(app_settings.GENERAL_SETTINGS_PATH):
            cap = 1_000_000
        else:
            cap = 128_000
        if length > cap:
            return JsonResponse({"error": intake.message("request_too_large")}, status=413)
        return self.get_response(request)


class PrivateResponseMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        response["X-Frame-Options"] = "DENY"
        response["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        # A view may set a stricter policy, as the favicon does.
        response.headers.setdefault("Content-Security-Policy", CONTENT_SECURITY_POLICY)
        if not request.path.startswith(PUBLIC_PATHS):
            response["Cache-Control"] = "no-store, private"
        return response


class AppSettingsMiddleware:
    """Applies the General settings: the language, timezone and date format."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path.startswith("/-/"):
            # Health checks answer without the database.
            return self.get_response(request)
        general = AppSettings.load()
        language = app_settings.request_language(request, general)
        request.app_settings, request.LANGUAGE_CODE = general, language
        with app_settings.applied(general, language):
            response = self.get_response(request)
        response.headers.setdefault("Content-Language", language)
        return response


class RequestContextMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        request.request_id = str(uuid.uuid4())
        response = self.get_response(request)
        response["X-Request-ID"] = request.request_id
        return response
