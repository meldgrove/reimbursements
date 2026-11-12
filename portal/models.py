import hashlib
import json
import re
import uuid
import zoneinfo
from datetime import timedelta
from decimal import Decimal
from functools import cache

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import MinValueValidator
from django.db import models, transaction
from django.utils import timezone, translation

from portal import dates
from portal.constants import DECLARATION, DECLARATION_VERSION, FORM_DESCRIPTION, FORM_TITLE
from portal.countries import country_name
from portal.i18n import LANGUAGES, language, t
from portal.intake import EXPENSE_FIELD_LENGTHS


def draft_expiry():
    return timezone.now() + timedelta(hours=24)


TIMEZONE_REGIONS = frozenset(
    "Africa America Antarctica Arctic Asia Atlantic Australia Europe Indian Pacific".split()
)


@cache
def timezone_names():
    """The timezones one can choose: UTC and those named after a region and a city."""
    return sorted(
        name
        for name in zoneinfo.available_timezones()
        if name == "UTC" or name.split("/")[0] in TIMEZONE_REGIONS
    )


def validate_timezone(value):
    if value not in timezone_names():
        raise ValidationError("Choose a timezone from the list.")


class AppSettings(models.Model):
    """The General settings: one row for the whole app, see portal.app_settings."""

    language = models.CharField(
        "App language",
        max_length=2,
        choices=LANGUAGES,
        default="de",
        help_text=(
            "For public forms, emails to participants and Finance, and the claim PDF. "
            "The admin area is always in English."
        ),
    )
    timezone = models.CharField(
        "Timezone",
        max_length=64,
        default="Europe/Berlin",
        validators=[validate_timezone],
        help_text="Times are shown in this timezone, and form opening times are entered in it.",
    )
    date_format = models.CharField(
        "Date format",
        max_length=8,
        choices=dates.CHOICES,
        default=dates.DEFAULT_DATE_FORMAT,
        help_text="For dates everywhere, including the admin area and the claim PDF.",
    )
    favicon = models.BinaryField("Favicon", blank=True, default=b"")
    favicon_type = models.CharField(max_length=40, blank=True)
    # Names the favicon in its link, so browsers fetch a new one at once.
    favicon_digest = models.CharField(max_length=16, blank=True, editable=False)
    updated_at = models.DateTimeField("Changed", auto_now=True)

    class Meta:
        verbose_name = "General settings"
        verbose_name_plural = "General settings"

    def __str__(self):
        return "General settings"

    @classmethod
    def load(cls):
        """The saved settings, or the defaults while none are saved.

        Every request loads them, so the favicon image itself loads only when used.
        """
        return cls.objects.defer("favicon").filter(pk=1).first() or cls(pk=1)

    def save(self, *args, **kwargs):
        self.pk = 1
        super().save(*args, **kwargs)

    def set_favicon(self, content, media_type=""):
        """Use `content` as the favicon; empty content restores the standard one."""
        self.favicon, self.favicon_type = content, media_type if content else ""
        self.favicon_digest = hashlib.sha256(content).hexdigest()[:16] if content else ""


def default_declaration():
    """The standard declaration in the app language, for new templates."""
    with translation.override(AppSettings.load().language):
        return t(DECLARATION)


class PrivacyNotice(models.Model):
    """The app's one privacy notice. Every change is a new version; claims keep theirs."""

    version = models.PositiveIntegerField(unique=True, editable=False)
    text = models.TextField("Text")
    created_at = models.DateTimeField("Created", default=timezone.now, editable=False)
    created_by = models.CharField("Created by", max_length=254, blank=True, editable=False)

    class Meta:
        ordering = ["-version"]
        verbose_name = "privacy notice"
        verbose_name_plural = "privacy notices"

    def __str__(self):
        return f"Version {self.version}"

    @classmethod
    def current(cls):
        return cls.objects.order_by("-version").first()

    def save(self, *args, **kwargs):
        if self.pk:
            raise ValidationError("Privacy notices are not changed but replaced.")
        latest = PrivacyNotice.objects.aggregate(models.Max("version"))["version__max"] or 0
        self.version = latest + 1
        super().save(*args, **kwargs)


