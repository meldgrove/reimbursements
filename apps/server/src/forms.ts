/**
 * The participant's claim details (ClaimForm in portal/forms.py of the Django
 * version), with Django's form semantics: each field is cleaned in order,
 * then the form-wide rules run on the fields that passed. Errors are keyed by
 * field name in that order, with Django's messages in the active language.
 */
import { domainToASCII } from "node:url";
import { isIP } from "node:net";
import { countries } from "@reimbursements/shared/countries";
import { isValidBic, isValidIban } from "./bank-accounts";
import { language, t } from "./i18n";
import type { FieldErrors } from "./intake";
import type { Terms } from "./services/terms";

/** IBAN countries in the SEPA scheme. Other IBANs also need a BIC for the transfer. */
export const SEPA_COUNTRIES: ReadonlySet<string> = new Set(
  "AD AT BE BG CH CY CZ DE DK EE ES FI FR GB GI GR HR HU IE IS IT LI LT LU LV MC MT NL NO PL PT RO SE SI SK SM VA".split(
    " ",
  ),
);
const POSTAL_CODE_FORMATS: Readonly<Record<string, [RegExp, string]>> = {
  DE: [/^\d{5}$/, "Please enter a five-digit postcode."],
  AT: [/^\d{4}$/, "Please enter a four-digit postcode."],
  CH: [/^\d{4}$/, "Please enter a four-digit postcode."],
};
const OTHER_POSTAL_CODE = /^[A-Za-z0-9](?:[A-Za-z0-9 -]{0,10}[A-Za-z0-9])?$/;

/** The fields of the claim details, in the order Django cleans them. */
export const CLAIM_FIELDS = [
  "full_name",
  "email",
  "street",
  "postal_code",
  "city",
  "country",
  "account_holder",
  "iban",
  "bic",
  "purpose",
  "purpose_details",
  "is_trip",
  "trip_destination",
  "trip_start",
  "trip_end",
  "declaration",
  "privacy_acknowledged",
] as const;
export type ClaimField = (typeof CLAIM_FIELDS)[number];

/** The cleaned claim details (strings, booleans, ISO dates or null). */
export type ClaimDetails = {
  full_name: string;
  email: string;
  street: string;
  postal_code: string;
  city: string;
  country: string;
  account_holder: string;
  iban: string;
  bic: string;
  purpose: string;
  purpose_details: string;
  is_trip: boolean;
  trip_destination: string;
  trip_start: string | null;
  trip_end: string | null;
  declaration: boolean;
  privacy_acknowledged: boolean;
};

class ValidationError extends Error {
  constructor(
    message: string,
    readonly code = "",
  ) {
    super(message);
  }
}

/** Number of code points, as Python's len(). */
function length(value: string): number {
  return [...value].length;
}

/** The characters Python's str.isspace() accepts. */
const PYTHON_SPACE =
  "[\\t\\n\\v\\f\\r\\u001c-\\u001f \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const STRIP = new RegExp(`^${PYTHON_SPACE}+|${PYTHON_SPACE}+$`, "g");

/** Python's str.strip(): Unicode whitespace at both ends. */
export function strip(value: string): string {
  return value.replace(STRIP, "");
}

/** Letters in any script, with spaces, hyphens, apostrophes and dots between them. */
export function validatePersonName(value: string, extra = ""): void {
  const allowed = new Set([..." -'’.", ...extra]);
  let letters = 0;
  let valid = true;
  for (const character of value) {
    if (/\p{L}/u.test(character)) letters += 1;
    if (!/[\p{L}\p{M}]/u.test(character) && !allowed.has(character)) valid = false;
  }
  if (letters < 2 || !valid)
    throw new ValidationError(t("Please enter the name using only letters, spaces, hyphens or apostrophes."));
}

