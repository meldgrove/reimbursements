"""Template components with escaped attributes and decorative inline symbols.

Use {% component "button" variant="outline" %}Save{% endcomponent %}.
The slot preserves rendered template escaping; extra options become attributes.
"""

from django import template
from django.template.loader import get_template
from django.utils.html import conditional_escape, format_html, format_html_join
from django.utils.safestring import mark_safe

register = template.Library()

COMPONENTS = {
    "alert": {"variant": "default"},
    "alert_description": {},
    "alert_title": {},
    "badge": {"variant": "secondary"},
    "button": {"variant": "default", "size": "default", "href": None},
    "card": {},
    "card_content": {},
    "card_description": {},
    "card_footer": {},
    "card_header": {},
    "card_title": {},
    "kbd": {},
}


def html_attributes(values):
    """Attribute pairs for `format_html_join`; values are escaped there."""
    pairs = []
    for name, value in values.items():
        if value is None or value is False:
            continue
        name = name.replace("_", "-")
        pairs.append((name, name if value is True else value))
    return format_html_join("", ' {}="{}"', pairs)


def render_component(name, slot, /, **options):
    """A component outside templates, e.g. `render_component("badge", "New", variant="success")`."""
    if name not in COMPONENTS:
        raise template.TemplateSyntaxError(f"Unknown component {name!r}.")
    variables = {key: options.pop(key, default) for key, default in COMPONENTS[name].items()}
    variables["class"] = options.pop("class", "")
    variables["attrs"] = html_attributes(options)
    variables["slot"] = conditional_escape(slot)
    return mark_safe(get_template(f"ui/{name}.html").render(variables).strip())


class ComponentNode(template.Node):
    def __init__(self, name, options, nodelist):
        self.name, self.options, self.nodelist = name, options, nodelist

    def render(self, context):
        options = {key: value.resolve(context) for key, value in self.options.items()}
        return render_component(
            self.name.resolve(context), self.nodelist.render(context), **options
        )


@register.tag
def component(parser, token):
    bits = token.split_contents()
    if len(bits) < 2:
        raise template.TemplateSyntaxError("component needs a component name.")
    options = {}
    for bit in bits[2:]:
        key, separator, value = bit.partition("=")
        if not separator:
            raise template.TemplateSyntaxError(f"component expects key=value, got {bit!r}.")
        options[key] = parser.compile_filter(value)
    nodelist = parser.parse(("endcomponent",))
    parser.delete_first_token()
    return ComponentNode(parser.compile_filter(bits[1]), options, nodelist)


