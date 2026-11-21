"""The update button's routes and the Updates tab (docs/updates.md)."""

import json
import os
import re
import subprocess
import sys

import httpx
import pytest
from django.contrib.auth import get_user_model
from django.test import Client

from portal import roles
from portal.models import AppSettings
from portal.services import updater

pytestmark = pytest.mark.django_db

UPDATER = "http://updater:8080"
STATUS = {
    "updater": "0.2.0",
    "mode": "host",
    "channel": "stable",
    "channelLocked": None,
    "installed": "0.2.0",
    "available": None,
    "attention": None,
    "installing": None,
    "last": None,
    "checking": False,
    "checkedAt": "2026-11-19T10:00:00Z",
    "error": None,
    "automatic": True,
    "cooldown": "3d",
    "window": None,
    "timezone": "UTC",
}
ROUTES = [
    ("get", "/admin/updates/"),
    ("post", "/admin/updates/check/"),
    ("post", "/admin/updates/install/"),
    ("post", "/admin/updates/channel/"),
]


def signed_in(client, role):
    user = get_user_model().objects.create_user(role, email=f"{role}@example.invalid")
    roles.assign(user, {role})
    client.force_login(user, backend="django.contrib.auth.backends.ModelBackend")
    return client


@pytest.fixture
def admin_client(client):
    return signed_in(client, roles.TEMPLATE_ADMIN)


@pytest.fixture
def service(monkeypatch, settings):
    """A stand-in updater: `answers` maps "METHOD /path" to a response or an exception."""
    settings.UPDATER_URL = UPDATER
    settings.APP_VERSION = "0.2.0"
    calls, answers = [], {}

    def respond(request):
        route = f"{request.method} {request.url.path}"
        calls.append((route, json.loads(request.content or "null"), request.extensions["timeout"]))
        answer = answers.get(route, httpx.Response(200, json=STATUS))
        if isinstance(answer, Exception):
            raise answer
        return answer

    monkeypatch.setattr(
        updater,
        "client",
        lambda: httpx.Client(transport=httpx.MockTransport(respond), base_url=UPDATER),
    )
    return calls, answers


def post(client, url, payload):
    return client.post(url, json.dumps(payload), content_type="application/json")


@pytest.mark.parametrize("role", [None, roles.FORM_EDITOR])
def test_only_template_admins_reach_the_routes(client, service, role):
    if role:
        signed_in(client, role)
    for method, url in ROUTES:
        response = getattr(client, method)(url)
        assert response.status_code == 404
        # The button stops its automatic requests on this mark, as after a sign-in redirect.
        assert response.json() == {
            "error": "Sign in as a template admin to manage updates.",
            "signedOut": True,
        }
    assert service[0] == []


def test_the_status_route_answers_with_the_updater_status(admin_client, service):
    calls, _ = service
    response = admin_client.get("/admin/updates/")
    assert response.status_code == 200
    assert response.json() == {
        "app": {"version": "0.2.0"},
        "reachable": True,
        "updater": STATUS,
        "error": None,
    }
    assert response["Cache-Control"] == "no-store, private"
    assert calls == [("GET /v1/status", None, timeout(3))]
    assert admin_client.post("/admin/updates/").status_code == 405
    assert admin_client.get("/admin/updates/check/").status_code == 405


def timeout(seconds):
    return {"connect": seconds, "read": seconds, "write": seconds, "pool": seconds}


def test_each_route_calls_the_updater_with_its_timeout(admin_client, service):
    calls, answers = service
    answers["POST /v1/install"] = httpx.Response(202, json=STATUS | {"installing": {}})
    assert admin_client.post("/admin/updates/check/").status_code == 200
    response = post(admin_client, "/admin/updates/install/", {"version": "0.2.1"})
    assert response.status_code == 202 and response.json()["updater"]["installing"] == {}
    assert post(admin_client, "/admin/updates/channel/", {"channel": "preview"}).status_code == 200
    assert calls == [
        ("POST /v1/check", None, timeout(35)),
        ("POST /v1/install", {"version": "0.2.1"}, timeout(10)),
        ("POST /v1/channel", {"channel": "preview"}, timeout(35)),
    ]


