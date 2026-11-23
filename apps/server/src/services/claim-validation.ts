/**
 * Claim and Expense rules shared by live feedback, review and acceptance.
 *
 * They read a form only through its terms (services/terms.ts). No storage reads or
 * writes. Errors use Claim field names or stable browser Expense field IDs. Both entry
 * points return all errors; callers decide which ones to show.
 */
import { fromCents } from "@reimbursements/shared/numbers";
import { config } from "../config";
import { cleanClaimForm, type ClaimDetails } from "../forms";
import { t } from "../i18n";
import {
  EXPENSE_FIELD_LENGTHS,
  IntakeError,
  MAX_CLAIM_TOTAL_CENTS,
  message,
  mileageAmount,
  parseAmount,
  parseDistance,
  type ExpenseTextField,
  type FieldErrors,
} from "../intake";
import type { Terms } from "./terms";

export const CONSENT: ReadonlySet<string> = new Set(["declaration", "privacy_acknowledged"]);
/** ClaimForm fields that are not stored on the Claim. */
export const NOT_STORED: ReadonlySet<string> = new Set([...CONSENT, "is_trip"]);
const REQUIRED_MESSAGES: Readonly<Record<string, string>> = {
  merchant: "Please enter the business partner.",
  vehicle_registration: "Please enter the vehicle registration.",
  route_from: "Please enter where the journey starts.",
  route_to: "Please enter the destination of the journey.",
};

/** The Claim field values acceptance stores. */
export type ClaimValues = Omit<ClaimDetails, "is_trip" | "declaration" | "privacy_acknowledged">;

/** A valid expense row, as acceptance stores it. */
export type ExpenseEntry = {
  id: string;
  position: number;
  kind: "receipt" | "mileage";
  purpose: string;
  merchant: string;
  receipt_reference: string;
  /** Cents. */
  amount: bigint;
  travel_date?: string | null;
  return_date?: string | null;
  vehicle_registration?: string;
  route_from?: string;
  route_to?: string;
  distance_km?: number | null;
  round_trip?: boolean;
  mileage_rate?: string | null;
  /** The row's receipt Upload IDs, in order. */
  uploads: string[];
};

/** Valid entries, in the parts acceptance stores. */
export type Entries = {
  claim: ClaimValues;
  expenses: ExpenseEntry[];
  /** The Signature's Upload ID; null in review. */
  signature: string | null;
  /** Cents. */
  total: bigint;
};

/** The largest claim total in cents; tests lower it (the Django tests patched MAX_CLAIM_TOTAL). */
export const totalLimit = { cents: MAX_CLAIM_TOTAL_CENTS };

export class Validation {
  errors: FieldErrors = {};
  entries: Entries | null = null;

  add(key: string, text: string) {
    (this.errors[key] ??= []).push({ message: text, code: "invalid" });
  }

  /** The entries, or IntakeError with every error. */
  requireValid(): Entries {
    if (Object.keys(this.errors).length) {
      const summary = this.errors.__all__ ?? [{ message: t("Please check the marked details."), code: "" }];
      throw new IntakeError(summary[0]!.message, { errors: this.errors });
    }
    return this.entries!;
  }
}

/**
 * The canonical form of a UUID as Python's str(uuid.UUID(value)) writes it;
 * throws for anything uuid.UUID refuses.
 */
