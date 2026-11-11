from datetime import timedelta
from urllib.parse import parse_qs, urlsplit

import pytest
from django.contrib.sessions.models import Session
from django.test import Client
from django.utils import timezone

from portal import roles
from portal.auth import KeycloakBackend

pytestmark = pytest.mark.django_db


def sign_in(client, user, monkeypatch):
    # Only the provider exchange is substituted; callback and session handling are real.
    monkeypatch.setattr(KeycloakBackend, "authenticate", lambda *args, **kwargs: user)
    response = client.get("/oidc/authenticate/")
    state = parse_qs(urlsplit(response.url).query)["state"][0]
    response = client.get("/oidc/callback/", {"state": state, "code": "synthetic-code"})
    assert response.status_code == 302 and response.url == "/admin/"
    return client.session.session_key


@pytest.mark.parametrize("activity", ["oidc", "draft", "save_every_request"])
def test_admin_deadline_survives_session_writes(
    client, form, django_user_model, settings, monkeypatch, activity
):
    user = django_user_model.objects.create_user("admin-subject")
    roles.assign(user, {roles.TEMPLATE_ADMIN})
    start = timezone.now()
    monkeypatch.setattr(timezone, "now", lambda: start)
    key = sign_in(client, user, monkeypatch)
    deadline = start + timedelta(seconds=settings.ADMIN_SESSION_SECONDS)
    assert Session.objects.get(pk=key).expire_date == deadline

    monkeypatch.setattr(timezone, "now", lambda: start + timedelta(hours=7))
    if activity == "oidc":
        assert client.get("/oidc/authenticate/").status_code == 302
    elif activity == "draft":
        assert client.get("/f/test/").status_code == 200
    else:
        settings.SESSION_SAVE_EVERY_REQUEST = True
    assert client.get("/admin/portal/claim/").status_code == 200
    assert Session.objects.get(pk=key).expire_date == deadline

    monkeypatch.setattr(timezone, "now", lambda: deadline + timedelta(seconds=1))
    response = client.get("/admin/portal/claim/")
    assert response.status_code == 302 and response.url.startswith("/admin/login/")
    new_key = sign_in(client, user, monkeypatch)
    assert client.get("/admin/portal/claim/").status_code == 200
    assert Session.objects.get(pk=new_key).expire_date == (
        deadline + timedelta(seconds=1 + settings.ADMIN_SESSION_SECONDS)
    )


@pytest.mark.parametrize(
    "expiry", [None, 8 * 3600, 0, "invalid", "2026-01-01T10:00:00", "2000-01-01T00:00:00+00:00"]
)
@pytest.mark.parametrize("path", ["/admin/portal/claim/", "/oidc/authenticate/", "/f/test/"])
def test_legacy_oidc_sessions_require_fresh_sign_in(client, form, django_user_model, expiry, path):
    user = django_user_model.objects.create_user("legacy-admin")
    roles.assign(user, {roles.TEMPLATE_ADMIN})
    client.force_login(user, backend="portal.auth.KeycloakBackend")
    session = client.session
    session["_session_expiry"] = expiry
    # Seed invalid policies directly; Django refuses some values when saving normally.
    Session.objects.filter(pk=session.session_key).update(
        session_data=session.encode(dict(session))
    )
    response = client.get(path)
    assert response.status_code in {200, 302}
    assert not Session.objects.filter(pk=session.session_key).exists()
    assert "_auth_user_id" not in client.session


def test_participant_and_development_password_sessions_remain_usable(
    form, django_user_model, settings
):
    participant = Client()
    assert participant.get("/f/test/").status_code == 200
    key = participant.session.session_key
    assert participant.get("/f/test/").status_code == 200
    assert participant.session.session_key == key
    assert participant.session.get_expiry_age() == settings.SESSION_COOKIE_AGE

    user = django_user_model.objects.create_superuser("local-admin", password="development-only")
    local = Client()
    assert local.login(username=user.username, password="development-only")
    assert local.get("/admin/portal/claim/").status_code == 200
