import { Hono, type Context } from "hono";
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
import type {
  AppearancePage,
  GeneralSettingsForm,
  GeneralSettingsPage,
} from "@reimbursements/shared/api/admin";
import type { GeneralSettings } from "@reimbursements/shared/api/meta";
import { config } from "../../config";
import type { AppEnv } from "../../http/env";
import { badRequest, validationError } from "../../http/errors";
import { requireTemplateAdmin } from "../../http/middleware";
import {
  faviconType,
  loadSettings,
  MAX_FAVICON_BYTES,
  saveSettings,
  setFavicon,
} from "../../services/app-settings";
import { body } from "./common";

/**
 * The Admin group's General and Appearance pages (AppSettingsAdmin and
 * AppearanceAdmin of portal/admin.py), for template admins: the app
 * language, timezone, date and number format, the running version; the
 * accent color and the favicon. Both are parts of the one settings row.
 */
const router = new Hono<AppEnv>();

function generalPage(settings: GeneralSettings): GeneralSettingsPage {
  return {
    settings: {
      language: settings.language,
      timezone: settings.timezone,
      dateFormat: settings.dateFormat,
      numberFormat: settings.numberFormat,
    },
    choices: {
      languages: LANGUAGES.map(([value, label]) => ({ value, label })),
      timezones: timezoneNames().map((name) => ({ value: name, label: name.replaceAll("_", " ") })),
      dateFormats: Object.values(DATE_FORMATS).map((format) => ({ value: format.code, label: format.label })),
      numberFormats: Object.values(NUMBER_FORMATS).map((format) => ({
        value: format.code,
        label: format.label,
      })),
    },
    version: config().APP_VERSION || "Built from source",
  };
}

router.get("/admin/settings/general", async (c) => {
  await requireTemplateAdmin(c);
  return c.json(generalPage(await loadSettings()));
});

const choiceError = (value: unknown) =>
  `Select a valid choice. ${typeof value === "string" ? value : ""} is not one of the available choices.`;

router.put("/admin/settings/general", async (c) => {
  await requireTemplateAdmin(c);
  const input = (await body(c)) as Partial<GeneralSettingsForm>;
  const errors: Record<string, string> = {};
  if (!isLanguage(input.language)) errors.language = choiceError(input.language);
  if (
    typeof input.timezone !== "string" ||
    !timezoneNames().includes(input.timezone) ||
    !isTimezone(input.timezone)
  )
    errors.timezone = choiceError(input.timezone);
  if (!isDateFormat(input.dateFormat)) errors.dateFormat = choiceError(input.dateFormat);
  if (!isNumberFormat(input.numberFormat)) errors.numberFormat = choiceError(input.numberFormat);
  if (Object.keys(errors).length > 0) throw validationError(errors, "Please correct the errors below.");
  const saved = await saveSettings({
    language: input.language!,
    timezone: input.timezone!,
    dateFormat: input.dateFormat as DateFormatCode,
    numberFormat: input.numberFormat as NumberFormatCode,
  });
  return c.json({ ...generalPage(saved), message: "The general settings were saved." });
});

function appearancePage(settings: GeneralSettings, warning?: string): AppearancePage {
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

router.get("/admin/settings/appearance", async (c) => {
  await requireTemplateAdmin(c);
  return c.json(appearancePage(await loadSettings()));
});

/** The Appearance form: JSON, or multipart with the new favicon as `favicon`. */
async function appearanceInput(c: Context<AppEnv>) {
  const type = c.req.header("content-type") ?? "";
  if (type.startsWith("multipart/form-data")) {
    let form: Record<string, string | File>;
    try {
      form = (await c.req.parseBody()) as Record<string, string | File>;
    } catch {
      throw badRequest("The upload could not be read.");
    }
    const file = form.favicon;
    return {
      accentColor: typeof form.accentColor === "string" ? form.accentColor : "",
      removeFavicon: form.removeFavicon === "true" || form.removeFavicon === "on",
      favicon: file instanceof File && file.size > 0 ? file : null,
    };
  }
  const input = await body(c);
  return {
    accentColor: typeof input.accentColor === "string" ? input.accentColor : "",
    removeFavicon: input.removeFavicon === true,
    favicon: null,
  };
}

router.post("/admin/settings/appearance", async (c) => {
  await requireTemplateAdmin(c);
  const input = await appearanceInput(c);
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
  let saved = await saveSettings({ accentColor: accent });
  if (favicon) saved = await setFavicon(favicon.content, favicon.type);
  else if (input.removeFavicon) saved = await setFavicon(Buffer.alloc(0));
  const warning =
    accent && hardToRead(accent)
      ? `Links in ${accent} are hard to read on white. A darker color reads better.`
      : undefined;
  return c.json({ ...appearancePage(saved, warning), message: "The appearance settings were saved." });
});

export default router;
