"""The Email tab's form, and the test email it can send.

Admins choose MailerSend or an SMTP server and enter its credentials. A saved secret is
never shown again: its field stays empty, and typing a new one replaces it. A field the
environment sets (`email_connection.ENVIRONMENT`) is shown but cannot be changed here.
The participant confirmation's subject and text start as the standard text in each
language; text that matches the standard one is not saved, so the standard text stays
in use.
"""

import uuid

from django import forms
from django.conf import settings
from django.core.validators import RegexValidator
from django.utils.html import format_html

from portal.constants import APP_NAME
from portal.i18n import LANGUAGES
from portal.models import EmailSettings
from portal.services import confirmations, email_connection, outbound, smtp
from portal.services.transport import (
    ACCEPTED,
    DELIVERED,
    FAILED,
    PAUSED,
    Message,
    SendResult,
)

TEST_TIMEOUT_SECONDS = 10
SECRET_LABELS = {
    "mailersend_token": ("API token", "Delete the saved API token"),
    "webhook_secret": ("Webhook signing secret", "Delete the saved signing secret"),
    "smtp_password": ("Password", "Delete the saved password"),
}


class SecretInput(forms.PasswordInput):
    """A secret, hidden until its eye button shows it, as in every Meldgrove app."""

    class Media:
        js = [forms.Script("portal/vendor/meldgrove-secret-input.js", type="module")]

    def __init__(self, attrs=None):
        # "new-password" keeps browsers from filling in a saved sign-in password.
        attrs = {"autocomplete": "new-password", "spellcheck": "false", **(attrs or {})}
        super().__init__(attrs, render_value=False)

    def render(self, name, value, attrs=None, renderer=None):
        field = super().render(name, value, attrs, renderer)
        return format_html('<meldgrove-secret-input locale="en">{}</meldgrove-secret-input>', field)


def _secret_field(name, *, strip=True):
    label, _ = SECRET_LABELS[name]
    return forms.CharField(
        label=label, required=False, max_length=1000, strip=strip, widget=SecretInput
    )


def _delete_field(name):
    _, label = SECRET_LABELS[name]
    return forms.BooleanField(label=label, required=False)


class BaseEmailSettingsForm(forms.ModelForm):
    smtp_host = forms.CharField(
        label="Server",
        required=False,
        max_length=253,
        validators=[
            RegexValidator(
                r"\A(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|[0-9A-Fa-f:]+)\Z",
                "Enter a host name such as smtp.example.org, or an IP address.",
            )
        ],
        help_text="Such as smtp.example.org.",
    )
    mailersend_token = _secret_field("mailersend_token")
    delete_mailersend_token = _delete_field("mailersend_token")
    webhook_secret = _secret_field("webhook_secret")
    delete_webhook_secret = _delete_field("webhook_secret")
    # A password may begin or end with a space.
    smtp_password = _secret_field("smtp_password", strip=False)
    delete_smtp_password = _delete_field("smtp_password")

    class Meta:
        model = EmailSettings
        fields = [
            "provider",
            "from_address",
            "reply_to_address",
            "smtp_host",
            "smtp_port",
            "smtp_security",
            "smtp_username",
            "confirmation_enabled",
        ]
        widgets = {"smtp_username": forms.TextInput(attrs={"autocomplete": "off"})}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        saved = self.instance
        self.saved_values = {
            name: getattr(saved, name) for name in ("provider", "from_address", "reply_to_address")
        }
        self.locked = set()
        for name, variable in email_connection.ENVIRONMENT.items():
            if email_connection.environment(name) and name in self.fields:
                self._lock(name, f"Set by {variable} in the environment.")
        if email_connection.environment("mailersend_token") and "provider" in self.fields:
            self._lock("provider", "MAILERSEND_API_TOKEN in the environment chooses MailerSend.")
            self.initial["provider"] = email_connection.MAILERSEND
        for name in SECRET_LABELS:
            if name in self.locked or name not in self.fields:
                continue
            value = saved.secret(name)
            if value is None:
                placeholder = (
                    "Saved, but unreadable since DJANGO_SECRET_KEY changed: enter it again"
                )
            elif value:
                placeholder = "Saved · type a new one to replace it"
            else:
                continue
            self.fields[name].widget.attrs["placeholder"] = placeholder
        for code, _ in LANGUAGES:
            subject, body = confirmations.texts(saved, code)
            self.initial.setdefault(f"confirmation_subject_{code}", subject)
            self.initial.setdefault(f"confirmation_body_{code}", body)

    def _lock(self, name, help_text):
        field = self.fields[name]
        field.disabled, field.help_text = True, help_text
        if name in SECRET_LABELS:
            field.widget.attrs["placeholder"] = "Set in the environment"
        elif name in email_connection.ENVIRONMENT:
            self.initial[name] = email_connection.environment(name)
        self.locked.add(name)

    def provider(self):
        if "provider" in self.locked:
            return email_connection.MAILERSEND
        return self.cleaned_data.get("provider", "")

    def has_secret(self, name):
        """Whether `name` is set after saving: in the environment, new, or kept."""
        if email_connection.environment(name) or self.cleaned_data.get(name):
            return True
        return bool(self.instance.secret(name)) and not self.cleaned_data.get(f"delete_{name}")

    def clean(self):
        data = super().clean()
        provider = self.provider()
        if provider:
            if not data.get("from_address") and "from_address" not in self.errors:
                self.add_error("from_address", "Enter the address every email comes from.")
            if not data.get("reply_to_address") and "reply_to_address" not in self.errors:
                self.add_error("reply_to_address", "Enter where Finance's replies go.")
        if provider == email_connection.MAILERSEND and not self.has_secret("mailersend_token"):
            self.add_error("mailersend_token", "Enter the MailerSend API token.")
        if provider == email_connection.SMTP:
            if not data.get("smtp_host") and "smtp_host" not in self.errors:
                self.add_error("smtp_host", "Enter the SMTP server.")
            if data.get("smtp_username") and not self.has_secret("smtp_password"):
                self.add_error("smtp_password", "Enter the password for this username.")
        for name in SECRET_LABELS:
            if data.get(name) and data.get(f"delete_{name}"):
                self.add_error(f"delete_{name}", "Delete it or enter a new one, not both.")
        for code, _ in LANGUAGES:
            subject = data.get(f"confirmation_subject_{code}", "")
            if "\n" in subject or "\r" in subject:
                self.add_error(f"confirmation_subject_{code}", "Write the subject on one line.")
            for part in ("subject", "body"):
                name = f"confirmation_{part}_{code}"
                if problem := confirmations.placeholder_problem(data.get(name, "")):
                    self.add_error(name, problem)
        return data

    def save(self, commit=True):
        saved = super().save(commit=False)
        for name in self.locked & set(self.saved_values):
            setattr(saved, name, self.saved_values[name])
        for name in SECRET_LABELS:
            if name in self.locked:
                continue
            if self.cleaned_data.get(name):
                saved.set_secret(name, self.cleaned_data[name])
            elif self.cleaned_data.get(f"delete_{name}"):
                saved.set_secret(name, "")
        saved.confirmation_texts = self._own_texts()
        if commit:
            saved.save()
        return saved

    def _own_texts(self):
        """The confirmation texts that differ from the standard ones, per language."""
        texts = {}
        for code, _ in LANGUAGES:
            standard_subject, standard_body = confirmations.standard_texts(code)
            subject = " ".join(self.cleaned_data.get(f"confirmation_subject_{code}", "").split())
            body = self.cleaned_data.get(f"confirmation_body_{code}", "")
            body = body.replace("\r\n", "\n").replace("\r", "\n").strip()
            own = {}
            if subject and subject != " ".join(standard_subject.split()):
                own["subject"] = subject
            if body and body != standard_body.strip():
                own["body"] = body + "\n"
            if own:
                texts[code] = own
        return texts