@pytest.mark.parametrize("version", ["0.2.1", "10.20.30", "0.2.1-preview.3", "sha256:0123456789ab"])
def test_install_takes_a_version_or_an_image_digest(admin_client, service, version):
    response = post(admin_client, "/admin/updates/install/", {"version": version})
    assert response.status_code == 200
    assert service[0][0][1] == {"version": version}


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"version": "latest"},
        {"version": "0.2"},
        {"version": "v0.2.1"},
        {"version": "0.2.1-rc.1"},
        {"version": "0.2.1\n"},
        {"version": "0.2.1 && reboot"},
        {"version": "sha256:0123456789AB"},
        {"version": "sha256:0123456789abc"},
        {"version": 21},
        ["0.2.1"],
    ],
)
def test_install_refuses_anything_else_without_calling_the_updater(admin_client, service, payload):
    response = post(admin_client, "/admin/updates/install/", payload)
    assert response.status_code == 400
    assert response.json()["error"] == "Name the version to install, such as 0.2.1."
    assert service[0] == []


@pytest.mark.parametrize("payload", [{}, {"channel": "beta"}, {"channel": "Stable"}, "preview"])
def test_the_channel_is_stable_or_preview(admin_client, service, payload):
    response = post(admin_client, "/admin/updates/channel/", payload)
    assert response.status_code == 400
    assert response.json()["error"] == "The channel is stable or preview."
    assert service[0] == []


def test_a_body_that_is_not_json_is_refused(admin_client, service):
    response = admin_client.post(
        "/admin/updates/install/", "version=0.2.1", content_type="text/plain"
    )
    assert response.status_code == 400
    assert service[0] == []


def test_an_updater_refusal_answers_409_with_its_error_and_the_latest_status(admin_client, service):
    calls, answers = service
    answers["POST /v1/install"] = httpx.Response(409, json={"error": "0.2.1 is being installed."})
    response = post(admin_client, "/admin/updates/install/", {"version": "0.2.2"})
    assert response.status_code == 409
    assert response.json() == {
        "app": {"version": "0.2.0"},
        "reachable": True,
        "updater": STATUS,
        "error": "0.2.1 is being installed.",
    }
    assert [route for route, *_ in calls] == ["POST /v1/install", "GET /v1/status"]
    answers["POST /v1/channel"] = httpx.Response(409, json={"error": "Change the tag there."})
    response = post(admin_client, "/admin/updates/channel/", {"channel": "preview"})
    assert response.status_code == 409 and response.json()["error"] == "Change the tag there."


@pytest.mark.parametrize("code", [500, 503])
def test_an_updater_server_error_of_an_installation_stays_one(admin_client, service, code):
    calls, answers = service
    answers["POST /v1/install"] = httpx.Response(code, json={"error": "The state file is busy."})
    response = post(admin_client, "/admin/updates/install/", {"version": "0.2.1"})
    # Never a 409: the button takes that as a refusal, and the installation may have started.
    assert response.status_code == code
    assert response.json() == {
        "app": {"version": "0.2.0"},
        "reachable": True,
        "updater": STATUS,
        "error": "The state file is busy.",
    }
    answers["POST /v1/install"] = httpx.Response(503, text="Service Unavailable")
    response = post(admin_client, "/admin/updates/install/", {"version": "0.2.1"})
    assert response.status_code == 503
    assert response.json()["error"] == "The update service answered with HTTP 503."


def test_an_updater_error_on_the_status_itself_answers_409(admin_client, service):
    service[1]["GET /v1/status"] = httpx.Response(500, json={"error": "The state file is broken."})
    response = admin_client.get("/admin/updates/")
    assert response.status_code == 409
    assert response.json()["updater"] is None
    assert response.json()["error"] == "The state file is broken."


@pytest.mark.parametrize(
    "failure",
    [
        httpx.ConnectError("Name or service not known"),
        httpx.Response(200, text="<html>Welcome to nginx</html>"),
        httpx.Response(404, text="Not found"),
        httpx.Response(200, json={"status": "ok"}),
    ],
)
def test_without_an_updater_the_routes_answer_unreachable(admin_client, service, failure):
    service[1]["GET /v1/status"] = failure
    response = admin_client.get("/admin/updates/")
    assert response.status_code == 200
    body = response.json()
    assert (body["reachable"], body["updater"]) == (False, None)
    assert UPDATER in body["error"]


def test_an_updater_that_does_not_answer_in_time_is_unreachable(admin_client, service):
    service[1]["POST /v1/check"] = httpx.ReadTimeout("synthetic timeout")
    response = admin_client.post("/admin/updates/check/")
    assert response.status_code == 200
    assert response.json()["reachable"] is False
    assert response.json()["error"] == "The update service did not answer within 35 s."


def test_an_empty_updater_url_switches_the_service_off_without_a_call(
    admin_client, service, settings
):
    settings.UPDATER_URL = ""
    settings.APP_VERSION = ""
    for method, url in ROUTES[:2]:
        response = getattr(admin_client, method)(url)
        assert response.status_code == 200
        assert response.json() == {
            "app": {"version": None},
            "reachable": False,
            "updater": None,
            "error": None,
        }
    assert service[0] == []


