/**
 * The app number format of the General settings, for every amount the app
 * shows. European numbers have a decimal comma (1.234,56), US numbers a
 * decimal point (1,234.56). Participants may type amounts with either
 * separator (`AMOUNT_PATTERN` in the intake rules).
 *
 * Amounts are decimal strings with two places ("12.50"), as PostgreSQL
 * returns numeric columns: never floats.
 */
export type NumberFormatCode = "european" | "us";

export type NumberFormat = {
  code: NumberFormatCode;
  decimal: string;
  thousands: string;
  name: string;
  /** The choice in the General settings, e.g. "1.234,56 (European)". */
  label: string;
};

const DEFINITIONS: Record<NumberFormatCode, Omit<NumberFormat, "code" | "label">> = {
  european: { decimal: ",", thousands: ".", name: "European" },
  us: { decimal: ".", thousands: ",", name: "US" },
};

export const DEFAULT_NUMBER_FORMAT: NumberFormatCode = "european";

export const NUMBER_FORMATS: Readonly<Record<NumberFormatCode, NumberFormat>> = {
  european: {
    code: "european",
    ...DEFINITIONS.european,
    label: `1${DEFINITIONS.european.thousands}234${DEFINITIONS.european.decimal}56 (European)`,
  },
  us: {
    code: "us",
    ...DEFINITIONS.us,
    label: `1${DEFINITIONS.us.thousands}234${DEFINITIONS.us.decimal}56 (US)`,
  },
};

export function isNumberFormat(value: unknown): value is NumberFormatCode {
  return value === "european" || value === "us";
}

/** The format `code`, or the default for an unknown one (as `numbers.use` did). */
export function numberFormat(code: string | null | undefined): NumberFormat {
  return NUMBER_FORMATS[isNumberFormat(code) ? code : DEFAULT_NUMBER_FORMAT];
}

/** `amount` with the format's decimal separator, such as 12,50 for 12.50. */
export function example(code: string, amount = "12.50"): string {
  return amount.replace(".", numberFormat(code).decimal);
}

/**
 * A decimal amount with `places` decimals and the format's decimal separator,
 * without thousands separators: Django's `floatformat:2` (12,50). Rounds half
 * up on the decimal digits, without floats.
 */
export function formatAmount(
  value: string | number | null | undefined,
  code: string,
  options: { places?: number; grouping?: boolean } = {},
): string {
  if (value === null || value === undefined || value === "") return "";
  const places = options.places ?? 2;
  const fixed = toFixedDecimal(String(value), places);
  const format = numberFormat(code);
  const negative = fixed.startsWith("-");
  const [whole, fraction] = (negative ? fixed.slice(1) : fixed).split(".") as [string, string | undefined];
  const grouped = options.grouping ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, format.thousands) : whole;
  return `${negative ? "-" : ""}${grouped}${fraction !== undefined ? format.decimal + fraction : ""}`;
}

/** A decimal string rounded half up to `places` places, without floats. */
export function toFixedDecimal(value: string, places: number): string {
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(value.trim());
  if (!match) throw new Error(`Not a decimal: ${value}`);
  const sign = match[1] ?? "";
  const whole = match[2] || "0";
  const digits = (match[3] ?? "").padEnd(places + 1, "0");
  let scaled = BigInt(whole + digits.slice(0, places));
  if (Number(digits[places] ?? "0") >= 5) scaled += 1n;
  const text = scaled.toString().padStart(places + 1, "0");
  const result = places > 0 ? `${text.slice(0, -places)}.${text.slice(-places)}` : text;
  return scaled === 0n ? result : sign + result;
}

/** Cents of a decimal amount string ("12.5" -> 1250), rounded half up. */
export function toCents(value: string): bigint {
  return BigInt(toFixedDecimal(value, 2).replace(".", ""));
}

/** A cent amount as a decimal string with two places (1250 -> "12.50"). */
export function fromCents(cents: bigint | number): string {
  const value = BigInt(cents);
  const negative = value < 0n;
  const text = (negative ? -value : value).toString().padStart(3, "0");
  return `${negative ? "-" : ""}${text.slice(0, -2)}.${text.slice(-2)}`;
}