def _confirmation_fields():
    """A subject and a text field per language."""
    fields = {}
    for code, name in LANGUAGES:
        fields[f"confirmation_subject_{code}"] = forms.CharField(
            label=f"Subject ({name})",
            required=False,
            max_length=confirmations.MAX_SUBJECT_LENGTH,
            help_text="Empty restores the standard subject.",
        )
        fields[f"confirmation_body_{code}"] = forms.CharField(
            label=f"Text ({name})",
            required=False,
            max_length=confirmations.MAX_BODY_LENGTH,
            widget=forms.Textarea(attrs={"rows": 14}),
            help_text="Empty restores the standard text.",
        )
    return fields


EmailSettingsForm = type(BaseEmailSettingsForm)(
    "EmailSettingsForm",
    (BaseEmailSettingsForm,),
    {"__module__": __name__, **_confirmation_fields()},
)


class TestEmailForm(forms.Form):
    to = forms.EmailField(label="Send a test email to")


def send_test(recipient):
    """Send a test email to `recipient` with the saved connection.

    Returns the connection and the `SendResult`. No record keeps the email: it belongs to
    no claim.
    """
    connection = email_connection.current()
    allowlist = settings.TEST_RECIPIENT_ALLOWLIST
    if allowlist and recipient.lower() not in allowlist:
        return connection, SendResult(FAILED, error_code="test_recipient_blocked")
    message = Message(
        attempt_id=str(uuid.uuid4()),
        sender=connection.sender,
        reply_to=connection.reply_to or connection.sender,
        recipient=recipient,
        subject=f"Test email from {APP_NAME}",
        text=(
            f"This is a test email from {APP_NAME}, sent from Admin > Email.\n\n"
            f"It came through {connection.name} from {connection.sender}. Participants and "
            "Finance receive their emails the same way.\n"
        ),
    )
    if connection.ready and connection.provider == email_connection.SMTP:
        # Within the admin page's request, so a slow server cannot take it over.
        transport = smtp.SmtpTransport(connection.smtp, timeout=TEST_TIMEOUT_SECONDS)
    else:
        transport = outbound.configured_transport(connection)
    return connection, transport.send(message)


def test_outcome(connection, recipient, result):
    """A message about a test email's `result`, and whether it reached the provider."""
    if result.state == DELIVERED and connection.provider == email_connection.LOCAL:
        return True, f"The test email to {recipient} is in the local outbox; nothing was sent."
    if result.state == DELIVERED:
        return True, f"The SMTP server accepted the test email to {recipient}."
    if result.state == ACCEPTED:
        return True, f"MailerSend accepted the test email to {recipient}."
    if result.state == PAUSED:
        return False, (
            f"MailerSend accepted the test email to {recipient}, but sending is paused for "
            "this account; see its dashboard."
        )
    if result.error_code == "email_not_set_up" and connection.missing:
        return False, f"Email is not set up yet. Missing: {', '.join(connection.missing)}."
    return False, email_connection.problem(result.error_code, connection.provider)
