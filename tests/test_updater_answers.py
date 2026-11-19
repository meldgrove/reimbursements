"""Answers captured from Meldgrove Updater 0.2 (tests/fixtures/updater-0.2) pass the
updater client unchanged."""

import json
from pathlib import Path

import httpx
import pytest

from portal.services import updater

FIXTURES = Path(__file__).parent / "fixtures" / "updater-0.2"
SAMPLES = sorted(path.name for path in FIXTURES.glob("*.json"))


def test_every_sample_is_here():
    assert len(SAMPLES) == 7


@pytest.fixture
def answering(monkeypatch, settings):
    """Makes the updater answer every request with a sample, 202 for an installation."""
    settings.UPDATER_URL = "http://updater:8080"
    settings.APP_VERSION = "0.1.1"
    sample = {}

    def respond(request):
        code = 202 if request.url.path == "/v1/install" else 200
        return httpx.Response(code, content=(FIXTURES / sample["name"]).read_bytes())

    monkeypatch.setattr(
        updater,
        "client",
        lambda: httpx.Client(transport=httpx.MockTransport(respond), base_url=settings.UPDATER_URL),
    )

    def use(name):
        sample["name"] = name
        return json.loads((FIXTURES / name).read_text())

    return use


@pytest.mark.parametrize("name", SAMPLES)
def test_status_passes_the_sample_on(answering, name):
    expected = answering(name)
    answer = updater.status()
    assert answer == updater.Answer(200, True, expected)
    assert answer.body() == {
        "app": {"version": "0.1.1"},
        "reachable": True,
        "updater": expected,
        "error": None,
    }


def test_install_keeps_the_202(answering):
    expected = answering("install-202.json")
    assert updater.install("0.1.3") == updater.Answer(202, True, expected)