export function normalizeUuid(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("not a UUID");
  const hex = value
    .replaceAll("urn:", "")
    .replaceAll("uuid:", "")
    .replace(/^[{}]+|[{}]+$/g, "")
    .replaceAll("-", "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new RangeError("not a UUID");
  const lower = hex.toLowerCase();
  return `${lower.slice(0, 8)}-${lower.slice(8, 12)}-${lower.slice(12, 16)}-${lower.slice(16, 20)}-${lower.slice(20)}`;
}

function text(value: unknown, key: ExpenseTextField, required = true): string {
  // PostgreSQL stores no NUL characters; Django's form fields refuse them as well.
  if (
    typeof value !== "string" ||
    value.includes("\u0000") ||
    [...value.trim()].length > EXPENSE_FIELD_LENGTHS[key]
  )
    throw new Error(t("Invalid entry."));
  const cleaned = value.trim();
  if (required && !cleaned) throw new Error(t(REQUIRED_MESSAGES[key]!));
  return cleaned;
}

/** A date as Django's parse_date reads it (ISO, or year-month-day with one-digit parts), or a thrown Error. */
export function parseDjangoDate(value: unknown): string {
  const raw = value === null || value === undefined || value === "" ? "" : value;
  if (typeof raw !== "string") throw new TypeError("not a date");
  const match = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(raw) ?? /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (!match) throw new Error("");
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1 || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error("");
  return `${match[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

class Row {
  valid = true;

  constructor(
    readonly row: Record<string, unknown>,
    readonly key: string,
    readonly result: Validation,
  ) {}

  error(name: string, message: string) {
    this.result.add(`expense-${this.key}-${name}`, message);
    this.valid = false;
  }

  read<T>(name: string, parse: (value: unknown) => T, error?: string): T | null {
    try {
      return parse(name in this.row ? this.row[name] : "");
    } catch (thrown) {
      const own =
        thrown instanceof Error && !(thrown instanceof TypeError || thrown instanceof RangeError)
          ? thrown.message
          : "";
      this.error(name, error ?? (own || t("Invalid entry.")));
      return null;
    }
  }

  text(name: ExpenseTextField, required = true): string | null {
    return this.read(name, (value) => text(value, name, required));
  }
}

function expense(
  row: Record<string, unknown>,
  terms: Terms,
  purpose: string,
  key: string,
  result: Validation,
): { item: Omit<Partial<ExpenseEntry>, "kind"> & { kind: string }; ids: string[]; valid: boolean } {
  const fields = new Row(row, key, result);
  const kind = "kind" in row ? row.kind : "receipt";
  const item: Omit<Partial<ExpenseEntry>, "kind"> & { kind: string } = { kind: String(kind), purpose };
  let amount: bigint | null = null;
  if (kind === "receipt") {
    item.merchant = fields.text("merchant") ?? undefined;
    item.receipt_reference = fields.text("receipt_reference", false) ?? undefined;
    amount = fields.read("amount", parseAmount);
  } else if (kind === "mileage" && terms.mileageRate !== null) {
    const start = fields.read("travel_date", parseDjangoDate, t("Please enter the date of the journey."));
    let returning: unknown = "round_trip" in row ? row.round_trip : false;
    if (typeof returning !== "boolean") {
      fields.error("round_trip", t("Invalid return journey entry."));
      returning = false;
    }
    let end: string | null = null;
    if (returning) {
      end = fields.read("return_date", parseDjangoDate, t("Please enter the return date."));
      if (start && end && end < start)
        fields.error("return_date", t("The return date cannot be before the outward journey."));
    }
    const distance = fields.read("distance_km", parseDistance);
    let registration = fields.text("vehicle_registration");
    if (registration !== null) {
      registration = registration.toUpperCase();
      if ([...registration].length > EXPENSE_FIELD_LENGTHS.vehicle_registration)
        fields.error("vehicle_registration", t("The registration may have at most 20 characters."));
    }
    const routeFrom = fields.text("route_from");
    const routeTo = fields.text("route_to");
    Object.assign(item, {
      merchant: "",
      receipt_reference: "",
      travel_date: start,
      return_date: end,
      vehicle_registration: registration ?? undefined,
      route_from: routeFrom ?? undefined,
      route_to: routeTo ?? undefined,
      distance_km: distance,
      round_trip: returning as boolean,
      mileage_rate: terms.mileageRate,
    });
    amount = distance !== null ? mileageAmount(distance, returning as boolean, terms.mileageRate) : null;
  } else {
    fields.error("__all__", t("This type of item is not enabled for the form."));
  }
  if (amount !== null) item.amount = amount;
  let ids: unknown = row.uploads;
  const minimum = kind === "receipt" ? 1 : 0;
  if (!Array.isArray(ids) || ids.length < minimum || ids.length > config().MAX_FILES_PER_EXPENSE) {
    fields.error("__all__", message(minimum ? "files_per_expense" : "mileage_files")!);
    ids = [];
  } else {
    try {
      ids = (ids as unknown[]).map(normalizeUuid);
    } catch {
      fields.error("__all__", t("Invalid receipt file."));
      ids = [];
    }
  }
  return { item, ids: ids as string[], valid: fields.valid };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function check(data: unknown, terms: Terms, submitting: boolean): Validation {
  const result = new Validation();
  if (!isRecord(data)) {
    result.add("__all__", t("Invalid request."));
    return result;
  }
  let rows: unknown = data.expenses;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > config().MAX_EXPENSES) {
    result.add("__all__", message("expense_count")!);
    rows = [];
  }
  const expenseRows = rows as unknown[];
  const hasMileage = expenseRows.some((row) => isRecord(row) && row.kind === "mileage");
  // The form page sends text, and true or false for checkboxes. Django's fields expect
  // that: any other JSON value counts as missing.
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string" || (typeof value === "boolean" && NOT_STORED.has(key))) fields[key] = value;
  }
  const claimForm = cleanClaimForm(fields, terms, hasMileage);
  for (const [key, value] of Object.entries(claimForm.errors)) {
    if (submitting || !CONSENT.has(key)) result.errors[key] = value;
  }
  const cleaned: ExpenseEntry[] = [];
  const rowIds = new Set<string>();
  const uploadIds = new Set<string>();
  let total = 0n;
  expenseRows.forEach((row, position) => {
    let rowId: string;
    try {
      if (!isRecord(row) || !("id" in row)) throw new Error("no id");
      rowId = normalizeUuid(row.id);
      if (rowIds.has(rowId)) throw new Error("duplicate");
    } catch {
      result.add("__all__", t("Item {number}: invalid item ID.", { number: position + 1 }));
      return;
    }
    rowIds.add(rowId);
    const { item, ids, valid } = expense(row, terms, claimForm.cleaned.purpose ?? "", rowId, result);
    if (new Set(ids).size !== ids.length || ids.some((id) => uploadIds.has(id)))
      result.add(`expense-${rowId}-__all__`, t("A receipt file can be assigned only once."));
    for (const id of ids) uploadIds.add(id);
    if (item.amount !== undefined) total += item.amount;
    if (valid) cleaned.push({ ...(item as unknown as ExpenseEntry), id: rowId, position, uploads: ids });
  });
  if (total > totalLimit.cents)
    result.add("__all__", t("The total of all items is too high. Please check the amounts."));
  let signature: string | null = null;
  if (submitting) {
    try {
      signature = normalizeUuid(data.signature);
    } catch {
      result.add("signature", t("Please draw or upload a signature."));
    }
  }
  if (!Object.keys(result.errors).length) {
    const claim: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(claimForm.cleaned))
      if (!NOT_STORED.has(key)) claim[key] = value;
    result.entries = { claim: claim as ClaimValues, expenses: cleaned, signature, total };
  }
  return result;
}

/**
 * All Claim/Expense errors under a form's `terms`, or normalized values and exact total.
 * No consent required.
 */
export function review(data: unknown, terms: Terms): Validation {
  return check(data, terms, false);
}

/** The same rules plus consent and a Signature ID. Stored Uploads are checked at acceptance. */
export function submission(data: unknown, terms: Terms): Validation {
  return check(data, terms, true);
}

/** A cent amount as the decimal string the database stores ("12.50"). */
export function amountText(cents: bigint): string {
  return fromCents(cents);
}
