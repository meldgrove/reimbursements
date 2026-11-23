/** Intake limits, formats and messages (the unit parts of tests/test_intake.py and tests/test_upload_failures.py). */
import { describe, expect, it } from "vitest";
import { overrideConfigForTests } from "./config";
import { VALIDATION_FAILURE_CODES } from "./documents/manifest";
import {
  MAX_CLAIM_TOTAL_CENTS,
  UNCHECKED_FAILURES,
  clientConfig,
  limits,
  megabytes,
  message,
  messages,
  mileageAmount,
  parseAmount,
  parseDistance,
} from "./intake";
import { INTERRUPTED, UNEXPECTED } from "./services/job-kinds";
import { SCAN_FAILURE_CODES } from "./services/scanner";
import { status } from "./services/uploads";
import type { Upload } from "./db/schema";

describe("intake", () => {
  it("client and server share one set of limits", () => {
    overrideConfigForTests({ MAX_FILES_PER_EXPENSE: 2, MAX_SUBMISSION_BYTES: 20_000_000 });
    const config = clientConfig();
    expect(config.limits.files_per_expense).toBe(2);
    expect(config.limits).toEqual(limits());
    expect(config.messages.submission_too_large!.endsWith("höchstens 20 MB groß sein.")).toBe(true);
    expect(config.messages.upload_hint).toContain("20 MB insgesamt");
    expect(config.messages.receipt_hint).toContain("Bis zu 2 Dateien.");
    expect(message("files_per_expense")).toBe("Jede Position benötigt 1 bis 2 Belegdateien.");
  });

  it("megabytes are written as Python's :g format writes them", () => {
    expect(megabytes(10_000_000)).toBe("10 MB");
    expect(megabytes(1_500_000)).toBe("1.5 MB");
    expect(megabytes(50_000_000)).toBe("50 MB");
  });

  it("amounts are euros with at most two cent digits", () => {
    expect(parseAmount("12,5")).toBe(1250n);
    expect(parseAmount("1250")).toBe(125000n);
    for (const value of ["12,505", "1.250,00", "0", "-3", "12 EUR", 12.5, "NaN", "1e3"]) {
      expect(() => parseAmount(value)).toThrow();
    }
    expect(MAX_CLAIM_TOTAL_CENTS).toBe(999_999_999_999n);
  });

  it("mileage is distance times rate, exact in cents", () => {
    expect(mileageAmount(123, false, "0.30")).toBe(3690n);
    expect(mileageAmount(123, true, "0.30")).toBe(7380n);
    expect(parseDistance("289")).toBe(289);
    expect(parseDistance(12)).toBe(12);
    for (const value of ["0", "12.5", "5001", "", true]) expect(() => parseDistance(value)).toThrow();
  });
});

describe("upload failures", () => {
  it("every validation failure has a message or is declared unfixable", () => {
    const codes = new Set<string>([
      ...VALIDATION_FAILURE_CODES,
      ...SCAN_FAILURE_CODES,
      UNEXPECTED.code,
      INTERRUPTED,
    ]);
    for (const code of ["invalid_pdf", "pdf_dimensions", "pdf_complexity", "malware_detected"])
      expect(codes.has(code)).toBe(true);
    const known = new Set(Object.keys(messages()));
    const unexplained = [...codes].filter((code) => !known.has(code) && !UNCHECKED_FAILURES.has(code));
    expect(unexplained.sort()).toEqual([]);
    expect([...UNCHECKED_FAILURES].filter((code) => known.has(code))).toEqual([]);
  });

  it.each(["invalid_pdf", "pdf_dimensions", "pdf_complexity", "document_timeout"])(
    "a failed upload reports its cause: %s",
    (code) => {
      const upload = { id: "u", state: "failed", errorCode: code, pages: 0 } as Upload;
      expect(status(upload).message).toBe(message(code));
      expect(status(upload).message).not.toBe(message("upload_unchecked"));
    },
  );

  it("an unfixable failure asks for a new upload", () => {
    const upload = { id: "u", state: "failed", errorCode: "worker_interrupted", pages: 0 } as Upload;
    expect(status(upload).message).toBe(message("upload_unchecked"));
  });
});
