/**
 * Admin > General and Admin > Appearance (AppSettingsAdmin and AppearanceAdmin of
 * portal/admin.py): what the pages show and how a save is checked. The admin routes
 * (modules/admin/settings.ts) and `cli settings` (commands/settings.ts) both call these,
 * so a setting saved either way passes the same checks and leaves the same audit entry.
 */
import {
  DATE_FORMATS,
  isDateFormat,
  isTimezone,
  timezoneNames,
  type DateFormatCode,
} from "@reimbursements/shared/dates";
import { isLanguage, LANGUAGES } from "@reimbursements/shared/i18n";
import { isNumberFormat, NUMBER_FORMATS, type NumberFormatCode } from "@reimbursements/shared/numbers";
import {
  darkAccent,
  hardToRead,
  normalize,
  STANDARD_ACCENT,
  STANDARD_DARK_ACCENT,
} from "@reimbursements/shared/theme";
import type { AppearancePage, GeneralSettingsPage } from "@reimbursements/shared/api/admin";
import type { GeneralSettings } from "@reimbursements/shared/api/meta";
import { config } from "../config";
import { atomic } from "../db/tx";
import { validationError } from "../http/errors";
import {
  faviconType,
  legalUrlProblem,
  loadSettings,
  MAX_FAVICON_BYTES,
  operatorProblem,
  saveSettings,
} from "./app-settings";
import { environmentNote } from "./moved-variables";
import { lockSettings, recordSettingsChange, type SettingsActor } from "./settings-audit";

/** The timezones of the General page: Django's list, and the stored one also when the list lacks it. */
function timezoneChoices(current: string): string[] {
  return [...new Set([...timezoneNames(), current])].filter((name) => isTimezone(name)).sort();
}

export function generalPage(settings: GeneralSettings): GeneralSettingsPage {
  return {
    settings: {
      language: settings.language,
      timezone: settings.timezone,
      dateFormat: settings.dateFormat,
      numberFormat: settings.numberFormat,
      operator: settings.operator,
      legalUrl: settings.legalUrl,
    },
    environmentNote: environmentNote("general"),
    choices: {
      languages: LANGUAGES.map(([value, label]) => ({ value, label })),
      timezones: timezoneChoices(settings.timezone).map((name) => ({
        value: name,
        label: name.replaceAll("_", " "),
      })),
      dateFormats: Object.values(DATE_FORMATS).map((format) => ({ value: format.code, label: format.label })),
      numberFormats: Object.values(NUMBER_FORMATS).map((format) => ({
        value: format.code,
        label: format.label,
      })),
    },
    version: config().APP_VERSION || "Built from source",
  };
}

const choiceError = (value: unknown) =>
  `Select a valid choice. ${typeof value === "string" ? value : ""} is not one of the available choices.`;

/**
 * Checks and saves the General page's form (PUT /admin/settings/general). `operator` and
 * `legalUrl` left out keep their saved values. Throws a 422 with the field errors.
 */
export async function saveGeneral(input: Record<string, unknown>, actor: SettingsActor) {
  return atomic(async () => {
    await lockSettings();
    const errors: Record<string, string> = {};
    if (!isLanguage(input.language)) errors.language = choiceError(input.language);
    const current = await loadSettings();
    if (typeof input.timezone !== "string" || !timezoneChoices(current.timezone).includes(input.timezone))
      errors.timezone = choiceError(input.timezone);
    if (!isDateFormat(input.dateFormat)) errors.dateFormat = choiceError(input.dateFormat);
    if (!isNumberFormat(input.numberFormat)) errors.numberFormat = choiceError(input.numberFormat);
    const text = (field: "operator" | "legalUrl") => {
      const value = input[field];
      if (value === undefined) return undefined;
      if (typeof value !== "string") {
        errors[field] = "Enter text.";
        return undefined;
      }
      return value.trim();
    };
    const operator = text("operator");
    const legalUrl = text("legalUrl");
    if (operator !== undefined && operatorProblem(operator)) errors.operator = operatorProblem(operator);
    if (legalUrl !== undefined && legalUrlProblem(legalUrl)) errors.legalUrl = legalUrlProblem(legalUrl);
    if (Object.keys(errors).length > 0) throw validationError(errors, "Please correct the errors below.");
    const saved = await saveSettings({
      language: input.language as GeneralSettings["language"],
      timezone: input.timezone as string,
      dateFormat: input.dateFormat as DateFormatCode,
      numberFormat: input.numberFormat as NumberFormatCode,
      operator,
      legalUrl,
    });
    await recordSettingsChange("general", actor);
    return saved;
  });
}

export function appearancePage(settings: GeneralSettings, warning?: string): AppearancePage {
  const custom = Boolean(settings.accentColor);
  return {
    accentColor: settings.accentColor,
    inUse: {
      custom,
      light: custom ? settings.accentColor : STANDARD_ACCENT,
      dark: custom ? darkAccent(settings.accentColor) : STANDARD_DARK_ACCENT,
    },
    favicon: settings.faviconDigest
      ? { custom: true, url: `/favicon/${settings.faviconDigest}/`, type: settings.faviconType }
      : { custom: false, url: "/favicon.svg", type: "image/svg+xml" },
    ...(warning ? { warning } : {}),
  };
}

/** The Appearance form: the accent color, and a new favicon or its removal. */
export type AppearanceInput = { accentColor: string; removeFavicon: boolean; favicon: Blob | null };

/** The Appearance form sent as JSON (AppearanceForm): the page's fields, without a new favicon. */
export function appearanceFromJson(input: Record<string, unknown>): AppearanceInput {
  return {
    accentColor: typeof input.accentColor === "string" ? input.accentColor : "",
    removeFavicon: input.removeFavicon === true,
    favicon: null,
  };
}

/**
 * Checks and saves the Appearance form (POST /admin/settings/appearance); the answer is
 * the page with a warning for a hard-to-read accent. Throws a 422 with the field errors.
 */
export async function saveAppearance(input: AppearanceInput, actor: SettingsActor): Promise<AppearancePage> {
  const errors: Record<string, string> = {};
  // A pasted code with spaces or a short code is normalized first.
  let accent = "";
  if (input.accentColor.trim()) {
    const color = normalize(input.accentColor);
    if (color === null) errors.accentColor = "Enter a hex code such as #0f766e.";
    else accent = color;
  }
  let favicon: { content: Buffer; type: string } | null = null;
  if (input.favicon) {
    if (input.favicon.size > MAX_FAVICON_BYTES) errors.favicon = "The favicon may be at most 100 KB.";
    else {
      const content = Buffer.from(await input.favicon.arrayBuffer());
      const type = faviconType(content);
      if (type === null) errors.favicon = "Upload a PNG, ICO, SVG or WebP file.";
      else favicon = { content, type };
    }
  }
  if (Object.keys(errors).length > 0) throw validationError(errors, "Please correct the errors below.");
  const saved = await atomic(async () => {
    // Accent and favicon in one statement: both change, or neither.
    const row = await saveSettings(
      { accentColor: accent },
      favicon ?? (input.removeFavicon ? { content: Buffer.alloc(0) } : undefined),
    );
    await recordSettingsChange("appearance", actor);
    return row;
  });
  const warning =
    accent && hardToRead(accent)
      ? `Links in ${accent} are hard to read on white. A darker color reads better.`
      : undefined;
  return appearancePage(saved, warning);
}
