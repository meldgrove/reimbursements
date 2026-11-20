"""Date and number formats from the General settings; others come from Django's locale."""

from portal import formats


def __getattr__(name):
    return formats.setting(name)
