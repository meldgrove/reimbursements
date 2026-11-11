from django import template
from django.utils.html import format_html, format_html_join

register = template.Library()


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
