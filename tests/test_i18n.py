"""Every text the app translates has a German version with the same placeholders."""

import ast
import re
import string
from pathlib import Path

from portal import constants, intake
from portal.i18n import de

PORTAL = Path(__file__).resolve().parent.parent / "portal"
TEMPLATE_TEXT = re.compile(r"""\{%\s*t(?:_html)?\s+(?:"([^"]*)"|'([^']*)')""")
# Constants and tables translated where they are shown, e.g. t(FORM_TITLE).
TRANSLATED_ELSEWHERE = [
    constants.DECLARATION,
    constants.FORM_TITLE,
    constants.FORM_DESCRIPTION,
    constants.PAYMENT_TIMING,
    *intake.STATIC_MESSAGES.values(),
]


def translated_texts():
    texts = set(TRANSLATED_ELSEWHERE)
    for path in PORTAL.glob("templates/**/*.html"):
        for match in TEMPLATE_TEXT.finditer(path.read_text()):
            texts.add(match[1] if match[1] is not None else match[2])
    for path in PORTAL.rglob("*.py"):
        if "migrations" in path.parts:
            continue
        for node in ast.walk(ast.parse(path.read_text())):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id in {"t", "t_lazy"}
                and node.args
                and isinstance(node.args[0], ast.Constant)
            ):
                texts.add(node.args[0].value)
    return texts


def placeholders(text):
    return {name for _, name, _, _ in string.Formatter().parse(text) if name}


def test_every_translated_text_has_german():
    missing = sorted(translated_texts() - de.TEXT.keys())
    assert not missing


def test_german_has_no_unused_texts():
    assert not sorted(de.TEXT.keys() - translated_texts())


def test_german_keeps_the_placeholders():
    assert not [
        text for text, german in de.TEXT.items() if placeholders(text) != placeholders(german)
    ]
