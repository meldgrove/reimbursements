"""The admin area: templates, forms, the privacy notice and claims, behind Keycloak."""

import logging
import uuid

from django import forms
from django.conf import settings
from django.contrib import admin, messages
from django.contrib.admin import helpers
from django.core.exceptions import PermissionDenied
from django.db import IntegrityError
from django.http import Http404, HttpResponseRedirect, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.template.response import TemplateResponse
from django.urls import path, reverse
from django.utils.html import format_html
from django.utils.http import url_has_allowed_host_and_scheme, urlencode
from mozilla_django_oidc.views import OIDCLogoutView

from portal import admin_navigation, roles
from portal.models import (
    Claim,
    Form,
    FormTemplate,
    Operation,
    PrivacyNotice,
    TemplateField,
)
from portal.roles import is_form_editor, is_template_admin
from portal.services import delivery, operations, publication, retention
from portal.templatetags.ui import render_component

logger = logging.getLogger(__name__)


class PortalAdminSite(admin.AdminSite):
    site_header = settings.PORTAL_NAME
    site_title = "Erstattungsportal"
    index_title = "Verwaltung"
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
            path("kein-zugriff/", self.no_access, name="no_access"),
            path("suche/", self.admin_view(self.search), name="search"),
            path(
                "suche/vorschlaege/",
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
            {**self.each_context(request), "title": "Suche", "query": query, "groups": groups},
        )

    def search_suggestions(self, request):
        query = request.GET.get("q", "")[:100]
        groups = admin_navigation.search(request, self, query, admin_navigation.SUGGESTION_LIMIT)
        return JsonResponse({"groups": groups})


