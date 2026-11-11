"""Form publication: drafts save with gaps, publishing needs complete settings.

A form starts as a draft of a template. Every save validates the settings for the status
the form has afterwards. A draft accepts gaps and gets a default name and slug; a
published form needs its name, slug, an approved recipient, a contact and internal values
that fit its template. Publishing keeps the opening schedule, so a published form opens
when its schedule says so. The first save of a new form is idempotent per creation key,
so a retried autosave never creates a second form. Only template admins delete forms,
and only forms without participant drafts or claims.
"""

import uuid

from django import forms
from django.conf import settings
from django.core.exceptions import ValidationError
from django.utils import translation
from django.utils.text import slugify

from portal import roles
from portal.constants import FORM_DESCRIPTION, FORM_TITLE
from portal.i18n import t
from portal.models import AppSettings, Form, TemplateField

# The status a publication action leads to; no action keeps the current one.
ACTIONS = {"": None, "publish": Form.Status.PUBLISHED, "unpublish": Form.Status.DRAFT}
# Settings a draft may leave empty. Internal values (`value_<key>`) may stay empty too.
DRAFT_OPTIONAL = frozenset({"name", "slug", "recipient", "support_email"})


class Refused(Exception):
    """A publication request that cannot be carried out. The message is for the admin area."""


def status_after(form, action):
    """The status `form` (None for a new form) has after `action`: "", publish or unpublish."""
    if action not in ACTIONS:
        raise Refused("Invalid status change.")
    return ACTIONS[action] or (form.status if form else Form.Status.DRAFT)


def _value_field(field):
    if field.kind == TemplateField.Kind.CHOICE:
        return forms.ChoiceField(
            label=field.label,
            required=field.required,
            choices=[("", "—"), *((option, option) for option in field.options())],
        )
    return forms.CharField(label=field.label, required=field.required, max_length=200)


class SettingsForm(forms.ModelForm):
    """A form's settings plus one `value_<key>` field per template field.

    Use `settings_form()` for the class of a template and status. Internal values are
    stored in `field_values`.
    """

    form_template = None
    next_status = Form.Status.DRAFT

    class Meta:
        model = Form
        fields = [
            "name",
            "title",
            "description",
            "slug",
            "primary",
            "opens_at",
            "closes_at",
            "instructions",
            "purpose_options",
            "trip_start",
            "trip_end",
            "recipient",
            "support_email",
        ]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if not self.instance.template_id:
            self.instance.template = self.form_template
        self.instance.status = self.next_status
        drafting = self.next_status == Form.Status.DRAFT
        if drafting:
            for name, field in self.fields.items():
                if name in DRAFT_OPTIONAL or name.startswith("value_"):
                    field.required = False
        for field in self.form_template.fields.all():
            self.initial.setdefault(
                f"value_{field.key}", self.instance.field_values.get(field.key, "")
            )
        # Empty texts show the standard ones, in the language participants see.
        with translation.override(AppSettings.load().language):
            for name, text in (("title", FORM_TITLE), ("description", FORM_DESCRIPTION)):
                if name in self.fields:
                    self.fields[name].widget.attrs["placeholder"] = t(text)
        if "recipient" in self.fields:
            choices = [(address, address) for address in settings.APPROVED_DELIVERY_RECIPIENTS]
            self.fields["recipient"] = forms.ChoiceField(
                label=self.fields["recipient"].label,
                choices=[("", "—"), *choices],
                required=not drafting,
            )

    def clean(self):
        data = super().clean()
        drafting = self.next_status == Form.Status.DRAFT
        if drafting:
            if "name" not in self.errors and not data.get("name"):
                data["name"] = "New form"
            if "slug" not in self.errors and not data.get("slug"):
                stem = slugify(data.get("name", ""))[:30] or "form"
                data["slug"] = self.instance.slug or f"{stem}-{uuid.uuid4().hex[:12]}"
        values = {}
        for field in self.form_template.fields.all():
            name = f"value_{field.key}"
            if drafting and not data.get(name):
                values[field.key] = ""
                continue
            try:
                values[field.key] = field.validate(data.get(name, ""))
            except ValidationError as exc:
                self.add_error(name, exc)
        self.instance.field_values = values
        start, end = data.get("trip_start"), data.get("trip_end")
        if start and end and start > end:
            self.add_error("trip_end", "The trip cannot end before it starts.")
        opens, closes = data.get("opens_at"), data.get("closes_at")
        if opens and closes and opens >= closes:
            self.add_error("closes_at", "The closing time must be after the opening time.")
        return data


def settings_form(template, status):
    """The settings form class for a form of `template` that will have `status` once saved."""
    attributes = {f"value_{field.key}": _value_field(field) for field in template.fields.all()}
    return type(
        "SettingsForm",
        (SettingsForm,),
        {**attributes, "form_template": template, "next_status": status},
    )


def save(form, person, *, creation_key=None):
    """Store a form whose settings validated; a new form records its creation key.

    The creator owns a new form. Form editors stay owners of every form they save, so
    nobody locks themselves out of a form they are editing.
    """
    created = form._state.adding
    if created and creation_key:
        form.creation_key = creation_key
    form.save()
    if created or not roles.is_template_admin(person):
        form.owners.add(person)
    return form


def created(person, creation_key):
    """The form an earlier first save with this creation key made, if this person manages it."""
    return roles.managed_forms(person).filter(creation_key=creation_key).first()


def may_delete(person, form):
    return (
        roles.is_template_admin(person)
        and form.status == Form.Status.DRAFT
        and not form.claims.exists()
        and not form.draft_set.exists()
    )
