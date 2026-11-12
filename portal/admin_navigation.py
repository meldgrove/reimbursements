"""The admin sidebar, the settings tabs and the global search.

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
    icon: str
    url_name: str
    # Admin URL names of these models (portal_<model>_<view>) mark the page active.
    models: tuple[str, ...]
    template_admins_only: bool = False
    # Settings sit apart at the end of the sidebar.
    separated: bool = False


SECTIONS = (
    Page("Claims", "receipt-euro", "admin:portal_claim_changelist", ("claim",)),
    Page("Forms", "file-text", "admin:portal_form_changelist", ("form",)),
    Page(
        "Admin",
        "settings",
        "admin:portal_appsettings_changelist",
        ("appsettings", "formtemplate", "privacynotice"),
        template_admins_only=True,
        separated=True,
    ),
)
SETTINGS_TABS = (
    Page(
        "General",
        "globe",
        "admin:portal_appsettings_changelist",
        ("appsettings",),
        template_admins_only=True,
    ),
    Page(
        "Templates",
        "layout-template",
        "admin:portal_formtemplate_changelist",
        ("formtemplate",),
        template_admins_only=True,
    ),
    Page(
        "Privacy notice",
        "shield-check",
        "admin:portal_privacynotice_changelist",
        ("privacynotice",),
        template_admins_only=True,
    ),
)
SUGGESTION_LIMIT = 5
RESULT_LIMIT = 50


def current_model(request):
    match = getattr(request, "resolver_match", None)
    parts = (match.url_name or "").split("_") if match else []
    return parts[1] if len(parts) >= 3 and parts[0] == "portal" else ""


def _visible(page, user):
    return is_form_editor(user) and (not page.template_admins_only or is_template_admin(user))


def _links(pages, request):
    model = current_model(request)
    return [
        {
            "label": page.label,
            "icon": page.icon,
            "url": reverse(page.url_name),
            "active": model in page.models,
            "separated": page.separated,
        }
        for page in pages
        if _visible(page, request.user)
    ]


def sections(request):
    return _links(SECTIONS, request)


def settings_tabs(request):
    """The tabs of the Admin section, or none outside it."""
    if current_model(request) not in SECTIONS[-1].models:
        return []
    return _links(SETTINGS_TABS, request)


def _claim(claim):
    detail = f"{claim.form.name} · {claim.reference}"
    return claim.full_name or "Claim", f"{detail} · Archived" if claim.archived_at else detail


def _form(form):
    detail = f"/f/{form.slug}/"
    return form.name, f"{detail} · Archived" if form.status == Form.Status.ARCHIVED else detail


def _template(template):
    return template.name, template.description.splitlines()[0] if template.description else ""


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
        {"name": link["label"], "detail": "Page", "url": link["url"]}
        for link in _links(SECTIONS + SETTINGS_TABS, request)
        if needle in link["label"].casefold()
    ]
    groups = [{"label": "Navigation", "items": pages}] if pages else []
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
            name, detail = describe(obj)
            url = reverse(f"admin:portal_{model._meta.model_name}_change", args=[obj.pk])
            items.append({"name": name, "detail": detail, "url": url})
        if items:
            groups.append({"label": label, "items": items})
    return groups
