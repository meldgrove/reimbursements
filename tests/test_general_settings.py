"""The General settings: app language, timezone, date format and favicon."""

import io
import json
import re
from datetime import UTC, datetime
from importlib import import_module

import pytest
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import Client
from PIL import Image

from portal import roles
from portal.models import AppSettings, DeliveryAttempt, Form, FormTemplate
from portal.services import confirmations, delivery
from portal.services.transport import ACCEPTED, SendResult

pytestmark = pytest.mark.django_db

URL = "/admin/portal/appsettings/1/change/"


def signed_in(client, role):
    user = get_user_model().objects.create_user(role, email=f"{role}@example.invalid")
    roles.assign(user, {role})
    client.force_login(user, backend="django.contrib.auth.backends.ModelBackend")
    return client


@pytest.fixture
def admin_client(client):
    return signed_in(client, roles.TEMPLATE_ADMIN)


def general(**changes):
    return {"language": "de", "timezone": "Europe/Berlin", "date_format": "d.m.Y", **changes}


def image_bytes(size=32, image_format="PNG"):
    output = io.BytesIO()
    Image.new("RGB", (size, size), "teal").save(output, image_format)
    return output.getvalue()


def configuration(page):
    match = re.search(
        r'<script id="portal-configuration" type="application/json">(.*?)</script>', page
    )
    return json.loads(match[1])


def test_template_admins_change_the_general_settings(admin_client):
    response = admin_client.get("/admin/portal/appsettings/")
    assert response.status_code == 302 and response.url == URL
    page = admin_client.get(URL).content.decode()
    assert "App language" in page and '<option value="Europe/Berlin" selected>' in page
    assert 'name="_save"' in page and 'name="_continue"' not in page
    changes = general(language="en", timezone="America/New_York", date_format="Y-m-d")
    response = admin_client.post(URL, changes)
    assert response.status_code == 302 and response.url == URL
    saved = AppSettings.load()
    assert (saved.language, saved.timezone, saved.date_format) == (
        "en",
        "America/New_York",
        "Y-m-d",
    )
    assert admin_client.post(URL, general(timezone="Mars/Olympus")).status_code == 200
    assert AppSettings.load().timezone == "America/New_York"


def test_form_editors_cannot_change_the_general_settings(client):
    signed_in(client, roles.FORM_EDITOR)
    assert client.get(URL).status_code == 403
    assert client.post(URL, general(language="en")).status_code == 403
    assert AppSettings.load().language == "de"
    assert (
        'href="/admin/portal/appsettings/"'
        not in client.get("/admin/portal/claim/").content.decode()
    )


def test_admin_area_is_english_whatever_the_app_language(admin_client):
    for language in ["de", "en"]:
        AppSettings.objects.update_or_create(pk=1, defaults={"language": language})
        page = admin_client.get(URL).content.decode()
        assert '<html lang="en">' in page and 'value="Save"' in page
        assert "Sichern" not in page and "Speichern" not in page
        page = admin_client.get("/admin/portal/claim/").content.decode()
        assert ">Claims<" in page and "Anträge" not in page


def test_public_pages_follow_the_app_language(client, form):
    page = client.get("/f/test/").content.decode()
    assert '<html lang="de">' in page and "Deine Angaben" in page
    assert configuration(page)["text"]["submit"] == "Antrag einreichen →"
    AppSettings.objects.create(language="en")
    page = client.get("/f/test/").content.decode()
    assert '<html lang="en">' in page and "Your details" in page and "Deine Angaben" not in page
    assert "Your expenses. Simply submitted." in page and ">Germany<" in page
    assert configuration(page)["text"]["submit"] == "Submit claim →"
    assert configuration(page)["locale"] == "en-GB"
    page = client.get("/datenschutz/").content.decode()
    assert "Privacy" in page and "Datenschutz<" not in page


