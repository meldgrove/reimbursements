from django.db import migrations, models


def publish_active_forms(apps, schema_editor):
    Form = apps.get_model("portal", "Form")
    Form.objects.using(schema_editor.connection.alias).filter(active=True).update(
        status="published"
    )


def restore_active_forms(apps, schema_editor):
    Form = apps.get_model("portal", "Form")
    Form.objects.using(schema_editor.connection.alias).filter(status="published").update(
        active=True
    )


class Migration(migrations.Migration):
    dependencies = [("portal", "0003_form_primary")]

    operations = [
        migrations.AddField(
            model_name="form",
            name="creation_key",
            field=models.UUIDField(editable=False, null=True, unique=True),
        ),
        migrations.AddField(
            model_name="form",
            name="status",
            field=models.CharField(
                choices=[("draft", "Entwurf"), ("published", "Veröffentlicht")],
                default="draft",
                max_length=12,
                verbose_name="Status",
            ),
        ),
        migrations.RunPython(publish_active_forms, restore_active_forms),
        migrations.RemoveField(model_name="form", name="active"),
    ]
