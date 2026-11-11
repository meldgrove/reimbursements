import contextlib
import json
import os
import signal
import subprocess
import sys
import time
import uuid
from datetime import timedelta

import pytest
from django.utils import timezone

from portal.jobs import run_one
from portal.models import Claim, Job, Upload, WorkspaceReservation
from portal.services.capacity import CapacityError, temporary_workspace
from portal.services.retention import orphan_cleanup
from portal.services.storage import path_for

pytestmark = pytest.mark.django_db


def separate_filesystems(settings, fake_disk):
    settings.MIN_FREE_STORAGE_BYTES = 1_000_000_000
    fake_disk(
        settings.MIN_FREE_STORAGE_BYTES
        + settings.UPLOAD_TEMP_HEADROOM_BYTES
        + 2 * settings.MAX_FINAL_PDF_BYTES,
        workspace_free=700_000_000,
    )


def test_render_needs_only_final_output_capacity_on_persistent_storage(
    accepted, settings, fake_disk
):
    separate_filesystems(settings, fake_disk)
    assert run_one()
    accepted.refresh_from_db()
    assert accepted.state == Claim.State.READY
    assert Job.objects.get(kind="render").state == "done"
    assert not WorkspaceReservation.objects.exists()


def test_shared_filesystem_still_reserves_workspace_above_storage_floor(
    accepted, settings, fake_disk
):
    settings.MIN_FREE_STORAGE_BYTES = 1_000_000_000
    fake_disk(1_100_000_000)
    with pytest.raises(CapacityError, match="storage_capacity"):
        with temporary_workspace(claim=accepted):
            pytest.fail("A shared filesystem must reserve workspace and final output")
    assert not WorkspaceReservation.objects.exists()


def test_separate_tmpfs_still_rejects_overlapping_render_workspaces(accepted, settings, fake_disk):
    separate_filesystems(settings, fake_disk)
    with temporary_workspace(claim=accepted):
        with pytest.raises(CapacityError, match="workspace_capacity"):
            with temporary_workspace(claim=accepted):
                pytest.fail("A second 600 MB execution must not fit in 700 MB")
    with temporary_workspace(claim=accepted):
        pass
    assert not WorkspaceReservation.objects.exists()


@pytest.mark.parametrize("age_seconds", [421, 25 * 3600])
def test_recovery_preserves_live_execution_then_releases_crashed_owner(
    accepted, settings, fake_disk, age_seconds
):
    separate_filesystems(settings, fake_disk)
    key = f"work/job-{uuid.uuid4()}"
    directory = path_for(key)
    directory.mkdir(parents=True, mode=0o700)
    (directory / "partial.pdf").write_bytes(b"synthetic partial output")
    lock = directory.parent / ".locks" / directory.name
    lock.parent.mkdir(mode=0o700)
    reservation = WorkspaceReservation.objects.create(
        directory=key,
        size=settings.MAX_RENDER_WORKSPACE_BYTES,
        claim=accepted,
        created_at=timezone.now() - timedelta(seconds=age_seconds),
        output_bytes=settings.MAX_FINAL_PDF_BYTES,
    )
    reservation_id = reservation.pk
    # An execution, including an orphaned parser, holds the external shared lock.
    process = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import fcntl,sys; lock=open(sys.argv[1],'a+b'); "
            "fcntl.flock(lock,fcntl.LOCK_SH); print('locked',flush=True); sys.stdin.read()",
            str(lock),
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert process.stdout.readline().strip() == "locked"
        orphan_cleanup()
        assert WorkspaceReservation.objects.filter(pk=reservation_id).exists()
        assert (directory / "partial.pdf").exists()
        process.kill()
        process.communicate(timeout=5)
        orphan_cleanup()
        assert not WorkspaceReservation.objects.filter(pk=reservation_id).exists()
        assert not directory.exists()
        with temporary_workspace(claim=accepted):
            pass
    finally:
        if process.poll() is None:
            process.kill()
        process.communicate(timeout=5)


