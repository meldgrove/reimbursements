/**
 * The app date format of the General settings, for every date the app shows
 * (participant pages, emails, the claim PDF and the admin area), and the app
 * timezone. Times are always shown with 24 hours.
 *
 * Codes are Django's date formats, as the database stores them.
 */
export type DateFormatCode = "d.m.Y" | "d/m/Y" | "m/d/Y" | "Y-m-d";

export type DateFormat = {
  code: DateFormatCode;
  /** The pattern of a date input, e.g. DD.MM.YYYY. */
  pattern: string;
  /** The choice in the General settings, e.g. "31.12.2026 (DD.MM.YYYY)". */
  label: string;
};

const PATTERNS: Record<DateFormatCode, string> = {
  "d.m.Y": "DD.MM.YYYY",
  "d/m/Y": "DD/MM/YYYY",
  "m/d/Y": "MM/DD/YYYY",
  "Y-m-d": "YYYY-MM-DD",
};

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

export const DEFAULT_DATE_FORMAT: DateFormatCode = "d.m.Y";
export const DEFAULT_TIMEZONE = "Europe/Berlin";

export const DATE_FORMATS: Readonly<Record<DateFormatCode, DateFormat>> = Object.fromEntries(
  (Object.keys(PATTERNS) as DateFormatCode[]).map((code) => [
    code,
    { code, pattern: PATTERNS[code], label: `${formatParts(code, 2026, 12, 31)} (${PATTERNS[code]})` },
  ]),
) as Record<DateFormatCode, DateFormat>;

export function isDateFormat(value: unknown): value is DateFormatCode {
  return typeof value === "string" && Object.hasOwn(PATTERNS, value);
}

/** The format `code`, or the default for an unknown one (as `dates.use` did). */
export function dateFormat(code: string | null | undefined): DateFormat {
  return DATE_FORMATS[isDateFormat(code) ? code : DEFAULT_DATE_FORMAT];
}

function formatParts(code: DateFormatCode, year: number, month: number, day: number): string {
  const [d, m, y] = [pad(day), pad(month), pad(year, 4)];
  switch (code) {
    case "d.m.Y":
      return `${d}.${m}.${y}`;
    case "d/m/Y":
      return `${d}/${m}/${y}`;
    case "m/d/Y":
      return `${m}/${d}/${y}`;
    case "Y-m-d":
      return `${y}-${m}-${d}`;
  }
}

/** Year, month, day, hour, minute and the zone's abbreviation of an instant in `timezone`. */
export function zonedParts(instant: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(instant);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
    hour: Number(value("hour")),
    minute: Number(value("minute")),
    second: Number(value("second")),
    zone: zoneAbbreviation(instant, timezone, value("timeZoneName")),
  };
}

/**
 * The zone's abbreviation as Django's "T" format shows it: CET/CEST and the
 * like where the zone has one, else what Intl gives (e.g. GMT+3).
 */
function zoneAbbreviation(instant: Date, timezone: string, intlName: string): string {
  if (timezone === "UTC") return "UTC";
  if (/^GMT[+-]/.test(intlName) || intlName === "GMT") {
    // en-GB names few zones; en-US knows the American ones, de the European ones.
    for (const locale of ["en-US", "de-DE", "en-AU"]) {
      const name = new Intl.DateTimeFormat(locale, { timeZone: timezone, timeZoneName: "short" })
        .formatToParts(instant)
        .find((part) => part.type === "timeZoneName")?.value;
      if (name && !/^(GMT|UTC|MEZ|MESZ|OEZ|OESZ|WEZ|WESZ)([+-]|$)/.test(name)) return name;
      if (name && locale === "de-DE") {
        const european: Record<string, string> = {
          MEZ: "CET",
          MESZ: "CEST",
          OEZ: "EET",
          OESZ: "EEST",
          WEZ: "WET",
          WESZ: "WEST",
        };
        if (european[name]) return european[name];
      }
    }
  }
  return intlName;
}

