"""The app number format of the General settings, applied to every amount the app shows.

European numbers have a decimal comma (1.234,56), US numbers a decimal point (1,234.56).
Like the date format (portal.dates), the modules of portal.formats answer with the active
format, and `use()` resets Django's format cache when the format changes. Participants
may type amounts with either separator; see intake.AMOUNT_PATTERN.
"""

from dataclasses import dataclass

from django.utils import formats


@dataclass(frozen=True)
class NumberFormat:
    decimal: str
    thousands: str
    name: str

    @property
    def label(self):
        return f"1{self.thousands}234{self.decimal}56 ({self.name})"

    def example(self, amount="12.50"):
        """`amount` with this decimal separator, such as 12,50 for 12.50."""
        return amount.replace(".", self.decimal)


NUMBER_FORMATS = {
    "european": NumberFormat(",", ".", "European"),
    "us": NumberFormat(".", ",", "US"),
}
DEFAULT_NUMBER_FORMAT = "european"
CHOICES = [(code, value.label) for code, value in NUMBER_FORMATS.items()]

_active = DEFAULT_NUMBER_FORMAT


def use(code):
    """Show numbers in the format `code` from now on in this process."""
    global _active
    code = code if code in NUMBER_FORMATS else DEFAULT_NUMBER_FORMAT
    if code != _active:
        _active = code
        formats.reset_format_cache()


def active():
    return NUMBER_FORMATS[_active]


def format_setting(name):
    """The value of a Django format setting such as DECIMAL_SEPARATOR, or AttributeError."""
    current = active()
    values = {"DECIMAL_SEPARATOR": current.decimal, "THOUSAND_SEPARATOR": current.thousands}
    try:
        return values[name]
    except KeyError:
        raise AttributeError(name) from None
