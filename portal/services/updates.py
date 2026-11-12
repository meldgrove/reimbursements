"""Automatic updates: the worker's hourly check for new releases.

Off until `UPDATE_DEPLOY_HOOK_URL` names a deploy link: a URL of the hosting platform
that redeploys the app when called. The worker then reads the project's releases from
GitHub once an hour. A release belongs to the running version's series when it has the
same major version, and before 1.0 also the same minor version. The image tags `X` and
`0.Y` follow a series, and its releases need no operator action (docs/releases.md).

For the newest release of the series the worker calls the deploy link once, and the
platform pulls the series tag again. A newer release outside the series only shows in
the admin area. See docs/updates.md.
"""

import logging
import re
from dataclasses import dataclass
from datetime import timedelta

import httpx
from django.conf import settings
from django.utils import formats, timezone

from portal.models import UpdateCheck

logger = logging.getLogger(__name__)
RELEASES_URL = "https://api.github.com/repos/meldgrove/reimbursements/releases"
RELEASE_NOTES_URL = "https://github.com/meldgrove/reimbursements/releases/"
CHECK_INTERVAL = timedelta(hours=1)
# A deploy that has not replaced the app by the next check failed.
DEPLOY_TIMEOUT = CHECK_INTERVAL
# How long checks may fail before the admin area says so.
CHECK_FAILURE_GRACE = timedelta(days=1)
VERSION = re.compile(r"v?(\d+)\.(\d+)\.(\d+)")


def enabled():
    return bool(settings.UPDATE_DEPLOY_HOOK_URL)


def parse(text):
    """(major, minor, patch) of a release such as `0.1.2` or `v0.1.2`, otherwise None."""
    match = VERSION.fullmatch(text) if isinstance(text, str) else None
    return tuple(int(part) for part in match.groups()) if match else None


def series(version):
    major, minor, _ = version
    return (major,) if major else (major, minor)


def label(version):
    return ".".join(map(str, version))


def client():
    return httpx.Client(
        headers={"User-Agent": f"reimbursements/{settings.APP_VERSION or 'source'}"},
        timeout=httpx.Timeout(15, connect=5),
    )


def releases(http):
    """The published releases as (version, release notes URL), without candidates."""
    response = http.get(
        RELEASES_URL,
        params={"per_page": 50},
        headers={"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"},
    )
    response.raise_for_status()
    body = response.json()
    if not isinstance(body, list):
        raise ValueError("unexpected releases response")
    found = []
    for release in body:
        if not isinstance(release, dict) or release.get("draft") or release.get("prerelease"):
            continue
        version, url = parse(release.get("tag_name")), release.get("html_url")
        if version:
            found.append((version, url if str(url).startswith(RELEASE_NOTES_URL) else ""))
    return found


def check(now=None):
    """Once an hour: look for new releases and deploy the newest one of the series."""
    if not enabled():
        return
    now = now or timezone.now()
    state = UpdateCheck.load()
    if state.checked_at and now - state.checked_at < CHECK_INTERVAL:
        return
    previous_check, state.checked_at = state.checked_at, now
    running = parse(settings.APP_VERSION)
    if running is None:
        state.save()
        logger.warning("update_check_skipped reason=no_release_version")
        return
    try:
        with client() as http:
            found = releases(http)
    except (httpx.HTTPError, ValueError):
        state.save()
        logger.warning("update_check_failed")
        return
    state.succeeded_at = now
    newer = [release for release in found if release[0] > running]
    other = max((r for r in newer if series(r[0]) != series(running)), default=None)
    state.available_version, state.available_url = (
        (label(other[0]), other[1]) if other else ("", "")
    )
    target = max((r for r in newer if series(r[0]) == series(running)), default=None)
    version = label(target[0]) if target else ""
    if state.target_version != version:
        state.target_version, state.requested_at, state.request_failure = version, None, ""
    if target and state.requested_at is None:
        request_deploy(state, now)
    elif target and previous_check and previous_check < state.requested_at + DEPLOY_TIMEOUT <= now:
        logger.warning("update_deploy_unchanged version=%s running=%s", version, label(running))
    state.save()


