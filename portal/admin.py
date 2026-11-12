"""The admin area, always in English: claims, forms, templates, the privacy notice and the
General settings, behind Keycloak."""

import uuid

from django import forms
from django.conf import settings
from django.contrib import admin, messages
from django.contrib.admin import helpers
from django.contrib.admin.utils import display_for_value
from django.core.exceptions import PermissionDenied
from django.db import IntegrityError
from django.http import Http404, HttpResponseNotAllowed, HttpResponseRedirect, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.template.response import TemplateResponse
from django.templatetags.static import static
from django.urls import path, reverse
from django.utils.html import format_html
from django.utils.http import url_has_allowed_host_and_scheme, urlencode
from mozilla_django_oidc.views import OIDCLogoutView

from portal import admin_navigation, app_settings, roles
from portal.constants import APP_NAME
from portal.models import (
    AppSettings,
    Claim,
    Form,
    FormTemplate,
    Operation,
    PrivacyNotice,
    TemplateField,
    timezone_names,
)
from portal.roles import is_form_editor, is_template_admin
from portal.services import claim_status, delivery, operations, publication, retention
from portal.templatetags.ui import render_component


class PortalAdminSite(admin.AdminSite):
    site_header = APP_NAME
    site_title = APP_NAME
    index_title = "Administration"
    site_url = "/"
    enable_nav_sidebar = False

    def has_permission(self, request):
        return is_form_editor(request.user)

    def login(self, request, extra_context=None):
        next_url = request.GET.get("next", "")
        if not url_has_allowed_host_and_scheme(next_url, {request.get_host()}):
            next_url = reverse("admin:index")
        if self.has_permission(request):
            return HttpResponseRedirect(next_url or reverse("admin:index"))
        if settings.OIDC_ENABLED:
            query = urlencode({"next": next_url or reverse("admin:index")})
            return HttpResponseRedirect(f"{reverse('oidc_authentication_init')}?{query}")
        if settings.DEBUG:
            # Local development without Keycloak: `manage.py createsuperuser`.
            return super().login(request, extra_context)
        return render(request, "admin/portal/no_access.html", {"unconfigured": True}, status=503)

    def logout(self, request, extra_context=None):
        if settings.OIDC_ENABLED and request.method == "POST":
            return OIDCLogoutView.as_view()(request)
        return super().logout(request, extra_context)

    def each_context(self, request):
        context = super().each_context(request)
        if self.has_permission(request):
            context["nav_sections"] = admin_navigation.sections(request)
            context["settings_tabs"] = admin_navigation.settings_tabs(request)
            context["account_url"] = settings.KEYCLOAK_ACCOUNT_URL if settings.OIDC_ENABLED else ""
        return context

    def index(self, request, extra_context=None):
        return redirect("admin:portal_claim_changelist")

    def app_index(self, request, app_label, extra_context=None):
        return redirect("admin:portal_claim_changelist")

    def get_urls(self):
        return [
            path("no-access/", self.no_access, name="no_access"),
            path("search/", self.admin_view(self.search), name="search"),
            path(
                "search/suggestions/",
                self.admin_view(self.search_suggestions),
                name="search_suggestions",
            ),
            *super().get_urls(),
        ]

    def no_access(self, request):
        return render(request, "admin/portal/no_access.html", status=403)

    def search(self, request):
        query = request.GET.get("q", "")[:100]
        groups = admin_navigation.search(request, self, query, admin_navigation.RESULT_LIMIT)
        return TemplateResponse(
            request,
            "admin/portal/search.html",
            {**self.each_context(request), "title": "Search", "query": query, "groups": groups},
        )

    def search_suggestions(self, request):
        query = request.GET.get("q", "")[:100]
        groups = admin_navigation.search(request, self, query, admin_navigation.SUGGESTION_LIMIT)
        return JsonResponse({"groups": groups})


site = PortalAdminSite(name="admin")


