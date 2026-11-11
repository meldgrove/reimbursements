"""Intake limits, formats and participant-facing messages.

The one source for the form template, its script and server validation. Limits come
from settings; every message that quotes a limit is rendered from the same value.
"""

import re
from dataclasses import asdict, dataclass
from decimal import ROUND_HALF_UP, Decimal

from django.conf import settings

from portal.i18n import language, t

# Amounts are always EUR. Whole euros up to nine digits, an optional decimal comma or
# point with at most two cent digits, no grouping.
AMOUNT_PATTERN = r"\d{1,9}(?:[,.]\d{1,2})?"
EXPENSE_FIELD_LENGTHS = {
    "merchant": 200,
    "purpose": 3000,
    "receipt_reference": 100,
    "route_from": 200,
    "route_to": 200,
    "vehicle_registration": 20,
}
# Kilometres of one mileage row, one way.
MAX_DISTANCE_KM = 5000
# The largest claim total the database stores (Claim.total, 12 digits).
MAX_CLAIM_TOTAL = Decimal("9999999999.99")
# Signature attempts kept per draft, independent of the expense rows.
MAX_SIGNATURE_FILES = 3
RECEIPT_EXTENSIONS = frozenset({".pdf", ".png", ".jpg", ".jpeg"})
SIGNATURE_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg"})


class IntakeError(Exception):
    """A participant-facing rejection: message in the app language, field errors, HTTP status."""

    def __init__(self, message, *, errors=None, status=400):
        super().__init__(message)
        self.message, self.errors, self.status = message, errors or {}, status


@dataclass(frozen=True)
class Limits:
    receipt_bytes: int
    submission_bytes: int
    signature_bytes: int
    expenses: int
    files_per_expense: int
    pdf_pages: int
    claim_pages: int

    @property
    def draft_files(self):
        return self.expenses * self.files_per_expense + MAX_SIGNATURE_FILES


def limits():
    return Limits(
        receipt_bytes=settings.MAX_RECEIPT_BYTES,
        submission_bytes=settings.MAX_SUBMISSION_BYTES,
        signature_bytes=settings.MAX_SIGNATURE_BYTES,
        expenses=settings.MAX_EXPENSES,
        files_per_expense=settings.MAX_FILES_PER_EXPENSE,
        pdf_pages=settings.MAX_PDF_PAGES,
        claim_pages=settings.MAX_CLAIM_PAGES,
    )


def megabytes(size):
    return f"{size / 1_000_000:g} MB"


STATIC_MESSAGES = {
    "normalized_size_limit": "The processed file is too large. Please export it at a lower resolution.",
    "document_sandbox_unavailable": "The security check is temporarily unavailable. Please contact us.",
    "unsupported_type": "Please upload a PDF, JPG or PNG file.",
    "invalid_document": "The file could not be read. Please export it again.",
    "encrypted_pdf": "The PDF is password-protected. Please upload an unprotected copy.",
    "pdf_active_content": "This PDF contains unsupported active content. Please export it as a plain PDF.",
    "empty_signature": "The signature is empty. Please sign again.",
    "malware_detected": "The file did not pass the security check.",
    "scanner_unavailable": "The security check is delayed. Please wait or try again later.",
    "upload_unchecked": "The file could not be checked. Please upload it again.",
    "request_too_large": "The file or request is too large.",
    "upload_unavailable": "Uploading is temporarily unavailable.",
    "draft_work_limit": "Too many files were uploaded for this form. Please contact us.",
    "network_work_limit": "Too many uploads from this network. Please try again later.",
    "draft_storage_limit": "The files need too much storage. Please remove files you do not need.",
    "upload_capacity": "Upload capacity is limited right now. Please wait a moment and try again.",
}


def messages():
    """Every message by code, in the active language, with the current limits."""
    current = limits()
    receipt, submission = megabytes(current.receipt_bytes), megabytes(current.submission_bytes)
    signature, files = megabytes(current.signature_bytes), current.files_per_expense
    return {
        **{code: t(text) for code, text in STATIC_MESSAGES.items()},
        "pdf_pages": t("A PDF may have at most {count} pages.", count=current.pdf_pages),
        "receipt_too_large": t("A receipt file may be at most {size}.", size=receipt),
        "receipt_size": t("Each receipt file must be between 1 byte and {size}.", size=receipt),
        "signature_too_large": t("The signature may be at most {size}.", size=signature),
        "submission_too_large": t("All receipts together may be at most {size}.", size=submission),
        "claim_pages": t(
            "All receipts together may have at most {count} pages.", count=current.claim_pages
        ),
        "expense_count": t("Please add 1 to {count} expense items.", count=current.expenses),
        "files_per_expense": t("Each item needs 1 to {count} receipt files.", count=files),
        "mileage_files": t("Mileage allows at most {count} supporting files.", count=files),
        "files_per_expense_exceeded": t(
            "Each item allows at most {count} receipt files.", count=files
        ),
        "upload_hint": t(
            "PDF, JPG or PNG · up to {receipt} per file · {submission} in total · "
            "at most {pages} receipt pages",
            receipt=receipt,
            submission=submission,
            pages=current.claim_pages,
        ),
        "receipt_hint": t(
            "An invoice, receipt or ticket that shows the amount, purpose and business "
            "partner. More files are optional. Up to {count} files. "
            "You can change their order afterwards.",
            count=files,
        ),
        "signature_hint": t(
            "Sign with your finger, a pen or the mouse, or upload an image. "
            "JPG/PNG, at most {size}.",
            size=signature,
        ),
    }


