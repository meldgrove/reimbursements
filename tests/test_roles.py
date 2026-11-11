import pytest
from django.contrib.auth import get_user_model

from portal import roles
from portal.models import Claim, Form

pytestmark = pytest.mark.django_db


def person(name, *granted):
    user = get_user_model().objects.create_user(name, email=f"{name}@example.invalid")
    roles.assign(user, set(granted))
    return user


@pytest.fixture
def other_form(form):
    return Form.objects.create(
        template=form.template,
        slug="andere",
        name="Andere",
        recipient=form.recipient,
        support_email=form.support_email,
    )


def test_template_admins_manage_every_form_and_see_every_claim(accepted, other_form):
    admin = person("admin", roles.TEMPLATE_ADMIN)
    assert set(roles.managed_forms(admin)) == {accepted.form, other_form}
    assert list(roles.visible_claims(admin)) == [accepted]
    assert roles.manages(admin, other_form) and roles.sees(admin, accepted)


def test_editors_manage_their_own_forms_and_see_only_their_claims(accepted, other_form):
    editor = person("editor", roles.FORM_EDITOR)
    other_form.owners.add(editor)
    assert list(roles.managed_forms(editor)) == [other_form]
    assert not roles.visible_claims(editor).exists()
    assert not roles.manages(editor, accepted.form) and not roles.sees(editor, accepted)
    accepted.form.owners.add(editor)
    assert roles.manages(editor, accepted.form) and roles.sees(editor, accepted)


def test_people_without_a_role_manage_nothing(accepted):
    nobody = person("nobody")
    accepted.form.owners.add(nobody)
    assert not roles.managed_forms(nobody).exists()
    assert not roles.visible_claims(nobody).exists()
    assert not roles.manages(nobody, accepted.form)


def test_lists_narrow_a_given_queryset(accepted, other_form):
    editor = person("editor", roles.FORM_EDITOR)
    accepted.form.owners.add(editor)
    other_form.owners.add(editor)
    assert list(roles.managed_forms(editor, Form.objects.filter(slug="andere"))) == [other_form]
    assert not roles.visible_claims(editor, Claim.objects.none()).exists()