/** A calendar date (YYYY-MM-DD, as the database keeps it) in the app date format. */
export function formatDate(value: string | Date | null | undefined, code: string): string {
  if (!value) return "";
  if (value instanceof Date) {
    return formatParts(
      dateFormat(code).code,
      value.getUTCFullYear(),
      value.getUTCMonth() + 1,
      value.getUTCDate(),
    );
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  return formatParts(dateFormat(code).code, Number(match[1]), Number(match[2]), Number(match[3]));
}

/** The calendar date of an instant in `timezone`, in the app date format. */
export function formatInstantDate(instant: Date | string, code: string, timezone: string): string {
  const parts = zonedParts(new Date(instant), timezone);
  return formatParts(dateFormat(code).code, parts.year, parts.month, parts.day);
}

/** An instant as date and time (24 hours) in `timezone`: Django's DATETIME_FORMAT, e.g. 31.12.2026, 14:05. */
export function formatDateTime(instant: Date | string, code: string, timezone: string): string {
  const parts = zonedParts(new Date(instant), timezone);
  return `${formatParts(dateFormat(code).code, parts.year, parts.month, parts.day)}, ${pad(parts.hour)}:${pad(parts.minute)}`;
}

/** Django's SHORT_DATETIME_FORMAT, e.g. 31.12.2026 14:05 (the claim PDF). */
export function formatShortDateTime(instant: Date | string, code: string, timezone: string): string {
  const parts = zonedParts(new Date(instant), timezone);
  return `${formatParts(dateFormat(code).code, parts.year, parts.month, parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`;
}

/** The time of an instant in `timezone`, e.g. 14:05. */
export function formatTime(instant: Date | string, timezone: string): string {
  const parts = zonedParts(new Date(instant), timezone);
  return `${pad(parts.hour)}:${pad(parts.minute)}`;
}

/** The zone's abbreviation at an instant, e.g. CET (Django's "T"). */
export function zoneName(instant: Date | string, timezone: string): string {
  return zonedParts(new Date(instant), timezone).zone;
}

/**
 * A typed date in the app date format, or ISO (YYYY-MM-DD, the other input
 * format Django accepted), as YYYY-MM-DD; null when it is not a real date.
 */
export function parseDate(input: string, code: string): string | null {
  const text = input.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  let year: number, month: number, day: number;
  if (iso) {
    [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else {
    const format = dateFormat(code).code;
    const separator = format[1]!;
    const pieces = text.split(separator);
    if (pieces.length !== 3 || !pieces.every((piece) => /^\d{1,4}$/.test(piece))) return null;
    const order = format.split(separator) as ("d" | "m" | "Y")[];
    const byPart = Object.fromEntries(order.map((part, index) => [part, pieces[index]!]));
    if (byPart.Y!.length !== 4 || byPart.d!.length > 2 || byPart.m!.length > 2) return null;
    [year, month, day] = [Number(byPart.Y), Number(byPart.m), Number(byPart.d)];
  }
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > last) return null;
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/**
 * Every instant that shows the wall-clock time `date` `time` in `timezone`:
 * one as a rule, none in the hour the clocks skip, two in the hour they
 * repeat. Null when the date or time is malformed.
 */
export function zonedInstants(date: string, time: string, timezone: string): Date[] | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time.trim());
  if (!d || !t) return null;
  const [hour, minute, second] = [Number(t[1]), Number(t[2]), Number(t[3] ?? 0)];
  if (hour > 23 || minute > 59 || second > 59) return null;
  const wall = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), hour, minute, second);
  const offsetAt = (instant: number) => {
    const parts = zonedParts(new Date(instant), timezone);
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - instant;
  };
  // The offsets a day before and a day after cover both sides of any transition.
  const offsets = new Set([offsetAt(wall - 86_400_000), offsetAt(wall), offsetAt(wall + 86_400_000)]);
  const found = new Set<number>();
  for (const offset of offsets) {
    const instant = wall - offset;
    if (offsetAt(instant) === offset) found.add(instant);
  }
  return [...found].sort((a, b) => a - b).map((instant) => new Date(instant));
}

/**
 * The instant of a wall-clock time in `timezone` (an admin enters opening
 * times in the app timezone). For a time that does not exist (the hour the
 * clocks skip) or exists twice, the earlier offset wins; `zonedInstants`
 * tells those cases apart.
 */
export function zonedInstant(date: string, time: string, timezone: string): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time.trim());
  if (!d || !t) return null;
  const [hour, minute, second] = [Number(t[1]), Number(t[2]), Number(t[3] ?? 0)];
  if (hour > 23 || minute > 59 || second > 59) return null;
  const wall = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), hour, minute, second);
  // The zone's offset near that wall time, tried twice to settle at transitions.
  let guess = wall;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = zonedParts(new Date(guess), timezone);
    const shown = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    guess += wall - shown;
  }
  return new Date(guess);
}

/** The timezones one can choose: UTC and those named after a region and a city. */
export const TIMEZONE_REGIONS = new Set(
  "Africa America Antarctica Arctic Asia Atlantic Australia Europe Indian Pacific".split(" "),
);

/**
 * Names Python's tzdata knows and Intl does not list (aliases and newer
 * names, such as Europe/Kyiv): Django offered them, and Intl accepts them.
 */
const TZDATA_NAMES = (
  "Africa/Asmara Africa/Timbuktu America/Argentina/Buenos_Aires America/Argentina/Catamarca " +
  "America/Argentina/Cordoba America/Argentina/Jujuy America/Argentina/Mendoza America/Atikokan " +
  "America/Atka America/Ensenada America/Indiana/Indianapolis America/Kentucky/Louisville " +
  "America/Montreal America/Nipigon America/Nuuk America/Pangnirtung America/Porto_Acre " +
  "America/Rainy_River America/Santa_Isabel America/Shiprock America/Thunder_Bay America/Virgin " +
  "America/Yellowknife Asia/Chongqing Asia/Harbin Asia/Ho_Chi_Minh Asia/Istanbul Asia/Kashgar " +
  "Asia/Kathmandu Asia/Kolkata Asia/Tel_Aviv Asia/Yangon Atlantic/Faroe Atlantic/Jan_Mayen " +
  "Australia/Canberra Australia/Currie Australia/Yancowinna Europe/Belfast Europe/Kyiv " +
  "Europe/Nicosia Europe/Tiraspol Pacific/Chuuk Pacific/Johnston Pacific/Kanton Pacific/Pohnpei " +
  "Pacific/Samoa Pacific/Yap"
).split(" ");

/** The choices of the General settings, as Django's: Intl's names and tzdata's other ones it accepts. */
export function timezoneNames(): string[] {
  const all =
    (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  const known = [...all, ...TZDATA_NAMES].filter(
    (name) => TIMEZONE_REGIONS.has(name.split("/")[0]!) && isTimezone(name),
  );
  return [...new Set(["UTC", ...known])].sort();
}

export function isTimezone(value: string): boolean {
  if (value !== "UTC" && !TIMEZONE_REGIONS.has(value.split("/")[0]!)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
