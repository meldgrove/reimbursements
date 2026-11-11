from decimal import Decimal

from django.db import migrations

from portal.constants import DECLARATION, DECLARATION_VERSION
from portal.privacy_notice import DEFAULT_PRIVACY_NOTICE


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
