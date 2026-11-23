import { AsyncLocalStorage } from "node:async_hooks";
import * as dates from "@reimbursements/shared/dates";
import { translate, type Language, type TextValues } from "@reimbursements/shared/i18n";
import * as numbers from "@reimbursements/shared/numbers";

/**
 * The language, timezone, date and number format the code running now
 * writes in (portal/i18n and portal/app_settings.py of the Django version).
 *
 * A request runs in the General settings it loaded (http/middleware.ts:
 * public pages in the app language, the admin area in English); the worker
 * runs a claim's PDF and emails in the claim's language (`forClaim` in
 * services/app-settings.ts). Outside both, texts are German and the formats
 * the defaults, as in the Django version.
 */
export type Applied = {
  language: Language;
  timezone: string;
  dateFormat: dates.DateFormatCode;
  numberFormat: numbers.NumberFormatCode;
};

export const DEFAULT_APPLIED: Applied = {
  language: "de",
  timezone: dates.DEFAULT_TIMEZONE,
  dateFormat: dates.DEFAULT_DATE_FORMAT,
  numberFormat: numbers.DEFAULT_NUMBER_FORMAT,
};

const storage = new AsyncLocalStorage<Applied>();

/** Runs `fn` with these settings applied. */
export function withApplied<T>(applied: Applied, fn: () => T): T {
  return storage.run(applied, fn);
}

/** The settings applied now. */
export function applied(): Applied {
  return storage.getStore() ?? DEFAULT_APPLIED;
}

/** The active language: de or en. */
export function language(): Language {
  return applied().language;
}

/** `text` in the active language, with `{name}` placeholders filled from `values`. */
export function t(text: string, values?: TextValues): string {
  return translate(language(), text, values);
}

/** A calendar date (YYYY-MM-DD or a Date of that day) in the app date format. */
export function formatDate(value: string | Date | null | undefined): string {
  return dates.formatDate(value, applied().dateFormat);
}

/** The calendar date of an instant in the app timezone. */
export function formatInstantDate(instant: Date | string): string {
  return dates.formatInstantDate(instant, applied().dateFormat, applied().timezone);
}

/** An instant with time in the app timezone, e.g. 31.12.2099, 23:30 (Django's DATETIME_FORMAT). */
export function formatDateTime(instant: Date | string): string {
  return dates.formatDateTime(instant, applied().dateFormat, applied().timezone);
}

/** An instant with time, without the comma: 31.12.2099 23:30 (Django's SHORT_DATETIME_FORMAT). */
export function formatShortDateTime(instant: Date | string): string {
  return dates.formatShortDateTime(instant, applied().dateFormat, applied().timezone);
}

/** The zone's abbreviation at an instant in the app timezone, e.g. CET. */
export function zoneName(instant: Date | string): string {
  return dates.zoneName(instant, applied().timezone);
}

/** An amount with two decimals and the app's decimal separator (Django's floatformat:2). */
export function formatAmount(value: string | number | null | undefined, places = 2): string {
  return numbers.formatAmount(value, applied().numberFormat, { places });
}
