from django.db import migrations
from django.utils import timezone


def delete_purged(apps, schema_editor):
    """Delete the empty records that content purge used to keep for 30 days.

    Their content is already gone. Logged operations lose the link to the claim. Drafts
    are released and expired, so the next cleanup removes them.
    """
    Claim = apps.get_model("portal", "Claim")
    Draft = apps.get_model("portal", "Draft")
    Draft.objects.filter(claim__state="purged").update(expires_at=timezone.now())
    Claim.objects.filter(state="purged").delete()


class Migration(migrations.Migration):
    # The schema change of the next migration must not share this transaction:
    # PostgreSQL refuses to alter a table with pending foreign key checks.
    dependencies = [("portal", "0008_content_retention_ninety_days")]

    operations = [migrations.RunPython(delete_purged, migrations.RunPython.noop)]
