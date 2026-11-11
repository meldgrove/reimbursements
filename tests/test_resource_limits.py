import io
import json
import subprocess
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import close_old_connections, connection, connections
from django.test import Client
from django.utils import timezone
from PIL import Image
from pypdf import PdfWriter

from portal.document_sandbox import supported
from portal.file_worker import DocumentError, validate_file
from portal.job_kinds import VALIDATE
from portal.jobs import Lease, acquire_job, reclaim_stale_jobs, run_one
from portal.models import (
    CapacityLock,
    Delivery,
    Draft,
    DraftAdmission,
    Job,
    Upload,
    WorkspaceReservation,
)
from portal.services.capacity import temporary_workspace
from portal.services.retention import cleanup
from portal.services.storage import path_for
from tests.conftest import image_bytes

pytestmark = pytest.mark.django_db


def token(prepared):
    return {"X-Draft-Token": prepared["data"]["token"]}


def upload_file(prepared, *, kind="receipt", content=None, name="receipt.png"):
    return prepared["client"].post(
        "/f/test/uploads/",
        {
            "draft_id": str(prepared["draft"].pk),
            "token": prepared["data"]["token"],
            "expense_id": prepared["data"]["expenses"][0]["id"] if kind == "receipt" else "",
            "kind": kind,
            "file": SimpleUploadedFile(name, content or image_bytes(signature=kind == "signature")),
        },
    )


@pytest.mark.parametrize("kind", ["receipt", "signature"])
def test_replacement_does_not_refund_processing_budget(prepared, settings, kind):
    settings.MAX_UPLOADS_PER_DRAFT = 2
    for _ in range(2):
        response = upload_file(prepared, kind=kind)
        assert response.status_code == 202
        assert run_one()
        assert (
            prepared["client"]
            .delete(response.json()["delete_url"], headers=token(prepared))
            .status_code
            == 200
        )
    assert upload_file(prepared, kind=kind).status_code == 429
    prepared["draft"].refresh_from_db()
    assert prepared["draft"].upload_count == 2
    assert DraftAdmission.objects.get().upload_count == 2
    assert not WorkspaceReservation.objects.exists()


def test_failed_validation_also_consumes_work_budget(prepared, settings):
    settings.MAX_UPLOADS_PER_DRAFT = 1
    response = upload_file(prepared, content=b"invalid image")
    assert run_one()
    item = Upload.objects.get(pk=response.json()["id"])
    assert item.state == "failed" and item.reserved_bytes == 0
    assert (
        prepared["client"]
        .delete(response.json()["delete_url"], headers=token(prepared))
        .status_code
        == 200
    )
    assert upload_file(prepared).status_code == 429


def test_network_upload_budget_survives_new_cookies_and_rolls_over(prepared, settings):
    settings.MAX_UPLOADS_PER_NETWORK = 1
    assert upload_file(prepared).status_code == 202
    other = Client()
    assert other.get("/f/test/").status_code == 200
    binding = other.session["draft:test"]
    other_prepared = {
        **prepared,
        "client": other,
        "draft": Draft.objects.get(pk=binding["id"]),
        "data": {**prepared["data"], "token": binding["token"]},
    }
    assert upload_file(other_prepared).status_code == 429
    DraftAdmission.objects.update(window_start=timezone.now() - timedelta(hours=25))
    assert upload_file(other_prepared).status_code == 202
    assert DraftAdmission.objects.get().upload_count == 1


def test_accepted_jobs_are_not_overtaken_by_replenished_validation(accepted):
    Job.objects.all().delete()
    due = timezone.now() - timedelta(seconds=1)
    render = Job.objects.create(key="accepted-render", kind="render", claim=accepted, run_after=due)
    delivery = Delivery.objects.create(claim=accepted, recipient="finance@example.invalid")
    send = Job.objects.create(key="accepted-send", kind="send", delivery=delivery, run_after=due)
    for expected in [render, send]:
        for _ in range(10):
            Job.objects.create(
                key=str(uuid.uuid4()), kind="validate", upload=accepted.uploads.first()
            )
        current = acquire_job()
        assert current.pk == expected.pk
        Lease(current).finish()


def test_backlog_is_checked_before_source_publication(prepared, settings):
    settings.MAX_PENDING_VALIDATIONS = 1
    first = upload_file(prepared)
    assert first.status_code == 202
    before = set(settings.PRIVATE_STORAGE_ROOT.rglob("source*"))
    assert upload_file(prepared).status_code == 503
    assert set(settings.PRIVATE_STORAGE_ROOT.rglob("source*")) == before


