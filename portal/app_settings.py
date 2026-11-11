"""The General settings, applied to every request and to what the worker sends.

The admin area is always English. Public pages, emails to participants and Finance and
the claim PDF use the app language; a claim keeps the language its participant saw.
Every page, email and PDF shows times in the app timezone and dates in the app date
format.
"""

import contextlib
import re

from django.utils import timezone, translation

from portal import dates
from portal.models import AppSettings

# Pages that are always English, whatever the app language.
ADMIN_PATHS = ("/admin/", "/oidc/")
MAX_FAVICON_BYTES = 100_000
# The admin page that uploads a favicon; its requests may carry a larger file than
# other admin pages, so the form can explain the limit.
GENERAL_SETTINGS_PATH = "/admin/portal/appsettings/"


def current(request):
    """The settings the middleware loaded for this request."""
    general = getattr(request, "app_settings", None)
    return general if general is not None else AppSettings.load()


def request_language(request, general):
    return "en" if request.path.startswith(ADMIN_PATHS) else general.language


@contextlib.contextmanager
def applied(general, language):
    """Use `language` and the app timezone and date format until the block ends."""
    dates.use(general.date_format)
    with translation.override(language), timezone.override(general.timezone):
        yield


def for_claim(claim):
    """The settings for the PDF and emails of `claim`. Older claims were all German."""
    return applied(AppSettings.load(), claim.snapshot.get("language", "de"))


def favicon_type(content):
    """The media type of a PNG, ICO, SVG or WebP favicon, or None for anything else.

    Browsers decode favicons themselves, so the server only checks the format and never
    parses the image.
    """
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if content.startswith(b"\x00\x00\x01\x00"):
        return "image/x-icon"
    if content.startswith(b"RIFF") and content[8:12] == b"WEBP":
        return "image/webp"
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        return None
    if text.lstrip().startswith("<") and re.search(r"<svg[\s>]", text[:4096]):
        return "image/svg+xml"
    return None
