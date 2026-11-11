import contextlib
import json
import os
import resource
import signal
import subprocess
import sys
import tempfile
from functools import lru_cache
from pathlib import Path

from django.conf import settings
from django.template.loader import render_to_string

from portal.services.capacity import temporary_workspace, workspace_lock
from portal.services.storage import (
    normalized_upload_key,
    path_for,
    publish_file,
    workspace_root,
)


class ProcessingError(Exception):
    pass


def resource_limits():
    resource.setrlimit(resource.RLIMIT_AS, (2_000_000_000, 2_000_000_000))
    resource.setrlimit(
        resource.RLIMIT_CPU, (settings.JOB_TIMEOUT_SECONDS, settings.JOB_TIMEOUT_SECONDS)
    )
    resource.setrlimit(resource.RLIMIT_FSIZE, (600_000_000, 600_000_000))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))


def child_environment(workspace):
    """Document children get no credentials or inherited configuration."""
    return {
        "PATH": os.defpath,
        "LANG": "C.UTF-8",
        "TMPDIR": str(workspace),
        "XDG_CACHE_HOME": str(Path(workspace) / "cache"),
        "PYTHONDONTWRITEBYTECODE": "1",
    }


class SandboxedRunner:
    """Production: Landlock/seccomp confinement before any parser is imported."""

    def command(self, arguments, *, readonly, workspace):
        policy = workspace / "sandbox.json"
        policy.write_text(json.dumps({"readonly": readonly, "workspace": str(workspace)}))
        return [sys.executable, "-m", "portal.document_sandbox", str(policy), *arguments]

    def ready(self, root):
        try:
            return successful_sandbox_probe(root)
        except (OSError, subprocess.TimeoutExpired):
            return False


class DirectRunner:
    """Local development: the same worker and limits, without confinement."""

    def command(self, arguments, *, readonly, workspace):
        return [sys.executable, "-m", "portal.file_worker", *arguments]

    def ready(self, root):
        return True


class UnavailableRunner:
    def command(self, arguments, *, readonly, workspace):
        raise ProcessingError("document_sandbox_unavailable")

    def ready(self, root):
        return False


def configured_runner():
    if settings.DOCUMENT_SANDBOX_ENABLED:
        return SandboxedRunner()
    return DirectRunner() if settings.DEBUG else UnavailableRunner()


@lru_cache(maxsize=16)
def successful_sandbox_probe(root):
    # lru_cache retains successes only. Exceptions leave transient failures retryable.
    Path(root).mkdir(exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(dir=root, prefix="job-probe-") as workspace:
        result = subprocess.run(
            [sys.executable, "-m", "portal.document_sandbox", "--self-test", workspace],
            cwd=settings.BASE_DIR,
            env=child_environment(workspace),
            capture_output=True,
            timeout=5,
        )
        if result.returncode != 0 or result.stdout.strip() != b"sandbox_ok":
            raise OSError("Document sandbox probe failed")
    return True


def sandbox_ready():
    return configured_runner().ready(str(workspace_root()))


def inspect_upload(source, workspace, *, kind="receipt"):
    """Validate a source file; images are normalized into the workspace."""
    source, workspace = Path(source).resolve(), Path(workspace).resolve()
    return execute(
        ["validate", str(source), str(workspace), "--kind", kind],
        readonly=[str(source)],
        workspace=workspace,
    )


def assemble_pdf(manifest_path, output_path):
    """Build the authoritative PDF next to its manifest from the listed inputs only."""
    manifest_path, output_path = Path(manifest_path).resolve(), Path(output_path).resolve()
    manifest = json.loads(manifest_path.read_text())
    readonly = [str(manifest_path), *manifest["allowed_assets"]]
    readonly += [item["path"] for item in manifest["receipts"]]
    return execute(
        ["build", str(manifest_path), str(output_path)],
        readonly=readonly,
        workspace=output_path.parent,
    )


def execute(arguments, *, readonly, workspace):
    command = configured_runner().command(arguments, readonly=readonly, workspace=workspace)
    with (
        workspace_lock(workspace) as execution_lock,
        (workspace / "process-result.json").open("w+b") as output,
    ):
        try:
            process = subprocess.Popen(
                command,
                cwd=settings.BASE_DIR,
                env=child_environment(workspace),
                stdout=output,
                stderr=subprocess.DEVNULL,
                preexec_fn=resource_limits,
                start_new_session=True,
                # Retain the execution lock if the supervisor dies before this child.
                pass_fds=(execution_lock.fileno(),),
            )
            try:
                process.wait(timeout=settings.JOB_TIMEOUT_SECONDS)
            finally:
                # Descendants inherit confinement and cannot change process groups.
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            output.seek(0)
            stdout = output.read(65_537)
        except subprocess.TimeoutExpired as exc:
            raise ProcessingError("document_timeout") from exc
    if len(stdout) > 65_536:
        raise ProcessingError("document_process_failed")
    try:
        payload = json.loads(stdout)
    except (ValueError, TypeError, UnicodeDecodeError) as exc:
        raise ProcessingError("document_process_failed") from exc
    if process.returncode or "error" in payload:
        raise ProcessingError(payload.get("error", "document_process_failed"))
    return payload


@contextlib.contextmanager
def validate_upload(upload):
    source = path_for(upload.source_key)
    with temporary_workspace(upload=upload) as workspace:
        result = inspect_upload(source, workspace, kind=upload.kind)
        normalized = Path(result.pop("normalized")).resolve()
        if result.get("media_type") == "application/pdf" and normalized == source:
            result.update(normalized_key=upload.source_key, normalized_size=0)
            yield result
            return
        suffix = ".png" if upload.kind == "signature" else ".jpg"
        expected = Path(workspace) / f"normalized{suffix}"
        if normalized != expected or not normalized.is_file() or normalized.is_symlink():
            raise ProcessingError("invalid_processing_output")
        size = normalized.stat().st_size
        if not 0 < size <= settings.MAX_NORMALIZED_FILE_BYTES:
            raise ProcessingError("normalized_size_limit")
        key = normalized_upload_key(upload.pk, suffix)
        publish_file(normalized, key, settings.MAX_NORMALIZED_FILE_BYTES)
        result.update(normalized_key=key, normalized_size=size)
        yield result


def build_claim_pdf(claim, workspace):
    uploads = list(claim.uploads.all())
    signature = next(upload for upload in uploads if upload.kind == "signature")
    signature_path = path_for(signature.normalized_key)
    expenses = list(claim.expenses.all())
    receipts = []
    for expense in expenses:
        for upload in sorted(
            (
                upload
                for upload in uploads
                if upload.expense_id == expense.id and upload.kind == "receipt"
            ),
            key=lambda upload: upload.position,
        ):
            receipts.append(
                {
                    "path": str(path_for(upload.normalized_key)),
                    "media_type": upload.media_type,
                    "label": " · ".join(
                        filter(
                            None, [f"Position {expense.position + 1}", expense.receipt_reference]
                        )
                    ),
                }
            )
    manifest = {
        "html": render_to_string(
            "portal/summary.html",
            {"claim": claim, "expenses": expenses, "signature_uri": signature_path.as_uri()},
        ),
        "allowed_assets": [str(signature_path)],
        "receipts": receipts,
        "reference": claim.reference,
        "max_bytes": settings.MAX_FINAL_PDF_BYTES,
    }
    manifest_path = Path(workspace) / "manifest.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    output_path = Path(workspace) / "complete.pdf"
    result = assemble_pdf(manifest_path, output_path)
    return output_path, result
