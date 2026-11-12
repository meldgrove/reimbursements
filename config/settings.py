import os
from pathlib import Path

import dj_database_url
from django.core.exceptions import ImproperlyConfigured

from portal.constants import MAX_IMAGE_PIXELS as MAX_IMAGE_PIXELS
from portal.constants import MAX_NORMALIZED_FILE_BYTES as MAX_NORMALIZED_FILE_BYTES
from portal.constants import MAX_PDF_PAGES as MAX_PDF_PAGES

BASE_DIR = Path(__file__).resolve().parent.parent
PORTAL_OPERATOR = os.getenv("PORTAL_OPERATOR", "")
PORTAL_LEGAL_URL = os.getenv("PORTAL_LEGAL_URL", "")
# Set in release images (Dockerfile); empty in images built from source.
APP_VERSION = os.getenv("APP_VERSION", "")
DEBUG = os.getenv("DJANGO_DEBUG", "0") == "1"
DEPLOYMENT_ENV = os.getenv("DEPLOYMENT_ENV", "development" if DEBUG else "production")
if DEPLOYMENT_ENV not in {"development", "staging", "production"} or DEBUG != (
    DEPLOYMENT_ENV == "development"
):
    raise ImproperlyConfigured("Only explicit development mode may enable DJANGO_DEBUG.")
SECRET_KEY = os.getenv("DJANGO_SECRET_KEY", "development-only-do-not-use-in-production")
ALLOWED_HOSTS = os.getenv("ALLOWED_HOSTS", "localhost,127.0.0.1,testserver").split(",")
CSRF_TRUSTED_ORIGINS = list(filter(None, os.getenv("CSRF_TRUSTED_ORIGINS", "").split(",")))
ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
INSTALLED_APPS = [
    "portal",
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "mozilla_django_oidc",
]
MIDDLEWARE = [
    "portal.middleware.RequestContextMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "portal.middleware.AppSettingsMiddleware",
    "portal.middleware.RequestLimitsMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "portal.middleware.AdminSessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "portal.middleware.PrivateResponseMiddleware",
]
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "portal.context_processors.branding",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ]
        },
    }
]

# Admin sign-in through Keycloak. Admin rights come from the groups claim.
OIDC_RP_CLIENT_ID = os.getenv("OIDC_CLIENT_ID", "")
OIDC_RP_CLIENT_SECRET = os.getenv("OIDC_CLIENT_SECRET", "")
OIDC_ENABLED = bool(OIDC_RP_CLIENT_ID and OIDC_RP_CLIENT_SECRET)
KEYCLOAK_BASE_URL = os.getenv(
    "KEYCLOAK_BASE_URL", "https://auth.example.invalid" if DEBUG else ""
).rstrip("/")
KEYCLOAK_REALM = os.getenv("KEYCLOAK_REALM", "reimbursements" if DEBUG else "")
KEYCLOAK_REALM_URL = f"{KEYCLOAK_BASE_URL}/realms/{KEYCLOAK_REALM}"
# Where admins manage their Keycloak account (profile menu in the admin sidebar).
KEYCLOAK_ACCOUNT_URL = f"{KEYCLOAK_REALM_URL}/account/"
KEYCLOAK_ADMIN_GROUP = os.getenv("KEYCLOAK_ADMIN_GROUP", "/reimbursements/admins")
KEYCLOAK_EDITOR_GROUP = os.getenv("KEYCLOAK_EDITOR_GROUP", "/reimbursements/editors")
OIDC_OP_AUTHORIZATION_ENDPOINT = f"{KEYCLOAK_REALM_URL}/protocol/openid-connect/auth"
OIDC_OP_TOKEN_ENDPOINT = f"{KEYCLOAK_REALM_URL}/protocol/openid-connect/token"
OIDC_OP_USER_ENDPOINT = f"{KEYCLOAK_REALM_URL}/protocol/openid-connect/userinfo"
OIDC_OP_JWKS_ENDPOINT = f"{KEYCLOAK_REALM_URL}/protocol/openid-connect/certs"
OIDC_OP_LOGOUT_ENDPOINT = f"{KEYCLOAK_REALM_URL}/protocol/openid-connect/logout"
OIDC_OP_LOGOUT_URL_METHOD = "portal.auth.keycloak_logout_url"
OIDC_RP_SIGN_ALGO = "RS256"
OIDC_RP_SCOPES = "openid email profile"
OIDC_USE_PKCE = True
OIDC_PKCE_CODE_CHALLENGE_METHOD = "S256"
OIDC_STORE_ACCESS_TOKEN = False
# The ID token is the logout hint; without it Keycloak keeps the SSO session.
OIDC_STORE_ID_TOKEN = True
OIDC_TIMEOUT = (3, 10)
OIDC_CALLBACK_CLASS = "portal.auth.AdminCallbackView"
AUTHENTICATION_BACKENDS = ["portal.auth.KeycloakBackend"]
if DEBUG:
    # Local development without Keycloak: `manage.py createsuperuser`.
    AUTHENTICATION_BACKENDS.append("django.contrib.auth.backends.ModelBackend")