class FormTemplate(models.Model):
    """A type of reimbursement form. Its fields hold each form's internal values."""

    class Travel(models.TextChoices):
        OFF = "off", "No travel details"
        OPTIONAL = "optional", "Optional (participants choose)"
        REQUIRED = "required", "Required"

    name = models.CharField("Name", max_length=200, unique=True)
    description = models.TextField("Internal description", blank=True)
    intro = models.TextField(
        "Notes for participants",
        blank=True,
        help_text="Shown at the top of every form of this template.",
    )
    declaration = models.TextField("Declaration", default=default_declaration)
    declaration_version = models.CharField(
        "Declaration version", max_length=80, default=DECLARATION_VERSION
    )
    travel = models.CharField(
        "Travel details (destination, dates)",
        max_length=12,
        choices=Travel.choices,
        default=Travel.OPTIONAL,
    )
    mileage_enabled = models.BooleanField("Allow mileage reimbursement", default=False)
    mileage_rate = models.DecimalField(
        "Mileage rate in EUR",
        max_digits=4,
        decimal_places=2,
        default=Decimal("0.30"),
        validators=[MinValueValidator(Decimal("0.01"))],
    )
    updated_at = models.DateTimeField("Changed", auto_now=True)

    class Meta:
        ordering = ["name"]
        verbose_name = "template"
        verbose_name_plural = "templates"

    def __str__(self):
        return self.name


class TemplateField(models.Model):
    """An internal value each form of the template sets, e.g. KST, KTR or an ID.

    Participants never see these values; they are printed in the PDF.
    """

    class Kind(models.TextChoices):
        TEXT = "text", "Text"
        CHOICE = "choice", "Choice"

    template = models.ForeignKey(FormTemplate, on_delete=models.CASCADE, related_name="fields")
    key = models.SlugField(
        "Key", max_length=40, help_text="Technical name, e.g. kst. Do not change it later."
    )
    label = models.CharField("Label", max_length=80, help_text="e.g. Kostenstelle (KST)")
    kind = models.CharField("Type", max_length=10, choices=Kind.choices, default=Kind.TEXT)
    choices = models.TextField(
        "Options", blank=True, help_text="Only for choices: one option per line."
    )
    pattern = models.CharField(
        "Format (regular expression)",
        max_length=200,
        blank=True,
        help_text="Optional, e.g. \\d{4} for four-digit numbers.",
    )
    required = models.BooleanField("Required", default=True)
    position = models.PositiveSmallIntegerField("Order", default=0)

    class Meta:
        ordering = ["position", "pk"]
        verbose_name = "field"
        verbose_name_plural = "fields"
        constraints = [
            models.UniqueConstraint(fields=["template", "key"], name="template_field_key_unique")
        ]

    def __str__(self):
        return self.label

    def options(self):
        return [line.strip() for line in self.choices.splitlines() if line.strip()]

    def clean(self):
        if self.pattern:
            try:
                re.compile(self.pattern)
            except re.error as exc:
                raise ValidationError({"pattern": "Invalid regular expression."}) from exc
        if self.kind == self.Kind.CHOICE and not self.options():
            raise ValidationError({"choices": "Enter at least one option."})

    def validate(self, value):
        """The cleaned value, or ValidationError with a message for the admin area."""
        value = (value or "").strip()
        if not value:
            if self.required:
                raise ValidationError("This field is required.")
            return ""
        if len(value) > 200:
            raise ValidationError("At most 200 characters.")
        if self.kind == self.Kind.CHOICE and value not in self.options():
            raise ValidationError("Choose one of the options.")
        if self.pattern and not re.fullmatch(self.pattern, value):
            raise ValidationError("The value does not match the template's format.")
        return value


