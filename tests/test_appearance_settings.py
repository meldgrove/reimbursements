"""The Appearance settings: accent color and favicon."""

import io

import pytest
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client
from PIL import Image

from portal import roles, theme
from portal.models import AppSettings

pytestmark = pytest.mark.django_db

URL = "/admin/portal/appearance/1/change/"


def signed_in(client, role):
    user = get_user_model().objects.create_user(role, email=f"{role}@example.invalid")
    roles.assign(user, {role})
    client.force_login(user, backend="django.contrib.auth.backends.ModelBackend")
    return client


@pytest.fixture
def admin_client(client):
    return signed_in(client, roles.TEMPLATE_ADMIN)


def appearance(**changes):
    return {"accent_color": "", **changes}


def image_bytes(size=32, image_format="PNG"):
    output = io.BytesIO()
    Image.new("RGB", (size, size), "teal").save(output, image_format)
    return output.getvalue()


def test_template_admins_open_the_appearance_tab(admin_client):
    response = admin_client.get("/admin/portal/appearance/")
    assert response.status_code == 302 and response.url == URL
    page = admin_client.get(URL).content.decode()
    assert '<h1 class="page-title">Appearance</h1>' in page
    assert 'name="accent_color"' in page and 'name="favicon_file"' in page
    assert 'data-color-picker="id_accent_color"' in page and 'value="#0f766e"' in page
    assert "Standard teal" in page and "Standard favicon" in page
    assert '<a href="/admin/portal/appearance/" aria-current="page"' in page
    assert '<a href="/admin/portal/appsettings/" class' in page
    assert 'name="_save"' in page and 'name="_continue"' not in page
    assert "portal/admin-color.js" in page


def test_form_editors_cannot_change_the_appearance(client):
    signed_in(client, roles.FORM_EDITOR)
    assert client.get(URL).status_code == 403
    assert client.post(URL, appearance(accent_color="#1d4ed8")).status_code == 403
    assert AppSettings.load().accent_color == ""


@pytest.mark.parametrize(
    ("entered", "saved"),
    [("#1D4ED8", "#1d4ed8"), (" 1d4ed8 ", "#1d4ed8"), ("#abc", "#aabbcc"), ("", "")],
)
def test_the_accent_color_takes_a_hex_code(admin_client, entered, saved):
    response = admin_client.post(URL, appearance(accent_color=entered))
    assert response.status_code == 302 and response.url == URL
    assert AppSettings.load().accent_color == saved


@pytest.mark.parametrize("entered", ["teal", "#12345", "#1d4ed8ff", "#ggg"])
def test_the_accent_color_must_be_a_hex_code(admin_client, entered):
    AppSettings.objects.create(accent_color="#1d4ed8")
    response = admin_client.post(URL, appearance(accent_color=entered))
    assert response.status_code == 200
    assert "Enter a hex code such as #0f766e." in response.content.decode()
    assert AppSettings.load().accent_color == "#1d4ed8"


def test_saving_the_appearance_keeps_the_general_settings(admin_client):
    AppSettings.objects.create(language="en", timezone="UTC", date_format="Y-m-d")
    assert admin_client.post(URL, appearance(accent_color="#1d4ed8")).status_code == 302
    saved = AppSettings.load()
    assert (saved.language, saved.timezone, saved.date_format) == ("en", "UTC", "Y-m-d")
    assert saved.accent_color == "#1d4ed8"


