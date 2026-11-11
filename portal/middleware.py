import uuid
from datetime import datetime

from django.conf import settings
from django.contrib.auth import BACKEND_SESSION_KEY, SESSION_KEY
from django.core.files.uploadhandler import StopUpload, TemporaryFileUploadHandler
from django.http import JsonResponse
from django.utils import timezone

from portal import intake


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
            return JsonResponse({"error": "Ungültige Anfrage."}, status=400)
        cap = (
            settings.MAX_RECEIPT_BYTES + 128_000 if request.path.endswith("/uploads/") else 128_000
        )
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
        response["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        )
        if not request.path.startswith("/static/"):
            response["Cache-Control"] = "no-store, private"
        return response


class RequestContextMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        request.request_id = str(uuid.uuid4())
        response = self.get_response(request)
        response["X-Request-ID"] = request.request_id
        return response
