import hashlib
import json

from django.db import migrations, models


def revision(form, notice):
    # Frozen copy of Form.revision() as of this migration.
    template = form.template
    configuration = {
        "declaration": template.declaration,
        "declaration_version": template.declaration_version,
        "privacy_version": notice.version if notice else None,
        "purpose_options": [
            line.strip() for line in form.purpose_options.splitlines() if line.strip()
        ],
        "travel": template.travel,
        "mileage_rate": f"{template.mileage_rate:.2f}" if template.mileage_enabled else None,
    }
    encoded = json.dumps(configuration, sort_keys=True, ensure_ascii=False).encode()
    return hashlib.sha256(encoded).hexdigest()[:16]


def keep_current_drafts(apps, schema_editor):
    """Open drafts of the form's current configuration keep working across the upgrade."""
    Draft = apps.get_model("portal", "Draft")
    notice = apps.get_model("portal", "PrivacyNotice").objects.order_by("-version").first()
    drafts = Draft.objects.filter(claim__isnull=True).select_related("form__template")
    for draft in drafts.iterator(chunk_size=500):
        if draft.config_version == draft.form.config_version:
            draft.revision = revision(draft.form, notice)
            draft.save(update_fields=["revision"])


class Migration(migrations.Migration):
    dependencies = [("portal", "0004_form_status")]

    operations = [
        migrations.AddField(
            model_name="draft",
            name="revision",
            field=models.CharField(default="", max_length=16),
            preserve_default=False,
        ),
        migrations.RunPython(keep_current_drafts, migrations.RunPython.noop),
        # A default lets the removal be reversed while drafts exist.
        migrations.AlterField(
            model_name="draft",
            name="config_version",
            field=models.PositiveIntegerField(default=1),
        ),
        migrations.RemoveField(model_name="draft", name="config_version"),
        migrations.RemoveField(model_name="form", name="config_version"),
        migrations.RemoveField(model_name="formtemplate", name="config_version"),
    ]
