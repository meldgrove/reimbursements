import re
import unicodedata

from django import forms
from stdnum import bic, iban

from portal.countries import countries
from portal.i18n import t, t_lazy
from portal.models import FormTemplate

# IBAN countries in the SEPA scheme. Other IBANs also need a BIC for the transfer.
SEPA_COUNTRIES = frozenset(
    "AD AT BE BG CH CY CZ DE DK EE ES FI FR GB GI GR HR HU IE IS IT LI LT LU LV MC MT NL "
    "NO PL PT RO SE SI SK SM VA".split()
)
POSTAL_CODE_FORMATS = {
    "DE": (r"\d{5}", t_lazy("Please enter a five-digit postcode.")),
    "AT": (r"\d{4}", t_lazy("Please enter a four-digit postcode.")),
    "CH": (r"\d{4}", t_lazy("Please enter a four-digit postcode.")),
}
OTHER_POSTAL_CODE = r"[A-Za-z0-9](?:[A-Za-z0-9 -]{0,10}[A-Za-z0-9])?"


def validate_person_name(value, *, extra=""):
    """Letters in any script, with spaces, hyphens, apostrophes and dots between them."""
    allowed = set(" -'’." + extra)
    letters = sum(1 for character in value if unicodedata.category(character).startswith("L"))
    if letters < 2 or any(
        unicodedata.category(character)[0] not in "LM" and character not in allowed
        for character in value
    ):
        raise forms.ValidationError(
            t("Please enter the name using only letters, spaces, hyphens or apostrophes.")
        )


def date_field(label):
    return forms.DateField(
        label=label,
        required=False,
        widget=forms.DateInput(attrs={"type": "date"}, format="%Y-%m-%d"),
        input_formats=["%Y-%m-%d"],
    )


class ClaimForm(forms.Form):
    full_name = forms.CharField(label=t_lazy("First and last name"), max_length=200)
    email = forms.EmailField(label=t_lazy("Email address"), max_length=254)
    street = forms.CharField(label=t_lazy("Street and house number"), max_length=200)
    postal_code = forms.CharField(label=t_lazy("Postcode"), max_length=12)
    city = forms.CharField(label=t_lazy("Town or city"), max_length=100)
    country = forms.ChoiceField(label=t_lazy("Country"), choices=countries, initial="DE")
    account_holder = forms.CharField(label=t_lazy("Account holder"), max_length=200)
    iban = forms.CharField(label=t_lazy("IBAN"), max_length=60)
    bic = forms.CharField(label=t_lazy("BIC"), max_length=20, required=False)
    purpose = forms.CharField(
        label=t_lazy("Occasion/connection to the project or event"),
        max_length=3000,
        widget=forms.Textarea(attrs={"rows": 4}),
    )
    purpose_details = forms.CharField(
        label=t_lazy("Additional details (optional)"),
        max_length=3000,
        required=False,
        widget=forms.Textarea(attrs={"rows": 3}),
    )
    is_trip = forms.BooleanField(label=t_lazy("My expenses belong to a trip"), required=False)
    trip_destination = forms.CharField(label=t_lazy("Destination"), max_length=200, required=False)
    trip_start = date_field(t_lazy("Trip start"))
    trip_end = date_field(t_lazy("Trip end"))
    declaration = forms.BooleanField(label=t_lazy("Confirm the declaration"))
    privacy_acknowledged = forms.BooleanField(label=t_lazy("Privacy notice read"))

    def __init__(self, *args, form, has_mileage=False, **kwargs):
        self.portal_form = form
        self.has_mileage = has_mileage
        super().__init__(*args, **kwargs)
        options = form.purpose_choices()
        self.fixed_purpose = options[0] if len(options) == 1 else None
        if self.fixed_purpose:
            self.fields["purpose"].initial = self.fixed_purpose
            self.fields["purpose"].disabled = True
            self.fields["purpose"].widget = forms.HiddenInput()
        elif options:
            self.fields["purpose"] = forms.ChoiceField(
                label=self.fields["purpose"].label,
                choices=[(option, option) for option in options],
                widget=forms.RadioSelect,
            )
        if (
            has_mileage
            or self.travel_mode == FormTemplate.Travel.OFF
            or (self.travel_mode == FormTemplate.Travel.OPTIONAL and not self.data.get("is_trip"))
        ):
            for name in ["trip_destination", "trip_start", "trip_end"]:
                self.fields[name].disabled = True
        for name, field in self.fields.items():
            field.widget.attrs["aria-describedby"] = f"error-{name}"
        for name, autocomplete in {
            "full_name": "name",
            "email": "email",
            "street": "address-line1",
            "postal_code": "postal-code",
            "city": "address-level2",
            "country": "country",
            "account_holder": "off",
            "iban": "off",
            "bic": "off",
        }.items():
            self.fields[name].widget.attrs["autocomplete"] = autocomplete
        for name in ["iban", "bic"]:
            self.fields[name].widget.attrs["spellcheck"] = "false"

    @property
    def travel_mode(self):
        return self.portal_form.template.travel

    def travel_required(self):
        if self.has_mileage or self.travel_mode == FormTemplate.Travel.OFF:
            return False
        return self.travel_mode == FormTemplate.Travel.REQUIRED or self.cleaned_data.get(
            "is_trip", False
        )

    def clean_full_name(self):
        value = self.cleaned_data["full_name"].strip()
        validate_person_name(value)
        return value

    def clean_account_holder(self):
        value = self.cleaned_data["account_holder"].strip()
        validate_person_name(value, extra="&,")
        return value

    def clean_postal_code(self):
        return self.cleaned_data["postal_code"].strip().upper()

    def clean_iban(self):
        value = self.cleaned_data["iban"].replace(" ", "").replace(" ", "").upper()
        if not re.fullmatch(r"[A-Z]{2}\d{2}[A-Z0-9]{11,30}", value) or not iban.is_valid(value):
            raise forms.ValidationError(t("Please enter a valid IBAN."))
        return value

    def clean_bic(self):
        value = self.cleaned_data["bic"].replace(" ", "").upper()
        if value and not bic.is_valid(value):
            raise forms.ValidationError(t("Please enter a valid BIC with 8 or 11 characters."))
        return value

    def clean(self):
        data = super().clean()
        country, postal_code = data.get("country"), data.get("postal_code")
        if country and postal_code:
            pattern, message = POSTAL_CODE_FORMATS.get(
                country, (OTHER_POSTAL_CODE, t("Please enter a valid postcode."))
            )
            if not re.fullmatch(pattern, postal_code):
                self.add_error("postal_code", str(message))
        account = data.get("iban")
        if account and account[:2] not in SEPA_COUNTRIES and not data.get("bic"):
            self.add_error("bic", t("Accounts outside the SEPA area need a BIC."))
        if not self.portal_form.purpose_choices():
            data["purpose_details"] = ""
        if not self.travel_required():
            data["trip_destination"], data["trip_start"], data["trip_end"] = "", None, None
            return data
        if not data.get("trip_destination", "").strip():
            self.add_error("trip_destination", t("Please enter the destination."))
        start, end = data.get("trip_start"), data.get("trip_end")
        if not start or not end:
            self.add_error("trip_end", t("Please enter both trip dates."))
        elif start > end:
            self.add_error("trip_end", t("The trip cannot end before it starts."))
        return data
