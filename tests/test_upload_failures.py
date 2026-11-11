"""Every way an upload's validation can fail tells the participant what to do."""

import ast
from pathlib import Path

import pytest

from portal import intake, job_kinds
from portal.models import Upload
from portal.services import uploads

PORTAL = Path(__file__).resolve().parent.parent / "portal"
# Where validation raises its failure codes: the sandboxed worker's validate path, the
# supervisor in documents.py, and the scanner.
SOURCES = {
    "file_worker.py": {"check_pdf_objects", "normalized_image", "validate_file", "main"},
    "services/documents.py": {"command", "execute", "validate_upload"},
    "services/scanner.py": None,
}
ERRORS = {"DocumentError", "ProcessingError", "ScanError", "BoundedBuffer"}


def raised_codes():
    codes = {job_kinds.UNEXPECTED.code, job_kinds.INTERRUPTED}
    for name, functions in SOURCES.items():
        tree = ast.parse((PORTAL / name).read_text())
        scopes = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.FunctionDef) and (functions is None or node.name in functions)
        ]
        for scope in scopes:
            for node in ast.walk(scope):
                if isinstance(node, ast.Call) and getattr(node.func, "id", None) in ERRORS:
                    codes.update(
                        arg.value
                        for arg in node.args
                        if isinstance(arg, ast.Constant) and isinstance(arg.value, str)
                    )
                if isinstance(node, ast.keyword) and node.arg == "error_code":
                    if isinstance(node.value, ast.Constant):
                        codes.add(node.value.value)
                if isinstance(node, ast.Constant) and node.value == "invalid_document":
                    codes.add(node.value)
    return codes


def test_every_validation_failure_has_a_message_or_is_declared_unfixable():
    codes = raised_codes()
    assert {"invalid_pdf", "pdf_dimensions", "pdf_complexity", "malware_detected"} <= codes
    unexplained = codes - intake.messages().keys() - intake.UNCHECKED_FAILURES
    assert not sorted(unexplained)
    assert not intake.UNCHECKED_FAILURES & intake.messages().keys()


@pytest.mark.django_db
@pytest.mark.parametrize(
    "code", ["invalid_pdf", "pdf_dimensions", "pdf_complexity", "document_timeout"]
)
def test_a_failed_upload_reports_its_cause(code):
    upload = Upload(state=Upload.State.FAILED, error_code=code)
    message = uploads.status(upload)["message"]
    assert message == intake.message(code) != intake.message("upload_unchecked")


@pytest.mark.django_db
def test_an_unfixable_failure_asks_for_a_new_upload():
    upload = Upload(state=Upload.State.FAILED, error_code="worker_interrupted")
    assert uploads.status(upload)["message"] == intake.message("upload_unchecked")
