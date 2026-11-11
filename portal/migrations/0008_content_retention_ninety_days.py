from datetime import timedelta

from django.db import migrations
from django.db.models import F

OLD = "Alle übrigen Angaben, Belege und deine Unterschrift löschen wir 30 Tage nach dem Einreichen."
NEW = "Alle übrigen Angaben, Belege und deine Unterschrift löschen wir 90 Tage nach dem Einreichen."
# Fixed here: a later change of CONTENT_RETENTION_DAYS must not change this migration.
CONTENT_PERIOD = timedelta(days=90)


def publish(apps, schema_editor):
    """Publish a notice version that states the 90-day content period.

    Only a current notice that still contains the original 30-day sentence is
    replaced. A rewritten notice is left alone; a template admin updates it.
    """
    PrivacyNotice = apps.get_model("portal", "PrivacyNotice")
    current = PrivacyNotice.objects.order_by("-version").first()
    if current is None or OLD not in current.text:
        return
    PrivacyNotice.objects.create(
        version=current.version + 1, text=current.text.replace(OLD, NEW), created_by="migration"
    )


def extend(apps, schema_editor):
    """Keep existing claims for 90 days after submission, as new claims are."""
    Claim = apps.get_model("portal", "Claim")
    claims = Claim.objects.exclude(state__in=["purging", "purged"])
    deadline = F("submitted_at") + CONTENT_PERIOD
    claims.filter(retention_due__lt=deadline).update(retention_due=deadline)
    claims.filter(resolution_due__lt=deadline).update(resolution_due=deadline)


class Migration(migrations.Migration):
    dependencies = [("portal", "0007_form_copy_and_confirmation")]

    operations = [
        migrations.RunPython(publish, migrations.RunPython.noop),
        migrations.RunPython(extend, migrations.RunPython.noop),
    ]
