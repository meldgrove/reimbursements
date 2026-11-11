"""Private file storage: artifact key layout, durable writes, integrity and orphan sweeps.

Callers name an artifact kind and its owner; only this module knows where it lives.
"""

import hashlib
import os
import shutil
import tempfile
import uuid
from pathlib import Path

from django.conf import settings
from django.utils import timezone

HEARTBEAT_KEY = "worker-heartbeat"


def upload_source_key(upload_id, extension):
    return f"uploads/{upload_id}/source{extension}"


def normalized_upload_key(upload_id, suffix):
    # Every execution gets an immutable key. A stale lease cannot replace or
    # delete the output published by another validation execution.
    return f"uploads/{upload_id}/{uuid.uuid4()}{suffix}"


def claim_pdf_key(claim_id, lease_token):
    # The lease-specific immutable key prevents an old renderer replacing a newer PDF.
    return f"pdf/{claim_id}/{lease_token}.pdf"


def outbox_key(attempt_id):
    return f"outbox/{attempt_id}.eml"


def new_workspace_key():
    return f"work/job-{uuid.uuid4()}"


def workspace_root():
    return settings.PRIVATE_STORAGE_ROOT / "work"


def path_for(key):
    root = settings.PRIVATE_STORAGE_ROOT.resolve()
    target = (root / key).resolve()
    if not key or not target.is_relative_to(root) or target == root:
        raise ValueError("Invalid private storage key")
    return target


def save_upload(file, key, limit):
    target = path_for(key)
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    size, checksum = 0, hashlib.sha256()
    handle, temporary = tempfile.mkstemp(dir=target.parent, prefix="incoming-")
    try:
        with os.fdopen(handle, "wb") as output:
            for chunk in file.chunks():
                size += len(chunk)
                if size > limit:
                    raise ValueError("file_too_large")
                output.write(chunk)
                checksum.update(chunk)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, target)
        sync_directory(target.parent)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return size, checksum.hexdigest()


class _Chunks:
    def __init__(self, read):
        self.read = read

    def chunks(self):
        yield from self.read()


def publish_file(source, key, limit):
    """Copy bounded sandbox output across filesystems, then atomically publish."""

    def read():
        with open(source, "rb") as input_file:
            while chunk := input_file.read(64 * 1024):
                yield chunk

    return save_upload(_Chunks(read), key, limit)


def write_bytes(key, content):
    """Durably and atomically store a small private artifact."""
    return save_upload(_Chunks(lambda: iter([content])), key, len(content))


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def remove_keys(*keys):
    for key in set(filter(None, keys)):
        path_for(key).unlink(missing_ok=True)


def verify(key, *, size, checksum=None):
    """True when the stored artifact has the recorded size and, if given, SHA-256."""
    path = path_for(key)
    if not path.is_file() or path.stat().st_size != size:
        return False
    if checksum is None:
        return True
    with path.open("rb") as stored:
        return hashlib.file_digest(stored, "sha256").hexdigest() == checksum


def check_writable():
    probe = path_for(f"checks/{uuid.uuid4()}")
    probe.parent.mkdir(exist_ok=True, mode=0o700)
    probe.write_bytes(b"ready")
    probe.unlink()


def write_heartbeat():
    path_for(HEARTBEAT_KEY).write_text(timezone.now().isoformat())


def heartbeat_age():
    """Seconds since the worker's last heartbeat, or None when it never wrote one."""
    try:
        return timezone.now().timestamp() - path_for(HEARTBEAT_KEY).stat().st_mtime
    except OSError:
        return None


def sweep_orphans(older_than, owners):
    """Remove stored artifacts older than the cutoff that no database record owns.

    `owners` answers ownership per artifact kind:
    - `upload_keys(upload_id)`: keys the upload retains, or None if it no longer exists.
    - `workspace_reserved(key)`: whether a workspace directory still has a reservation.
    - `pdf_referenced(key)`: whether a claim still references the PDF.
    """
    cutoff = older_than.timestamp()
    root = settings.PRIVATE_STORAGE_ROOT

    def key(path):
        return str(path.relative_to(root))

    for directory in (root / "uploads").glob("*"):
        if not directory.is_dir() or directory.stat().st_mtime >= cutoff:
            continue
        try:
            upload_id = uuid.UUID(directory.name)
        except ValueError:
            continue
        retained = owners.upload_keys(upload_id)
        if retained is None:
            shutil.rmtree(directory)
            continue
        for file in directory.iterdir():
            if file.is_file() and file.stat().st_mtime < cutoff and key(file) not in retained:
                file.unlink()
    for directory in workspace_root().glob("job-*"):
        if (
            directory.is_dir()
            and directory.stat().st_mtime < cutoff
            and not owners.workspace_reserved(key(directory))
        ):
            shutil.rmtree(directory)
    for file in (root / "pdf").glob("*/*.pdf"):
        if file.stat().st_mtime < cutoff and not owners.pdf_referenced(key(file)):
            file.unlink()
    for file in (root / "incoming").glob("*"):
        if file.is_file() and file.stat().st_mtime < cutoff:
            file.unlink()