def test_restart_recovers_missing_tmpfs_workspace_before_next_render(accepted, settings, fake_disk):
    separate_filesystems(settings, fake_disk)
    reservation = WorkspaceReservation.objects.create(
        directory=f"work/job-{uuid.uuid4()}",
        size=settings.MAX_RENDER_WORKSPACE_BYTES,
        claim=accepted,
        created_at=timezone.now() - timedelta(seconds=421),
        output_bytes=settings.MAX_FINAL_PDF_BYTES,
    )
    reservation_id = reservation.pk
    orphan_cleanup()
    assert not WorkspaceReservation.objects.filter(pk=reservation_id).exists()
    assert run_one()
    accepted.refresh_from_db()
    assert accepted.state == Claim.State.READY


def test_crashed_validation_restores_pending_output_reservation(prepared, settings):
    item = prepared["draft"].uploads.first()
    item.state = Upload.State.PENDING
    item.save(update_fields=["state"])
    reservation = WorkspaceReservation.objects.create(
        directory=f"work/job-{uuid.uuid4()}",
        size=settings.MAX_NORMALIZED_FILE_BYTES,
        output_bytes=settings.MAX_NORMALIZED_FILE_BYTES,
        upload=item,
        created_at=timezone.now() - timedelta(seconds=421),
    )
    reservation_id = reservation.pk
    orphan_cleanup()
    item.refresh_from_db()
    assert item.reserved_bytes == settings.MAX_NORMALIZED_FILE_BYTES
    assert not WorkspaceReservation.objects.filter(pk=reservation_id).exists()


def test_parser_keeps_execution_lock_after_supervisor_crash(accepted, tmp_path, settings):
    key = f"work/job-{uuid.uuid4()}"
    directory = path_for(key)
    directory.mkdir(parents=True)
    reservation = WorkspaceReservation.objects.create(
        directory=key,
        size=settings.MAX_RENDER_WORKSPACE_BYTES,
        output_bytes=settings.MAX_FINAL_PDF_BYTES,
        claim=accepted,
        created_at=timezone.now() - timedelta(seconds=421),
    )
    reservation_id = reservation.pk
    coordinator = tmp_path / "child.json"
    source = tmp_path / "source.png"
    source.write_bytes(b"synthetic")
    code = """
import json,sys
from pathlib import Path
import django
django.setup()
import portal.services.documents as documents
spawn = documents.subprocess.Popen
def sleeping_parser(command, **options):
 process = spawn([sys.executable, '-c', 'import time; time.sleep(60)'], **options)
 Path(sys.argv[3]).write_text(json.dumps({'pid': process.pid}))
 return process
documents.subprocess.Popen = sleeping_parser
from portal.services.capacity import workspace_lock
with workspace_lock(Path(sys.argv[2])):
 documents.inspect_upload(sys.argv[1], sys.argv[2])
"""
    supervisor = subprocess.Popen(
        [sys.executable, "-c", code, str(source), str(directory), str(coordinator)],
        env=os.environ | {"DJANGO_SETTINGS_MODULE": "config.test_settings"},
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    child_pid = None
    try:
        deadline = time.monotonic() + 5
        while (
            not coordinator.exists() and supervisor.poll() is None and time.monotonic() < deadline
        ):
            time.sleep(0.01)
        assert coordinator.exists(), supervisor.communicate(timeout=5)
        child_pid = json.loads(coordinator.read_text())["pid"]
        supervisor.kill()
        supervisor.communicate(timeout=5)
        orphan_cleanup()
        assert WorkspaceReservation.objects.filter(pk=reservation_id).exists()
        assert directory.exists()
        os.killpg(child_pid, signal.SIGKILL)
        deadline = time.monotonic() + 5
        while (
            WorkspaceReservation.objects.filter(pk=reservation_id).exists()
            and time.monotonic() < deadline
        ):
            orphan_cleanup()
            time.sleep(0.01)
        assert not WorkspaceReservation.objects.filter(pk=reservation_id).exists()
    finally:
        if supervisor.poll() is None:
            supervisor.kill()
        supervisor.communicate(timeout=5)
        if child_pid:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(child_pid, signal.SIGKILL)