LOGIN_URL = "admin:login"
LOGIN_REDIRECT_URL = "/admin/"
LOGIN_REDIRECT_URL_FAILURE = "/admin/no-access/"
LOGOUT_REDIRECT_URL = "/"
ADMIN_SESSION_SECONDS = 8 * 3600
PRIVATE_STORAGE_ROOT = Path(os.getenv("PRIVATE_STORAGE_ROOT", str(BASE_DIR / "var/private")))
PRIVATE_STORAGE_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
FILE_UPLOAD_TEMP_DIR = str(PRIVATE_STORAGE_ROOT / "incoming")
Path(FILE_UPLOAD_TEMP_DIR).mkdir(exist_ok=True, mode=0o700)
DATABASES = {
    "default": dj_database_url.parse(
        os.getenv("DATABASE_URL", f"sqlite:///{BASE_DIR / 'var/development.sqlite3'}"),
        conn_max_age=60,
    )
}
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
# The app language, timezone and date format are General settings in the admin area
# (portal.app_settings). These are the defaults before they are saved.
LANGUAGE_CODE = "de"
LANGUAGES = [("de", "Deutsch"), ("en", "English")]
TIME_ZONE = "Europe/Berlin"
USE_TZ = True
FORMAT_MODULE_PATH = ["portal.formats"]
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
}
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
SESSION_COOKIE_AGE = 7 * 24 * 3600
SESSION_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_SECURE = not DEBUG
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"
SECURE_SSL_REDIRECT = not DEBUG
SECURE_HSTS_SECONDS = 31536000 if not DEBUG else 0
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
# Enable only behind the deployment's trusted proxy, which must replace this header.
if os.getenv("TRUST_PROXY_HEADERS", "0") == "1":
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
X_FRAME_OPTIONS = "DENY"
DATA_UPLOAD_MAX_MEMORY_SIZE = 128 * 1024
# Admin forms with inline template fields post a few hundred fields.
DATA_UPLOAD_MAX_NUMBER_FIELDS = 400
DATA_UPLOAD_MAX_NUMBER_FILES = 1
FILE_UPLOAD_MAX_MEMORY_SIZE = 0
FILE_UPLOAD_HANDLERS = ["portal.middleware.BoundedUploadHandler"]
MAX_RECEIPT_BYTES = 10_000_000
MAX_SUBMISSION_BYTES = 50_000_000
MAX_SIGNATURE_BYTES = 1_000_000
MAX_FINAL_PDF_BYTES = int(os.getenv("MAX_FINAL_PDF_BYTES", "10000000"))
MAX_EXPENSES = 30
MAX_FILES_PER_EXPENSE = 3
MAX_CLAIM_PAGES = 100
MAX_DRAFT_DERIVED_BYTES = 100_000_000
MAX_RENDER_WORKSPACE_BYTES = 600_000_000
MAX_UPLOADS_PER_DRAFT = 200
MAX_UPLOAD_BYTES_PER_DRAFT = 150_000_000
# One client network can keep the shared validation queue busy for about as long as
# its daily upload budget lasts. Size it for one venue, not for many.
MAX_UPLOADS_PER_NETWORK = int(os.getenv("MAX_UPLOADS_PER_NETWORK", "5000"))
MAX_UPLOAD_BYTES_PER_NETWORK = int(os.getenv("MAX_UPLOAD_BYTES_PER_NETWORK", "15000000000"))
MAX_UPLOADS_PER_NETWORK_PER_MINUTE = int(os.getenv("MAX_UPLOADS_PER_NETWORK_PER_MINUTE", "1000"))
MAX_PENDING_VALIDATIONS = int(os.getenv("MAX_PENDING_VALIDATIONS", "1000"))
# The synchronous gunicorn workers of the web service.
TOTAL_WEB_WORKERS = int(os.getenv("TOTAL_WEB_WORKERS", "2"))
if TOTAL_WEB_WORKERS < 1:
    raise ImproperlyConfigured("TOTAL_WEB_WORKERS must be a positive integer.")