def test_an_accent_color_restyles_public_pages_and_the_admin_area(admin_client, form):
    visitor = Client()
    assert "/theme/" not in visitor.get("/f/test/").content.decode()
    assert visitor.get(f"/theme/{theme.digest('#1d4ed8')}.css").status_code == 404
    response = admin_client.post(URL, appearance(accent_color="#1d4ed8"))
    assert response.status_code == 302
    url = f"/theme/{theme.digest('#1d4ed8')}.css"
    link = f'<link rel="stylesheet" href="{url}">'
    page = visitor.get("/f/test/").content.decode()
    # The accent overrides ui.css, so it comes after it.
    assert link in page and page.index("portal/ui.css") < page.index(link)
    assert link in admin_client.get("/admin/portal/claim/").content.decode()
    response = visitor.get(url)
    assert response.status_code == 200
    assert response["Content-Type"] == "text/css; charset=utf-8"
    assert response["Cache-Control"] == "public, max-age=31536000, immutable"
    css = response.content.decode()
    assert "--primary: #1d4ed8;" in css and "--primary-foreground: #ffffff;" in css
    dark = theme.dark_accent("#1d4ed8")
    assert f"    --primary: {dark};" in css and "@media (prefers-color-scheme: dark)" in css
    # An old link still answers, but browsers check again before reusing it.
    assert visitor.get("/theme/0000000000000000.css")["Cache-Control"] == "public, no-cache"
    page = admin_client.get(URL).content.decode()
    assert "Custom color" in page and dark in page and 'value="#1d4ed8"' in page
    assert admin_client.post(URL, appearance()).status_code == 302
    assert "/theme/" not in visitor.get("/f/test/").content.decode()
    assert visitor.get(url).status_code == 404


def test_a_light_accent_color_warns_that_links_are_hard_to_read(admin_client):
    response = admin_client.post(URL, appearance(accent_color="#facc15"), follow=True)
    page = response.content.decode()
    assert "Links in #facc15 are hard to read on white." in page
    assert AppSettings.load().accent_color == "#facc15"
    response = admin_client.post(URL, appearance(accent_color="#1d4ed8"), follow=True)
    assert "hard to read" not in response.content.decode()


@pytest.mark.parametrize("color", ["#0f766e", "#1d4ed8", "#000000", "#b91c1c", "#facc15"])
def test_text_on_the_accent_reads_in_light_and_dark_mode(color):
    dark = theme.dark_accent(color)
    assert theme.contrast(dark, theme.NEAR_BLACK) >= theme.DARK_CONTRAST
    for accent in [color, dark]:
        assert theme.contrast(accent, theme.foreground(accent)) >= 4.5


def test_dark_mode_keeps_the_hue_of_the_accent():
    # A deep blue becomes a light blue, not a gray.
    red, green, blue = (int(theme.dark_accent("#1d4ed8")[i : i + 2], 16) for i in (1, 3, 5))
    assert blue > green > red and blue - red > 100
    # Colors that already read on the dark background stay as chosen.
    assert theme.dark_accent("#facc15") == "#facc15"
    assert theme.foreground("#facc15") == theme.NEAR_BLACK
    assert theme.foreground("#1d4ed8") == theme.WHITE


@pytest.mark.parametrize(
    ("image_format", "media_type"), [("PNG", "image/png"), ("WEBP", "image/webp")]
)
def test_a_custom_favicon_replaces_the_standard_one(admin_client, form, image_format, media_type):
    visitor = Client()
    assert "portal/brand/logo" in visitor.get("/f/test/").content.decode()
    content = image_bytes(image_format=image_format)
    upload = SimpleUploadedFile(f"icon.{image_format.lower()}", content, content_type=media_type)
    response = admin_client.post(URL, {**appearance(), "favicon_file": upload})
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
    assert admin_client.post(URL, {**appearance(), "remove_favicon": "on"}).status_code == 302
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
    response = admin_client.post(URL, {**appearance(), "favicon_file": upload})
    assert response.status_code == 200 and error in response.content.decode()
    assert not AppSettings.load().favicon


def test_svg_and_ico_favicons_are_accepted(admin_client):
    for content, media_type in [
        (b'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>', "image/svg+xml"),
        (b"\0\0\1\0\1\0" + b"\0" * 40, "image/x-icon"),
    ]:
        upload = SimpleUploadedFile("icon", content)
        assert admin_client.post(URL, {**appearance(), "favicon_file": upload}).status_code == 302
        assert AppSettings.load().favicon_type == media_type