class GeneralSettingsForm(forms.ModelForm):
    timezone = forms.ChoiceField(label="Timezone")
    favicon_file = forms.FileField(
        label="New favicon",
        required=False,
        help_text="PNG, ICO, SVG or WebP, at most 100 KB. Square images of at least 32 × 32 pixels "
        "look best.",
    )
    remove_favicon = forms.BooleanField(label="Use the standard favicon", required=False)

    class Meta:
        model = AppSettings
        fields = ["language", "timezone", "date_format"]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["timezone"].choices = [
            (name, name.replace("_", " ")) for name in timezone_names()
        ]
        self.fields["timezone"].help_text = AppSettings._meta.get_field("timezone").help_text

    def clean_favicon_file(self):
        upload = self.cleaned_data.get("favicon_file")
        if not upload:
            return None
        if upload.size > app_settings.MAX_FAVICON_BYTES:
            raise forms.ValidationError("The favicon may be at most 100 KB.")
        content = upload.read()
        media_type = app_settings.favicon_type(content)
        if media_type is None:
            raise forms.ValidationError("Upload a PNG, ICO, SVG or WebP file.")
        return content, media_type

    def save(self, commit=True):
        general = super().save(commit=False)
        if self.cleaned_data.get("favicon_file"):
            general.set_favicon(*self.cleaned_data["favicon_file"])
        elif self.cleaned_data.get("remove_favicon"):
            general.set_favicon(b"")
        if commit:
            general.save()
        return general


@admin.register(AppSettings, site=site)
class AppSettingsAdmin(admin.ModelAdmin):
    """The General tab: one settings row, edited in place."""

    form = GeneralSettingsForm
    change_form_template = "admin/portal/appsettings/change_form.html"
    fieldsets = [
        ("Language and dates", {"fields": ["language", "timezone", "date_format"]}),
        (
            "Favicon",
            {
                "fields": ["current_favicon", "favicon_file", "remove_favicon"],
                "description": "The icon in browser tabs, on public pages and in the admin area.",
            },
        ),
    ]
    readonly_fields = ["current_favicon"]

    def has_module_permission(self, request):
        return is_template_admin(request.user)

    def has_view_permission(self, request, obj=None):
        return is_template_admin(request.user)

    def has_change_permission(self, request, obj=None):
        return is_template_admin(request.user)

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    def get_object(self, request, object_id, from_field=None):
        return AppSettings.load() if str(object_id) == "1" else None

    def changelist_view(self, request, extra_context=None):
        return redirect("admin:portal_appsettings_change", 1)

    def change_view(self, request, object_id, form_url="", extra_context=None):
        extra_context = {
            **(extra_context or {}),
            "title": "General",
            "show_save_and_continue": False,
            "show_save_and_add_another": False,
        }
        return super().change_view(request, object_id, form_url, extra_context)

    def response_change(self, request, obj):
        messages.success(request, "The general settings were saved.")
        return redirect("admin:portal_appsettings_change", 1)

    @admin.display(description="Current favicon")
    def current_favicon(self, obj):
        if obj.favicon_digest:
            url, label = reverse("favicon", args=[obj.favicon_digest]), "Custom favicon"
        else:
            url, label = static("portal/brand/logo.svg"), "Standard favicon"
        return format_html(
            '<span class="inline-flex items-center gap-3"><img src="{}" alt="" width="32" '
            'height="32" class="size-8 rounded-md border bg-background object-contain">{}</span>',
            url,
            label,
        )


class RoleAdmin(admin.ModelAdmin):
    """Template admins may change; form editors may only view."""

    def has_module_permission(self, request):
        return is_form_editor(request.user)

    def has_view_permission(self, request, obj=None):
        return is_form_editor(request.user)

    def has_add_permission(self, request):
        return is_template_admin(request.user)

    def has_change_permission(self, request, obj=None):
        return is_template_admin(request.user)

    def has_delete_permission(self, request, obj=None):
        return is_template_admin(request.user)


@admin.register(PrivacyNotice, site=site)
class PrivacyNoticeAdmin(RoleAdmin):
    list_description = (
        "Participants always see the latest version. Every change is saved as a new version."
    )
    add_label = "New version"
    list_display = ["__str__", "created_at", "created_by", "is_current"]
    fields = ["text"]

    def has_module_permission(self, request):
        return is_template_admin(request.user)

    def has_view_permission(self, request, obj=None):
        return is_template_admin(request.user)

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    @admin.display(description="Current", boolean=True)
    def is_current(self, obj):
        current = PrivacyNotice.current()
        return bool(current and current.pk == obj.pk)

    def get_form(self, request, obj=None, change=False, **kwargs):
        kwargs["help_texts"] = {
            "text": "A blank line separates paragraphs. A line starting with “# ” becomes a heading."
        }
        return super().get_form(request, obj, change, **kwargs)

    def add_view(self, request, form_url="", extra_context=None):
        extra_context = {**(extra_context or {}), "show_save_and_add_another": False}
        return super().add_view(request, form_url, extra_context)

    def get_changeform_initial_data(self, request):
        current = PrivacyNotice.current()
        return {"text": current.text} if current else {}

    def save_model(self, request, obj, form, change):
        obj.created_by = request.user.email or request.user.get_username()
        obj.save()


