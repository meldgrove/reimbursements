"""The admin's sidebar, the person shown in it, and the global search.

The admin area shows its pages in the frame of every Meldgrove app (@meldgrove/ui's
AppFrame, rebuilt server-side in admin/base.html): the navigation as text in groups,
"G then a letter" for the main pages ("O" is the start page in every app, none for
admin pages), and the search.

Search reuses each ModelAdmin's queryset and search, so it finds exactly what the
signed-in person may open from the admin lists. It also finds archived claims and
forms, which the lists leave out, and marks them.
"""

from dataclasses import dataclass

from django.urls import reverse

from portal.models import Claim, Form, FormTemplate
from portal.roles import is_form_editor, is_template_admin


@dataclass(frozen=True)
class Page:
    label: str
    url_name: str
    # Admin URL names of these models (portal_<model>_<view>) mark the page active.
    models: tuple[str, ...]
    # "G then this letter" opens the page.
    shortcut: str = ""


@dataclass(frozen=True)
class Group:
    label: str
    pages: tuple[Page, ...]
    template_admins_only: bool = False


NAVIGATION = (
    Group(
        "",
        (
            Page("Claims", "admin:portal_claim_changelist", ("claim",), shortcut="o"),
            Page("Forms", "admin:portal_form_changelist", ("form",), shortcut="f"),
        ),
    ),
    Group(
        "Admin",
        (
            Page("General", "admin:portal_appsettings_changelist", ("appsettings",)),
            Page("Appearance", "admin:portal_appearance_changelist", ("appearance",)),
            Page("Templates", "admin:portal_formtemplate_changelist", ("formtemplate",)),
            Page("Privacy notice", "admin:portal_privacynotice_changelist", ("privacynotice",)),
            # Not a model: the channel lives in the updater (portal.admin_updates).
            Page("Updates", "admin:portal_updates_settings", ("updates",)),
        ),
        template_admins_only=True,
    ),
)
SUGGESTION_LIMIT = 5
RESULT_LIMIT = 50


def current_model(request):
    match = getattr(request, "resolver_match", None)
    parts = (match.url_name or "").split("_") if match else []
    return parts[1] if len(parts) >= 3 and parts[0] == "portal" else ""


def _visible(group, user):
    return is_form_editor(user) and (not group.template_admins_only or is_template_admin(user))


def navigation(request):
    """The sidebar's groups for this person, with the current page marked."""
    model = current_model(request)
    return [
        {
            "label": group.label,
            "items": [
                {
                    "label": page.label,
                    "url": reverse(page.url_name),
                    "shortcut": page.shortcut,
                    "active": model in page.models,
                }
                for page in group.pages
            ],
        }
        for group in NAVIGATION
        if _visible(group, request.user)
    ]


def person(user):
    """The person at the bottom of the sidebar: name, email, role and initials."""
    name = user.get_full_name() or user.email or user.get_username()
    words = name.split()
    letters = [words[0], words[-1]] if len(words) > 1 else words
    return {
        "name": name,
        "email": user.email,
        "detail": "Template admin" if is_template_admin(user) else "Form editor",
        "initials": "".join(word[0] for word in letters).upper() or "?",
    }


def _claim(claim):
    detail = f"{claim.form.name} · {claim.reference}"
    return {
        "name": claim.full_name or "Claim",
        "detail": f"{detail} · Archived" if claim.archived_at else detail,
        "reference": claim.bookkeeping_reference or str(claim.id)[:8],
        "kind": "Archived" if claim.archived_at else "Claim",
    }


def _form(form):
    archived = form.status == Form.Status.ARCHIVED
    detail = f"/f/{form.slug}/"
    return {
        "name": form.name,
        "detail": f"{detail} · Archived" if archived else detail,
        "kind": "Archived" if archived else "Form",
    }


def _template(template):
    return {
        "name": template.name,
        "detail": template.description.splitlines()[0] if template.description else "",
        "kind": "Template",
    }


SEARCHES = (
    ("Claims", Claim, ["-submitted_at"], _claim),
    ("Forms", Form, ["name"], _form),
    ("Templates", FormTemplate, ["name"], _template),
)


def search(request, site, query, limit):
    """Groups of results: matching pages first, then records, each at most `limit` long."""
    term = query.strip()
    if len(term) < 2:
        return []
    needle = term.casefold()
    pages = [
        {"name": item["label"], "detail": "Page", "url": item["url"]}
        for group in navigation(request)
        for item in group["items"]
        if needle in item["label"].casefold()
    ]
    groups = [{"label": "Pages", "items": pages}] if pages else []
    for label, model, ordering, describe in SEARCHES:
        model_admin = site._registry[model]
        if not model_admin.has_view_permission(request):
            continue
        if model is FormTemplate and not is_template_admin(request.user):
            continue
        queryset = model_admin.get_queryset(request)
        queryset, may_have_duplicates = model_admin.get_search_results(request, queryset, term)
        if may_have_duplicates:
            queryset = queryset.distinct()
        items = []
        for obj in queryset.order_by(*ordering)[:limit]:
            url = reverse(f"admin:portal_{model._meta.model_name}_change", args=[obj.pk])
            items.append({**describe(obj), "url": url})
        if items:
            groups.append({"label": label, "items": items})
    return groups


def results(request, site, query):
    """The records for the frame's search; it finds the pages itself, in the sidebar."""
    return [
        {
            "href": item["url"],
            "title": item["name"],
            "reference": item.get("reference", ""),
            "kind": item["kind"],
        }
        for group in search(request, site, query, SUGGESTION_LIMIT)
        if group["label"] != "Pages"
        for item in group["items"]
    ]
