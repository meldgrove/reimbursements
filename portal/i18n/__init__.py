"""Text in the app language, German or English.

The admin area is always English. Public pages, emails to participants and Finance and
the claim PDF use the app language from the General settings. Text is written in
English; `de.TEXT` holds its German version. Django's own messages, such as form
validation, follow the same active language.
"""

from django.utils import translation
from django.utils.functional import lazy

from portal.i18n import de

LANGUAGES = [("de", "Deutsch"), ("en", "English")]
CATALOGS = {"de": de.TEXT}


def language():
    """The active language: de or en."""
    return "de" if (translation.get_language() or "").startswith("de") else "en"


def t(text, /, **values):
    """`text` in the active language, with `{name}` placeholders filled from `values`."""
    text = CATALOGS.get(language(), {}).get(text, text)
    return text.format(**values) if values else text


t_lazy = lazy(t, str)
