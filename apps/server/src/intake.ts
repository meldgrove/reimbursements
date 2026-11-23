/**
 * Intake limits, formats and participant-facing messages (portal/intake.py of the
 * Django version).
 *
 * The one source for the form page, its script and server validation. Limits come
 * from the configuration; every message that quotes a limit is rendered from the same
 * value.
 */
import { example, numberFormat } from "@reimbursements/shared/numbers";
import { config } from "./config";
import { MAX_PDF_PAGES } from "./constants";
import { applied, language, t } from "./i18n";

/**
 * Amounts are always EUR. Whole euros up to nine digits, an optional decimal comma or
 * point with at most two cent digits, no grouping.
 */
export const AMOUNT_PATTERN = "\\d{1,9}(?:[,.]\\d{1,2})?";
const AMOUNT = new RegExp(`^(?:${AMOUNT_PATTERN})$`);
export const EXPENSE_FIELD_LENGTHS = {
  merchant: 200,
  purpose: 3000,
  receipt_reference: 100,
  route_from: 200,
  route_to: 200,
  vehicle_registration: 20,
} as const;
export type ExpenseTextField = keyof typeof EXPENSE_FIELD_LENGTHS;
/** Kilometres of one mileage row, one way. */
export const MAX_DISTANCE_KM = 5000;
/** The largest claim total the database stores (Claim.total, 12 digits), in cents. */
export const MAX_CLAIM_TOTAL_CENTS = 999_999_999_999n;
/** Signature attempts kept per draft, independent of the expense rows. */
export const MAX_SIGNATURE_FILES = 3;
export const RECEIPT_EXTENSIONS: ReadonlySet<string> = new Set([".pdf", ".png", ".jpg", ".jpeg"]);
export const SIGNATURE_EXTENSIONS: ReadonlySet<string> = new Set([".png", ".jpg", ".jpeg"]);

export type FieldErrors = Record<string, Array<{ message: string; code: string }>>;

/** A participant-facing rejection: message in the app language, field errors, HTTP status. */
export class IntakeError extends Error {
  readonly errors: FieldErrors;
  readonly status: number;

  constructor(message: string, options: { errors?: FieldErrors; status?: number } = {}) {
    super(message);
    this.name = "IntakeError";
    this.errors = options.errors ?? {};
    this.status = options.status ?? 400;
  }
}

export type Limits = {
  receipt_bytes: number;
  submission_bytes: number;
  signature_bytes: number;
  expenses: number;
  files_per_expense: number;
  pdf_pages: number;
  claim_pages: number;
};

export function limits(): Limits {
  const settings = config();
  return {
    receipt_bytes: settings.MAX_RECEIPT_BYTES,
    submission_bytes: settings.MAX_SUBMISSION_BYTES,
    signature_bytes: settings.MAX_SIGNATURE_BYTES,
    expenses: settings.MAX_EXPENSES,
    files_per_expense: settings.MAX_FILES_PER_EXPENSE,
    pdf_pages: MAX_PDF_PAGES,
    claim_pages: settings.MAX_CLAIM_PAGES,
  };
}

/** The files one draft may hold: every expense's receipts and the signature attempts. */
export function draftFiles(current: Limits = limits()): number {
  return current.expenses * current.files_per_expense + MAX_SIGNATURE_FILES;
}

/** `size` bytes as megabytes, as Python's f"{size / 1_000_000:g} MB". */
export function megabytes(size: number): string {
  return `${formatG(size / 1_000_000)} MB`;
}

/** Python's "g" format: up to six significant digits, no trailing zeros. */
function formatG(value: number): string {
  if (value === 0) return "0";
  const exponent = Math.floor(Math.log10(Math.abs(value)));
  if (exponent < -4 || exponent >= 6) {
    const [mantissa, power] = value.toExponential(5).split("e") as [string, string];
    const trimmed = mantissa.replace(/\.?0+$/, "");
    const sign = power.startsWith("-") ? "-" : "+";
    return `${trimmed}e${sign}${power.replace(/^[+-]/, "").padStart(2, "0")}`;
  }
  return String(Number(value.toPrecision(6)));
}

