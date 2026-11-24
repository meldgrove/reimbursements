import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  isDateFormat,
  isTimezone,
  DEFAULT_DATE_FORMAT,
  DEFAULT_TIMEZONE,
} from "@reimbursements/shared/dates";
import { isLanguage, type Language } from "@reimbursements/shared/i18n";
import { DEFAULT_NUMBER_FORMAT, isNumberFormat } from "@reimbursements/shared/numbers";
import type { GeneralSettings } from "@reimbursements/shared/api/meta";
import { appSettings } from "../db/schema";
import { q } from "../db/tx";
import { withApplied, type Applied } from "../i18n";

/**
 * The General and Appearance settings: one row (id 1) for the whole app
 * (portal/app_settings.py and AppSettings of the Django version).
 *
 * The admin area is always English. Public pages, emails to participants and
 * Finance and the claim PDF use the app language; a claim keeps the language
 * its participant saw. Every page, email and PDF shows times in the app
 * timezone, dates in the app date format and amounts in the app number
 * format. The Appearance settings (accent color, favicon) apply to pages only.
 * The operator's name and legal page appear in the footer of public pages.
 */

export const SETTINGS_ID = 1;
export const MAX_FAVICON_BYTES = 100_000;
export const MAX_OPERATOR_LENGTH = 200;
export const MAX_LEGAL_URL_LENGTH = 500;
/** Paths that are always English, whatever the app language. */
export const ADMIN_PATHS = ["/admin/", "/admin", "/oidc/", "/api/v1/admin/"];

export const DEFAULT_SETTINGS: GeneralSettings = {
  language: "de",
  timezone: DEFAULT_TIMEZONE,
  dateFormat: DEFAULT_DATE_FORMAT,
  numberFormat: DEFAULT_NUMBER_FORMAT,
  accentColor: "",
  faviconDigest: "",
  faviconType: "",
  operator: "",
  legalUrl: "",
};

/** The saved settings, or the defaults while none are saved. The favicon image loads only when used. */
export async function loadSettings(): Promise<GeneralSettings> {
  const [row] = await q()
    .select({
      language: appSettings.language,
      timezone: appSettings.timezone,
      dateFormat: appSettings.dateFormat,
      numberFormat: appSettings.numberFormat,
      accentColor: appSettings.accentColor,
      faviconDigest: appSettings.faviconDigest,
      faviconType: appSettings.faviconType,
      operator: appSettings.operator,
      legalUrl: appSettings.legalUrl,
    })
    .from(appSettings)
    .where(eq(appSettings.id, SETTINGS_ID));
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    language: isLanguage(row.language) ? row.language : "de",
    timezone: row.timezone,
    dateFormat: isDateFormat(row.dateFormat) ? row.dateFormat : DEFAULT_DATE_FORMAT,
    numberFormat: isNumberFormat(row.numberFormat) ? row.numberFormat : DEFAULT_NUMBER_FORMAT,
    accentColor: row.accentColor,
    faviconDigest: row.faviconDigest,
    faviconType: row.faviconType,
    operator: row.operator,
    legalUrl: row.legalUrl,
  };
}

/** Whether the settings row exists, that is, whether anything was ever saved. */
export async function settingsSaved(): Promise<boolean> {
  const [row] = await q()
    .select({ id: appSettings.id })
    .from(appSettings)
    .where(eq(appSettings.id, SETTINGS_ID));
  return Boolean(row);
}

const CHANGEABLE = [
  "language",
  "timezone",
  "dateFormat",
  "numberFormat",
  "accentColor",
  "operator",
  "legalUrl",
] as const;

export type SettingsChanges = Partial<Pick<GeneralSettings, (typeof CHANGEABLE)[number]>>;

/** A new favicon (`content` empty: back to the standard one). */
export type FaviconChange = { content: Buffer; type?: string };

/**
 * Saves changes to the settings row in one statement, creating it with the
 * defaults first. Only the given settings change, so a save of the General
 * page and one of the Appearance page do not undo each other. Validates
 * nothing: callers do.
 */