def test_normalized_bytes_are_measured_and_reserved_before_conversion(prepared):
    image = Image.new("RGB", (1000, 1000))
    image.putdata(
        [(255, 255, 255) if (x + y) % 2 else (0, 0, 0) for y in range(1000) for x in range(1000)]
    )
    content = io.BytesIO()
    image.save(content, "PNG")
    response = upload_file(prepared, content=content.getvalue())
    item = Upload.objects.get(pk=response.json()["id"])
    assert item.reserved_bytes == 10_000_000
    assert run_one()
    item.refresh_from_db()
    assert item.state == "ready", item.error_code
    assert item.normalized_size == path_for(item.normalized_key).stat().st_size
    assert item.normalized_size > item.size * 10
    assert item.reserved_bytes == 0 and not WorkspaceReservation.objects.exists()


def test_image_dimensions_and_serialized_output_are_bounded(tmp_path, monkeypatch):
    source = tmp_path / "wide.png"
    source.write_bytes(image_bytes(size=(4000, 1200)))
    result = validate_file(source, tmp_path / "output", "receipt")
    with Image.open(result["normalized"]) as normalized:
        assert max(normalized.size) <= 3508
    monkeypatch.setattr("portal.file_worker.MAX_NORMALIZED_FILE_BYTES", 100)
    with pytest.raises(DocumentError, match="normalized_size_limit"):
        validate_file(source, tmp_path / "limited", "receipt")
    assert not (tmp_path / "limited" / "normalized.jpg").exists()


def test_workspace_transfer_retains_capacity_until_cleanup(prepared, settings):
    response = upload_file(prepared)
    item = Upload.objects.get(pk=response.json()["id"])
    with temporary_workspace(upload=item) as directory:
        item.refresh_from_db()
        assert item.reserved_bytes == 0
        assert (
            WorkspaceReservation.objects.get(upload=item).size == settings.MAX_NORMALIZED_FILE_BYTES
        )
        assert (
            prepared["client"]
            .delete(response.json()["delete_url"], headers=token(prepared))
            .status_code
            == 409
        )
        assert Path(directory).is_dir()
    assert not WorkspaceReservation.objects.exists()


def test_workspace_cleanup_failure_keeps_reservation(prepared, monkeypatch):
    response = upload_file(prepared)
    item = Upload.objects.get(pk=response.json()["id"])
    with monkeypatch.context() as patch:
        patch.setattr(
            "portal.services.capacity.shutil.rmtree",
            lambda path: (_ for _ in ()).throw(OSError("synthetic")),
        )
        with pytest.raises(OSError):
            with temporary_workspace(upload=item):
                pass
    assert WorkspaceReservation.objects.filter(upload=item).exists()
    WorkspaceReservation.objects.update(created_at=timezone.now() - timedelta(hours=25))
    cleanup(execute=True)
    assert not WorkspaceReservation.objects.exists()


def test_expired_or_failed_uploads_release_pending_capacity(prepared):
    response = upload_file(prepared)
    item = Upload.objects.get(pk=response.json()["id"])
    job = Job.objects.get(upload=item)
    job.state, job.lease_until, job.attempts = "running", timezone.now() - timedelta(seconds=1), 5
    job.save()
    reclaim_stale_jobs()
    item.refresh_from_db()
    assert item.reserved_bytes == 0
    Draft.objects.filter(pk=prepared["draft"].pk).update(
        expires_at=timezone.now() - timedelta(seconds=1)
    )
    cleanup(execute=True)
    assert not Upload.objects.exists()


def test_stale_pdf_validator_does_not_delete_its_source(prepared, monkeypatch):
    writer, output = PdfWriter(), io.BytesIO()
    writer.add_blank_page(595, 842)
    writer.write(output)
    response = upload_file(prepared, content=output.getvalue(), name="source.pdf")
    item = Upload.objects.get(pk=response.json()["id"])
    old = acquire_job()
    from portal.services.documents import inspect_upload

    def expire_after_processing(*args, **kwargs):
        result = inspect_upload(*args, **kwargs)
        Job.objects.filter(pk=old.pk).update(lease_token=uuid.uuid4())
        return result

    monkeypatch.setattr("portal.services.documents.inspect_upload", expire_after_processing)
    VALIDATE.run(old, Lease(old))
    assert path_for(item.source_key).is_file()
    assert not WorkspaceReservation.objects.exists()


def test_validation_reservation_survives_until_metadata_publication(prepared, monkeypatch):
    response = upload_file(prepared)
    item = Upload.objects.get(pk=response.json()["id"])
    current = acquire_job()
    observed = []

    def finish_with_reservation(lease, *args, **kwargs):
        item.refresh_from_db()
        observed.append(WorkspaceReservation.objects.filter(upload=item).exists())
        assert item.state == "ready" and item.normalized_size > 0
        finish(lease, *args, **kwargs)

    finish = Lease.finish
    monkeypatch.setattr(Lease, "finish", finish_with_reservation)
    VALIDATE.run(current, Lease(current))
    assert observed == [True]
    assert not WorkspaceReservation.objects.exists()


