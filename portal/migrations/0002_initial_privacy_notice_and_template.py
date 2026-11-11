from decimal import Decimal

from django.db import migrations

from portal.privacy_notice import DEFAULT_PRIVACY_NOTICE

# The declaration as it was when this migration was written; the app's default now
# follows the app language.
DECLARATION = (
    "Hiermit bestätige ich, dass die angegebenen Auslagen tatsächlich entstanden sind, "
    "dem genannten Zweck dienen und bisher nicht erstattet wurden."
)
DECLARATION_VERSION = "reimbursement-v1"


def seed(apps, schema_editor):
    PrivacyNotice = apps.get_model("portal", "PrivacyNotice")
    FormTemplate = apps.get_model("portal", "FormTemplate")
    TemplateField = apps.get_model("portal", "TemplateField")
    if not PrivacyNotice.objects.exists():
        PrivacyNotice.objects.create(version=1, text=DEFAULT_PRIVACY_NOTICE, created_by="initial")
    if FormTemplate.objects.exists():
        return
    template = FormTemplate.objects.create(
        name="Externe Erstattung",
        description="Auslagen externer Teilnehmender, z. B. für eine Werkstatt.",
        declaration=DECLARATION,
        declaration_version=DECLARATION_VERSION,
        travel="optional",
        mileage_enabled=True,
        mileage_rate=Decimal("0.30"),
    )
    for position, (key, label, required) in enumerate(
        [
            ("kst", "Kostenstelle (KST)", True),
            ("ktr", "Kostenträger (KTR)", False),
            ("id", "ID", False),
        ]
    ):
        TemplateField.objects.create(
            template=template, key=key, label=label, required=required, position=position
        )


class Migration(migrations.Migration):
    dependencies = [("portal", "0001_initial")]

    operations = [migrations.RunPython(seed, migrations.RunPython.noop)]
