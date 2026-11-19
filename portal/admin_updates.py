"""The update button's routes and the Updates tab of the Admin section (docs/updates.md).

Only template admins see the button and the tab. The routes answer everyone else 404,
marked `signedOut` so that the button stops its automatic requests when the session
ends, and the tab answers form editors 403, as the other tabs do. Sign-in and CSRF
protection are the admin area's.
"""

import json
from functools import wraps

from django.conf import settings
from django.core.exceptions import PermissionDenied
from django.http import JsonResponse
from django.template.response import TemplateResponse
from django.urls import path, reverse
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_GET, require_POST

from portal import app_settings
from portal.constants import APP_NAME
from portal.roles import is_template_admin
from portal.services import updater

GUIDE_URL = "https://github.com/meldgrove/reimbursements/blob/main/docs/updates.md"


SIGNED_OUT = {"error": "Sign in as a template admin to manage updates.", "signedOut": True}


def admins_only(view):
    @wraps(view)
    def wrapper(request, *args, **kwargs):
        if not is_template_admin(request.user):
            return JsonResponse(SIGNED_OUT, status=404)
        return view(request, *args, **kwargs)

    return never_cache(wrapper)


def _respond(answer):
    return JsonResponse(answer.body(), status=answer.status_code)


def _field(request, name):
    try:
        payload = json.loads(request.body)
    except ValueError:
        return None
    return payload.get(name) if isinstance(payload, dict) else None


def _invalid(message):
    answer = updater.Answer(400, bool(settings.UPDATER_URL), error=message)
    return _respond(answer)


@admins_only
@require_GET
def status(request):
    return _respond(updater.status())


@admins_only
@require_POST
def check(request):
    return _respond(updater.check())


@admins_only
@require_POST
def install(request):
    version = _field(request, "version")
    if not updater.valid_version(version):
        return _invalid("Name the version to install, such as 0.2.1.")
    return _respond(updater.install(version))


@admins_only
@require_POST
def channel(request):
    name = _field(request, "channel")
    if name not in updater.CHANNELS:
        return _invalid("The channel is stable or preview.")
    return _respond(updater.change_channel(name))


def urls(site):
    """The routes under /admin/; the tab's URL name marks the Admin section active."""

    def settings_tab(request):
        if not is_template_admin(request.user):
            raise PermissionDenied
        return TemplateResponse(
            request,
            "admin/portal/updates.html",
            {
                **site.each_context(request),
                "title": "Updates",
                "description": "Which versions this server installs, and when.",
            },
        )

    return [
        path("updates/", status, name="updates"),
        path("updates/check/", check, name="updates_check"),
        path("updates/install/", install, name="updates_install"),
        path("updates/channel/", channel, name="updates_channel"),
        path("portal/updates/", site.admin_view(settings_tab), name="portal_updates_settings"),
    ]


# The locale whose dates read like each date format (Admin > General); en-GB for YYYY-MM-DD.
DATE_LOCALES = {"d.m.Y": "de-DE", "d/m/Y": "en-GB", "m/d/Y": "en-US"}


def context(request):
    """What the admin pages need for the button and the tab, for template admins only."""
    if not is_template_admin(request.user):
        return None
    general = app_settings.current(request)
    return {
        # The button needs the updater; the tab explains its absence.
        "button": bool(settings.UPDATER_URL),
        # The attributes of the @meldgrove/ui elements (updates_attributes.html).
        "app_name": APP_NAME,
        "url": reverse("admin:updates"),
        "guide": f"{GUIDE_URL}#switch-it-on",
        # Dates as in the rest of the admin area: the format and timezone of Admin > General.
        "date_locale": DATE_LOCALES.get(general.date_format, "en-GB"),
        "time_zone": general.timezone,
    }
