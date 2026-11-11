"""Verify a synthetic capacity backup, then exercise deletion in its restored copy."""

import io
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

import django

django.setup()

from django.conf import settings  # noqa: E402
from django.core.management import call_command  # noqa: E402
from django.utils import timezone  # noqa: E402

from portal.models import Claim, Form, Job  # noqa: E402
from portal.services.retention import cleanup  # noqa: E402

if (
    not settings.DEBUG
    or settings.MAIL_DELIVERY_MODE != "local"
    or settings.DATABASES["default"]["NAME"] != "capacity_restore"
    or Form.objects.exclude(slug="demo").exists()
    or Claim.objects.exclude(
        full_name="Synthetic Participant",
        iban="DE89370400440532013000",
        email="capacity@example.invalid",
    ).exists()
    or Job.objects.filter(state__in=["pending", "running"]).exists()
):
    raise SystemExit("Restore probe requires a stopped, synthetic capacity database copy.")

before = io.StringIO()
call_command("verify_storage", stdout=before)
count = Claim.objects.count()
if not count:
    raise SystemExit("The restored dataset is empty")
Claim.objects.update(retention_due=timezone.now())
result = cleanup(execute=True)
if result["failures"] or Claim.objects.exists():
    raise SystemExit("Restored deletion failed")
after = io.StringIO()
call_command("verify_storage", stdout=after)
report = {
    "restored_claims": count,
    "before_purge": json.loads(before.getvalue()),
    "purged_claims": count - Claim.objects.count(),
    "after_purge": json.loads(after.getvalue()),
}
print(json.dumps(report))