def test_posts_need_the_csrf_token(service):
    client = signed_in(Client(enforce_csrf_checks=True), roles.TEMPLATE_ADMIN)
    assert post(client, "/admin/updates/install/", {"version": "0.2.1"}).status_code == 403
    assert client.post("/admin/updates/check/").status_code == 403
    assert service[0] == []


def attributes(page, element):
    """The attributes of the first <element …> in the page."""
    tag = re.search(rf"<{element}\s([^>]*)>", page)
    assert tag, f"no <{element}> in the page"
    return dict(re.findall(r'([a-z-]+)="([^"]*)"', tag.group(1)))


ELEMENT = {
    "url": "/admin/updates/",
    "app-name": "Meldgrove Reimbursement",
    "project": "reimbursements",
    "locale": "en",
    "guide-url": "https://github.com/meldgrove/reimbursements/blob/main/docs/updates.md#switch-it-on",
    # The default date format (DD.MM.YYYY) and timezone of Admin > General.
    "date-locale": "de-DE",
    "time-zone": "Europe/Berlin",
}
SCRIPT = '<script type="module" src="/static/portal/vendor/meldgrove-updates.js"></script>'


def test_template_admins_see_the_update_button(admin_client, settings, service):
    settings.UPDATER_URL = UPDATER
    page = admin_client.get("/admin/portal/claim/").content.decode()
    button = attributes(page, "meldgrove-update-button")
    assert button.pop("csrf-token")
    assert button == ELEMENT
    assert SCRIPT in page
    assert service[0] == [], "The page itself never waits for the updater."


def test_form_editors_see_no_update_button(client, settings):
    settings.UPDATER_URL = UPDATER
    signed_in(client, roles.FORM_EDITOR)
    page = client.get("/admin/portal/claim/").content.decode()
    assert "meldgrove-update" not in page
    assert "/admin/updates/" not in page


def test_an_empty_updater_url_hides_the_button_but_not_the_tab(admin_client, settings):
    settings.UPDATER_URL = ""
    page = admin_client.get("/admin/portal/claim/").content.decode()
    assert "meldgrove-update" not in page
    assert admin_client.get("/admin/portal/updates/").status_code == 200


def test_template_admins_open_the_updates_tab(admin_client, service):
    page = admin_client.get("/admin/portal/updates/").content.decode()
    assert '<h1 class="page-title">Updates</h1>' in page
    assert '<a href="/admin/portal/updates/" class="frame-menu-button" aria-current="page"' in page
    assert '<a href="/admin/portal/appsettings/" class' in page
    # The settings come from @meldgrove/ui; without an updater, they say so.
    content = page.split('id="content"', 1)[1]
    element = attributes(content, "meldgrove-updates-settings")
    assert element.pop("csrf-token")
    assert element == ELEMENT
    assert SCRIPT in content
    assert service[0] == [], "The tab never waits for the updater."
    page = admin_client.get("/admin/portal/appsettings/1/change/").content.decode()
    assert '<a href="/admin/portal/updates/" class' in page


def test_the_updates_tab_is_for_template_admins_only(client):
    assert client.get("/admin/portal/updates/").status_code == 302
    signed_in(client, roles.FORM_EDITOR)
    assert client.get("/admin/portal/updates/").status_code == 403


@pytest.mark.parametrize("value", ["updater:8080", "ftp://updater", "http://"])
def test_settings_refuse_an_updater_url_that_is_not_one(tmp_path, value):
    environment = {
        "PATH": os.defpath,
        "PRIVATE_STORAGE_ROOT": str(tmp_path / "private"),
        "DJANGO_DEBUG": "1",
        "DEPLOYMENT_ENV": "development",
        "UPDATER_URL": value,
    }
    result = subprocess.run(
        [sys.executable, "-c", "import config.settings"],
        env=environment,
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    assert "UPDATER_URL must be empty or a URL such as http://updater:8080." in result.stderr


def test_the_elements_take_the_date_format_and_timezone_of_general(admin_client, settings, service):
    settings.UPDATER_URL = UPDATER
    general = AppSettings.load()
    general.date_format, general.timezone = "m/d/Y", "America/New_York"
    general.save()
    page = admin_client.get("/admin/portal/claim/").content.decode()
    button = attributes(page, "meldgrove-update-button")
    assert button["date-locale"] == "en-US"
    assert button["time-zone"] == "America/New_York"
