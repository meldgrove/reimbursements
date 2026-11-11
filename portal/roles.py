"""Admin roles and form access. Keycloak groups map to these Django groups at every sign-in.

Template admins manage templates, the privacy notice, every form and claim actions.
Form editors create forms from templates and see the claims of the forms they own.
Every check of who may manage a form or see a claim goes through `managed_forms` and
`visible_claims`, so object checks and admin lists cannot disagree.
"""

from django.contrib.auth.models import Group

from portal.models import Claim, Form

TEMPLATE_ADMIN = "Vorlagen-Admins"
FORM_EDITOR = "Formular-Editoren"
ROLES = (TEMPLATE_ADMIN, FORM_EDITOR)


def roles(user):
    if not user.is_authenticated or not user.is_active:
        return frozenset()
    cached = getattr(user, "_portal_roles", None)
    if cached is None:
        cached = frozenset(user.groups.filter(name__in=ROLES).values_list("name", flat=True))
        if user.is_superuser:
            cached |= {TEMPLATE_ADMIN}
        user._portal_roles = cached
    return cached


def is_template_admin(user):
    return TEMPLATE_ADMIN in roles(user)


def is_form_editor(user):
    """Form editing is part of both roles."""
    return bool(roles(user))


def managed_forms(user, forms=None):
    """The forms this person manages: all for template admins, their own for form editors."""
    forms = Form.objects.all() if forms is None else forms
    if is_template_admin(user):
        return forms
    if is_form_editor(user):
        return forms.filter(owners=user)
    return forms.none()


def visible_claims(user, claims=None):
    """The claims this person sees: those of the forms they manage."""
    claims = Claim.objects.all() if claims is None else claims
    if is_template_admin(user):
        return claims
    if is_form_editor(user):
        return claims.filter(form__owners=user)
    return claims.none()


def manages(user, form):
    return managed_forms(user).filter(pk=form.pk).exists()


def sees(user, claim):
    return visible_claims(user).filter(pk=claim.pk).exists()


def assign(user, granted):
    """Replace the user's portal roles; staff access follows from having any role."""
    groups = {name: Group.objects.get_or_create(name=name)[0] for name in ROLES}
    user.groups.remove(*groups.values())
    user.groups.add(*(groups[name] for name in granted))
    user.is_staff = bool(granted)
    user.save(update_fields=["is_staff"])
    user._portal_roles = None
