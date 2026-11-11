"""Deployment branding for public pages and the administration area."""

from django.conf import settings


def branding(request):
    return {
        "portal_name": settings.PORTAL_NAME,
        "portal_operator": settings.PORTAL_OPERATOR,
        "portal_legal_url": settings.PORTAL_LEGAL_URL,
    }
