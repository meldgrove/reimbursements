"""Check production startup/deployment controls using inert CI-only settings."""

import os
import secrets
import subprocess
import sys

environment = os.environ | {
    "DJANGO_SETTINGS_MODULE": "config.settings",
    "DJANGO_DEBUG": "0",
    "DEPLOYMENT_ENV": "staging",
    "DJANGO_SECRET_KEY": secrets.token_urlsafe(64),
    "DATABASE_URL": "postgresql://ci:ci@localhost/ci",
    "ALLOWED_HOSTS": "localhost",
    "CSRF_TRUSTED_ORIGINS": "https://localhost",
    "MAILERSEND_API_TOKEN": "ci-only-never-sent",
    "MAILERSEND_WEBHOOK_SIGNING_SECRET": "ci-only-never-sent",
    "APPROVED_DELIVERY_RECIPIENTS": "ci@example.invalid",
    "TEST_RECIPIENT_ALLOWLIST": "ci@example.invalid",
    "HEALTHCHECK_TOKEN": "ci-only",
    "OIDC_CLIENT_ID": "ci-only",
    "OIDC_CLIENT_SECRET": "ci-only-never-sent",
    "KEYCLOAK_BASE_URL": "https://auth.example.invalid",
    "KEYCLOAK_REALM": "reimbursements",
    "MAIL_FROM_ADDRESS": "no-reply@example.invalid",
    "MAIL_REPLY_TO_ADDRESS": "finance@example.invalid",
    "UPLOAD_SCANNER": "clamav",
    "MAIL_DELIVERY_MODE": "mailersend",
    "REQUIRE_WORKER_HEARTBEAT": "1",
    "DOCUMENT_SANDBOX_ENABLED": "1",
}
raise SystemExit(
    subprocess.call(
        [sys.executable, "manage.py", "check", "--deploy", "--fail-level", "WARNING"],
        env=environment,
    )
)