def test_validation_messages_follow_the_app_language(prepared):
    AppSettings.objects.create(language="en")
    data = {**prepared["data"], "full_name": "", "iban": "DE00"}
    response = prepared["client"].post(
        "/f/test/validate/",
        data=json.dumps(data),
        content_type="application/json",
        headers={"X-Draft-Token": data["token"]},
    )
    fields = response.json()["fields"]
    assert fields["full_name"][0]["message"] == "This field is required."
    assert fields["iban"][0]["message"] == "Please enter a valid IBAN."


def test_public_pages_have_no_header(client, form):
    for url in ["/", "/f/test/", "/datenschutz/"]:
        page = client.get(url).content.decode()
        assert "<header" not in page and 'href="#main"' in page


def test_dates_follow_the_app_date_format_and_timezone(client, form):
    form.closes_at = datetime(2099, 12, 31, 22, 30, tzinfo=UTC)
    form.save()
    page = client.get("/f/test/").content.decode()
    assert "Einreichen bis 31.12.2099, 23:30 CET" in page
    assert configuration(page)["date_format"] == "DD.MM.YYYY"
    AppSettings.objects.create(language="en", date_format="Y-m-d", timezone="America/New_York")
    page = client.get("/f/test/").content.decode()
    assert "Submit by 2099-12-31, 17:30 EST" in page
    assert configuration(page)["date_format"] == "YYYY-MM-DD"


def test_admin_shows_and_reads_dates_in_the_app_date_format(admin_client, form):
    form.closes_at = datetime(2099, 12, 31, 22, 30, tzinfo=UTC)
    form.save()
    AppSettings.objects.create(date_format="m/d/Y")
    assert "12/31/2099, 23:30" in admin_client.get("/admin/portal/form/").content.decode()
    response = admin_client.post(
        f"/admin/portal/form/{form.pk}/change/",
        {
            "_autosave": "1",
            "name": form.name,
            "slug": form.slug,
            "value_kst": "TEST-KST",
            "recipient": form.recipient,
            "support_email": form.support_email,
            "trip_start": "10/20/2099",
            "trip_end": "10/21/2099",
        },
    )
    assert response.status_code == 200, response.content
    form.refresh_from_db()
    assert form.trip_start.isoformat() == "2099-10-20"


def test_claims_keep_the_language_their_participant_saw(accepted, monkeypatch):
    assert accepted.snapshot["language"] == "de"
    AppSettings.objects.create(language="en", timezone="UTC")
    sent = []

    class Capture:
        def send(self, message):
            sent.append(message)
            return SendResult(ACCEPTED, "message-1")

    monkeypatch.setattr(confirmations, "configured_transport", Capture)
    confirmations.send(accepted.confirmation)
    assert sent[-1].subject.startswith("Eingangsbestätigung: Erstattungsantrag")
    accepted.snapshot["language"] = "en"
    accepted.save()
    confirmations.send(accepted.confirmation)
    assert sent[-1].subject.startswith("Confirmation of receipt: reimbursement claim")
    assert "Your Meldgrove Reimbursement team" in sent[-1].text


def test_the_finance_email_uses_the_claim_language(delivery):
    attempt = DeliveryAttempt.objects.create(delivery=delivery)
    assert delivery.claim.snapshot["language"] == "de"
    assert "beigefügten PDF" in delivery_text(attempt)
    delivery.claim.snapshot["language"] = "en"
    delivery.claim.save()
    attempt.refresh_from_db()
    assert "attached PDF" in delivery_text(attempt)


def delivery_text(attempt):
    attempt = DeliveryAttempt.objects.select_related("delivery__claim").get(pk=attempt.pk)
    return delivery.compose(attempt).text


def test_new_templates_get_the_declaration_in_the_app_language():
    assert FormTemplate.objects.create(name="German").declaration.startswith("Hiermit bestätige")
    AppSettings.objects.create(language="en")
    assert FormTemplate.objects.create(name="English").declaration.startswith("I confirm")