// Django's EmailValidator (django/core/validators.py).
const EMAIL_USER =
  // eslint-disable-next-line no-control-regex
  /^(?:[-!#$%&'*+/=?^_`{}|~0-9A-Z]+(?:\.[-!#$%&'*+/=?^_`{}|~0-9A-Z]+)*|"(?:[\x01-\x08\x0b\x0c\x0e-\x1f!#-[\]-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])*")$/i;
const EMAIL_DOMAIN = /^((?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+)(?:[A-Z0-9-]{2,63}(?<!-))$/i;
const EMAIL_LITERAL = /^\[([A-F0-9:.]+)\]$/i;

function validDomainPart(domain: string): boolean {
  if (EMAIL_DOMAIN.test(domain)) return true;
  const literal = EMAIL_LITERAL.exec(domain);
  return Boolean(literal && isIP(literal[1]!) !== 0);
}

/** Whether Django's EmailValidator accepts `value`. */
export function validEmail(value: string): boolean {
  if (!value || !value.includes("@") || length(value) > 320) return false;
  const at = value.lastIndexOf("@");
  const user = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!EMAIL_USER.test(user)) return false;
  if (domain === "localhost" || validDomainPart(domain)) return true;
  // A possible IDN domain part.
  const ascii = domainToASCII(domain);
  return Boolean(ascii) && validDomainPart(ascii);
}

const required = () => new ValidationError(t("This field is required."), "required");

/** Django's CharField validators after the value is cleaned: max length, null characters. */
function charValidators(value: string, maxLength: number): ValidationError[] {
  const errors: ValidationError[] = [];
  if (length(value) > maxLength)
    errors.push(
      new ValidationError(
        t("Ensure this value has at most {limit_value} characters (it has {show_value}).", {
          limit_value: maxLength,
          show_value: length(value),
        }),
        "max_length",
      ),
    );
  if (value.includes("\u0000"))
    errors.push(new ValidationError(t("Null characters are not allowed."), "null_characters_not_allowed"));
  return errors;
}

type Cleaner = (raw: unknown) => unknown;

function charField(maxLength: number, isRequired = true): Cleaner {
  return (raw) => {
    const value = raw === undefined || raw === null ? "" : strip(String(raw));
    if (!value) {
      if (isRequired) throw [required()];
      return "";
    }
    const errors = charValidators(value, maxLength);
    if (errors.length) throw errors;
    return value;
  };
}

function emailField(maxLength: number): Cleaner {
  return (raw) => {
    const value = raw === undefined || raw === null ? "" : strip(String(raw));
    if (!value) throw [required()];
    const errors: ValidationError[] = [];
    if (!validEmail(value)) errors.push(new ValidationError(t("Enter a valid email address."), "invalid"));
    errors.push(...charValidators(value, maxLength));
    if (errors.length) throw errors;
    return value;
  };
}

function choiceField(choices: () => readonly string[]): Cleaner {
  return (raw) => {
    const value = raw === undefined || raw === null || raw === "" ? "" : String(raw);
    if (!value) throw [required()];
    if (!choices().includes(value))
      throw [
        new ValidationError(
          t("Select a valid choice. {value} is not one of the available choices.", { value }),
          "invalid_choice",
        ),
      ];
    return value;
  };
}

/** Django's CheckboxInput: "true"/"false" strings, else the value's truth. */
function checkbox(raw: unknown): boolean {
  if (raw === undefined) return false;
  if (typeof raw === "string") {
    const lowered = raw.toLowerCase();
    if (lowered === "true") return true;
    if (lowered === "false") return false;
    return raw !== "";
  }
  return Boolean(raw);
}

function booleanField(isRequired: boolean): Cleaner {
  return (raw) => {
    const value = checkbox(raw);
    if (!value && isRequired) throw [required()];
    return value;
  };
}

const DATE = /^(\d{4})-(1[0-2]|0[1-9]|[1-9])-(3[01]|[12]\d|0[1-9]|[1-9]| [1-9])$/;

/** An ISO date (YYYY-MM-DD) as Python's strptime("%Y-%m-%d") reads it, or null. */
export function parseIsoDate(value: string): string | null {
  const match = DATE.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3]!.trim())];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1 || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function dateField(): Cleaner {
  return (raw) => {
    if (raw === undefined || raw === null || raw === "") return null;
    const value = strip(String(raw));
    if (!value) return null;
    const parsed = parseIsoDate(value);
    if (!parsed) throw [new ValidationError(t("Enter a valid date."), "invalid")];
    return parsed;
  };
}

/** The result of cleaning the claim details. */
export type ClaimFormResult = {
  errors: FieldErrors;
  /** The values that passed, as Django's cleaned_data. */
  cleaned: Partial<ClaimDetails>;
};

/**
 * Cleans the claim details in `data` (text values, and booleans for the
 * checkboxes) under a form's `terms`. With mileage rows, or without travel
 * details, the trip fields are not read.
 */
