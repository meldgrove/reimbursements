"""The updater service's API (docs/updates.md), for the admins' update button and the
Updates tab.

Each call returns an `Answer`: the HTTP status for the app's route and the
`UpdatesResponse` it sends. The updater refusing a request (any error answer) becomes
409 with its `error` and the latest status. No answer, or an answer that is not the
updater's, is 200 with `reachable: false`; so is an empty `UPDATER_URL`, without a call.
"""

import re
from dataclasses import dataclass

import httpx
from django.conf import settings

# Seconds. A check runs up to 30 s in the updater; saving a channel checks as well.
STATUS_TIMEOUT, CHECK_TIMEOUT, INSTALL_TIMEOUT, CHANNEL_TIMEOUT = 3, 35, 10, 35
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(-preview\.[0-9]+)?|sha256:[0-9a-f]{12}")
CHANNELS = ("stable", "preview")
MODES = ("host", "platform", "off")


@dataclass(frozen=True)
class Answer:
    status_code: int
    reachable: bool
    updater: dict | None = None
    error: str | None = None

    def body(self):
        return {
            "app": {"version": settings.APP_VERSION or None},
            "reachable": self.reachable,
            "updater": self.updater,
            "error": self.error,
        }


def client():
    return httpx.Client(base_url=settings.UPDATER_URL, headers={"Accept": "application/json"})


def status():
    return _call("GET", "/v1/status", STATUS_TIMEOUT)


def check():
    return _call("POST", "/v1/check", CHECK_TIMEOUT)


def install(version):
    """Install `version`, which the caller has checked with `valid_version`."""
    return _call("POST", "/v1/install", INSTALL_TIMEOUT, {"version": version})


def change_channel(channel):
    """Switch to `channel`, one of CHANNELS."""
    return _call("POST", "/v1/channel", CHANNEL_TIMEOUT, {"channel": channel})


def valid_version(value):
    return isinstance(value, str) and VERSION.fullmatch(value) is not None


def _call(method, path, timeout, payload=None):
    url = settings.UPDATER_URL
    if not url:
        return Answer(200, reachable=False)
    try:
        with client() as http:
            response = http.request(method, path, json=payload, timeout=timeout)
    except httpx.TimeoutException:
        return Answer(200, False, error=f"The update service did not answer within {timeout} s.")
    except (httpx.HTTPError, httpx.InvalidURL):
        return Answer(200, False, error=f"No update service answers at {url}.")
    try:
        body = response.json()
    except ValueError:
        body = None
    if response.is_success and _is_status(body):
        return Answer(response.status_code, True, body)
    if response.is_error and isinstance(body, dict) and isinstance(body.get("error"), str):
        latest = status() if path != "/v1/status" else None
        return Answer(409, True, latest.updater if latest else None, body["error"])
    return Answer(200, False, error=f"The service at {url} is not the update service.")


def _is_status(body):
    return isinstance(body, dict) and body.get("mode") in MODES and body.get("channel") in CHANNELS