@pytest.mark.parametrize(
    ("image_format", "media_type"), [("PNG", "image/png"), ("WEBP", "image/webp")]
)
def test_a_custom_favicon_replaces_the_standard_one(admin_client, form, image_format, media_type):
    visitor = Client()
    assert "portal/brand/logo" in visitor.get("/f/test/").content.decode()
    content = image_bytes(image_format=image_format)
    upload = SimpleUploadedFile(f"icon.{image_format.lower()}", content, content_type=media_type)
    response = admin_client.post(URL, {**general(), "favicon_file": upload})
    assert response.status_code == 302
    settings = AppSettings.load()
    # Every request loads the settings; the image loads only for the favicon itself.
    assert "favicon" in settings.get_deferred_fields()
    assert settings.favicon_type == media_type and bytes(settings.favicon) == content
    url = f"/favicon/{settings.favicon_digest}/"
    assert (
        f'<link rel="icon" type="{media_type}" href="{url}">'
        in visitor.get("/f/test/").content.decode()
    )
    assert f'href="{url}"' in admin_client.get("/admin/portal/claim/").content.decode()
    response = visitor.get(url)
    assert response.status_code == 200 and response.content == content
    assert response["Content-Type"] == media_type
    assert response["Cache-Control"] == "public, max-age=31536000, immutable"
    assert "sandbox" in response["Content-Security-Policy"]
    assert admin_client.post(URL, {**general(), "remove_favicon": "on"}).status_code == 302
    assert not AppSettings.load().favicon
    assert visitor.get(url).status_code == 404


@pytest.mark.parametrize(
    ("content", "error"),
    [
        (b"GIF89a not accepted", "Upload a PNG, ICO, SVG or WebP file."),
        (b"<html><script>alert(1)</script></html>", "Upload a PNG, ICO, SVG or WebP file."),
        (b"RIFF\x24\x00\x00\x00WAVEfmt ", "Upload a PNG, ICO, SVG or WebP file."),
        (b"WEBP", "Upload a PNG, ICO, SVG or WebP file."),
        (image_bytes(400) + b"\0" * 100_000, "The favicon may be at most 100 KB."),
    ],
)
def test_favicons_must_be_small_png_ico_svg_or_webp(admin_client, content, error):
    upload = SimpleUploadedFile("icon", content)
    response = admin_client.post(URL, {**general(), "favicon_file": upload})
    assert response.status_code == 200 and error in response.content.decode()
    assert not AppSettings.load().favicon


def test_svg_and_ico_favicons_are_accepted(admin_client):
    for content, media_type in [
        (b'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>', "image/svg+xml"),
        (b"\0\0\1\0\1\0" + b"\0" * 40, "image/x-icon"),
    ]:
        upload = SimpleUploadedFile("icon", content)
        assert admin_client.post(URL, {**general(), "favicon_file": upload}).status_code == 302
        assert AppSettings.load().favicon_type == media_type


def test_health_checks_do_not_read_the_general_settings(client, django_assert_num_queries):
    with django_assert_num_queries(0):
        assert client.get("/-/healthz").status_code == 200


@pytest.mark.django_db(transaction=True)
def test_stored_standard_form_texts_follow_the_app_language_after_migrating():
    before = [("portal", "0011_general_settings_and_english_admin")]
    after = [("portal", "0012_standard_form_texts_follow_language")]
    migration = import_module("portal.migrations.0012_standard_form_texts_follow_language")
    executor = MigrationExecutor(connection)
    executor.migrate(before)
    try:
        apps = executor.loader.project_state(before).apps
        template = apps.get_model("portal", "FormTemplate").objects.create(name="Migration")
        for slug, title in [("standard", migration.STORED_TITLE), ("own", "Our workshop")]:
            apps.get_model("portal", "Form").objects.create(
                template=template,
                name=slug,
                slug=slug,
                title=title,
                description=migration.STORED_DESCRIPTION,
                recipient="finance@example.invalid",
                support_email="finance@example.invalid",
            )
        executor = MigrationExecutor(connection)
        executor.migrate(after)
        assert dict(Form.objects.values_list("slug", "title")) == {
            "standard": "",
            "own": "Our workshop",
        }
        assert set(Form.objects.values_list("description", flat=True)) == {""}
    finally:
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(executor.loader.graph.leaf_nodes())