class Form(models.Model):
    """A reimbursement form, drafted and published by its owners."""

    class Status(models.TextChoices):
        DRAFT = "draft", "Draft"
        PUBLISHED = "published", "Published"

    template = models.ForeignKey(
        FormTemplate, on_delete=models.PROTECT, related_name="forms", verbose_name="Template"
    )
    slug = models.SlugField(
        "Short name for the link",
        unique=True,
        help_text="The link is /f/short-name/. Do not change it once shared.",
    )
    name = models.CharField("Name", max_length=200, help_text="Visible to participants.")
    title = models.CharField(
        "Title",
        max_length=200,
        blank=True,
        help_text="Heading above the form. Leave empty for the standard title.",
    )
    description = models.TextField(
        "Description",
        blank=True,
        help_text="Text below the title. Leave empty for the standard description.",
    )
    field_values = models.JSONField("Internal values", default=dict, blank=True)
    purpose_options = models.TextField(
        "Preset purposes",
        blank=True,
        help_text=(
            "One option per line. A single preset is shown as text; with several, "
            "participants choose one. Additional details are optional. "
            "Leave empty for free text."
        ),
    )
    instructions = models.TextField("Notes for participants", blank=True)
    recipient = models.EmailField("Receiving inbox (accounting)")
    support_email = models.EmailField("Contact for questions")
    trip_start = models.DateField("Trip start (preset)", null=True, blank=True)
    trip_end = models.DateField("Trip end (preset)", null=True, blank=True)
    opens_at = models.DateTimeField("Opens", null=True, blank=True)
    closes_at = models.DateTimeField("Closes", null=True, blank=True)
    status = models.CharField("Status", max_length=12, choices=Status.choices, default=Status.DRAFT)
    creation_key = models.UUIDField(null=True, unique=True, editable=False)
    primary = models.BooleanField(
        "Start page",
        default=False,
        help_text=(
            "The start page redirects to this form while it is open. "
            "Only one form can be the start page."
        ),
    )
    owners = models.ManyToManyField(
        settings.AUTH_USER_MODEL,
        blank=True,
        related_name="owned_forms",
        verbose_name="Owners",
    )
    created_at = models.DateTimeField("Created", default=timezone.now, editable=False)
    updated_at = models.DateTimeField("Changed", auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        verbose_name = "form"
        verbose_name_plural = "forms"
        constraints = [
            models.UniqueConstraint(
                fields=["primary"], condition=models.Q(primary=True), name="form_primary_unique"
            )
        ]

    def __str__(self):
        return self.name

    def is_open(self):
        now = timezone.now()
        return (
            self.status == self.Status.PUBLISHED
            and (not self.opens_at or now >= self.opens_at)
            and (not self.closes_at or now <= self.closes_at)
            and not self.internal_value_errors()
        )

    @property
    def display_title(self):
        return self.title or t(FORM_TITLE)

    @property
    def display_description(self):
        return self.description or t(FORM_DESCRIPTION)

    def internal_value_errors(self):
        """Labels of internal values that no longer satisfy the current template.

        A template change can add a required field or tighten a pattern; the form then
        stays closed until its owners update the values.
        """
        errors = []
        for field in self.template.fields.all():
            try:
                field.validate(self.field_values.get(field.key, ""))
            except ValidationError:
                errors.append(field.label)
        return errors

    def validate_constraints(self, exclude=None):
        # Marking a second start page is a handover that save() performs, not a conflict.
        super().validate_constraints(exclude={*(exclude or ()), "primary"})

    def revision(self):
        """A digest of what a participant agrees to and what their entries are validated against.

        A draft is opened against one revision and accepted only while the form keeps it: the
        declaration, the privacy notice version, the purpose options, the travel mode and the
        mileage rate. Wording, opening times, internal values and contacts change without
        sending open drafts back; the claim snapshot records them at acceptance.
        """
        return self._revision(PrivacyNotice.current())

    def _revision(self, notice):
        template = self.template
        configuration = {
            "intake_version": 2,
            "declaration": template.declaration,
            "declaration_version": template.declaration_version,
            "privacy_version": notice.version if notice else None,
            "purpose_options": self.purpose_choices(),
            "travel": template.travel,
            "mileage_rate": f"{template.mileage_rate:.2f}" if template.mileage_enabled else None,
        }
        encoded = json.dumps(configuration, sort_keys=True, ensure_ascii=False).encode()
        return hashlib.sha256(encoded).hexdigest()[:16]

    def save(self, *args, **kwargs):
        with transaction.atomic():
            if self.primary:
                # Only one form is the start page; the previous one just stops being it.
                Form.objects.filter(primary=True).exclude(pk=self.pk).update(primary=False)
            super().save(*args, **kwargs)

    def purpose_choices(self):
        # Repeated presets are one choice, so a single distinct purpose stays fixed text.
        return list(
            dict.fromkeys(
                line.strip() for line in self.purpose_options.splitlines() if line.strip()
            )
        )

    def internal_values(self):
        """(label, value) pairs in template order, for the PDF."""
        return [
            (field.label, self.field_values.get(field.key, ""))
            for field in self.template.fields.all()
            if self.field_values.get(field.key, "")
        ]

    def snapshot(self):
        template, notice = self.template, PrivacyNotice.current()
        return {
            "name": self.name,
            "slug": self.slug,
            "template": template.name,
            "internal_values": self.internal_values(),
            "recipient": self.recipient,
            "support_email": self.support_email,
            "declaration": template.declaration,
            "declaration_version": template.declaration_version,
            "privacy_version": notice.version if notice else None,
            "mileage_rate": str(template.mileage_rate) if template.mileage_enabled else None,
            "revision": self._revision(notice),
            # The PDF and the emails use the language the participant saw.
            "language": language(),
        }


class DraftAdmission(models.Model):
    """A shared creation budget, keyed by a secret digest of the client network."""

    key = models.CharField(max_length=64, primary_key=True)
    window_start = models.DateTimeField(default=timezone.now, db_index=True)
    count = models.PositiveIntegerField(default=0)
    upload_count = models.PositiveIntegerField(default=0)
    upload_bytes = models.PositiveBigIntegerField(default=0)
    upload_window_start = models.DateTimeField(default=timezone.now)
    upload_window_count = models.PositiveIntegerField(default=0)


class Draft(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    form = models.ForeignKey(Form, on_delete=models.PROTECT)
    session_hash = models.CharField(max_length=64)
    token_hash = models.CharField(max_length=64)
    # The form's revision when the draft was opened; see Form.revision().
    revision = models.CharField(max_length=16)
    created_at = models.DateTimeField(default=timezone.now)
    expires_at = models.DateTimeField(default=draft_expiry, db_index=True)
    claim = models.OneToOneField(
        "Claim", on_delete=models.SET_NULL, null=True, blank=True, related_name="accepted_draft"
    )
    payload_hash = models.CharField(max_length=64, blank=True)
    upload_count = models.PositiveIntegerField(default=0)
    upload_bytes = models.PositiveBigIntegerField(default=0)


class ClaimReferenceCounter(models.Model):
    """A permanent, participant-free sequence, including after claims are purged."""

    id = models.PositiveSmallIntegerField(primary_key=True, default=1, editable=False)
    value = models.PositiveBigIntegerField(default=0)


class ClaimQuerySet(models.QuerySet):
    def for_reference(self, reference):
        try:
            claim_id = uuid.UUID(str(reference))
        except (ValueError, TypeError, AttributeError):
            return self.filter(bookkeeping_reference=reference)
        return self.filter(pk=claim_id)


class Claim(models.Model):
    objects = ClaimQuerySet.as_manager()

    class State(models.TextChoices):
        RECEIVED = "received", "Received"
        RENDERING = "rendering", "Creating PDF"
        READY = "ready", "PDF created"
        FAILED = "processing_failed", "PDF creation failed"
        # Content removal has begun; the claim record itself is deleted last.
        PURGING = "purging", "Being deleted"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    form = models.ForeignKey(
        Form, on_delete=models.PROTECT, related_name="claims", verbose_name="Form"
    )
    full_name = models.CharField("Name", max_length=200)
    email = models.EmailField("Email")
    street = models.CharField(max_length=200)
    postal_code = models.CharField(max_length=12)
    city = models.CharField(max_length=100)
    country = models.CharField(max_length=2)
    account_holder = models.CharField(max_length=200)
    iban = models.CharField(max_length=34)
    bic = models.CharField(max_length=11, blank=True)
    purpose = models.TextField()
    purpose_details = models.TextField(blank=True)
    bookkeeping_reference = models.CharField(max_length=200, null=True, unique=True, editable=False)
    trip_destination = models.CharField(max_length=200, blank=True)
    trip_start = models.DateField(null=True, blank=True)
    trip_end = models.DateField(null=True, blank=True)
    submitted_at = models.DateTimeField("Submitted", default=timezone.now)
    snapshot = models.JSONField()
    total = models.DecimalField(
        "Total (EUR)", max_digits=12, decimal_places=2, null=True, blank=True
    )
    state = models.CharField(
        "Processing", max_length=24, choices=State.choices, default=State.RECEIVED, db_index=True
    )
    pdf_key = models.CharField(max_length=200, blank=True)
    pdf_hash = models.CharField(max_length=64, blank=True)
    pdf_size = models.PositiveIntegerField(default=0)
    pdf_page_count = models.PositiveIntegerField(default=0)
    error_code = models.CharField(max_length=80, blank=True)
    # The PDF is removed first; all remaining content at retention_due.
    pdf_due = models.DateTimeField(null=True, blank=True, db_index=True)
    pdf_removed_at = models.DateTimeField("PDF deleted", null=True, blank=True)
    retention_due = models.DateTimeField(
        "Content deleted from", null=True, blank=True, db_index=True
    )
    resolution_due = models.DateTimeField(default=timezone.now)
    supersedes = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.SET_NULL, related_name="replacements"
    )

    class Meta:
        verbose_name = "claim"
        verbose_name_plural = "claims"

    def __str__(self):
        return self.reference

    @property
    def reference(self):
        return self.bookkeeping_reference or str(self.id)

    @property
    def postal_address(self):
        if not self.street:
            return ""
        return f"{self.street}\n{self.postal_code} {self.city}\n{country_name(self.country)}"


class Expense(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    claim = models.ForeignKey(Claim, on_delete=models.CASCADE, related_name="expenses")

    class Kind(models.TextChoices):
        RECEIPT = "receipt", "Receipt"
        MILEAGE = "mileage", "Mileage"

    position = models.PositiveSmallIntegerField()
    kind = models.CharField(max_length=10, choices=Kind.choices, default=Kind.RECEIPT)
    merchant = models.CharField(max_length=EXPENSE_FIELD_LENGTHS["merchant"], blank=True)
    purpose = models.CharField(max_length=EXPENSE_FIELD_LENGTHS["purpose"])
    receipt_reference = models.CharField(
        max_length=EXPENSE_FIELD_LENGTHS["receipt_reference"], blank=True
    )
    travel_date = models.DateField(null=True, blank=True)
    return_date = models.DateField(null=True, blank=True)
    vehicle_registration = models.CharField(
        max_length=EXPENSE_FIELD_LENGTHS["vehicle_registration"], blank=True
    )
    route_from = models.CharField(max_length=EXPENSE_FIELD_LENGTHS["route_from"], blank=True)
    route_to = models.CharField(max_length=EXPENSE_FIELD_LENGTHS["route_to"], blank=True)
    distance_km = models.PositiveIntegerField(null=True, blank=True)
    round_trip = models.BooleanField(default=False)
    mileage_rate = models.DecimalField(max_digits=4, decimal_places=2, null=True, blank=True)
    amount = models.DecimalField(max_digits=12, decimal_places=2)

    @property
    def billed_km(self):
        return (self.distance_km or 0) * (2 if self.round_trip else 1)

    class Meta:
        ordering = ["position"]
        constraints = [
            models.UniqueConstraint(fields=["claim", "position"], name="expense_position_unique"),
            models.CheckConstraint(
                condition=models.Q(amount__gt=0), name="expense_amount_positive"
            ),
        ]


class Upload(models.Model):
    class State(models.TextChoices):
        PENDING = "pending"
        READY = "ready"
        FAILED = "failed"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    draft = models.ForeignKey(Draft, on_delete=models.CASCADE, related_name="uploads")
    claim = models.ForeignKey(
        Claim, null=True, blank=True, on_delete=models.CASCADE, related_name="uploads"
    )
    expense_id = models.UUIDField(null=True, blank=True)
    position = models.PositiveSmallIntegerField(default=0)
    kind = models.CharField(max_length=12, default="receipt")
    original_name = models.CharField(max_length=200)
    source_key = models.CharField(max_length=200)
    normalized_key = models.CharField(max_length=200, blank=True)
    normalized_size = models.PositiveIntegerField(default=0)
    reserved_bytes = models.PositiveIntegerField(default=0)
    size = models.PositiveIntegerField()
    checksum = models.CharField(max_length=64)
    media_type = models.CharField(max_length=40, blank=True)
    pages = models.PositiveIntegerField(default=0)
    state = models.CharField(max_length=12, choices=State.choices, default=State.PENDING)
    error_code = models.CharField(max_length=80, blank=True)
    created_at = models.DateTimeField(default=timezone.now)


class Delivery(models.Model):
    claim = models.OneToOneField(Claim, on_delete=models.CASCADE, related_name="delivery")
    recipient = models.EmailField()
    state = models.CharField("Delivery", max_length=24, default="pending", db_index=True)
    message_id = models.CharField(max_length=100, blank=True)
    delivered_at = models.DateTimeField(null=True, blank=True)
    error_code = models.CharField(max_length=80, blank=True)
    updated_at = models.DateTimeField(auto_now=True)


class Confirmation(models.Model):
    """The participant's receipt email, independent of PDF processing and Finance delivery."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    claim = models.OneToOneField(Claim, on_delete=models.CASCADE, related_name="confirmation")
    state = models.CharField(max_length=24, default="pending")
    message_id = models.CharField(max_length=100, blank=True)
    error_code = models.CharField(max_length=80, blank=True)
    updated_at = models.DateTimeField(auto_now=True)
    last_checked_at = models.DateTimeField(null=True, blank=True, db_index=True)


class DeliveryAttempt(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    delivery = models.ForeignKey(Delivery, on_delete=models.CASCADE, related_name="attempts")
    state = models.CharField(max_length=24, default="sending")
    message_id = models.CharField(max_length=100, null=True, blank=True, unique=True)
    error_code = models.CharField(max_length=80, blank=True)
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(auto_now=True)
    last_checked_at = models.DateTimeField(null=True, blank=True, db_index=True)


class DeliveryEvent(models.Model):
    """Evidence about one sent email: a Finance delivery attempt or a confirmation.

    It names its email by provider message ID or by `attempt_tag`, the ID of the email's
    record, never by claim.
    """

    provider_id = models.CharField(max_length=100, unique=True)
    message_id = models.CharField(max_length=100, blank=True, db_index=True)
    kind = models.CharField(max_length=80)
    recipient_hash = models.CharField(max_length=64)
    attempt_tag = models.CharField(max_length=80, blank=True)
    provider_timestamp = models.DateTimeField()
    received_at = models.DateTimeField(default=timezone.now)
    applied = models.BooleanField(default=False)
    last_checked_at = models.DateTimeField(null=True, blank=True, db_index=True)


class Job(models.Model):
    key = models.CharField(max_length=160, unique=True)
    kind = models.CharField(max_length=20)
    upload = models.ForeignKey(Upload, null=True, blank=True, on_delete=models.CASCADE)
    claim = models.ForeignKey(Claim, null=True, blank=True, on_delete=models.CASCADE)
    delivery = models.ForeignKey(Delivery, null=True, blank=True, on_delete=models.CASCADE)
    state = models.CharField(max_length=16, default="pending", db_index=True)
    attempts = models.PositiveIntegerField(default=0)
    run_after = models.DateTimeField(default=timezone.now, db_index=True)
    lease_token = models.UUIDField(null=True, blank=True)
    lease_until = models.DateTimeField(null=True, blank=True)
    error_code = models.CharField(max_length=80, blank=True)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(upload__isnull=False, claim__isnull=True, delivery__isnull=True)
                    | models.Q(upload__isnull=True, claim__isnull=False, delivery__isnull=True)
                    | models.Q(upload__isnull=True, claim__isnull=True, delivery__isnull=False)
                ),
                name="job_exactly_one_target",
            )
        ]


class Operation(models.Model):
    claim = models.ForeignKey(Claim, null=True, blank=True, on_delete=models.SET_NULL)
    action = models.CharField(max_length=40)
    actor = models.CharField(max_length=254)
    reason = models.CharField(max_length=500)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["-created_at"]


class CapacityLock(models.Model):
    """One transaction lock serializes admission against the shared filesystem."""

    id = models.PositiveSmallIntegerField(primary_key=True, default=1)


class WorkspaceReservation(models.Model):
    """A reservation lives until its particular process workspace is removed."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    directory = models.CharField(max_length=200, unique=True)
    size = models.PositiveIntegerField()
    output_bytes = models.PositiveIntegerField(default=0)
    upload = models.ForeignKey(Upload, null=True, blank=True, on_delete=models.PROTECT)
    claim = models.ForeignKey(Claim, null=True, blank=True, on_delete=models.PROTECT)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
