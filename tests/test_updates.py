"""Automatic updates: the worker's hourly release check and what the admin area shows."""

import os
import subprocess
import sys
from datetime import timedelta

import httpx
import pytest
from django.conf import settings as django_settings
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.utils import timezone

from portal import roles
from portal.models import UpdateCheck
from portal.services import updates

pytestmark = pytest.mark.django_db

HOOK = "https://deploy.example.invalid/api/v1/deploy?uuid=reimbursements&force=false"
NOTES = "https://github.com/meldgrove/reimbursements/releases/tag/"


def release(tag, **fields):
    return {"tag_name": tag, "draft": False, "prerelease": False, "html_url": NOTES + tag, **fields}


class Network:
    """GitHub's releases and the deploy link, as the worker reaches them."""

    def __init__(self):
        self.releases = []
        self.github = 200
        self.hook = 200
        self.requests = []

    def handle(self, request):
        self.requests.append(request)
        if request.url.host == "api.github.com":
            if self.github is None:
                raise httpx.ConnectError("synthetic outage", request=request)
            return httpx.Response(self.github, json=self.releases)
        if self.hook is None:
            raise httpx.ConnectError("synthetic outage", request=request)
        return httpx.Response(self.hook, json={"deployments": []})

    @property
    def checks(self):
        return [r for r in self.requests if r.url.host == "api.github.com"]

    @property
    def deploys(self):
        return [r for r in self.requests if r.url.host == "deploy.example.invalid"]


@pytest.fixture
def network(monkeypatch, settings):
    settings.UPDATE_DEPLOY_HOOK_URL = HOOK
    settings.UPDATE_DEPLOY_HOOK_TOKEN = "deploy-only-token"
    settings.APP_VERSION = "0.1.2"
    fake = Network()
    monkeypatch.setattr(
        updates, "client", lambda: httpx.Client(transport=httpx.MockTransport(fake.handle))
    )
    return fake


def texts(now):
    return [notice.text for notice in updates.notices(now)]


def test_versions_and_series():
    assert updates.parse("v1.2.3") == updates.parse("1.2.3") == (1, 2, 3)
    assert updates.parse("0.1.4-rc.1") is None
    assert updates.parse(None) is None and updates.parse("") is None
    assert updates.series((0, 1, 2)) == (0, 1) and updates.series((1, 4, 0)) == (1,)


def test_updates_are_off_without_a_deploy_link(network, settings):
    settings.UPDATE_DEPLOY_HOOK_URL = ""
    updates.check()
    assert network.requests == [] and not UpdateCheck.objects.exists()
    assert updates.notices() == []
    assert updates.summary() == "Version 0.1.2. Automatic updates are off; see docs/updates.md."


def test_the_newest_release_of_the_series_is_deployed_once(network, settings):
    network.releases = [
        release("v0.1.5", draft=True),
        release("v0.1.4-rc.1", prerelease=True),
        release("v0.1.3"),
        release("v0.1.2"),
    ]
    now = timezone.now()
    updates.check(now)
    (deploy,) = network.deploys
    assert deploy.method == "POST" and str(deploy.url) == HOOK
    assert deploy.headers["authorization"] == "Bearer deploy-only-token"
    state = UpdateCheck.load()
    assert (state.target_version, state.requested_at, state.request_failure) == ("0.1.3", now, "")
    assert texts(now + timedelta(minutes=10)) == [
        "Updating to version 0.1.3: the deploy link was called less than an hour ago."
    ]

    # Not due again within the hour.
    updates.check(now + timedelta(minutes=30))
    assert len(network.checks) == 1

    # Still the old version an hour later: report it, never call the link again.
    later = now + timedelta(minutes=61)
    updates.check(later)
    updates.check(later + timedelta(hours=1))
    assert len(network.checks) == 3 and len(network.deploys) == 1
    (stuck,) = texts(later)
    assert stuck.startswith("The deploy link was called for version 0.1.3 over an hour ago, but")
    assert "still runs 0.1.2" in stuck and "does not call the deploy link again" in stuck

    # A newer release of the series gets its own call.
    network.releases.insert(0, release("v0.1.4"))
    updates.check(later + timedelta(hours=2))
    assert len(network.deploys) == 2 and UpdateCheck.load().target_version == "0.1.4"


def test_the_deployed_release_ends_the_update(network, settings):
    network.releases = [release("v0.1.3"), release("v0.1.2")]
    now = timezone.now()
    updates.check(now)
    settings.APP_VERSION = "0.1.3"
    assert texts(now + timedelta(hours=2)) == []
    updates.check(now + timedelta(hours=2))
    state = UpdateCheck.load()
    assert (state.target_version, state.requested_at) == ("", None)
    assert len(network.deploys) == 1


@pytest.mark.parametrize(
    ("status", "failure"), [(401, "HTTP 401"), (302, "HTTP 302"), (None, "unreachable")]
)
def test_a_failed_deploy_link_is_called_again_an_hour_later(network, status, failure):
    network.releases = [release("v0.1.3")]
    network.hook = status
    now = timezone.now()
    updates.check(now)
    state = UpdateCheck.load()
    assert (state.requested_at, state.request_failure) == (None, failure)
    assert texts(now) == [
        f"The deploy link failed for version 0.1.3 ({failure}). Check UPDATE_DEPLOY_HOOK_URL "
        "and UPDATE_DEPLOY_HOOK_TOKEN. The worker tries again every hour."
    ]
    network.hook = 200
    updates.check(now + timedelta(hours=1))
    assert len(network.deploys) == 2
    assert UpdateCheck.load().requested_at == now + timedelta(hours=1)