export async function saveSettings(
  changes: SettingsChanges,
  favicon?: FaviconChange,
): Promise<GeneralSettings> {
  const set: Partial<typeof appSettings.$inferInsert> = {};
  for (const key of CHANGEABLE)
    if (changes[key] !== undefined) (set as Record<string, unknown>)[key] = changes[key];
  if (favicon) {
    const { content } = favicon;
    set.favicon = content;
    set.faviconType = content.length > 0 ? (favicon.type ?? "") : "";
    set.faviconDigest =
      content.length > 0 ? createHash("sha256").update(content).digest("hex").slice(0, 16) : "";
  }
  await q()
    .insert(appSettings)
    .values({
      id: SETTINGS_ID,
      language: DEFAULT_SETTINGS.language,
      timezone: DEFAULT_SETTINGS.timezone,
      dateFormat: DEFAULT_SETTINGS.dateFormat,
      numberFormat: DEFAULT_SETTINGS.numberFormat,
      accentColor: DEFAULT_SETTINGS.accentColor,
      operator: DEFAULT_SETTINGS.operator,
      legalUrl: DEFAULT_SETTINGS.legalUrl,
      favicon: Buffer.alloc(0),
      faviconType: "",
      faviconDigest: "",
      ...set,
    })
    .onConflictDoUpdate({ target: appSettings.id, set: { ...set, updatedAt: new Date() } });
  return loadSettings();
}

/** The operator's name as the General page takes it: one line, stripped, or its error. */
export function operatorProblem(value: string): string {
  if (/[\r\n\0]/.test(value)) return "Write the name on one line.";
  const length = [...value].length;
  if (length > MAX_OPERATOR_LENGTH)
    return `Ensure this value has at most ${MAX_OPERATOR_LENGTH} characters (it has ${length}).`;
  return "";
}

/** The legal page's address as the General page takes it (an http or https URL), or its error. */
export function legalUrlProblem(value: string): string {
  if (!value) return "";
  if (value.length > MAX_LEGAL_URL_LENGTH)
    return `Ensure this value has at most ${MAX_LEGAL_URL_LENGTH} characters (it has ${value.length}).`;
  if (!/^https?:\/\/[^\s]+$/i.test(value) || !URL.canParse(value) || !new URL(value).hostname) {
    return "Enter a full address such as https://example.invalid/imprint.";
  }
  return "";
}

/** Uses `content` as the favicon; empty content restores the standard one. */
export async function setFavicon(content: Buffer, mediaType = ""): Promise<GeneralSettings> {
  return saveSettings({}, { content, type: mediaType });
}

/** The favicon image and its type, or null for the standard one. */
export async function loadFavicon(): Promise<{ content: Buffer; type: string; digest: string } | null> {
  const [row] = await q()
    .select({
      content: appSettings.favicon,
      type: appSettings.faviconType,
      digest: appSettings.faviconDigest,
    })
    .from(appSettings)
    .where(eq(appSettings.id, SETTINGS_ID));
  return row && row.digest && row.content.length > 0 ? row : null;
}

/**
 * The media type of a PNG, ICO, SVG or WebP favicon, or null for anything
 * else. Browsers decode favicons themselves, so the server only checks the
 * format and never parses the image.
 */
export function faviconType(content: Buffer): string | null {
  if (content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png";
  if (content.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) return "image/x-icon";
  if (
    content.subarray(0, 4).toString("latin1") === "RIFF" &&
    content.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content).replace(/^\u{FEFF}/u, "");
  } catch {
    return null;
  }
  if (text.trimStart().startsWith("<") && /<svg[\s>]/.test(text.slice(0, 4096))) return "image/svg+xml";
  return null;
}

/** The language of a request: English in the admin area, the app language elsewhere. */
export function requestLanguage(path: string, general: Pick<GeneralSettings, "language">): Language {
  return ADMIN_PATHS.some(
    (prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`),
  )
    ? "en"
    : general.language;
}

/** The applied settings of `general` in `language`. */
export function appliedOf(general: GeneralSettings, language: Language): Applied {
  return {
    language,
    timezone: isTimezone(general.timezone) ? general.timezone : DEFAULT_TIMEZONE,
    dateFormat: general.dateFormat,
    numberFormat: general.numberFormat,
  };
}

/** Runs `fn` in the settings of `general` and `language`. */
export function applied<T>(general: GeneralSettings, language: Language, fn: () => T): T {
  return withApplied(appliedOf(general, language), fn);
}

/** Runs `fn` in the settings for the PDF and emails of `claim`. Older claims were all German. */
export async function forClaim<T>(
  claim: { snapshot: Record<string, unknown> },
  fn: () => Promise<T>,
): Promise<T> {
  const language = claim.snapshot.language;
  return applied(await loadSettings(), isLanguage(language) ? language : "de", fn);
}
