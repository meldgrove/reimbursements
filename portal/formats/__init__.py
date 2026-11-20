"""Format modules for FORMAT_MODULE_PATH: dates and numbers follow the General settings."""

from portal import dates, numbers


def setting(name):
    """The value of a Django format setting from the General settings, or AttributeError."""
    try:
        return numbers.format_setting(name)
    except AttributeError:
        return dates.format_setting(name)
