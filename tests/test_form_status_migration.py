from importlib import import_module

import pytest
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.utils import timezone


@pytest.mark.django_db(transaction=True)
def test_existing_forms_keep_their_publication_state_when_migrating():
    before = [("portal", "0003_form_primary")]
    after = [("portal", "0004_form_status")]
    executor = MigrationExecutor(connection)
    executor.migrate(before)
    try:
        apps = executor.loader.project_state(before).apps
        template = apps.get_model("portal", "FormTemplate").objects.create(name="Migration")
        Form = apps.get_model("portal", "Form")
        for slug, active in [("open", True), ("closed", False)]:
            Form.objects.create(
                template=template,
                name=slug,
                slug=slug,
                recipient="finance@example.invalid",
                support_email="finance@example.invalid",
                active=active,
            )
        executor = MigrationExecutor(connection)
        executor.migrate(after)
        Form = executor.loader.project_state(after).apps.get_model("portal", "Form")
        assert dict(Form.objects.values_list("slug", "status")) == {
            "open": "published",
            "closed": "draft",
        }
        executor = MigrationExecutor(connection)
        executor.migrate(before)
        Form = executor.loader.project_state(before).apps.get_model("portal", "Form")
        assert dict(Form.objects.values_list("slug", "active")) == {"open": True, "closed": False}
    finally:
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())


@pytest.mark.django_db(transaction=True)
def test_open_drafts_of_the_current_configuration_survive_the_revision_migration():
    before = [("portal", "0004_form_status")]
    after = [("portal", "0005_form_revision")]
    executor = MigrationExecutor(connection)
    executor.migrate(before)
    try:
        apps = executor.loader.project_state(before).apps
        apps.get_model("portal", "PrivacyNotice").objects.create(version=7, text="Hinweis")
        template = apps.get_model("portal", "FormTemplate").objects.create(
            name="Migration", mileage_enabled=True
        )
        old = apps.get_model("portal", "Form").objects.create(
            template=template,
            name="Alt",
            slug="alt",
            recipient="finance@example.invalid",
            support_email="finance@example.invalid",
            purpose_options="A\n\nB ",
            config_version=4,
        )
        Draft = apps.get_model("portal", "Draft")
        for config_version in (4, 3):
            Draft.objects.create(
                form=old, session_hash="s", token_hash="t", config_version=config_version
            )
        executor = MigrationExecutor(connection)
        executor.migrate(after)
        Draft = executor.loader.project_state(after).apps.get_model("portal", "Draft")
        apps = executor.loader.project_state(after).apps
        revision = import_module("portal.migrations.0005_form_revision").revision
        current = revision(
            apps.get_model("portal", "Form").objects.select_related("template").get(slug="alt"),
            apps.get_model("portal", "PrivacyNotice").objects.order_by("-version").first(),
        )
        assert sorted(Draft.objects.values_list("revision", flat=True)) == ["", current]
    finally:
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())


@pytest.mark.django_db(transaction=True)
def test_the_empty_records_of_purged_claims_are_deleted_when_migrating():
    before = [("portal", "0008_content_retention_ninety_days")]
    after = [("portal", "0010_remove_purged_state")]
    executor = MigrationExecutor(connection)
    executor.migrate(before)
    try:
        apps = executor.loader.project_state(before).apps
        template = apps.get_model("portal", "FormTemplate").objects.create(name="Migration")
        form = apps.get_model("portal", "Form").objects.create(
            template=template,
            name="Formular",
            slug="formular",
            recipient="finance@example.invalid",
            support_email="finance@example.invalid",
        )
        Claim = apps.get_model("portal", "Claim")
        kept = Claim.objects.create(form=form, full_name="Alex Beispiel", snapshot={})
        purged = Claim.objects.create(form=form, state="purged", snapshot={})
        apps.get_model("portal", "Draft").objects.create(
            form=form, session_hash="", token_hash="", revision="r", claim=purged
        )
        apps.get_model("portal", "Operation").objects.create(
            claim=purged, action="delete", actor="admin", reason="Test"
        )
        executor = MigrationExecutor(connection)
        executor.migrate(after)
        apps = executor.loader.project_state(after).apps
        Claim = apps.get_model("portal", "Claim")
        assert list(Claim.objects.values_list("pk", flat=True)) == [kept.pk]
        draft = apps.get_model("portal", "Draft").objects.get()
        assert draft.claim_id is None and draft.expires_at <= timezone.now()
        operation = apps.get_model("portal", "Operation").objects.get()
        assert (operation.claim_id, operation.action) == (None, "delete")
    finally:
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())
