import pytest
from django.template import Context, Template, TemplateSyntaxError


def render(source, **context):
    return Template("{% load ui %}" + source).render(Context(context))


def test_component_passes_variables_classes_and_attributes():
    html = render(
        '{% component "button" variant="outline" class="w-full" type="submit" '
        'data_action="save" disabled=True hidden=False %}Speichern{% endcomponent %}'
    )
    assert html.startswith("<button") and html.endswith("Speichern</button>")
    assert "border-input" in html and "w-full" in html and "bg-primary" not in html
    assert ' type="submit"' in html and ' data-action="save"' in html
    assert ' disabled="disabled"' in html and "hidden" not in html


def test_component_renders_a_link_and_escapes_attributes():
    html = render(
        '{% component "button" href=url title=title %}{{ title }}{% endcomponent %}',
        url="/admin/?a=1&b=2",
        title='"<x>"',
    )
    assert html.startswith('<a href="/admin/?a=1&amp;b=2"') and html.endswith("</a>")
    assert 'title="&quot;&lt;x&gt;&quot;"' in html and "&quot;&lt;x&gt;&quot;</a>" in html


def test_unknown_components_fail_loudly():
    with pytest.raises(TemplateSyntaxError):
        render('{% component "carousel" %}{% endcomponent %}')


@pytest.mark.parametrize(
    ("snapshot", "version"),
    [({"revision": "0123456789abcdef"}, "0123456789abcdef"), ({"config_version": 7}, "7")],
)
def test_pdf_summary_names_the_form_version_of_new_and_older_claims(accepted, snapshot, version):
    from django.template.loader import render_to_string

    accepted.snapshot = snapshot
    html = render_to_string(
        "portal/summary.html", {"claim": accepted, "expenses": [], "signature_uri": ""}
    )
    assert f"Formularversion {version}" in html