ICONS = {
    "archive": '<rect x="3" y="5" width="26" height="7" rx="1"/><path d="M5 12V27H27V12M13 18H19"/>',
    "arrow-down": '<path d="M16 6V26L8 18M16 26L24 18"/>',
    "arrow-up": '<path d="M16 26V6L8 14M16 6L24 14"/>',
    "arrow-left": '<path d="M26 16H6L14 8M6 16L14 24"/>',
    "arrow-right": '<path d="M6 16H26L18 8M26 16L18 24"/>',
    "chevron-down": '<polyline points="7,11 16,20 25,11"/>',
    "chevron-left": '<polyline points="21,7 12,16 21,25"/>',
    "chevron-right": '<polyline points="11,7 20,16 11,25"/>',
    "chevrons-up-down": '<path d="M10 11L16 5L22 11M10 21L16 27L22 21"/>',
    "check": '<polyline points="6,16 13,23 27,8"/>',
    "x": '<path d="M7 7L25 25M7 25L25 7"/>',
    "plus": '<path d="M5 16H27M16 5V27"/>',
    "calendar": '<rect x="5" y="7" width="22" height="21" rx="3"/><path d="M5 14H27M11 4V10M21 4V10M11 20H13M19 20H21"/>',
    "corner-down-left": '<path d="M25 5V20H6L12 14M6 20L12 26"/>',
    "external-link": '<path d="M18 5H27V14M27 5L14 18M13 6H5V27H26V19"/>',
    "eye": '<path d="M3 16Q16-2 29 16Q16 34 3 16Z"/><circle cx="16" cy="16" r="4"/>',
    "globe": '<circle cx="16" cy="16" r="13"/><path d="M3 16H29M16 3Q8 16 16 29Q24 16 16 3"/>',
    "file-text": '<path d="M7 3H20L26 9V29H7ZM20 3V10H26M11 16H22M11 22H22"/>',
    "history": '<path d="M6 10A12 12 0 1 1 4 20M6 3V10H13M16 8V16L22 20"/>',
    "layout-template": '<rect x="4" y="4" width="24" height="24" rx="2"/><path d="M4 12H28M18 12V28"/>',
    "list-filter": '<path d="M4 7H28M9 16H23M14 25H18"/>',
    "loader": '<path d="M16 4A12 12 0 1 1 4 16"/>',
    "lock": '<rect x="6" y="14" width="20" height="15" rx="2"/><path d="M10 14V9A6 6 0 0 1 22 9V14M16 20V24"/>',
    "log-out": '<path d="M13 4H5V28H13M13 16H29L23 10M29 16L23 22"/>',
    "mail": '<path d="M4 7H28V25H4ZM4 7L16 18L28 7"/>',
    "menu": '<path d="M5 8H27M5 16H27M5 24H27"/>',
    "palette": '<path d="M16 3A13 13 0 0 0 16 29Q19 29 18 25Q17 21 21 21H24Q29 21 29 15Q29 3 16 3Z"/><circle cx="10" cy="15" r="1"/><circle cx="12" cy="9" r="1"/><circle cx="19" cy="8" r="1"/><circle cx="24" cy="13" r="1"/>',
    "panel-left": '<rect x="4" y="5" width="24" height="22" rx="2"/><path d="M12 5V27"/>',
    "paperclip": '<path d="M13 11V24A4 4 0 0 0 21 24V8A6 6 0 0 0 9 8V23A8 8 0 0 0 25 23V12"/>',
    "pen-line": '<path d="M5 27L7 20L23 4L28 9L12 25ZM7 20L12 25M18 27H29"/>',
    "receipt-euro": '<path d="M7 3H25V29L20 26L16 29L12 26L7 29ZM20 10Q12 6 12 16Q12 24 20 21M9 14H18M9 18H18"/>',
    "refresh-cw": '<path d="M6 12A11 11 0 0 1 26 9M26 3V10H19M26 20A11 11 0 0 1 6 23M6 29V22H13"/>',
    "search": '<circle cx="13" cy="13" r="9"/><path d="M20 20L29 29"/>',
    "send": '<path d="M3 5L29 16L3 27L8 16ZM8 16H29"/>',
    "settings": '<path d="M5 8H27M5 16H27M5 24H27"/><rect x="10" y="5" width="5" height="6"/><rect x="20" y="13" width="5" height="6"/><rect x="7" y="21" width="5" height="6"/>',
    "shield-check": '<path d="M16 3L27 8V17Q27 24 16 29Q5 24 5 17V8ZM10 16L14 20L22 12"/>',
    "trash": '<path d="M4 8H28M8 8L10 28H22L24 8M12 8V4H20V8M14 13V23M18 13V23"/>',
    "triangle-alert": '<path d="M16 3L30 28H2ZM16 11V19"/><circle cx="16" cy="24" r="1"/>',
    "upload": '<path d="M4 22V28H28V22M16 23V4L8 12M16 4L24 12"/>',
    "user-round": '<circle cx="16" cy="10" r="6"/><path d="M4 29V26Q4 19 16 19Q28 19 28 26V29"/>',
    "circle-alert": '<circle cx="16" cy="16" r="13"/><path d="M16 8V18"/><circle cx="16" cy="23" r="1"/>',
    "circle-check": '<circle cx="16" cy="16" r="13"/><path d="M9 16L14 21L23 11"/>',
    "circle-plus": '<circle cx="16" cy="16" r="13"/><path d="M9 16H23M16 9V23"/>',
    "circle-x": '<circle cx="16" cy="16" r="13"/><path d="M11 11L21 21M11 21L21 11"/>',
    "info": '<circle cx="16" cy="16" r="13"/><path d="M16 14V24"/><circle cx="16" cy="9" r="1"/>',
}


@register.simple_tag
def icon(name, **attributes):
    """Render a decorative symbol; controls must supply their own visible or aria label."""
    attributes.setdefault("class", "size-4")
    return format_html(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" '
        'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" '
        'aria-hidden="true" focusable="false"{}>{}</svg>',
        html_attributes(attributes),
        mark_safe(ICONS[name]),
    )
