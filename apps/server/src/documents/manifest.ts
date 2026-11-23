/**
 * What the parent hands the document child, and what the child answers.
 *
 * The child has no database, settings or translations: the parent
 * (services/documents.ts) prepares every text of the claim PDF already
 * translated and formatted (dates, amounts, country names) in the language
 * the participant saw, so the child only lays it out.
 */
import type { Language } from "@reimbursements/shared/i18n";

export type UploadKind = "receipt" | "signature";

/** `validate`'s answer: the normalized output, or the source itself for a PDF. */
export type ValidateResult = {
  normalized: string;
  mediaType: "application/pdf" | "image/jpeg" | "image/png";
  pages: number;
};

/** `build`'s answer. */
export type BuildResult = {
  size: number;
  /** SHA-256 of the PDF, hex. */
  checksum: string;
  pages: number;
  dpi: number;
  quality: number;
};

/** One line of a two-column table: a label and its value (newlines kept). */
export type SummaryRow = readonly [label: string, value: string];

export type SummarySection = { heading: string; rows: SummaryRow[] };

/** One row of the expense table. Lines are printed below each other. */
export type SummaryExpense = {
  number: string;
  partner: string[];
  purpose: string[];
  reference: string;
  amount: string;
};

/** The first pages of the claim PDF (portal/templates/portal/summary.html in 0.4). */
export type ClaimSummary = {
  language: Language;
  /** The footer's left part: "<app name> · <reference>". */
  footer: string;
  /** "Reimbursement of privately paid costs", printed in capitals. */
  eyebrow: string;
  title: string;
  /** The lines under the title: the reference, then submission time and form version. */
  meta: string[];
  personal: SummarySection;
  assignment: SummarySection;
  occasion: SummarySection;
  expenses: {
    heading: string;
    /** No., business partner / journey, occasion/purpose, reference, amount. */
    columns: [string, string, string, string, string];
    rows: SummaryExpense[];
    total: { label: string; amount: string };
  };
  /** How the receipt pages follow. */
  receiptNote: string;
  declaration: {
    heading: string;
    text: string;
    /** The signature image's alternative text. */
    signatureLabel: string;
    /** "<name> · <date>" under the signature. */
    signed: string;
    /** The declaration and privacy notice versions. */
    versions: string;
  };
};

export type ReceiptInput = {
  path: string;
  mediaType: string;
  /** The bookmark of the item the pages belong to: "Item 1 · TEST-1". */
  label: string;
};

/** The manifest of `build`, written as manifest.json into the execution's workspace. */
export type BuildManifest = {
  summary: ClaimSummary;
  /** The normalized signature (PNG); null only in tests of the assembly. */
  signature: string | null;
  receipts: ReceiptInput[];
  /** The PDF's Title metadata. */
  title: string;
  /** The largest PDF that may be sent (MAX_FINAL_PDF_BYTES). */
  maxBytes: number;
};

/** The files a build may read: the manifest names them, nothing else is opened. */
export function manifestInputs(manifest: BuildManifest): string[] {
  return [
    ...(manifest.signature ? [manifest.signature] : []),
    ...manifest.receipts.map((receipt) => receipt.path),
  ];
}

/**
 * Every code an upload's validation can fail with, from the child (validate)
 * and from its runner (services/documents.ts). The intake has a message for
 * each, or lists it as one the participant cannot fix (0.4's
 * tests/test_upload_failures.py read them from the sources).
 */
export const VALIDATION_FAILURE_CODES = [
  "unsupported_type",
  "empty_signature",
  "encrypted_pdf",
  "pdf_pages",
  "pdf_active_content",
  "pdf_complexity",
  "invalid_pdf",
  "pdf_dimensions",
  "normalized_size_limit",
  "invalid_document",
  "document_sandbox_unavailable",
  "document_timeout",
  "document_process_failed",
  "invalid_processing_output",
] as const;

/** The codes a claim PDF's build can fail with, from the child. */
export const BUILD_FAILURE_CODES = [
  "output_page_count",
  "output_blank_page",
  "output_size_limit",
  "workspace_limit",
  "invalid_document",
  "document_sandbox_unavailable",
] as const;

/** Every failure code the parent accepts from the child; any other answer is document_process_failed. */
export const CHILD_FAILURE_CODES: ReadonlySet<string> = new Set([
  ...VALIDATION_FAILURE_CODES,
  ...BUILD_FAILURE_CODES,
]);