UPLOAD_TEMP_HEADROOM_BYTES = TOTAL_WEB_WORKERS * (MAX_RECEIPT_BYTES + 128_000)
DOCUMENT_SANDBOX_ENABLED = os.getenv("DOCUMENT_SANDBOX_ENABLED", "1") == "1"
MAX_JOB_AGE_SECONDS = int(os.getenv("MAX_JOB_AGE_SECONDS", "900"))
REQUIRE_WORKER_HEARTBEAT = os.getenv("REQUIRE_WORKER_HEARTBEAT", "1" if not DEBUG else "0") == "1"
# Far above one network's draft budget: otherwise a few client networks can open every
# available draft and turn all new participants away.
MAX_ACTIVE_DRAFTS = int(os.getenv("MAX_ACTIVE_DRAFTS", "10000"))
MAX_DRAFTS_PER_NETWORK = int(os.getenv("MAX_DRAFTS_PER_NETWORK", "300"))
TRUSTED_PROXY_CIDRS = list(filter(None, os.getenv("TRUSTED_PROXY_CIDRS", "").split(",")))
MIN_FREE_STORAGE_BYTES = int(os.getenv("MIN_FREE_STORAGE_BYTES", "1000000000"))
JOB_TIMEOUT_SECONDS = int(os.getenv("JOB_TIMEOUT_SECONDS", "240"))
JOB_LEASE_SECONDS = JOB_TIMEOUT_SECONDS + 120
# After delivery the PDF is deleted after PDF_RETENTION_DAYS; all other claim content
# CONTENT_RETENTION_DAYS after submission. The privacy notice states both periods, so
# they are fixed here rather than read from the environment.
PDF_RETENTION_DAYS = 7
CONTENT_RETENTION_DAYS = 90
UPLOAD_SCANNER = os.getenv("UPLOAD_SCANNER", "disabled" if DEBUG else "clamav")
CLAMAV_HOST = os.getenv("CLAMAV_HOST", "scanner")
CLAMAV_PORT = int(os.getenv("CLAMAV_PORT", "3310"))
MAIL_DELIVERY_MODE = os.getenv("MAIL_DELIVERY_MODE", "local" if DEBUG else "mailersend")
MAILERSEND_API_TOKEN = os.getenv("MAILERSEND_API_TOKEN", "")
MAILERSEND_WEBHOOK_SIGNING_SECRET = os.getenv("MAILERSEND_WEBHOOK_SIGNING_SECRET", "")
# Shared by all forms; verify the sender domain in MailerSend.
MAIL_FROM_ADDRESS = os.getenv("MAIL_FROM_ADDRESS", "no-reply@example.invalid" if DEBUG else "")
MAIL_REPLY_TO_ADDRESS = os.getenv(
    "MAIL_REPLY_TO_ADDRESS", "finance@example.invalid" if DEBUG else ""
)
APPROVED_DELIVERY_RECIPIENTS = list(
    filter(
        None,
        os.getenv("APPROVED_DELIVERY_RECIPIENTS", "finance@example.invalid" if DEBUG else "")
        .lower()
        .split(","),
    )
)
TEST_RECIPIENT_ALLOWLIST = list(
    filter(None, os.getenv("TEST_RECIPIENT_ALLOWLIST", "").lower().split(","))
)
HEALTHCHECK_TOKEN = os.getenv("HEALTHCHECK_TOKEN", "")
REDACTED_LOG_FORMAT = "{levelname} {name} {message}"
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "safe": {
            "()": "portal.logging.RedactedExceptionFormatter",
            "format": REDACTED_LOG_FORMAT,
            "style": "{",
        }
    },
    "filters": {"request": {"()": "portal.logging.SafeRequestFilter"}},
    "handlers": {
        "console": {"class": "logging.StreamHandler", "formatter": "safe"},
        "requests": {"class": "logging.StreamHandler", "formatter": "safe", "filters": ["request"]},
    },
    "root": {"handlers": ["console"], "level": "INFO"},
    "loggers": {
        "django.request": {"handlers": ["requests"], "level": "WARNING", "propagate": False},
        "django.security": {"handlers": ["requests"], "level": "WARNING", "propagate": False},
        "httpx": {"level": "WARNING"},
    },
}
if not DEBUG:
    if not REQUIRE_WORKER_HEARTBEAT:
        raise ImproperlyConfigured("Production requires worker heartbeat checks.")
    required = [
        "DJANGO_SECRET_KEY",
        "DATABASE_URL",
        "ALLOWED_HOSTS",
        "HEALTHCHECK_TOKEN",
        "MAILERSEND_API_TOKEN",
        "MAILERSEND_WEBHOOK_SIGNING_SECRET",
        "APPROVED_DELIVERY_RECIPIENTS",
        "OIDC_CLIENT_ID",
        "OIDC_CLIENT_SECRET",
        "KEYCLOAK_BASE_URL",
        "KEYCLOAK_REALM",
        "MAIL_FROM_ADDRESS",
        "MAIL_REPLY_TO_ADDRESS",
    ]
    missing = [key for key in required if not os.getenv(key)]
    if (
        missing
        or SECRET_KEY.startswith("development-")
        or len(SECRET_KEY) < 50
        or len(set(SECRET_KEY)) < 5
    ):
        raise ImproperlyConfigured(f"Missing production configuration: {', '.join(missing)}")
    if DATABASES["default"]["ENGINE"] != "django.db.backends.postgresql":
        raise ImproperlyConfigured("Production requires PostgreSQL.")
    if UPLOAD_SCANNER != "clamav" or MAIL_DELIVERY_MODE != "mailersend":
        raise ImproperlyConfigured("Production requires ClamAV and MailerSend.")
    if not DOCUMENT_SANDBOX_ENABLED:
        raise ImproperlyConfigured("Production requires the document sandbox.")
    if os.getenv("TRUST_PROXY_HEADERS", "0") == "1" and not TRUSTED_PROXY_CIDRS:
        raise ImproperlyConfigured("Trusted proxy headers require TRUSTED_PROXY_CIDRS.")
    if DEPLOYMENT_ENV == "staging" and not TEST_RECIPIENT_ALLOWLIST:
        raise ImproperlyConfigured("Staging requires TEST_RECIPIENT_ALLOWLIST.")

# HSTS preload enrollment is an independent domain-owner decision.
SILENCED_SYSTEM_CHECKS = ["security.W021"]

# Error reports to Sentry or a compatible service: off without SENTRY_DSN.
SENTRY_DSN = os.getenv("SENTRY_DSN", "")
if SENTRY_DSN:
    from portal import error_reporting

    error_reporting.start(
        dsn=SENTRY_DSN,
        environment=os.getenv("SENTRY_ENVIRONMENT") or DEPLOYMENT_ENV,
        release=os.getenv("SENTRY_RELEASE")
        or (f"reimbursements@{APP_VERSION}" if APP_VERSION else None),
    )