export const STATIC_MESSAGES: Readonly<Record<string, string>> = {
  normalized_size_limit: "The processed file is too large. Please export it at a lower resolution.",
  document_sandbox_unavailable: "The security check is temporarily unavailable. Please contact us.",
  unsupported_type: "Please upload a PDF, JPG or PNG file.",
  invalid_document: "The file could not be read. Please export it again.",
  invalid_pdf: "The file could not be read. Please export it again.",
  pdf_dimensions:
    "The PDF has a page size that cannot be processed. Please export it in a standard paper size such as A4.",
  pdf_complexity:
    "The PDF is too complex to check. Please export it again as a simpler PDF or upload a photo.",
  document_timeout: "Checking the file took too long. Please upload a smaller or simpler file.",
  scanner_configuration: "The security check is temporarily unavailable. Please contact us.",
  encrypted_pdf: "The PDF is password-protected. Please upload an unprotected copy.",
  pdf_active_content: "This PDF contains unsupported active content. Please export it as a plain PDF.",
  empty_signature: "The signature is empty. Please sign again.",
  malware_detected: "The file did not pass the security check.",
  scanner_unavailable: "The security check is delayed. Please wait or try again later.",
  upload_unchecked: "The file could not be checked. Please upload it again.",
  request_too_large: "The file or request is too large.",
  upload_unavailable: "Uploading is temporarily unavailable.",
  draft_work_limit: "Too many files were uploaded for this form. Please contact us.",
  network_work_limit: "Too many uploads from this network. Please try again later.",
  draft_storage_limit: "The files need too much storage. Please remove files you do not need.",
  upload_capacity: "Upload capacity is limited right now. Please wait a moment and try again.",
};

/** Validation failures with no cause a participant can fix: they see "upload_unchecked". */
export const UNCHECKED_FAILURES: ReadonlySet<string> = new Set([
  "document_process_failed",
  "invalid_processing_output",
  "processing_error",
  "worker_interrupted",
]);

/** Every message by code, in the active language, with the current limits. */
export function messages(): Record<string, string> {
  const current = limits();
  const receipt = megabytes(current.receipt_bytes);
  const submission = megabytes(current.submission_bytes);
  const signature = megabytes(current.signature_bytes);
  const files = current.files_per_expense;
  const translated: Record<string, string> = {};
  for (const [code, text] of Object.entries(STATIC_MESSAGES)) translated[code] = t(text);
  return {
    ...translated,
    pdf_pages: t("A PDF may have at most {count} pages.", { count: current.pdf_pages }),
    receipt_too_large: t("A receipt file may be at most {size}.", { size: receipt }),
    receipt_size: t("Each receipt file must be between 1 byte and {size}.", { size: receipt }),
    signature_too_large: t("The signature may be at most {size}.", { size: signature }),
    submission_too_large: t("All receipts together may be at most {size}.", { size: submission }),
    claim_pages: t("All receipts together may have at most {count} pages.", { count: current.claim_pages }),
    expense_count: t("Please add 1 to {count} expense items.", { count: current.expenses }),
    files_per_expense: t("Each item needs 1 to {count} receipt files.", { count: files }),
    mileage_files: t("Mileage allows at most {count} supporting files.", { count: files }),
    files_per_expense_exceeded: t("Each item allows at most {count} receipt files.", { count: files }),
    upload_hint: t(
      "PDF, JPG or PNG · up to {receipt} per file · {submission} in total · at most {pages} receipt pages",
      { receipt, submission, pages: current.claim_pages },
    ),
    receipt_hint: t(
      "An invoice, receipt or ticket that shows the amount, purpose and business partner. More files are optional. Up to {count} files. You can change their order afterwards.",
      { count: files },
    ),
    signature_hint: t(
      "Sign with your finger, a pen or the mouse, or upload an image. JPG/PNG, at most {size}.",
      { size: signature },
    ),
  };
}

export function message(code: string, fallback?: string): string | undefined {
  return messages()[code] ?? fallback;
}

/** The active number format's separators and an example amount. */
function activeNumbers() {
  const format = numberFormat(applied().numberFormat);
  return { format, example: (amount = "12.50") => example(format.code, amount) };
}

/** Everything the form page needs to apply the same limits, formats and text. */
export function clientConfig() {
  const active = activeNumbers();
  return {
    limits: limits(),
    amount_pattern: AMOUNT_PATTERN,
    max_distance_km: MAX_DISTANCE_KM,
    messages: messages(),
    text: scriptText(),
    locale: language() === "de" ? "de-DE" : "en-GB",
    decimal_separator: active.format.decimal,
    thousands_separator: active.format.thousands,
  };
}

export type ClientConfig = ReturnType<typeof clientConfig>;

