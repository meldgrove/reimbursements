"""Protected operational checks with no provider calls or participant content."""

import os
import re
from pathlib import Path

from django.conf import settings
from django.db.models import Q
from django.utils import timezone

from portal.models import Job
from portal.services.documents import sandbox_ready
from portal.services.queue import PENDING, RUNNING
from portal.services.scanner import scanner_ready
from portal.services.storage import heartbeat_age, workspace_root


def bounded_workspace():
    root = workspace_root().resolve()
    if not root.is_dir():
        return False
    try:
        mounts = []
        for line in Path("/proc/self/mountinfo").read_text().splitlines():
            fields, filesystem = line.split(" - ", 1)
            mount = Path(
                re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), fields.split()[4])
            )
            if root.is_relative_to(mount):
                mounts.append((len(mount.parts), filesystem.split()[0]))
        filesystem = os.statvfs(root)
        return (
            max(mounts)[1] == "tmpfs"
            and root.stat().st_dev != settings.PRIVATE_STORAGE_ROOT.stat().st_dev
            and root.stat().st_mode & 0o077 == 0
            and root.stat().st_uid == os.getuid()
            and filesystem.f_blocks * filesystem.f_frsize <= 750_000_000
        )
    except (OSError, ValueError):
        return False


def queue_age_seconds():
    now = timezone.now()
    oldest = (
        Job.objects.filter(Q(state=PENDING, run_after__lte=now) | Q(state=RUNNING))
        .order_by("run_after")
        .values_list("run_after", flat=True)
        .first()
    )
    # A retry starts waiting when its backoff ends, regardless of original creation.
    return max(0, int((now - oldest).total_seconds())) if oldest else 0


def dependencies():
    result = {"sandbox": sandbox_ready(), "scanner": scanner_ready()}
    if not settings.DEBUG:
        result["workspace"] = bounded_workspace()
    if settings.REQUIRE_WORKER_HEARTBEAT:
        age = heartbeat_age()
        result["worker"] = age is not None and 0 <= age < settings.JOB_LEASE_SECONDS + 60
    age = queue_age_seconds()
    result["queue"] = age <= settings.MAX_JOB_AGE_SECONDS
    return result, age
