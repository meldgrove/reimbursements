import uuid

import pytest
from django.contrib.auth import get_user_model

from portal import roles
from portal.models import Form
from portal.services import publication

pytestmark = pytest.mark.django_db

COMPLETE = {
    "name": "Werkstatt",
    "slug": "werkstatt",
    "value_kst": "4711",
    "recipient": "finance@example.invalid",
    "support_email": "team@example.invalid",
}


def person(name, role):
    user = get_user_model().objects.create_user(name, email=f"{name}@example.invalid")
    roles.assign(user, {role})
    return user


def settings(template, data, *, form=None, action=""):
    status = publication.status_after(form, action)
    return publication.settings_form(template, status)(data, instance=form)


def saved(template, data, person, **options):
    submitted = settings(template, data, **options)
    assert submitted.is_valid(), submitted.errors
    return publication.save(submitted.save(commit=False), person)


def test_a_new_draft_saves_with_gaps_and_its_creator_owns_it(template):
    editor = person("editor", roles.FORM_EDITOR)
    form = saved(template, {"instructions": "Erste Notiz"}, editor)
    assert form.status == Form.Status.DRAFT and form.name == "New form"
    assert form.slug.startswith("new-form-")
    assert form.field_values == {"kst": "", "ktr": ""}
    assert list(form.owners.all()) == [editor]


def test_publishing_needs_complete_settings(template):
    incomplete = settings(template, {"name": "Werkstatt"}, action="publish")
    assert not incomplete.is_valid()
    assert {"slug", "value_kst", "recipient", "support_email"} <= set(incomplete.errors)
    admin = person("admin", roles.TEMPLATE_ADMIN)
    form = saved(template, COMPLETE, admin, action="publish")
    assert form.status == Form.Status.PUBLISHED and form.is_open()


def test_publishing_checks_internal_values_and_the_schedule(template):
    invalid = settings(
        template,
        {**COMPLETE, "value_ktr": "x" * 201, "opens_at": "2099-01-02", "closes_at": "2099-01-01"},
        action="publish",
    )
    assert not invalid.is_valid()
    assert {"value_ktr", "closes_at"} <= set(invalid.errors)


def test_unpublishing_returns_a_form_to_draft_and_keeps_its_settings(form):
    admin = person("admin", roles.TEMPLATE_ADMIN)
    data = {**COMPLETE, "slug": form.slug, "value_kst": "", "recipient": ""}
    draft = saved(form.template, data, admin, form=form, action="unpublish")
    assert draft.status == Form.Status.DRAFT and draft.field_values["kst"] == ""
    assert not draft.owners.exists()


def test_unknown_actions_are_refused(form):
    with pytest.raises(publication.Refused):
        publication.status_after(form, "delete")
    assert publication.status_after(form, "") == Form.Status.PUBLISHED
    assert publication.status_after(None, "") == Form.Status.DRAFT


def test_archiving_closes_a_form_and_gives_up_the_start_page(form):
    admin = person("admin", roles.TEMPLATE_ADMIN)
    form.primary = True
    form.save()
    # An archived form keeps gaps like a draft.
    data = {**COMPLETE, "slug": form.slug, "value_kst": "", "primary": "on"}
    archived = saved(form.template, data, admin, form=form, action="archive")
    assert archived.status == Form.Status.ARCHIVED and archived.field_values["kst"] == ""
    assert not archived.primary and not archived.is_open()
    assert publication.status_after(archived, "") == Form.Status.ARCHIVED
    assert publication.status_after(archived, "unarchive") == Form.Status.DRAFT


def test_archived_forms_are_set_back_to_drafts(form):
    assert publication.set_archived(form, True)
    assert not publication.set_archived(form, True)
    form.refresh_from_db()
    assert form.status == Form.Status.ARCHIVED
    assert publication.set_archived(form, False)
    assert not publication.set_archived(form, False)
    form.refresh_from_db()
    assert form.status == Form.Status.DRAFT


def test_a_retried_first_save_finds_the_form_it_created(template):
    editor, other = person("editor", roles.FORM_EDITOR), person("other", roles.FORM_EDITOR)
    key = uuid.uuid4()
    submitted = settings(template, {"name": "Erst"})
    assert submitted.is_valid()
    form = publication.save(submitted.save(commit=False), editor, creation_key=key)
    assert publication.created(editor, key) == form
    assert publication.created(other, key) is None
    assert publication.created(editor, uuid.uuid4()) is None


def test_editors_stay_owners_of_forms_they_save(form):
    editor = person("editor", roles.FORM_EDITOR)
    data = {**COMPLETE, "slug": form.slug}
    assert editor in saved(form.template, data, editor, form=form).owners.all()
    admin = person("admin", roles.TEMPLATE_ADMIN)
    assert admin not in saved(form.template, data, admin, form=form).owners.all()


def test_only_template_admins_delete_and_only_forms_without_claims_or_drafts(accepted):
    admin, editor = person("admin", roles.TEMPLATE_ADMIN), person("editor", roles.FORM_EDITOR)
    form = accepted.form
    assert not publication.may_delete(admin, form)
    form.status = Form.Status.DRAFT
    assert not publication.may_delete(admin, form)
    accepted.delete()
    assert not publication.may_delete(admin, form)
    form.draft_set.all().delete()
    assert publication.may_delete(admin, form)
    assert not publication.may_delete(editor, form)
    form.status = Form.Status.ARCHIVED
    assert publication.may_delete(admin, form)