@pytest.mark.parametrize(
    ("url", "token"),
    [(HOOK, "tökén"), ("https://deploy.example.invalid:port/hook", "deploy-only-token")],
)
def test_a_malformed_deploy_link_is_reported_instead_of_stopping_the_worker(
    network, settings, url, token
):
    settings.UPDATE_DEPLOY_HOOK_URL, settings.UPDATE_DEPLOY_HOOK_TOKEN = url, token
    network.releases = [release("v0.1.3")]
    updates.check()
    state = UpdateCheck.load()
    assert (state.requested_at, state.request_failure) == (None, "invalid")


def test_the_deploy_link_works_without_a_token(network, settings):
    settings.UPDATE_DEPLOY_HOOK_TOKEN = ""
    network.releases = [release("v0.1.3")]
    updates.check()
    (deploy,) = network.deploys
    assert "authorization" not in deploy.headers


def test_releases_outside_the_series_are_only_shown(network):
    network.releases = [release("v1.0.0"), release("v0.2.0"), release("v0.1.2")]
    now = timezone.now()
    updates.check(now)
    assert network.deploys == []
    (notice,) = updates.notices(now)
    assert notice.text == (
        "Version 1.0.0 is available. It may need manual steps, so it is not installed "
        "automatically. Read its release notes before you upgrade."
    )
    assert (notice.level, notice.link) == ("info", NOTES + "v1.0.0")


def test_from_1_0_the_series_is_the_major_version(network, settings):
    settings.APP_VERSION = "1.2.0"
    network.releases = [release("v2.0.0"), release("v1.3.1"), release("v1.3.0")]
    now = timezone.now()
    updates.check(now)
    assert len(network.deploys) == 1 and UpdateCheck.load().target_version == "1.3.1"
    updating, available = texts(now)
    assert updating.startswith("Updating to version 1.3.1:")
    assert available.startswith("Version 2.0.0 is available.")


def test_release_notes_links_only_point_to_the_project(network):
    network.releases = [release("v0.2.0", html_url="https://elsewhere.example.invalid/x")]
    updates.check()
    assert UpdateCheck.load().available_url == ""


def test_an_app_without_a_release_version_is_never_updated(network, settings):
    settings.APP_VERSION = ""
    network.releases = [release("v0.1.3")]
    updates.check()
    assert network.requests == []
    (notice,) = updates.notices()
    assert notice.level == "warning" and "does not run a release image" in notice.text
    assert updates.summary().startswith("Built from source. Automatic updates are on")


@pytest.mark.parametrize("outage", [None, 403, "not a list"])
def test_failed_checks_show_until_one_succeeds(network, outage):
    now = timezone.now()
    if outage == "not a list":
        network.releases = {"message": "unexpected"}
    else:
        network.github = outage
    updates.check(now)
    assert texts(now) == [
        "The worker cannot check for new releases. Make sure it can reach api.github.com."
    ]
    network.github, network.releases = 200, [release("v0.1.2")]
    updates.check(now + timedelta(hours=1))
    assert texts(now + timedelta(hours=1)) == []
    # A short outage after a successful check stays quiet for a day.
    network.github = None
    updates.check(now + timedelta(hours=2))
    assert texts(now + timedelta(hours=2)) == []
    assert len(texts(now + timedelta(days=1, hours=2))) == 1


# The worker closes old connections, which needs real transactions.
@pytest.mark.django_db(transaction=True)
def test_the_worker_checks_during_its_maintenance(network):
    network.releases = [release("v0.1.3")]
    call_command("run_jobs", once=True)
    assert len(network.deploys) == 1


def signed_in(client, role):
    user = get_user_model().objects.create_user(role, email=f"{role}@example.invalid")
    roles.assign(user, {role})
    client.force_login(user, backend="django.contrib.auth.backends.ModelBackend")
    return client


def test_template_admins_see_update_notices_on_every_page(network, client):
    network.releases = [release("v0.2.0")]
    updates.check()
    signed_in(client, roles.TEMPLATE_ADMIN)
    page = client.get("/admin/portal/claim/").content.decode()
    assert "Version 0.2.0 is available." in page
    assert f'href="{NOTES}v0.2.0" rel="noopener noreferrer">Release notes</a>' in page


def test_form_editors_do_not_see_update_notices(network, client):
    network.releases = [release("v0.2.0")]
    updates.check()
    signed_in(client, roles.FORM_EDITOR)
    page = client.get("/admin/portal/claim/").content.decode()
    assert "is available" not in page and "data-update-notices" not in page


def test_general_settings_show_the_version_and_the_last_check(network, client):
    network.releases = [release("v0.1.2")]
    signed_in(client, roles.TEMPLATE_ADMIN)
    page = client.get("/admin/portal/appsettings/1/change/").content.decode()
    assert "Version and updates" in page
    assert (
        "Version 0.1.2. Automatic updates are on: the worker checks every hour (not checked yet)."
        in page
    )
    updates.check()
    page = client.get("/admin/portal/appsettings/1/change/").content.decode()
    assert "Automatic updates are on: the worker checks every hour (last checked " in page


@pytest.mark.parametrize("url", ["ftp://deploy.example.invalid/hook", "deploy.example.invalid"])
def test_the_deploy_link_must_be_a_web_address(url):
    environment = os.environ | {
        "DJANGO_SETTINGS_MODULE": "config.test_settings",
        "UPDATE_DEPLOY_HOOK_URL": url,
    }
    result = subprocess.run(
        [sys.executable, "-c", "from django.conf import settings; settings.DEBUG"],
        env=environment,
        capture_output=True,
        text=True,
        cwd=django_settings.BASE_DIR,
    )
    assert result.returncode != 0
    assert "UPDATE_DEPLOY_HOOK_URL must be an http(s) URL." in result.stderr
