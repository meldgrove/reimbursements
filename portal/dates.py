"""The app date format of the General settings, applied to every date Django shows.

`FORMAT_MODULE_PATH` points Django at portal.formats, whose modules answer with the
active format below. Django caches formats per process, so `use()` resets that cache
when the format changes. Times are always shown with 24 hours.
"""

from dataclasses import dataclass
from datetime import date

from django.utils import formats


@dataclass(frozen=True)
class DateFormat:
    # The Django date filter format, e.g. d.m.Y.
    django: str
    # The matching strptime format for date inputs, e.g. %d.%m.%Y.
    python: str
    # The pattern the form script fills in, e.g. DD.MM.YYYY.
    script: str

    @property
    def label(self):
        return f"{date(2026, 12, 31).strftime(self.python)} ({self.script})"


DATE_FORMATS = {
    "d.m.Y": DateFormat("d.m.Y", "%d.%m.%Y", "DD.MM.YYYY"),
    "d/m/Y": DateFormat("d/m/Y", "%d/%m/%Y", "DD/MM/YYYY"),
    "m/d/Y": DateFormat("m/d/Y", "%m/%d/%Y", "MM/DD/YYYY"),
    "Y-m-d": DateFormat("Y-m-d", "%Y-%m-%d", "YYYY-MM-DD"),
}
DEFAULT_DATE_FORMAT = "d.m.Y"
CHOICES = [(code, value.label) for code, value in DATE_FORMATS.items()]

_active = DEFAULT_DATE_FORMAT


def use(code):
    """Show dates in the format `code` from now on in this process."""
    global _active
    code = code if code in DATE_FORMATS else DEFAULT_DATE_FORMAT
    if code != _active:
        _active = code
        formats.reset_format_cache()


def active():
    return DATE_FORMATS[_active]


def format_setting(name):
    """The value of a Django format setting such as DATE_FORMAT, or AttributeError."""
    current = active()
    values = {
        "DATE_FORMAT": current.django,
        "SHORT_DATE_FORMAT": current.django,
        "DATETIME_FORMAT": f"{current.django}, H:i",
        "SHORT_DATETIME_FORMAT": f"{current.django} H:i",
        "TIME_FORMAT": "H:i",
        "DATE_INPUT_FORMATS": [current.python, "%Y-%m-%d"],
        "DATETIME_INPUT_FORMATS": [
            f"{current.python} %H:%M:%S",
            f"{current.python} %H:%M",
            "%Y-%m-%d %H:%M:%S",
            "%Y-%m-%d %H:%M",
        ],
    }
    try:
        return values[name]
    except KeyError:
        raise AttributeError(name) from None
