"""Date formats from the General settings; other formats come from Django's locale."""

from portal import dates


def __getattr__(name):
    return dates.format_setting(name)