class TemplateFieldInline(admin.TabularInline):
    model = TemplateField
    extra = 0
    fields = ["position", "label", "key", "kind", "choices", "pattern", "required"]

    def has_view_permission(self, request, obj=None):
        return is_form_editor(request.user)

    def has_add_permission(self, request, obj=None):
        return is_template_admin(request.user)

    def has_change_permission(self, request, obj=None):
        return is_template_admin(request.user)

    def has_delete_permission(self, request, obj=None):
        return is_template_admin(request.user)


@admin.register(FormTemplate, site=site)
class FormTemplateAdmin(RoleAdmin):
    list_description = "Templates set which internal values and details a form asks for."
    add_label = "Add template"
    search_placeholder = "Name or description …"
    list_display = ["name", "travel", "mileage_enabled", "form_count", "updated_at"]
    search_fields = ["name", "description"]
    inlines = [TemplateFieldInline]
    fieldsets = [
        (None, {"fields": ["name", "description"]}),
        ("For participants", {"fields": ["intro", "travel", "mileage_enabled", "mileage_rate"]}),
        ("Declaration", {"fields": ["declaration", "declaration_version"]}),
    ]

    @admin.display(description="Forms")
    def form_count(self, obj):
        return obj.forms.count()

    def has_delete_permission(self, request, obj=None):
        return super().has_delete_permission(request, obj) and not (obj and obj.forms.exists())


def actor(request):
    """Who an audited action is logged for."""
    return request.user.email or request.user.get_username()


class ArchiveFilter(admin.SimpleListFilter):
    """A Status filter of a list that leaves archived records out unless asked for them."""

    title = "Status"
    parameter_name = "status"
    # The filter value that lists the archived records.
    archived = None

    def choices(self, changelist):
        choices = list(super().choices(changelist))
        choices[0]["display"] = "All except archived"
        return choices

    @classmethod
    def lists_archived(cls, request):
        """The list shows archived records, so its actions unarchive instead of archive."""
        return request.GET.get(cls.parameter_name) == cls.archived


class FormStatusFilter(ArchiveFilter):
    archived = Form.Status.ARCHIVED

    def lookups(self, request, model_admin):
        return Form.Status.choices

    def queryset(self, request, queryset):
        if self.value() in Form.Status.values:
            return queryset.filter(status=self.value())
        return queryset.exclude(status=Form.Status.ARCHIVED)


def report_archiving(request, changed, noun, *, archived):
    """Tell the person how many records a bulk (un)archive action changed."""
    verb = "archived" if archived else "unarchived"
    if changed == 1:
        messages.success(request, f"1 {noun} was {verb}.")
    elif changed:
        messages.success(request, f"{changed} {noun}s were {verb}.")
    elif archived:
        messages.info(request, f"The selected {noun}s were already archived.")
    else:
        messages.info(request, f"None of the selected {noun}s were archived.")


FORM_STATUS_TONES = {
    Form.Status.DRAFT: "secondary",
    Form.Status.PUBLISHED: "success",
    Form.Status.ARCHIVED: "outline",
}