def request_deploy(state, now):
    """Call the deploy link for `state.target_version`; only a success counts as called."""
    headers = {}
    if settings.UPDATE_DEPLOY_HOOK_TOKEN:
        headers["Authorization"] = f"Bearer {settings.UPDATE_DEPLOY_HOOK_TOKEN}"
    try:
        with client() as http:
            response = http.post(settings.UPDATE_DEPLOY_HOOK_URL, headers=headers)
    except httpx.HTTPError:
        state.request_failure = "unreachable"
    else:
        state.request_failure = "" if response.is_success else f"HTTP {response.status_code}"
    if not state.request_failure:
        state.requested_at = now
    # At once: the deploy may replace this worker any moment now.
    state.save()
    if state.request_failure:
        logger.warning(
            "update_deploy_failed version=%s failure=%s",
            state.target_version,
            state.request_failure,
        )
    else:
        logger.info("update_deploy_requested version=%s", state.target_version)


@dataclass(frozen=True)
class Notice:
    # An alert variant: "info" or "warning".
    level: str
    text: str
    link: str = ""


def notices(now=None):
    """What the admin area tells template admins about updates, on every page."""
    if not enabled():
        return []
    now = now or timezone.now()
    running = parse(settings.APP_VERSION)
    if running is None:
        return [
            Notice(
                "warning",
                "Automatic updates are on, but this app does not run a release image, so it "
                "cannot tell which releases to install. Run a release image as described in "
                "docs/updates.md.",
            )
        ]
    state = UpdateCheck.load()
    found = []
    if (
        state.checked_at
        and state.succeeded_at != state.checked_at
        and (state.succeeded_at is None or now - state.succeeded_at > CHECK_FAILURE_GRACE)
    ):
        found.append(
            Notice(
                "warning",
                "The worker cannot check for new releases. Make sure it can reach api.github.com.",
            )
        )
    target = parse(state.target_version)
    if target and target > running:
        if state.requested_at is None and state.request_failure:
            found.append(
                Notice(
                    "warning",
                    f"The deploy link failed for version {label(target)} "
                    f"({state.request_failure}). Check UPDATE_DEPLOY_HOOK_URL and "
                    "UPDATE_DEPLOY_HOOK_TOKEN. The worker tries again every hour.",
                )
            )
        elif state.requested_at and now - state.requested_at < DEPLOY_TIMEOUT:
            found.append(
                Notice(
                    "info",
                    f"Updating to version {label(target)}: the deploy link was called less "
                    "than an hour ago.",
                )
            )
        elif state.requested_at:
            found.append(
                Notice(
                    "warning",
                    f"The deploy link was called for version {label(target)} over an hour ago, "
                    f"but the app still runs {label(running)}. Check the deployment's logs, and "
                    "that REIMBURSEMENTS_VERSION names a series such as 0.1, not an exact "
                    "version. The worker does not call the deploy link again for this version.",
                )
            )
    available = parse(state.available_version)
    if available and available > running and series(available) != series(running):
        found.append(
            Notice(
                "info",
                f"Version {label(available)} is available. It may need manual steps, so it is "
                "not installed automatically. Read its release notes before you upgrade.",
                state.available_url,
            )
        )
    return found


def summary():
    """The running version and the state of automatic updates, for the General settings."""
    version = f"Version {settings.APP_VERSION}" if settings.APP_VERSION else "Built from source"
    if not enabled():
        return f"{version}. Automatic updates are off; see docs/updates.md."
    checked = UpdateCheck.load().succeeded_at
    last = (
        f"last checked {formats.date_format(timezone.localtime(checked), 'DATETIME_FORMAT')}"
        if checked
        else "not checked yet"
    )
    return f"{version}. Automatic updates are on: the worker checks every hour ({last})."