/** The form page's own text, in the active language. */
export function scriptText(): Record<string, string> {
  const active = activeNumbers();
  return {
    session_gone: t("The session or file is no longer available. Please open the form again."),
    request_failed: t("The request could not be processed."),
    connection_lost: t("The connection was interrupted. Please try again."),
    request_error: t("The request failed."),
    field_required: t("Please fill in this field."),
    amount_invalid: t("Please enter a positive amount in euros, e.g. {example}.", {
      example: active.example(),
    }),
    check_marked: t("Please check the marked details."),
    return_before_outward: t("The return date cannot be before the outward journey."),
    total: t("Total"),
    duplicate_reference: t("Note: A receipt reference is used more than once. Please check the assignment."),
    expenses_empty_mileage: t("Add an expense with a receipt or a mileage claim."),
    expenses_empty: t("Add an expense with a receipt."),
    file_ready: t("Checked"),
    file_pending: t("Checking …"),
    file_uploading: t("Uploading …"),
    file_failed: t("Check failed"),
    move_receipt_up: t("Move receipt up"),
    move_receipt_down: t("Move receipt down"),
    remove: t("Remove"),
    check_again: t("Check status again"),
    preview_upload: t("Preview: uploading is not possible."),
    upload_progress: t("Upload {percent} %"),
    upload_failed_retry: t("The upload failed. Please try again."),
    upload_failed: t("The upload failed."),
    upload_interrupted: t("The upload was interrupted. Please try again."),
    connection_slow: t("The connection is slow. The check stays saved."),
    check_slow: t("The check is taking longer. Please check the status again later; the file stays saved."),
    signature_uploading: t("Uploading and checking the signature …"),
    signature_ready: t("Signature checked."),
    signature_ready_file: t("Signature checked: {name}"),
    signature_retry: t("Please clear the signature or try again."),
    signature_drawn: t("Signature drawn."),
    signature_changed: t("The signature changed. Please try again."),
    signature_busy: t("The signature is still being processed."),
    signature_missing: t("Please draw or upload a signature."),
    signature_required: t("Please sign or upload a signature."),
    signature_wait: t("Please wait until the signature has been checked."),
    receipts_missing: t("Each expense needs at least one receipt, and all files must be checked."),
    amounts_invalid: t(
      "Please enter a positive amount in euros or a distance in whole kilometres for each item.",
    ),
    review_name: t("Name"),
    review_email: t("Email"),
    review_street: t("Street and house number"),
    review_postal_code: t("Postcode"),
    review_city: t("Town or city"),
    review_country: t("Country"),
    review_account_holder: t("Account holder"),
    review_iban: t("IBAN"),
    review_bic: t("BIC"),
    review_purpose: t("Occasion/project"),
    review_purpose_details: t("Additional details"),
    review_trip_destination: t("Destination"),
    review_trip_start: t("Trip start"),
    review_trip_end: t("Trip end"),
    review_trip: t("Trip {start} – {end}"),
    review_trip_return: t("Trip {start} – {end} and back"),
    review_outward: t("Outward: {date}"),
    review_return: t("Return: {date}"),
    review_registration: t("Registration: {plate}"),
    review_reference: t("Reference {reference}"),
    review_total: t("Total: {amount}"),
    consent_missing: t("Please confirm the declaration and the privacy notice."),
    submitting: t("Submitting …"),
    submit: t("Submit claim →"),
  };
}

/** An exact positive EUR amount in cents (at most two cent digits), or a thrown Error. */
export function parseAmount(value: unknown): bigint {
  if (typeof value !== "string" || !AMOUNT.test(value.trim())) {
    throw new Error(
      t("Enter the amount in euros without thousands separators, e.g. {example}.", {
        example: activeNumbers().example(),
      }),
    );
  }
  const [whole = "0", fraction = ""] = value.trim().replace(",", ".").split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0") || "0");
  if (cents <= 0n) throw new Error(t("Please enter a positive amount."));
  return cents;
}

/** Whole kilometres of one way, 1 to MAX_DISTANCE_KM, or a thrown Error. */
export function parseDistance(value: unknown): number {
  let text = value;
  if (typeof text === "number" && Number.isInteger(text)) text = String(text);
  if (typeof text !== "string" || !/^\d{1,5}$/.test(text.trim()))
    throw new Error(t("Please enter the distance in whole kilometres."));
  const distance = Number(text.trim());
  if (distance < 1 || distance > MAX_DISTANCE_KM)
    throw new Error(t("The distance must be between 1 and {maximum} km.", { maximum: MAX_DISTANCE_KM }));
  return distance;
}

/**
 * The exact EUR amount of a mileage row in cents, rounded half up to cents.
 * `rate` is EUR per kilometre with at most two decimals ("0.30").
 */
export function mileageAmount(distanceKm: number, roundTrip: boolean, rate: string): bigint {
  const kilometres = BigInt(distanceKm * (roundTrip ? 2 : 1));
  const [whole = "0", fraction = ""] = rate.split(".");
  // The rate has at most two decimals (numeric(4,2)): the product is exact in cents.
  const rateCents = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, "0") || "0");
  return kilometres * rateCents;
}