@admin.register(Form, site=site)
class FormAdmin(admin.ModelAdmin):
    change_form_template = "admin/portal/form/change_form.html"
    delete_confirmation_template = "admin/portal/form/delete_confirmation.html"
    list_description = "Participants submit their expenses through a form's link."
    add_label = "Add form"
    search_placeholder = "Name or short name …"
    empty_description = "Create a form from a template and share its link."
    list_display = [
        "name",
        "template",
        "publication_status",
        "primary",
        "values_complete",
        "open_now",
        "closes_at",
        "link",
    ]
    list_filter = [FormStatusFilter, "primary", "template"]
    search_fields = ["name", "slug"]
    exclude = ["status", "creation_key"]
    prepopulated_fields = {"slug": ["name"]}
    actions = ["archive_forms", "unarchive_forms"]

    def has_module_permission(self, request):
        return is_form_editor(request.user)

    def has_view_permission(self, request, obj=None):
        return is_form_editor(request.user) and (obj is None or roles.manages(request.user, obj))

    def has_add_permission(self, request):
        return is_form_editor(request.user)

    def has_change_permission(self, request, obj=None):
        return self.has_view_permission(request, obj)

    def has_delete_permission(self, request, obj=None):
        if obj is None:
            return is_template_admin(request.user)
        return publication.may_delete(request.user, obj)

    def delete_view(self, request, object_id, extra_context=None):
        if request.method == "POST" and request.POST.get("post") != "yes":
            return JsonResponse({"error": "Please confirm deleting the draft."}, status=400)
        form = self.get_object(request, object_id)
        archived = form is not None and form.status == Form.Status.ARCHIVED
        extra_context = {**(extra_context or {}), "kind": "archived form" if archived else "draft"}
        return super().delete_view(request, object_id, extra_context)

    def get_actions(self, request):
        actions = super().get_actions(request)
        archived = FormStatusFilter.lists_archived(request)
        actions.pop("archive_forms" if archived else "unarchive_forms", None)
        return actions

    @admin.action(description="Archive selected forms", permissions=["change"])
    def archive_forms(self, request, queryset):
        self._set_archived(request, queryset, archived=True)

    @admin.action(description="Unarchive selected forms", permissions=["change"])
    def unarchive_forms(self, request, queryset):
        self._set_archived(request, queryset, archived=False)

    def _set_archived(self, request, queryset, *, archived):
        changed = 0
        for form in queryset:
            if publication.set_archived(form, archived):
                self.log_change(request, form, "Archived." if archived else "Unarchived.")
                changed += 1
        report_archiving(request, changed, "form", archived=archived)

    def get_queryset(self, request):
        return roles.managed_forms(
            request.user, super().get_queryset(request).select_related("template")
        )

    def _template(self, request, obj):
        if obj is not None:
            return obj.template
        try:
            return FormTemplate.objects.get(pk=request.GET.get("template"))
        except (FormTemplate.DoesNotExist, ValueError, TypeError) as exc:
            raise Http404 from exc

    def add_view(self, request, form_url="", extra_context=None):
        if "template" not in request.GET:
            return TemplateResponse(
                request,
                "admin/portal/form/choose_template.html",
                {
                    **self.admin_site.each_context(request),
                    "opts": self.model._meta,
                    "title": "Choose a template for the new form",
                    "templates": FormTemplate.objects.all(),
                },
            )
        return super().add_view(request, form_url, extra_context)

    def get_form(self, request, obj=None, change=False, **kwargs):
        # changeform_view has already refused unknown actions.
        status = publication.status_after(obj, request.POST.get("_publication", ""))
        kwargs["form"] = publication.settings_form(self._template(request, obj), status)
        return super().get_form(request, obj, change, **kwargs)

    def get_fieldsets(self, request, obj=None):
        template = self._template(request, obj)
        main = ["template_name", "name", "slug", "primary", "opens_at", "closes_at"]
        if obj is not None:
            main.append("link")
        fieldsets = [(None, {"fields": main})]
        values = [f"value_{field.key}" for field in template.fields.all()]
        if values:
            fieldsets.append(
                (
                    "Internal values",
                    {
                        "fields": values,
                        "description": "Not visible to participants; printed in the PDF.",
                    },
                )
            )
        participant = ["title", "description", "instructions", "purpose_options"]
        if template.travel != FormTemplate.Travel.OFF:
            participant += ["trip_start", "trip_end"]
        fieldsets += [
            ("For participants", {"fields": participant}),
            ("Delivery and contact", {"fields": ["recipient", "support_email"]}),
        ]
        return fieldsets

    def get_readonly_fields(self, request, obj=None):
        # The start page is app-wide, so only template admins choose it.
        if is_template_admin(request.user):
            return ["template_name", "link"]
        return ["template_name", "link", "primary"]

    def get_prepopulated_fields(self, request, obj=None):
        return self.prepopulated_fields if obj is None else {}

    def get_changeform_initial_data(self, request):
        recipients = settings.APPROVED_DELIVERY_RECIPIENTS
        return {
            "support_email": request.user.email,
            "recipient": recipients[0] if len(recipients) == 1 else "",
        }

    @admin.display(description="Status", ordering="status")
    def publication_status(self, obj):
        return render_component(
            "badge", obj.get_status_display(), variant=FORM_STATUS_TONES[obj.status]
        )

    @admin.display(description="Template")
    def template_name(self, obj):
        return obj.template.name if obj and obj.template_id else ""

    @admin.display(description="Link", ordering="slug")
    def link(self, obj):
        if not obj or not obj.pk:
            return ""
        url = self._absolute(reverse("form_page", kwargs={"form_slug": obj.slug}))
        return format_html('<a href="{}" target="_blank" rel="noopener">{}</a>', url, url)

    def _absolute(self, url):
        request = getattr(self, "_request", None)
        return request.build_absolute_uri(url) if request else url

    @admin.display(description="Open now", boolean=True)
    def open_now(self, obj):
        return obj.is_open()

    @admin.display(description="Internal values complete", boolean=True)
    def values_complete(self, obj):
        return not obj.internal_value_errors()

    def changelist_view(self, request, extra_context=None):
        self._request = request
        return super().changelist_view(request, extra_context)

    def changeform_view(self, request, object_id=None, form_url="", extra_context=None):
        self._request = request
        try:
            creation_key = self._creation_key(request) if object_id is None else None
        except ValueError:
            return JsonResponse({"error": "Invalid request. Please reload the page."}, status=400)
        existing = creation_key and publication.created(request.user, creation_key)
        if existing:
            object_id = str(existing.pk)
        form = self.get_object(request, object_id) if object_id else None
        extra_context = {
            **(extra_context or {}),
            "form_delete_hidden": not (form and self.has_delete_permission(request, form)),
            "form_archived": bool(form and form.status == Form.Status.ARCHIVED),
        }
        if (
            request.method == "GET"
            and form
            and form.status == Form.Status.PUBLISHED
            and form.internal_value_errors()
        ):
            messages.warning(
                request,
                "The template was changed. The form stays closed until these internal "
                f"values fit: {', '.join(form.internal_value_errors())}.",
            )
        try:
            publication.status_after(form, request.POST.get("_publication", ""))
        except publication.Refused as exc:
            return JsonResponse({"error": str(exc)}, status=400)
        try:
            response = super().changeform_view(request, object_id, form_url, extra_context)
        except IntegrityError:
            # A timed-out first save may still finish while its retry is being processed.
            existing = (
                publication.created(request.user, creation_key)
                if creation_key and object_id is None
                else None
            )
            if existing is None:
                raise
            return self.changeform_view(request, str(existing.pk), form_url, extra_context)
        if self._autosave(request) and isinstance(response, TemplateResponse):
            context = response.context_data
            if context.get("adminform"):
                return JsonResponse(
                    {"errors": context["adminform"].form.errors.get_json_data()}, status=400
                )
        if self._autosave(request) and response.status_code == 302:
            # A deleted form must never turn an autosave into a second new form.
            return JsonResponse(
                {"error": "The form is no longer available. Please reload the page."},
                status=404,
            )
        return response

    @staticmethod
    def _autosave(request):
        return request.method == "POST" and request.POST.get("_autosave") == "1"

    @classmethod
    def _creation_key(cls, request):
        """The key a script sends with every first save of a new form; ValueError if invalid."""
        value = request.POST.get("_creation_key") if cls._autosave(request) else None
        return uuid.UUID(value) if value else None

    def _saved_response(self, request, obj):
        return JsonResponse(
            {
                "url": reverse("admin:portal_form_change", args=[obj.pk]),
                "name": obj.name,
                "slug": obj.slug,
                "status": obj.status,
                "status_label": obj.get_status_display(),
                "primary": obj.primary,
                "link": reverse("form_page", kwargs={"form_slug": obj.slug}),
                "can_delete": self.has_delete_permission(request, obj),
                "delete_url": reverse("admin:portal_form_delete", args=[obj.pk]),
            }
        )

    def response_add(self, request, obj, post_url_continue=None):
        if self._autosave(request):
            return self._saved_response(request, obj)
        return super().response_add(request, obj, post_url_continue)

    def response_change(self, request, obj):
        if self._autosave(request):
            return self._saved_response(request, obj)
        return super().response_change(request, obj)

    def save_model(self, request, obj, form, change):
        creation_key = None if change else self._creation_key(request)
        publication.save(obj, request.user, creation_key=creation_key)


