from datetime import timedelta

import pytest
from django.contrib.sessions.backends.db import SessionStore
from django.contrib.sessions.models import Session
from django.core.management import call_command
from django.test import Client, RequestFactory
from django.utils import timezone

from portal.models import Draft, DraftAdmission
from portal.participants import client_network
from portal.services.retention import cleanup

pytestmark = pytest.mark.django_db


@pytest.mark.django_db(transaction=True)
def test_worker_removes_expired_sessions_and_preserves_active_sessions():
    expired, active = SessionStore(), SessionStore()
    for session in (expired, active):
        session["marker"] = "synthetic"
        session.save()
    Session.objects.filter(pk=expired.session_key).update(
        expire_date=timezone.now() - timedelta(seconds=1)
    )
    cleanup(execute=False)
    assert Session.objects.count() == 2
    call_command("run_jobs", once=True)
    assert not Session.objects.filter(pk=expired.session_key).exists()
    assert Session.objects.filter(pk=active.session_key).exists()
    assert SessionStore(active.session_key)["marker"] == "synthetic"


def test_cookie_resets_cannot_exhaust_draft_capacity(form, settings):
    settings.MAX_DRAFTS_PER_NETWORK = 3
    clients = [Client() for _ in range(4)]
    assert [client.get("/f/test/").status_code for client in clients] == [200, 200, 200, 429]
    assert Draft.objects.count() == 3
    assert Session.objects.count() == 3
    assert DraftAdmission.objects.get().count == 3
    # Existing work is accessible after the new-draft budget is exhausted.
    assert clients[0].get("/f/test/").status_code == 200
    assert Client().get("/f/test/", REMOTE_ADDR="192.0.2.5").status_code == 200
    # A direct caller cannot bypass the limit by inventing a forwarded address.
    assert Client().get("/f/test/", HTTP_X_FORWARDED_FOR="192.0.2.6").status_code == 429


def test_expired_budget_resets_and_old_keys_are_cleaned(form, settings):
    settings.MAX_DRAFTS_PER_NETWORK = 1
    assert Client().get("/f/test/").status_code == 200
    DraftAdmission.objects.update(window_start=timezone.now() - timedelta(hours=25))
    assert Client().get("/f/test/").status_code == 200
    assert DraftAdmission.objects.get().count == 1
    DraftAdmission.objects.update(window_start=timezone.now() - timedelta(days=3))
    cleanup(execute=True)
    assert not DraftAdmission.objects.exists()


def test_full_capacity_rejects_before_creating_another_session(form, settings):
    settings.MAX_ACTIVE_DRAFTS = 1
    assert Client().get("/f/test/").status_code == 200
    assert Client().get("/f/test/").status_code == 503
    assert Session.objects.count() == 1


@pytest.mark.parametrize(
    ("peer", "forwarded", "proxies", "expected"),
    [
        ("192.0.2.1", "198.51.100.1", [], "192.0.2.1/32"),
        ("10.0.0.2", "198.51.100.1", ["10.0.0.0/8"], "198.51.100.1/32"),
        ("10.0.0.2", "203.0.113.2, 198.51.100.1", ["10.0.0.0/8"], "198.51.100.1/32"),
        ("10.0.0.2", "198.51.100.1, 10.0.0.3", ["10.0.0.0/8"], "198.51.100.1/32"),
        ("10.0.0.2", "invalid", ["10.0.0.0/8"], "10.0.0.2/32"),
        ("2001:db8::1", "", [], "2001:db8::/48"),
        ("2001:db8::ffff", "", [], "2001:db8::/48"),
        # Another /64 of the same site shares its budget; another site does not.
        ("2001:db8:0:ff::1", "", [], "2001:db8::/48"),
        ("2001:db8:1::1", "", [], "2001:db8:1::/48"),
        ("::ffff:192.0.2.1", "", [], "192.0.2.1/32"),
    ],
)
def test_client_network_trusts_only_configured_proxy_chain(
    settings, peer, forwarded, proxies, expected
):
    settings.TRUSTED_PROXY_CIDRS = proxies
    request = RequestFactory().get("/", REMOTE_ADDR=peer, HTTP_X_FORWARDED_FOR=forwarded)
    assert client_network(request) == expected