site = PortalAdminSite(name="admin")


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
        "Teilnehmende sehen immer die neueste Version. Jede Änderung wird als neue Version "
        "gespeichert."
    )
    add_label = "Neue Version"
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

    @admin.display(description="Aktuell", boolean=True)
    def is_current(self, obj):
        current = PrivacyNotice.current()
        return bool(current and current.pk == obj.pk)

    def get_form(self, request, obj=None, change=False, **kwargs):
        kwargs["help_texts"] = {
            "text": "Eine Leerzeile trennt Absätze. Eine Zeile mit „# “ am Anfang wird zur Überschrift."
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
    list_description = (
        "Vorlagen legen fest, welche internen Werte und Angaben ein Formular abfragt."
    )
    add_label = "Vorlage anlegen"
    search_placeholder = "Name oder Beschreibung …"
    list_display = ["name", "travel", "mileage_enabled", "form_count", "updated_at"]
    search_fields = ["name", "description"]
    inlines = [TemplateFieldInline]
    fieldsets = [
        (None, {"fields": ["name", "description"]}),
        ("Für Teilnehmende", {"fields": ["intro", "travel", "mileage_enabled", "mileage_rate"]}),
        ("Erklärung", {"fields": ["declaration", "declaration_version"]}),
    ]

    @admin.display(description="Formulare")
    def form_count(self, obj):
        return obj.forms.count()

    def has_delete_permission(self, request, obj=None):
        return super().has_delete_permission(request, obj) and not (obj and obj.forms.exists())


@admin.register(Form, site=site)
class FormAdmin(admin.ModelAdmin):
    change_form_template = "admin/portal/form/change_form.html"
    delete_confirmation_template = "admin/portal/form/delete_confirmation.html"
    list_description = "Über den Link eines Formulars reichen Teilnehmende ihre Auslagen ein."
    add_label = "Formular anlegen"
    search_placeholder = "Name oder Kurzname …"
    empty_description = "Lege ein Formular aus einer Vorlage an und teile den Link."
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
    list_filter = ["status", "primary", "template"]
    search_fields = ["name", "slug"]
    exclude = ["status", "creation_key"]
    prepopulated_fields = {"slug": ["name"]}

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
            return JsonResponse({"error": "Bitte bestätige das Löschen des Entwurfs."}, status=400)
        return super().delete_view(request, object_id, extra_context)

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
                    "title": "Vorlage für das neue Formular wählen",
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
                    "Interne Werte",
                    {
                        "fields": values,
                        "description": "Nicht sichtbar für Teilnehmende, erscheinen in der PDF.",
                    },
                )
            )
        participant = ["title", "description", "instructions", "purpose_options"]
        if template.travel != FormTemplate.Travel.OFF:
            participant += ["trip_start", "trip_end"]
        fieldsets += [
            ("Für Teilnehmende", {"fields": participant}),
            ("Versand und Kontakt", {"fields": ["recipient", "support_email"]}),
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
            "badge",
            obj.get_status_display(),
            variant="success" if obj.status == Form.Status.PUBLISHED else "secondary",
        )

    @admin.display(description="Vorlage")
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

    @admin.display(description="Jetzt geöffnet", boolean=True)
    def open_now(self, obj):
        return obj.is_open()

    @admin.display(description="Interne Werte vollständig", boolean=True)
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
            return JsonResponse(
                {"error": "Ungültige Anfrage. Bitte lade die Seite neu."}, status=400
            )
        existing = creation_key and publication.created(request.user, creation_key)
        if existing:
            object_id = str(existing.pk)
        form = self.get_object(request, object_id) if object_id else None
        extra_context = {
            **(extra_context or {}),
            "form_delete_hidden": not (form and self.has_delete_permission(request, form)),
        }
        if (
            request.method == "GET"
            and form
            and form.status == Form.Status.PUBLISHED
            and form.internal_value_errors()
        ):
            messages.warning(
                request,
                "Die Vorlage wurde geändert. Das Formular bleibt geschlossen, bis diese "
                f"internen Werte passen: {', '.join(form.internal_value_errors())}.",
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
                {"error": "Das Formular ist nicht mehr verfügbar. Bitte lade die Seite neu."},
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


DELIVERY_STATUS = {
    "pending": "Versand wartet",
    "sending": "Wird versendet",
    "provider_accepted": "Vom Versanddienst angenommen",
    "paused": "Versand verzögert",
    "delivered": "Zugestellt",
    "failed": "Versand fehlgeschlagen",
    "send_unknown": "Versandstatus unklar",
}


# Badge tones of claim and delivery states.
STATUS_TONES = {
    Claim.State.FAILED: "destructive",
    Claim.State.PURGING: "outline",
    "paused": "warning",
    "send_unknown": "warning",
    "failed": "destructive",
    "delivered": "success",
}


STATUS_LABELS = {**dict(Claim.State.choices), **DELIVERY_STATUS}

# A deleted claim is gone; one still being deleted is left to the worker's cleanup.
DELETED_STATES = (Claim.State.PURGING,)

# Status filter options in the order a claim passes through them.
STATUS_ORDER = [
    *(state for state in Claim.State if state not in DELETED_STATES),
    *DELIVERY_STATUS,
    *DELETED_STATES,
]


def claim_status_parts(claim):
    state = delivery.operator_status(claim).state
    return state, STATUS_LABELS.get(state, state)


def claim_status(claim):
    return claim_status_parts(claim)[1]


def claim_status_badge(claim):
    key, label = claim_status_parts(claim)
    return render_component("badge", label, variant=STATUS_TONES.get(key, "secondary"))


class StatusFilter(admin.SimpleListFilter):
    """Filters claims by the value of their Status column."""

    title = "Status"
    parameter_name = "status"

    def lookups(self, request, model_admin):
        return [(state, STATUS_LABELS[state]) for state in STATUS_ORDER]

    def queryset(self, request, queryset):
        if self.value() in STATUS_LABELS:
            return queryset.filter(delivery.operator_state_filter(self.value()))
        return queryset


class RetryForm(forms.Form):
    reason = forms.CharField(
        label="Grund", max_length=500, widget=forms.Textarea(attrs={"rows": 3})
    )
    acknowledge_duplicate_risk = forms.BooleanField(
        label=(
            "Ich habe den Versand geprüft und nehme in Kauf, dass Finance den Antrag "
            "doppelt erhalten kann."
        ),
        required=False,
    )


class DeleteForm(forms.Form):
    reason = forms.CharField(
        label="Grund", max_length=500, widget=forms.Textarea(attrs={"rows": 3})
    )


# A bulk deletion purges in the request; larger cleanups run in several steps.
MAX_BULK_DELETE = 100

OPERATION_LABELS = {"retry": "Erneut verarbeitet", "delete": "Gelöscht"}


class OperationInline(admin.TabularInline):
    model = Operation
    extra = 0
    fields = ["when", "what", "who", "why"]
    readonly_fields = fields
    can_delete = False
    verbose_name = "Aktion"
    verbose_name_plural = "Protokollierte Aktionen"

    def has_view_permission(self, request, obj=None):
        return is_form_editor(request.user)

    def has_add_permission(self, request, obj=None):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    @admin.display(description="Zeitpunkt")
    def when(self, obj):
        return obj.created_at

    @admin.display(description="Aktion")
    def what(self, obj):
        return OPERATION_LABELS.get(obj.action, obj.action)

    @admin.display(description="Durch")
    def who(self, obj):
        return obj.actor

    @admin.display(description="Grund")
    def why(self, obj):
        return obj.reason


@admin.register(Claim, site=site)
class ClaimAdmin(admin.ModelAdmin):
    list_description = "Eingereichte Anträge und ihr Verarbeitungsstand."
    search_placeholder = "Name, E-Mail oder Referenz …"
    empty_description = "Sobald Teilnehmende ein Formular einreichen, erscheint der Antrag hier."
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
    actions = ["delete_claims"]
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
            "Verarbeitung",
            {"fields": ["status", "error", "pdf_removed_at", "retention_due", "overdue"]},
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
        "pdf_removed_at",
        "retention_due",
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
        return roles.visible_claims(
            request.user, super().get_queryset(request).select_related("form", "delivery")
        )

    def get_search_results(self, request, queryset, search_term):
        try:
            # A participant quotes the full reference.
            return queryset.filter(pk=uuid.UUID(search_term.strip())), False
        except ValueError:
            return super().get_search_results(request, queryset, search_term)

    @admin.display(description="Referenz")
    def reference_display(self, obj):
        return obj.reference

    @admin.display(description="Referenz", ordering="id")
    def short_reference(self, obj):
        return obj.bookkeeping_reference or str(obj.id)[:8]

    @admin.display(description="Status")
    def status(self, obj):
        return claim_status_badge(obj)

    @admin.display(description="Fehler")
    def error(self, obj):
        return delivery.operator_status(obj).error_code or "—"

    @admin.display(description="Klärung")
    def overdue(self, obj):
        if delivery.operator_status(obj).overdue:
            return render_component("badge", "Überfällig", variant="warning")
        return "—"

    def has_purge_permission(self, request):
        """Deleting a claim's content is an operator action, like a retry."""
        return is_template_admin(request.user)

    def get_urls(self):
        return [
            path(
                "<uuid:claim_id>/erneut-versuchen/",
                self.admin_site.admin_view(self.retry_view),
                name="portal_claim_retry",
            ),
            path(
                "<uuid:claim_id>/loeschen/",
                self.admin_site.admin_view(self.purge_view),
                name="portal_claim_purge",
            ),
            *super().get_urls(),
        ]

    def change_view(self, request, object_id, form_url="", extra_context=None):
        claim = self.get_object(request, object_id)
        # A deleted claim has nothing left to process or delete.
        operable = (
            claim is not None
            and is_template_admin(request.user)
            and claim.state not in DELETED_STATES
        )
        extra_context = {
            **(extra_context or {}),
            "can_retry": operable,
            "retry_url": reverse("admin:portal_claim_retry", args=[object_id]),
            "can_purge": operable,
            "purge_url": reverse("admin:portal_claim_purge", args=[object_id]),
        }
        return super().change_view(request, object_id, form_url, extra_context)

    def purge_view(self, request, claim_id):
        if not self.has_purge_permission(request):
            raise PermissionDenied
        claim = get_object_or_404(self.get_queryset(request), pk=claim_id)
        if claim.state in DELETED_STATES:
            messages.info(request, "Dieser Antrag wurde bereits gelöscht.")
            return redirect("admin:portal_claim_change", claim.pk)
        form = DeleteForm(request.POST or None)
        if request.method == "POST" and form.is_valid():
            refused = self._delete(request, [claim], form.cleaned_data["reason"])
            if not refused:
                return redirect("admin:portal_claim_changelist")
            form.add_error(None, refused[0][1])
        return self._delete_confirmation(request, [claim], form)

    @admin.action(description="Ausgewählte Anträge löschen", permissions=["purge"])
    def delete_claims(self, request, queryset):
        claims = list(queryset.exclude(state__in=DELETED_STATES)[: MAX_BULK_DELETE + 1])
        if not claims:
            messages.info(request, "Die ausgewählten Anträge wurden bereits gelöscht.")
            return None
        if len(claims) > MAX_BULK_DELETE:
            messages.error(request, f"Bitte wähle höchstens {MAX_BULK_DELETE} Anträge auf einmal.")
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
                operations.delete(
                    claim.pk, actor=request.user.email or request.user.get_username(), reason=reason
                )
            except operations.ActionRefused as exc:
                refused.append((claim, str(exc)))
            except (OSError, retention.ClaimBusy):
                # The claim stays purging; the worker's cleanup finishes it.
                logger.error("purge_failed reference=%s", claim.pk)
                resuming += 1
            else:
                deleted += 1
        if deleted:
            messages.success(
                request,
                "Der Antrag wurde gelöscht."
                if deleted == 1
                else f"{deleted} Anträge wurden gelöscht.",
            )
        if resuming:
            messages.warning(
                request,
                "Die Löschung wurde begonnen und wird in wenigen Minuten automatisch "
                f"abgeschlossen ({resuming} {'Antrag' if resuming == 1 else 'Anträge'}).",
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
                "title": "Antrag löschen?" if len(rows) == 1 else f"{len(rows)} Anträge löschen?",
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
        claim = get_object_or_404(Claim.objects.select_related("form"), pk=claim_id)
        form = RetryForm(request.POST or None)
        if request.method == "POST" and form.is_valid():
            try:
                operations.retry(
                    claim.pk,
                    actor=request.user.email or request.user.get_username(),
                    reason=form.cleaned_data["reason"],
                    acknowledge_duplicate_risk=form.cleaned_data["acknowledge_duplicate_risk"],
                )
            except operations.ActionRefused as exc:
                form.add_error(None, str(exc))
            else:
                messages.success(request, "Die Verarbeitung wurde erneut gestartet.")
                return redirect("admin:portal_claim_change", claim.pk)
        return TemplateResponse(
            request,
            "admin/portal/claim/retry.html",
            {
                **self.admin_site.each_context(request),
                "opts": self.model._meta,
                "title": "Antrag erneut verarbeiten",
                "claim": claim,
                "status": claim_status(claim),
                "status_badge": claim_status_badge(claim),
                "duplicate_risk": delivery.operator_status(claim).duplicate_risk,
                "form": form,
            },
        )