def claim_status_badge(claim):
    status = claim_status.of(claim)
    badge = render_component("badge", status.label, variant=status.tone)
    if not status.archived:
        return badge
    archived = render_component("badge", "Archived", variant="outline")
    return format_html('<span class="inline-flex flex-wrap gap-1">{}{}</span>', badge, archived)


class StatusFilter(ArchiveFilter):
    """Filters claims by the value of their Status column; archived claims by Archived."""

    archived = claim_status.ARCHIVED

    def lookups(self, request, model_admin):
        return claim_status.FILTER_CHOICES

    def queryset(self, request, queryset):
        return claim_status.listed(queryset, self.value())


class RetryForm(forms.Form):
    reason = forms.CharField(
        label="Reason", max_length=500, widget=forms.Textarea(attrs={"rows": 3})
    )
    acknowledge_duplicate_risk = forms.BooleanField(
        label=("I have checked the delivery and accept that Finance may receive the claim twice."),
        required=False,
    )


class DeleteForm(forms.Form):
    reason = forms.CharField(
        label="Reason", max_length=500, widget=forms.Textarea(attrs={"rows": 3})
    )


# A bulk deletion purges in the request; larger cleanups run in several steps.
MAX_BULK_DELETE = 100

OPERATION_LABELS = {
    "retry": "Processed again",
    "delete": "Deleted",
    "archive": "Archived",
    "unarchive": "Unarchived",
}


