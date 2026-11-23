/**
 * Terms: what a participant agrees to and what their entries are validated against.
 *
 * A form's terms are its template's declaration and declaration version, the privacy
 * notice, the form's purpose options, the template's travel mode and its mileage rate if
 * mileage is allowed. A draft is opened against the terms of its form and accepted only
 * while the form keeps them: their digest is the draft's revision. Validation reads a
 * form only through its terms, so every change validation would notice sends open drafts
 * back. Wording, opening times, internal values and contacts are not terms; the claim
 * snapshot records them at acceptance.
 */
import { createHash } from "node:crypto";
import { language } from "../i18n";
import { currentPrivacyNotice, internalValues, isOpen, type FormWithTemplate } from "../models";
import type { PrivacyNotice } from "../db/schema";
import { recipientApproved } from "./outbound";

/** Part of every revision. Raising it sends every open draft back. */
export const INTAKE_VERSION = 2;

/** Why a form takes no new claims (`refusal`): it is closed, or it is open but unavailable. */
export const CLOSED = "closed";
export const UNAPPROVED_RECIPIENT = "unapproved_recipient";
export const NO_PRIVACY_NOTICE = "no_privacy_notice";
export type Refusal = "" | typeof CLOSED | typeof UNAPPROVED_RECIPIENT | typeof NO_PRIVACY_NOTICE;

export type Travel = "off" | "optional" | "required";

export class Terms {
  constructor(
    readonly declaration: string,
    readonly declarationVersion: string,
    /** The current privacy notice; without one the form is unavailable. */
    readonly privacyNotice: PrivacyNotice | null,
    /** Distinct preset purposes in order; empty for free text. */
    readonly purposeOptions: readonly string[],
    /** A FormTemplate travel value. */
    readonly travel: Travel,
    /** EUR per kilometre with two decimals ("0.30"); null when the template allows no mileage. */
    readonly mileageRate: string | null,
  ) {}

  get privacyVersion(): number | null {
    return this.privacyNotice ? this.privacyNotice.version : null;
  }

  /** The purpose a single preset fixes, or null. */
  get fixedPurpose(): string | null {
    return this.purposeOptions.length === 1 ? this.purposeOptions[0]! : null;
  }

  /**
   * The digest a draft is opened against: the first 16 hex digits of SHA-256 over
   * the JSON Python's json.dumps(sort_keys=True, ensure_ascii=False) writes, so a
   * revision is the same as the Django version's.
   */
  get revision(): string {
    const configuration: Record<string, unknown> = {
      intake_version: INTAKE_VERSION,
      declaration: this.declaration,
      declaration_version: this.declarationVersion,
      privacy_version: this.privacyVersion,
      purpose_options: [...this.purposeOptions],
      travel: this.travel,
      mileage_rate: this.mileageRate === null ? null : twoDecimals(this.mileageRate),
    };
    return createHash("sha256").update(pythonJson(configuration), "utf8").digest("hex").slice(0, 16);
  }

  /** What the form page needs of these terms. */
  scriptConfiguration() {
    return {
      travel: this.travel,
      mileageRate: this.mileageRate,
      purposeOptions: this.purposeOptions.length > 0,
      fixedPurpose: this.fixedPurpose,
    };
  }
}

/** A decimal string with exactly two places, rounded half up as Python's f"{x:.2f}" of a Decimal. */
function twoDecimals(value: string): string {
  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length <= 2) return `${whole}.${fraction.padEnd(2, "0")}`;
  const cents = BigInt(whole + fraction.slice(0, 2)) + (Number(fraction[2]) >= 5 ? 1n : 0n);
  const text = cents.toString().padStart(3, "0");
  return `${text.slice(0, -2)}.${text.slice(-2)}`;
}

/** json.dumps(value, sort_keys=True, ensure_ascii=False) with Python's default separators. */
export function pythonJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}: ${pythonJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(", ")}}`;
}

/** The distinct non-empty lines of a form's preset purposes, in order. */
export function purposeOptionsOf(text: string): string[] {
  const options = text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return [...new Set(options)];
}

/** The terms `form` offers now. `privacyNotice` defaults to the current one. */
export async function of(form: FormWithTemplate, privacyNotice?: PrivacyNotice | null): Promise<Terms> {
  const template = form.template;
  return new Terms(
    template.declaration,
    template.declarationVersion,
    privacyNotice === undefined ? await currentPrivacyNotice() : privacyNotice,
    // Repeated presets are one option, so a single distinct purpose stays fixed text.
    purposeOptionsOf(form.purposeOptions),
    template.travel as Travel,
    template.mileageEnabled ? template.mileageRate : null,
  );
}

/**
 * Why `form` takes no new claims now, or "" while it does. `privacyNotice` is the
 * current one (`currentPrivacyNotice()`, or the one `of(form)` offers).
 *
 * A form takes claims while it is open (`isOpen`) and available: its inbox is an
 * approved Finance inbox and a privacy notice exists for participants to acknowledge.
 * The Draft gate, the start page and the admin's Open now follow this one rule.
 */
export function refusal(
  form: FormWithTemplate,
  privacyNotice: PrivacyNotice | null,
  now: Date = new Date(),
): Refusal {
  if (!isOpen(form, now)) return CLOSED;
  if (!recipientApproved(form.recipient)) return UNAPPROVED_RECIPIENT;
  if (privacyNotice === null) return NO_PRIVACY_NOTICE;
  return "";
}

/** Whether `form` takes new claims now. */
export async function accepting(form: FormWithTemplate): Promise<boolean> {
  return !refusal(form, await currentPrivacyNotice());
}

/** The claim's record of `form` and the `terms` its participant accepted. */
export function snapshot(form: FormWithTemplate, terms: Terms): Record<string, unknown> {
  return {
    name: form.name,
    slug: form.slug,
    template: form.template.name,
    internal_values: internalValues(form),
    recipient: form.recipient,
    support_email: form.supportEmail,
    declaration: terms.declaration,
    declaration_version: terms.declarationVersion,
    privacy_version: terms.privacyVersion,
    mileage_rate: terms.mileageRate,
    revision: terms.revision,
    // The PDF and the emails use the language the participant saw.
    language: language(),
  };
}
