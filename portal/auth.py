"""Keycloak sign-in for the admin area.

mozilla-django-oidc checks the token signature and nonce. This module adds the issuer,
audience and lifetime checks, keys users by their Keycloak subject, and grants roles
only from the verified `groups` claim of every sign-in.
"""

import logging
import math
import time
from datetime import timedelta
from urllib.parse import urlencode

from django.conf import settings
from django.core.exceptions import SuspiciousOperation
from mozilla_django_oidc.auth import OIDCAuthenticationBackend
from mozilla_django_oidc.views import OIDCAuthenticationCallbackView

from portal import roles

logger = logging.getLogger(__name__)


def keycloak_logout_url(request):
    query = {
        "client_id": settings.OIDC_RP_CLIENT_ID,
        "post_logout_redirect_uri": request.build_absolute_uri(settings.LOGOUT_REDIRECT_URL),
    }
    id_token = request.session.get("oidc_id_token")
    if id_token:
        query["id_token_hint"] = id_token
    return f"{settings.OIDC_OP_LOGOUT_ENDPOINT}?{urlencode(query)}"


def granted_roles(claims):
    groups = claims.get("groups")
    groups = (
        {group for group in groups if isinstance(group, str)} if isinstance(groups, list) else set()
    )
    granted = set()
    if settings.KEYCLOAK_ADMIN_GROUP in groups:
        granted.add(roles.TEMPLATE_ADMIN)
    if settings.KEYCLOAK_EDITOR_GROUP in groups:
        granted.add(roles.FORM_EDITOR)
    return granted


def email_verified(claims):
    value = claims.get("email_verified")
    if isinstance(value, str):
        return value.strip().lower() == "true"
    return value is True


class KeycloakBackend(OIDCAuthenticationBackend):
    def verify_token(self, token, **kwargs):
        try:
            payload = super().verify_token(token, **kwargs)
        except (ValueError, TypeError, AttributeError) as exc:
            raise SuspiciousOperation("Malformed OIDC ID token.") from exc
        if payload.get("iss") != settings.KEYCLOAK_REALM_URL:
            raise SuspiciousOperation("OIDC ID token issuer did not match.")
        for claim in ("sub", "nonce"):
            if not isinstance(payload.get(claim), str) or not payload[claim]:
                raise SuspiciousOperation(f"OIDC ID token {claim} is missing.")
        audience = payload.get("aud")
        audiences = [audience] if isinstance(audience, str) else audience
        if (
            not isinstance(audiences, list)
            or not audiences
            or any(value != self.OIDC_RP_CLIENT_ID for value in audiences)
        ):
            raise SuspiciousOperation("OIDC ID token audience did not match.")
        if ("azp" in payload or len(audiences) > 1) and payload.get(
            "azp"
        ) != self.OIDC_RP_CLIENT_ID:
            raise SuspiciousOperation("OIDC ID token authorized party did not match.")
        dates = {}
        for claim in ("exp", "iat", "nbf"):
            if claim == "nbf" and claim not in payload:
                continue
            value = payload.get(claim)
            if type(value) not in (int, float) or not math.isfinite(value):
                raise SuspiciousOperation(f"OIDC ID token {claim} is invalid.")
            dates[claim] = value
        now = time.time()
        if dates["exp"] <= now or dates["exp"] <= dates["iat"]:
            raise SuspiciousOperation("OIDC ID token has expired.")
        # One minute of provider clock skew for issue and not-before times.
        if dates["iat"] > now + 60 or dates.get("nbf", now) > now + 60:
            raise SuspiciousOperation("OIDC ID token is not yet valid.")
        return payload

    def get_userinfo(self, access_token, id_token, payload):
        user_info = super().get_userinfo(access_token, id_token, payload)
        if user_info.get("sub") != payload.get("sub"):
            raise SuspiciousOperation("OIDC ID token and UserInfo subjects did not match.")
        # Keycloak may put groups only into the verified ID token.
        if isinstance(payload.get("groups"), list):
            user_info["groups"] = payload["groups"]
        return user_info

    def verify_claims(self, claims):
        if not email_verified(claims) or not claims.get("email"):
            logger.warning("admin_login_denied reason=unverified_email")
            return False
        if not granted_roles(claims):
            logger.warning("admin_login_denied reason=no_portal_group")
            return False
        return True

    def filter_users_by_claims(self, claims):
        return self.UserModel.objects.filter(username=claims["sub"])

    def create_user(self, claims):
        user = self.UserModel.objects.create_user(claims["sub"])
        return self.update_user(user, claims)

    def update_user(self, user, claims):
        user.email = claims.get("email", "")[:254]
        user.first_name = claims.get("given_name", "")[:150]
        user.last_name = claims.get("family_name", "")[:150]
        user.save(update_fields=["email", "first_name", "last_name"])
        roles.assign(user, granted_roles(claims))
        return user


class AdminCallbackView(OIDCAuthenticationCallbackView):
    def login_success(self):
        response = super().login_success()
        # An inactivity timeout would let ordinary session writes prolong admin access.
        self.request.session.set_expiry(timedelta(seconds=settings.ADMIN_SESSION_SECONDS))
        return response