class OperationInline(admin.TabularInline):
    model = Operation
    extra = 0
    fields = ["when", "what", "who", "why"]
    readonly_fields = fields
    can_delete = False
    verbose_name = "action"
    verbose_name_plural = "Logged actions"

    def has_view_permission(self, request, obj=None):
        return is_form_editor(request.user)

    def has_add_permission(self, request, obj=None):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    @admin.display(description="When")
    def when(self, obj):
        return display_for_value(obj.created_at, "—")

    @admin.display(description="Action")
    def what(self, obj):
        return OPERATION_LABELS.get(obj.action, obj.action)

    @admin.display(description="By")
    def who(self, obj):
        return obj.actor

    @admin.display(description="Reason")
    def why(self, obj):
        return obj.reason or "—"


@admin.register(Claim, site=site)
class ClaimAdmin(admin.ModelAdmin):
    list_description = "Submitted claims and how far they have been processed."
    search_placeholder = "Name, email or reference …"
    empty_description = "As soon as participants submit a form, the claim appears here."
    list_display = [
        "short_reference",
        "form",
        "submitted_at",
        "full_name",
        "email",
        "total",
        "status",
        "overdue",
    ]
    list_filter = [("form", admin.RelatedOnlyFieldListFilter), StatusFilter]
    search_fields = ["full_name", "email", "=bookkeeping_reference"]
    date_hierarchy = "submitted_at"
    inlines = [OperationInline]
    actions = ["archive_claims", "unarchive_claims", "delete_claims"]
    fieldsets = [
        (
            None,
            {
                "fields": [
                    "reference_display",
                    "form",
                    "submitted_at",
                    "full_name",
                    "email",
                    "total",
                ]
            },
        ),
        (
            "Processing",
            {
                "fields": [
                    "status",
                    "error",
                    "archived_at",
                    "pdf_removed_at",
                    "content_due",
                    "overdue",
                ]
            },
        ),
    ]
    readonly_fields = [
        "reference_display",
        "form",
        "submitted_at",
        "full_name",
        "email",
        "total",
        "status",
        "error",
        "archived_at",
        "pdf_removed_at",
        "content_due",
        "overdue",
    ]

    def has_module_permission(self, request):
        return is_form_editor(request.user)

    def has_view_permission(self, request, obj=None):
        return is_form_editor(request.user) and (obj is None or roles.sees(request.user, obj))

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    def get_queryset(self, request):
        return claim_status.annotate(
            roles.visible_claims(
                request.user, super().get_queryset(request).select_related("form", "delivery")
            )
        )

    def get_search_results(self, request, queryset, search_term):
        try:
            # A participant quotes the full reference.
            return queryset.filter(pk=uuid.UUID(search_term.strip())), False
        except ValueError:
            return super().get_search_results(request, queryset, search_term)

    @admin.display(description="Reference")
    def reference_display(self, obj):
        return obj.reference

    @admin.display(description="Reference", ordering="id")
    def short_reference(self, obj):
        return obj.bookkeeping_reference or str(obj.id)[:8]

    @admin.display(description="Status")
    def status(self, obj):
        return claim_status_badge(obj)

    @admin.display(description="Error")
    def error(self, obj):
        return claim_status.of(obj).error_code or "—"

    @admin.display(description="Follow-up")
    def overdue(self, obj):
        if claim_status.of(obj).overdue:
            return render_component("badge", "Overdue", variant="warning")
        return "—"

    @admin.display(description="Content deleted from")
    def content_due(self, obj):
        return display_for_value(retention.content_due(obj), "-")

    def has_purge_permission(self, request):
        """Deleting a claim's content is an operator action, like a retry."""
        return is_template_admin(request.user)

    def has_archive_permission(self, request):
        """Archiving ends the wait for a resolution, so it is an operator action too."""
        return is_template_admin(request.user)

    def get_urls(self):
        return [
            path(
                "<uuid:claim_id>/retry/",
                self.admin_site.admin_view(self.retry_view),
                name="portal_claim_retry",
            ),
            path(
                "<uuid:claim_id>/purge/",
                self.admin_site.admin_view(self.purge_view),
                name="portal_claim_purge",
            ),
            path(
                "<uuid:claim_id>/archive/",
                self.admin_site.admin_view(self.archive_view),
                {"archived": True},
                name="portal_claim_archive",
            ),
            path(
                "<uuid:claim_id>/unarchive/",
                self.admin_site.admin_view(self.archive_view),
                {"archived": False},
                name="portal_claim_unarchive",
            ),
            *super().get_urls(),
        ]

    def get_actions(self, request):
        actions = super().get_actions(request)
        archived = StatusFilter.lists_archived(request)
        actions.pop("archive_claims" if archived else "unarchive_claims", None)
        return actions

    def change_view(self, request, object_id, form_url="", extra_context=None):
        claim = self.get_object(request, object_id)
        if claim is None:
            # Django redirects with a message, e.g. for an outdated link.
            return super().change_view(request, object_id, form_url, extra_context)
        # A deleted claim has nothing left to process, archive or delete.
        operable = is_template_admin(request.user) and not claim_status.of(claim).deleted
        archive_url_name = "unarchive" if claim.archived_at else "archive"
        extra_context = {
            **(extra_context or {}),
            "can_retry": operable,
            "retry_url": reverse("admin:portal_claim_retry", args=[object_id]),
            "can_archive": operable,
            "claim_archived": bool(claim.archived_at),
            "archive_url": reverse(f"admin:portal_claim_{archive_url_name}", args=[object_id]),
            "can_purge": operable,
            "purge_url": reverse("admin:portal_claim_purge", args=[object_id]),
        }
        return super().change_view(request, object_id, form_url, extra_context)

    def archive_view(self, request, claim_id, archived):
        if not self.has_archive_permission(request):
            raise PermissionDenied
        if request.method != "POST":
            return HttpResponseNotAllowed(["POST"])
        claim = get_object_or_404(self.get_queryset(request), pk=claim_id)
        if claim_status.of(claim).deleted:
            messages.info(request, "This claim has already been deleted.")
        elif archived:
            confirmation = self._archive(request, [claim])
            if confirmation:
                return confirmation
        elif operations.unarchive([claim.pk], actor=actor(request)):
            messages.success(request, "The claim was unarchived.")
        return redirect("admin:portal_claim_change", claim.pk)

    @admin.action(description="Archive selected claims", permissions=["archive"])
    def archive_claims(self, request, queryset):
        return self._archive(request, list(queryset), bulk=True)

    def _archive(self, request, claims, *, bulk=False):
        """Archive claims, or ask first when that deletes some of them at once.

        An overdue claim is past its retention period and kept only for its resolution.
        Archiving ends that wait, so retention deletes it within minutes.
        """
        overdue = [claim for claim in claims if claim_status.of(claim).overdue]
        if overdue and request.POST.get("post") != "yes":
            return TemplateResponse(
                request,
                "admin/portal/claim/archive.html",
                {
                    **self.admin_site.each_context(request),
                    "opts": self.model._meta,
                    "title": "Archive claim?"
                    if len(claims) == 1
                    else f"Archive {len(claims)} claims?",
                    "claims": claims,
                    "rows": [
                        {"claim": claim, "status_badge": claim_status_badge(claim)}
                        for claim in overdue
                    ],
                    "retention_days": settings.CONTENT_RETENTION_DAYS,
                    "bulk": bulk,
                    "action_checkbox_name": helpers.ACTION_CHECKBOX_NAME,
                },
            )
        changed = operations.archive([claim.pk for claim in claims], actor=actor(request))
        if bulk:
            report_archiving(request, changed, "claim", archived=True)
        elif changed:
            messages.success(
                request,
                "The claim was archived. The claims list shows it under Status: Archived.",
            )
        return None

    @admin.action(description="Unarchive selected claims", permissions=["archive"])
    def unarchive_claims(self, request, queryset):
        changed = operations.unarchive(
            list(queryset.values_list("pk", flat=True)), actor=actor(request)
        )
        report_archiving(request, changed, "claim", archived=False)

    def purge_view(self, request, claim_id):
        if not self.has_purge_permission(request):
            raise PermissionDenied
        claim = get_object_or_404(self.get_queryset(request), pk=claim_id)
        if claim_status.of(claim).deleted:
            messages.info(request, "This claim has already been deleted.")
            return redirect("admin:portal_claim_change", claim.pk)
        form = DeleteForm(request.POST or None)
        if request.method == "POST" and form.is_valid():
            refused = self._delete(request, [claim], form.cleaned_data["reason"])
            if not refused:
                return redirect("admin:portal_claim_changelist")
            form.add_error(None, refused[0][1])
        return self._delete_confirmation(request, [claim], form)

    @admin.action(description="Delete selected claims", permissions=["purge"])
    def delete_claims(self, request, queryset):
        claims = list(queryset.exclude(state__in=claim_status.DELETED)[: MAX_BULK_DELETE + 1])
        if not claims:
            messages.info(request, "The selected claims have already been deleted.")
            return None
        if len(claims) > MAX_BULK_DELETE:
            messages.error(request, f"Please select at most {MAX_BULK_DELETE} claims at once.")
            return None
        # The changelist's action form submits first; the confirmation page sends `post`.
        form = DeleteForm(request.POST if request.POST.get("post") == "yes" else None)
        if form.is_valid():
            for claim, message in self._delete(request, claims, form.cleaned_data["reason"]):
                messages.error(request, f"{claim.reference}: {message}")
            return None
        return self._delete_confirmation(request, claims, form, bulk=True)

    def _delete(self, request, claims, reason):
        """Delete each claim and report the outcome. Returns the refused claims and why."""
        deleted, resuming, refused = 0, 0, []
        for claim in claims:
            try:
                finished = operations.delete(claim.pk, actor=actor(request), reason=reason)
            except operations.ActionRefused as exc:
                refused.append((claim, str(exc)))
            else:
                deleted += finished
                resuming += not finished
        if deleted:
            messages.success(
                request,
                "The claim was deleted." if deleted == 1 else f"{deleted} claims were deleted.",
            )
        if resuming:
            messages.warning(
                request,
                "Deletion has started and finishes automatically within a few minutes "
                f"({resuming} {'claim' if resuming == 1 else 'claims'}).",
            )
        return refused

    def _delete_confirmation(self, request, claims, form, *, bulk=False):
        rows = [
            {
                "claim": claim,
                "status_badge": claim_status_badge(claim),
                "sent": delivery.may_have_reached_finance(claim),
            }
            for claim in claims
        ]
        sent = sum(row["sent"] for row in rows)
        return TemplateResponse(
            request,
            "admin/portal/claim/delete.html",
            {
                **self.admin_site.each_context(request),
                "opts": self.model._meta,
                "title": "Delete claim?" if len(rows) == 1 else f"Delete {len(rows)} claims?",
                "rows": rows,
                "sent_count": sent,
                "unsent_count": len(rows) - sent,
                "form": form,
                "bulk": bulk,
                "action_checkbox_name": helpers.ACTION_CHECKBOX_NAME,
            },
        )

    def retry_view(self, request, claim_id):
        if not is_template_admin(request.user):
            raise PermissionDenied
        claim = get_object_or_404(
            claim_status.annotate(Claim.objects.select_related("form", "delivery")), pk=claim_id
        )
        form = RetryForm(request.POST or None)
        if request.method == "POST" and form.is_valid():
            try:
                operations.retry(
                    claim.pk,
                    actor=actor(request),
                    reason=form.cleaned_data["reason"],
                    acknowledge_duplicate_risk=form.cleaned_data["acknowledge_duplicate_risk"],
                )
            except operations.ActionRefused as exc:
                form.add_error(None, str(exc))
            else:
                messages.success(request, "Processing has started again.")
                return redirect("admin:portal_claim_change", claim.pk)
        try:
            plan, refused = operations.plan_retry(claim), ""
        except operations.ActionRefused as exc:
            plan, refused = None, str(exc)
        return TemplateResponse(
            request,
            "admin/portal/claim/retry.html",
            {
                **self.admin_site.each_context(request),
                "opts": self.model._meta,
                "title": "Process claim again",
                "claim": claim,
                "status_badge": claim_status_badge(claim),
                "plan": plan,
                "refused": refused,
                "form": form,
            },
        )
