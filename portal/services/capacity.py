"""Disk reservation shared by web processes and document workers.

Invariant: free private storage covers the configured floor, spool headroom for
in-flight requests, every pending upload's reserved output and every workspace
reservation. A reservation moves through admit (upload intake), transfer (into
an execution workspace), release (outcome recorded) and recover (after a crash).

Lock order is Draft, then network budget, then capacity. `admit_upload` takes
them in that order itself. No worker takes a Draft lock while holding a Job lock,
including the release and recovery paths.
"""

import contextlib
import fcntl
import shutil
from datetime import timedelta
from pathlib import Path

from django.conf import settings
from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from portal.models import CapacityLock, Draft, Upload, WorkspaceReservation
from portal.services import network_budget, queue
from portal.services.storage import new_workspace_key, path_for, workspace_root


class CapacityError(Exception):
    pass


class SystemDisk:
    def free(self, path):
        return shutil.disk_usage(path).free

    def shared(self, path, root):
        """Whether `path` is (or will be created) on the filesystem of `root`."""
        path, root = Path(path), Path(root)
        return not path.exists() or path.stat().st_dev == root.stat().st_dev


# The disk measurement seam. Tests replace it with a fixed-size fake.
disk = SystemDisk()


def storage_available():
    return disk.free(settings.PRIVATE_STORAGE_ROOT) >= settings.MIN_FREE_STORAGE_BYTES


def _total(query, field):
    return query.aggregate(value=Sum(field))["value"] or 0


def _lock():
    if not transaction.get_connection().in_atomic_block:
        raise RuntimeError("Capacity admission requires a transaction")
    CapacityLock.objects.select_for_update().get_or_create(pk=1)


def _workspace_shares_storage():
    return disk.shared(workspace_root(), settings.PRIVATE_STORAGE_ROOT)


def _check(additional):
    """Caller holds an atomic transaction; the lock lasts through publication."""
    _lock()
    reservations = WorkspaceReservation.objects.all()
    reserved = _total(Upload.objects.all(), "reserved_bytes") + _total(reservations, "output_bytes")
    if _workspace_shares_storage():
        reserved += _total(reservations, "size")
    free = disk.free(settings.PRIVATE_STORAGE_ROOT)
    if free < (
        settings.MIN_FREE_STORAGE_BYTES
        + settings.UPLOAD_TEMP_HEADROOM_BYTES
        + reserved
        + additional
    ):
        raise CapacityError("storage_capacity")


def admit_upload(network, draft, size):
    """Charge an upload to its draft and client network, and reserve its normalized output.

    Returns the bytes to record as the new upload's `reserved_bytes`.
    """
    draft = Draft.objects.select_for_update().get(pk=draft.pk)
    if (
        draft.upload_count >= settings.MAX_UPLOADS_PER_DRAFT
        or draft.upload_bytes + size > settings.MAX_UPLOAD_BYTES_PER_DRAFT
    ):
        raise CapacityError("draft_work_limit")
    # The caller's transaction refunds this charge if a later check fails.
    if not network_budget.charge_upload(network, size):
        raise CapacityError("network_work_limit")
    reservation = settings.MAX_NORMALIZED_FILE_BYTES
    _check(size + reservation)
    derived = (
        _total(draft.uploads.all(), "normalized_size")
        + _total(draft.uploads.all(), "reserved_bytes")
        + _total(WorkspaceReservation.objects.filter(upload__draft=draft), "size")
    )
    if derived + reservation > settings.MAX_DRAFT_DERIVED_BYTES:
        raise CapacityError("draft_storage_limit")
    if queue.validation_backlog() >= settings.MAX_PENDING_VALIDATIONS:
        raise CapacityError("validation_backlog")
    draft.upload_count += 1
    draft.upload_bytes += size
    draft.save(update_fields=["upload_count", "upload_bytes"])
    return reservation


def release_upload(upload_id):
    """The upload's outcome is recorded; it no longer owes normalized output."""
    Upload.objects.filter(pk=upload_id).update(reserved_bytes=0)


@contextlib.contextmanager
def workspace_lock(directory, *, exclusive=False):
    """Shared by an execution and its child; exclusive only for crash recovery."""
    directory = Path(directory)
    locks = directory.parent / ".locks"
    locks.mkdir(exist_ok=True, mode=0o700)
    # Outside the parser's writable subtree, so it cannot unlink/replace the lock.
    lock_path = locks / directory.name
    with lock_path.open("a+b") as handle:
        operation = fcntl.LOCK_EX | fcntl.LOCK_NB if exclusive else fcntl.LOCK_SH
        fcntl.flock(handle, operation)
        yield handle


@contextlib.contextmanager
def temporary_workspace(*, upload=None, claim=None):
    """A private execution directory whose disk is reserved until it is removed.

    An upload's pending output reservation transfers into the workspace reservation.
    """
    root = workspace_root()
    root.mkdir(exist_ok=True, mode=0o700)
    key = new_workspace_key()
    directory = path_for(key)
    size = settings.MAX_NORMALIZED_FILE_BYTES if upload else settings.MAX_RENDER_WORKSPACE_BYTES
    output_size = settings.MAX_NORMALIZED_FILE_BYTES if upload else settings.MAX_FINAL_PDF_BYTES
    persistent_size = output_size + (size if _workspace_shares_storage() else 0)
    reservation = None
    with workspace_lock(directory):
        try:
            with transaction.atomic():
                _check(0)
                current = Upload.objects.select_for_update().get(pk=upload.pk) if upload else None
                _check(max(0, persistent_size - (current.reserved_bytes if current else 0)))
                if disk.free(root) < _total(WorkspaceReservation.objects.all(), "size") + size:
                    raise CapacityError("workspace_capacity")
                reservation = WorkspaceReservation.objects.create(
                    directory=key, size=size, output_bytes=output_size, upload=upload, claim=claim
                )
                if current:
                    current.reserved_bytes = 0
                    current.save(update_fields=["reserved_bytes"])
                directory.mkdir(mode=0o700)
            yield str(directory)
        finally:
            if directory.exists():
                shutil.rmtree(directory)
            if reservation:
                reservation.delete()
            (root / ".locks" / directory.name).unlink(missing_ok=True)


def recover_abandoned_workspaces():
    """Release workspaces whose execution died, once no process holds their lock."""
    cutoff = timezone.now() - timedelta(seconds=settings.JOB_LEASE_SECONDS)
    for reservation in WorkspaceReservation.objects.filter(created_at__lt=cutoff):
        _remove_abandoned_workspace(reservation)


def _remove_abandoned_workspace(reservation):
    directory = path_for(reservation.directory)
    directory.parent.mkdir(exist_ok=True, mode=0o700)
    try:
        with workspace_lock(directory, exclusive=True):
            if directory.exists():
                shutil.rmtree(directory)
            with transaction.atomic():
                _lock()
                if reservation.upload_id:
                    current = Upload.objects.select_for_update().get(pk=reservation.upload_id)
                    if (
                        current.state == Upload.State.PENDING
                        and not WorkspaceReservation.objects.filter(upload=current)
                        .exclude(pk=reservation.pk)
                        .exists()
                    ):
                        # A crashed validator still owes its admitted output capacity.
                        current.reserved_bytes = max(
                            current.reserved_bytes, reservation.output_bytes
                        )
                        current.save(update_fields=["reserved_bytes"])
                reservation.delete()
            (directory.parent / ".locks" / directory.name).unlink(missing_ok=True)
        return True
    except BlockingIOError:
        # An expired job lease does not prove that its parser has stopped.
        return False
