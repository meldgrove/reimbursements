"""MailerSend: the deployment transport adapter, message lookup and webhook signatures."""

import base64
import hashlib
import hmac
import re

import httpx
from django.conf import settings

from portal.services.transport import ACCEPTED, FAILED, PAUSED, PENDING, UNKNOWN, SendResult


def client():
    return httpx.Client(
        base_url="https://api.mailersend.com/v1/",
        headers={
            "Authorization": f"Bearer {settings.MAILERSEND_API_TOKEN}",
            "Accept": "application/json",
        },
        timeout=httpx.Timeout(30, connect=10),
    )


class MailerSendTransport:
    """Deployment transport: the MailerSend email API."""

    def send(self, message):
        payload = {
            "from": {"email": message.sender, "name": settings.PORTAL_NAME},
            "to": [{"email": message.recipient}],
            "reply_to": {"email": message.reply_to},
            "subject": message.subject,
            "text": message.text,
            "tags": ["reimbursements", f"attempt-{message.attempt_id}"],
            "settings": {"track_opens": False, "track_clicks": False, "track_content": False},
        }
        if message.attachment is not None:
            payload["attachments"] = [
                {
                    "content": base64.b64encode(message.attachment).decode("ascii"),
                    "filename": message.filename,
                    "disposition": "attachment",
                }
            ]
        try:
            with client() as provider:
                response = provider.post("email", json=payload)
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout):
            # Connection failures known to precede acceptance can retry.
            return SendResult(PENDING, error_code="provider_connection", retry_after=60)
        except httpx.TransportError:
            return SendResult(UNKNOWN, error_code="provider_outcome_unknown")
        if response.status_code == 429:
            try:
                delay = min(3600, max(60, int(response.headers.get("retry-after", "60"))))
            except ValueError:
                delay = 60
            return SendResult(PENDING, error_code="provider_throttled", retry_after=delay)
        if response.status_code >= 500:
            return SendResult(UNKNOWN, error_code="provider_outcome_unknown")
        if response.status_code != 202:
            return SendResult(FAILED, error_code="provider_rejected")
        try:
            warnings = response.json().get("warnings", []) if response.content else []
        except (ValueError, AttributeError):
            return SendResult(UNKNOWN, error_code="provider_response_invalid")
        if any(
            warning.get("type") in {"ALL_SUPPRESSED", "SOME_SUPPRESSED"} for warning in warnings
        ):
            return SendResult(FAILED, error_code="recipient_suppressed")
        message_id = response.headers.get("x-message-id", "")
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", message_id):
            return SendResult(UNKNOWN, error_code="provider_message_id_missing")
        paused = response.headers.get("x-send-paused", "").lower() == "true"
        return SendResult(PAUSED if paused else ACCEPTED, message_id)


WEBHOOK_TEST_SECRET = "test_Am3L1GuOIc4blLUuHqAPxxwkZaJyEk8G"


def verify_webhook(raw_body, signature, *, test=False):
    secret = WEBHOOK_TEST_SECRET if test else settings.MAILERSEND_WEBHOOK_SIGNING_SECRET
    if not secret or not isinstance(signature, str):
        return False
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


def retrieve_message(message_id):
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", message_id):
        return None
    try:
        with client() as provider:
            response = provider.get(f"messages/{message_id}")
            response.raise_for_status()
            return response.json().get("data")
    except (httpx.HTTPError, ValueError):
        return None


def message_snapshot(message):
    """Only interpret explicitly documented email statuses, never an empty emails list."""
    if not isinstance(message, dict):
        return None
    emails = message.get("emails")
    if not isinstance(emails, list):
        return None
    for email in emails:
        if not isinstance(email, dict):
            continue
        status = email.get("status")
        if status == "rejected":
            # Rejection is terminal even when no webhook/activity was recorded.
            # Prefer documented suppression or bounce details when available.
            reason = email.get("suppression_reason")
            activities = email.get("activity") or []
            kinds = (
                {item.get("type") for item in activities if isinstance(item, dict)}
                if isinstance(activities, list)
                else set()
            )
            if reason == "hard_bounced" or "hard_bounced" in kinds:
                status = "hard_bounced"
            elif (
                reason in {"on_hold", "unsubscribed", "spam_complained", "blocklisted"}
                or "suppressed" in kinds
            ):
                status = "suppressed"
        if status in {
            "delivered",
            "hard_bounced",
            "soft_bounced",
            "suppressed",
            "sent",
            "queued",
            "rejected",
        }:
            return {
                "status": status,
                "recipient": email.get("to")
                or (
                    email.get("recipient", {}).get("email")
                    if isinstance(email.get("recipient"), dict)
                    else email.get("recipient")
                ),
                "id": email.get("id", ""),
            }
    return None