def message(code, default=None):
    return messages().get(code, default)


def client_config():
    """Everything the form script needs to apply the same limits, formats and text."""
    return {
        "limits": asdict(limits()),
        "amount_pattern": AMOUNT_PATTERN,
        "max_distance_km": MAX_DISTANCE_KM,
        "messages": messages(),
        "text": script_text(),
        "locale": "de-DE" if language() == "de" else "en-GB",
    }


def script_text():
    """The form script's own text, in the active language."""
    return {
        "session_gone": t(
            "The session or file is no longer available. Please open the form again."
        ),
        "request_failed": t("The request could not be processed."),
        "connection_lost": t("The connection was interrupted. Please try again."),
        "request_error": t("The request failed."),
        "field_required": t("Please fill in this field."),
        "amount_invalid": t("Please enter a positive amount in euros, e.g. 12.50."),
        "check_marked": t("Please check the marked details."),
        "return_before_outward": t("The return date cannot be before the outward journey."),
        "total": t("Total"),
        "duplicate_reference": t(
            "Note: A receipt reference is used more than once. Please check the assignment."
        ),
        "expenses_empty_mileage": t("Add an expense with a receipt or a mileage claim."),
        "expenses_empty": t("Add an expense with a receipt."),
        "file_ready": t("Checked"),
        "file_pending": t("Checking …"),
        "file_uploading": t("Uploading …"),
        "file_failed": t("Check failed"),
        "move_receipt_up": t("Move receipt up"),
        "move_receipt_down": t("Move receipt down"),
        "remove": t("Remove"),
        "check_again": t("Check status again"),
        "preview_upload": t("Preview: uploading is not possible."),
        "upload_progress": t("Upload {percent} %"),
        "upload_failed_retry": t("The upload failed. Please try again."),
        "upload_failed": t("The upload failed."),
        "upload_interrupted": t("The upload was interrupted. Please try again."),
        "connection_slow": t("The connection is slow. The check stays saved."),
        "check_slow": t(
            "The check is taking longer. Please check the status again later; the file stays saved."
        ),
        "signature_uploading": t("Uploading and checking the signature …"),
        "signature_ready": t("Signature checked."),
        "signature_ready_file": t("Signature checked: {name}"),
        "signature_retry": t("Please clear the signature or try again."),
        "signature_drawn": t("Signature drawn."),
        "signature_changed": t("The signature changed. Please try again."),
        "signature_busy": t("The signature is still being processed."),
        "signature_missing": t("Please draw or upload a signature."),
        "signature_required": t("Please sign or upload a signature."),
        "signature_wait": t("Please wait until the signature has been checked."),
        "receipts_missing": t(
            "Each expense needs at least one receipt, and all files must be checked."
        ),
        "amounts_invalid": t(
            "Please enter a positive amount in euros or a distance in whole kilometres for each item."
        ),
        "review_name": t("Name"),
        "review_email": t("Email"),
        "review_street": t("Street and house number"),
        "review_postal_code": t("Postcode"),
        "review_city": t("Town or city"),
        "review_country": t("Country"),
        "review_account_holder": t("Account holder"),
        "review_iban": t("IBAN"),
        "review_bic": t("BIC"),
        "review_purpose": t("Occasion/project"),
        "review_purpose_details": t("Additional details"),
        "review_trip_destination": t("Destination"),
        "review_trip_start": t("Trip start"),
        "review_trip_end": t("Trip end"),
        "review_trip": t("Trip {start} – {end}"),
        "review_trip_return": t("Trip {start} – {end} and back"),
        "review_outward": t("Outward: {date}"),
        "review_return": t("Return: {date}"),
        "review_registration": t("Registration: {plate}"),
        "review_reference": t("Reference {reference}"),
        "review_total": t("Total: {amount}"),
        "consent_missing": t("Please confirm the declaration and the privacy notice."),
        "submitting": t("Submitting …"),
        "submit": t("Submit claim →"),
    }


def parse_amount(value):
    """An exact positive EUR Decimal with at most two cent digits, or ValueError."""
    if not isinstance(value, str) or not re.fullmatch(AMOUNT_PATTERN, value.strip()):
        raise ValueError(t("Enter the amount in euros without thousands separators, e.g. 12.50."))
    amount = Decimal(value.strip().replace(",", "."))
    if amount <= 0:
        raise ValueError(t("Please enter a positive amount."))
    return amount


def parse_distance(value):
    """Whole kilometres of one way, 1 to MAX_DISTANCE_KM, or ValueError."""
    if isinstance(value, int) and not isinstance(value, bool):
        value = str(value)
    if not isinstance(value, str) or not re.fullmatch(r"\d{1,5}", value.strip()):
        raise ValueError(t("Please enter the distance in whole kilometres."))
    distance = int(value.strip())
    if not 1 <= distance <= MAX_DISTANCE_KM:
        raise ValueError(
            t("The distance must be between 1 and {maximum} km.", maximum=MAX_DISTANCE_KM)
        )
    return distance


def mileage_amount(distance_km, round_trip, rate):
    """The exact EUR amount of a mileage row, rounded half up to cents."""
    kilometres = distance_km * (2 if round_trip else 1)
    return (Decimal(kilometres) * Decimal(rate)).quantize(Decimal("0.01"), ROUND_HALF_UP)