export function cleanClaimForm(
  data: Readonly<Record<string, unknown>>,
  terms: Terms,
  hasMileage = false,
): ClaimFormResult {
  const errors: FieldErrors = {};
  const cleaned: Record<string, unknown> = {};
  const addError = (field: string, error: ValidationError) => {
    (errors[field] ??= []).push({ message: error.message, code: error.code });
    delete cleaned[field];
  };
  const options = terms.purposeOptions;
  const fixedPurpose = terms.fixedPurpose;
  const travel = terms.travel;
  const tripDisabled = hasMileage || travel === "off" || (travel === "optional" && !data.is_trip);
  const countryCodes = () => countries(language()).map(([code]) => code);

  const fields: Array<[ClaimField, Cleaner, { disabled?: boolean; initial?: unknown }?]> = [
    ["full_name", charField(200)],
    ["email", emailField(254)],
    ["street", charField(200)],
    ["postal_code", charField(12)],
    ["city", charField(100)],
    ["country", choiceField(countryCodes)],
    ["account_holder", charField(200)],
    ["iban", charField(60)],
    ["bic", charField(20, false)],
    fixedPurpose
      ? ["purpose", charField(3000), { disabled: true, initial: fixedPurpose }]
      : options.length
        ? ["purpose", choiceField(() => options)]
        : ["purpose", charField(3000)],
    ["purpose_details", charField(3000, false)],
    ["is_trip", booleanField(false)],
    ["trip_destination", charField(200, false), { disabled: tripDisabled }],
    ["trip_start", dateField(), { disabled: tripDisabled }],
    ["trip_end", dateField(), { disabled: tripDisabled }],
    ["declaration", booleanField(true)],
    ["privacy_acknowledged", booleanField(true)],
  ];
  const fieldCleaners: Partial<Record<ClaimField, (value: unknown) => unknown>> = {
    full_name: (value) => {
      const name = strip(String(value));
      validatePersonName(name);
      return name;
    },
    account_holder: (value) => {
      const name = strip(String(value));
      validatePersonName(name, "&,");
      return name;
    },
    postal_code: (value) => strip(String(value)).toUpperCase(),
    iban: (value) => {
      const iban = String(value).replaceAll(" ", "").replaceAll(" ", "").toUpperCase();
      if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban) || !isValidIban(iban))
        throw new ValidationError(t("Please enter a valid IBAN."));
      return iban;
    },
    bic: (value) => {
      const bic = String(value).replaceAll(" ", "").toUpperCase();
      if (bic && !isValidBic(bic))
        throw new ValidationError(t("Please enter a valid BIC with 8 or 11 characters."));
      return bic;
    },
  };

  for (const [name, clean, options_ = {}] of fields) {
    const raw = options_.disabled ? (options_.initial ?? null) : data[name];
    try {
      let value = clean(raw);
      const extra = fieldCleaners[name];
      if (extra) value = extra(value);
      cleaned[name] = value;
    } catch (thrown) {
      const list = Array.isArray(thrown) ? thrown : [thrown];
      for (const error of list) {
        if (error instanceof ValidationError) addError(name, error);
        else throw error;
      }
    }
  }

  // The form-wide rules (ClaimForm.clean).
  const country = cleaned.country as string | undefined;
  const postalCode = cleaned.postal_code as string | undefined;
  if (country && postalCode) {
    const [pattern, text] = POSTAL_CODE_FORMATS[country] ?? [
      OTHER_POSTAL_CODE,
      "Please enter a valid postcode.",
    ];
    if (!pattern.test(postalCode)) addError("postal_code", new ValidationError(t(text)));
  }
  const account = cleaned.iban as string | undefined;
  if (account && !SEPA_COUNTRIES.has(account.slice(0, 2)) && !cleaned.bic)
    addError("bic", new ValidationError(t("Accounts outside the SEPA area need a BIC.")));
  if (!options.length && "purpose_details" in cleaned) cleaned.purpose_details = "";
  const travelRequired =
    !hasMileage && travel !== "off" && (travel === "required" || Boolean(cleaned.is_trip));
  if (!travelRequired) {
    cleaned.trip_destination = "";
    cleaned.trip_start = null;
    cleaned.trip_end = null;
    return { errors, cleaned: cleaned as Partial<ClaimDetails> };
  }
  if (!String(cleaned.trip_destination ?? "").trim())
    addError("trip_destination", new ValidationError(t("Please enter the destination.")));
  const start = cleaned.trip_start as string | null | undefined;
  const end = cleaned.trip_end as string | null | undefined;
  if (!start || !end) addError("trip_end", new ValidationError(t("Please enter both trip dates.")));
  else if (start > end) addError("trip_end", new ValidationError(t("The trip cannot end before it starts.")));
  return { errors, cleaned: cleaned as Partial<ClaimDetails> };
}
