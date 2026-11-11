from django import template
from django.utils.html import format_html, format_html_join
from django.utils.safestring import mark_safe

from portal import i18n

register = template.Library()


@register.simple_tag(name="t")
def translate(text, **values):
    """`{% t "Text with {name}" name=value %}`: text in the app language, escaped."""
    return i18n.t(text, **values)


@register.simple_tag(name="t_html")
def translate_html(text, **values):
    """Like `t` for text with markup: the text is trusted, only the values are escaped."""
    text = i18n.t(text)
    return format_html(text, **values) if values else mark_safe(text)


@register.filter
def paragraphs(text):
    """Blank-line separated paragraphs; a paragraph starting with "# " is a heading."""
    blocks = [block.strip() for block in (text or "").replace("\r\n", "\n").split("\n\n")]
    items = []
    for block in filter(None, blocks):
        if block.startswith("# "):
            items.append(("h3", block[2:].strip()))
        else:
            items.append(("p", block))
    return format_html_join("", "<{0}>{1}</{0}>", items) if items else format_html("")
