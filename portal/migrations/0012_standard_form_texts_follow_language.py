from django.db import migrations

# The standard title and description that new forms stored until now. An empty title
# or description shows the standard text in the app language instead; before this
# change it showed the German one, so going back needs no change.
STORED_TITLE = "Deine Auslagen. Einfach eingereicht."
STORED_DESCRIPTION = (
    "Reiche deine privat ausgelegten Kosten zur Erstattung ein. Deine Angaben, Belege und "
    "Unterschrift werden als PDF an die Buchhaltung gesendet."
)


def follow_language(apps, schema_editor):
    Form = apps.get_model("portal", "Form")
    Form.objects.filter(title=STORED_TITLE).update(title="")
    Form.objects.filter(description=STORED_DESCRIPTION).update(description="")


class Migration(migrations.Migration):
    dependencies = [("portal", "0011_general_settings_and_english_admin")]

    operations = [migrations.RunPython(follow_language, migrations.RunPython.noop)]
