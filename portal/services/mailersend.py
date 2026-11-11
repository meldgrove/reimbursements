"""MailerSend: the deployment transport adapter and its delivery evidence.

Webhooks and message lookups become `Evidence` here; MailerSend's payloads, event and
status names and the attempt tag format stay in this module.
"""

import base64
import hashlib
import hmac
import re
from dataclasses import dataclass
from datetime import datetime

import httpx
from django.conf import settings
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from portal.constants import APP_NAME
from portal.services.transport import (
    ACCEPTED,
    DELIVERED,
    FAILED,
    PAUSED,
    PENDING,
    UNKNOWN,
    SendResult,
)

# What each webhook event ("activity.*") or looked-up status ("reconciliation.*") shows.
EVIDENCE_STATES = {
    "activity.sent": ACCEPTED,
    "activity.delivered": DELIVERED,
    "activity.deferred": ACCEPTED,
    "activity.soft_bounced": ACCEPTED,
    "activity.hard_bounced": FAILED,
    "activity.suppressed": FAILED,
    "reconciliation.queued": ACCEPTED,
    "reconciliation.sent": ACCEPTED,
    "reconciliation.delivered": DELIVERED,
    "reconciliation.soft_bounced": ACCEPTED,
    "reconciliation.hard_bounced": FAILED,
    "reconciliation.suppressed": FAILED,
    "reconciliation.rejected": FAILED,
}
# Evidence that the provider has the message, without saying more than that.
RESOLVES_UNKNOWN_ONLY = frozenset({"reconciliation.queued"})
ATTEMPT_TAG = "attempt-"


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
            "from": {"email": message.sender, "name": APP_NAME},
            "to": [{"email": message.recipient}],
            "reply_to": {"email": message.reply_to},
            "subject": message.subject,
            "text": message.text,
            "tags": ["reimbursements", f"{ATTEMPT_TAG}{message.attempt_id}"],
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


@dataclass(frozen=True)
class Evidence:
    """What MailerSend says about one message. `kind` names the event or status."""

    kind: str
    # Unique per piece of evidence, so a repeated webhook is recorded once.
    provider_id: str
    timestamp: datetime
    message_id: str
    recipient: str
    # The attempt that sent the message, from its tag; empty when unknown.
    attempt_id: str = ""


def outcome(kind):
    """The attempt state that evidence of `kind` shows, its error code, and whether it may
    only resolve an unknown outcome."""
    state = EVIDENCE_STATES[kind]
    error_code = f"provider_{kind.rsplit('.', 1)[-1]}" if state == FAILED else ""
    return state, error_code, kind in RESOLVES_UNKNOWN_ONLY


def webhook_evidence(data):
    """Evidence from a verified webhook payload, or None for an event that is not evidence.

    Raises ValueError for a malformed payload.
    """
    body = data.get("data", {})
    timestamp = parse_datetime(data.get("created_at", ""))
    provider_id = body.get("id")
    recipient = body.get("recipient")
    if data.get("type") not in EVIDENCE_STATES or data["type"].startswith("reconciliation."):
        return None
    if (
        not isinstance(provider_id, str)
        or not 1 <= len(provider_id) <= 100
        or not isinstance(recipient, str)
        or len(recipient) > 254
        or not timestamp
        or timezone.is_naive(timestamp)
    ):
        raise ValueError("invalid_event")
    tags = body.get("tags", [])
    attempt_id = (
        next(
            (
                tag.removeprefix(ATTEMPT_TAG)
                for tag in tags
                if isinstance(tag, str) and tag.startswith(ATTEMPT_TAG) and len(tag) == 44
            ),
            "",
        )
        if isinstance(tags, list)
        else ""
    )
    message_id = body.get("message_id", "")
    if not isinstance(message_id, str) or len(message_id) > 100:
        raise ValueError("invalid_event")
    return Evidence(data["type"], provider_id, timestamp, message_id, recipient, attempt_id)


class LookupFailed(Exception):
    """MailerSend could not be asked about a message."""


def lookup(attempt_id, message_id):
    """Evidence from asking MailerSend about a sent message; None while it has no answer.

    Raises LookupFailed when the lookup itself fails.
    """
    message = retrieve_message(message_id)
    if message is None:
        raise LookupFailed
    snapshot = message_snapshot(message)
    if not snapshot or not snapshot.get("recipient"):
        return None
    status = snapshot["status"]
    return Evidence(
        kind=f"reconciliation.{status}",
        provider_id=f"reconcile-{attempt_id}-{status}",
        timestamp=timezone.now(),
        message_id=message_id,
        recipient=snapshot["recipient"],
    )