@pytest.mark.django_db(transaction=True)
def test_competing_drafts_cannot_reserve_the_same_last_space(form, settings, fake_disk):
    if connection.vendor != "postgresql":
        pytest.skip("Concurrent row locking requires PostgreSQL")
    CapacityLock.objects.get_or_create(pk=1)
    clients = [Client(), Client()]
    for client in clients:
        assert client.get("/f/test/").status_code == 200
    content = image_bytes()
    free = (
        settings.UPLOAD_TEMP_HEADROOM_BYTES + settings.MAX_NORMALIZED_FILE_BYTES + len(content) * 2
    )
    fake_disk(free)

    def submit(client):
        close_old_connections()
        try:
            binding = client.session["draft:test"]
            return client.post(
                "/f/test/uploads/",
                {
                    "draft_id": binding["id"],
                    "token": binding["token"],
                    "kind": "receipt",
                    "expense_id": str(uuid.uuid4()),
                    "file": SimpleUploadedFile("receipt.png", content),
                },
            ).status_code
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as executor:
        assert sorted(executor.map(submit, clients)) == [202, 503]
    assert Upload.objects.count() == 1
    assert DraftAdmission.objects.get().upload_count == 1


def test_parser_has_no_unrelated_files_network_or_process_authority(tmp_path):
    assert supported(), "The supported Docker test runtime must provide Landlock and libseccomp"
    workspace = tmp_path / "workspace"
    workspace.mkdir(mode=0o700)
    allowed = tmp_path / "allowed.txt"
    allowed.write_text("synthetic receipt")
    private = tmp_path / "unrelated.env"
    private.write_text("synthetic private value")
    code = """
import ctypes, fcntl, json, os, resource, signal, socket, struct
from pathlib import Path
from portal.document_sandbox import install, libraries
workspace, allowed, private = map(Path, __import__('sys').argv[1:])
parent = os.getppid()
parent_pidfd = os.pidfd_open(parent)
limits = resource.prlimit(parent, resource.RLIMIT_NOFILE)
priority = os.getpriority(os.PRIO_PROCESS, parent)
affinity = os.sched_getaffinity(parent)
policy, parameter = os.sched_getscheduler(parent), os.sched_getparam(parent)
libc, seccomp = libraries()
queue_number = seccomp.seccomp_syscall_resolve_name(b'rt_tgsigqueueinfo')
info = ctypes.create_string_buffer(128)
struct.pack_into('iii', info, 0, 0, 0, -1)
struct.pack_into('ii', info, 16, os.getpid(), os.getuid())
execution_lock = (workspace.parent / 'execution.lock').open('a+b')
fcntl.flock(execution_lock, fcntl.LOCK_SH)
def native(operation):
 if operation() == -1:
  raise OSError(ctypes.get_errno(), 'native syscall denied')
install([str(allowed)], workspace)
assert allowed.read_text() == 'synthetic receipt'
denied = []
for name, operation in [
 ('private_read', lambda: private.read_text()),
 ('private_write', lambda: private.write_text('changed')),
 ('private_chmod', lambda: private.chmod(0)),
 ('ipv4', lambda: socket.socket(socket.AF_INET)),
 ('ipv6', lambda: socket.socket(socket.AF_INET6)),
 ('unix_socket', lambda: socket.socket(socket.AF_UNIX)),
 ('parent_signal', lambda: os.kill(os.getppid(), 0)),
 ('parent_pidfd', lambda: os.pidfd_open(os.getppid())),
 ('parent_pidfd_signal', lambda: signal.pidfd_send_signal(parent_pidfd, 0)),
 ('parent_sigqueue', lambda: native(lambda: libc.sigqueue(parent, 0, 0))),
 ('parent_thread_sigqueue', lambda: native(lambda: libc.syscall(queue_number, parent, parent, 0, ctypes.byref(info)))),
 ('parent_limits', lambda: resource.prlimit(parent, resource.RLIMIT_NOFILE, limits)),
 ('parent_priority', lambda: os.setpriority(os.PRIO_PROCESS, parent, priority)),
 ('parent_affinity', lambda: os.sched_setaffinity(parent, affinity)),
 ('parent_scheduler', lambda: os.sched_setscheduler(parent, policy, parameter)),
 ('parent_schedparam', lambda: os.sched_setparam(parent, parameter)),
 ('execution_unlock', lambda: fcntl.flock(execution_lock, fcntl.LOCK_UN)),
 ('outside_create', lambda: (workspace.parent / 'escape').write_text('changed')),
]:
 try: operation()
 except PermissionError: denied.append(name)
 else: raise AssertionError(name)
(workspace / 'output.txt').write_text('bounded output')
print(json.dumps(denied))
"""
    result = subprocess.run(
        [sys.executable, "-c", code, str(workspace), str(allowed), str(private)],
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
    assert len(json.loads(result.stdout)) == 18
    assert private.read_text() == "synthetic private value"
