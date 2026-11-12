"""Branding for public pages and the administration area."""

from django.conf import settings
from django.templatetags.static import static
from django.urls import reverse

from portal import app_settings, theme
from portal.constants import APP_NAME
from portal.i18n import language


def branding(request):
    general = app_settings.current(request)
    if general.favicon_digest:
        favicon = reverse("favicon", args=[general.favicon_digest]), general.favicon_type
    else:
        favicon = static("portal/brand/logo.svg"), "image/svg+xml"
    color = general.accent_color
    return {
        "app_name": APP_NAME,
        "page_language": language(),
        "portal_operator": settings.PORTAL_OPERATOR,
        "portal_legal_url": settings.PORTAL_LEGAL_URL,
        "favicon_url": favicon[0],
        "favicon_type": favicon[1],
        # Over ui.css, so it links after it; none for the standard accent.
        "theme_url": reverse("theme", args=[theme.digest(color)]) if color else "",
    }
