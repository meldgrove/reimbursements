import { DE } from "./i18n/de";

/**
 * Text in the app language, German or English.
 *
 * The admin area is always English. Public pages, emails to participants and
 * Finance and the claim PDF use the app language from the General settings.
 * Text is written in English; `DE` holds its German version. Placeholders are
 * `{name}`, filled from `values` (`{{` and `}}` stand for braces), as Python's
 * str.format did in the Django version.
 */
export type Language = "de" | "en";

export const LANGUAGES: ReadonlyArray<readonly [Language, string]> = [
  ["de", "Deutsch"],
  ["en", "English"],
];

export const CATALOGS: Readonly<Record<Language, Readonly<Record<string, string>>>> = { de: DE, en: {} };

export type TextValues = Readonly<Record<string, string | number>>;

export function isLanguage(value: unknown): value is Language {
  return value === "de" || value === "en";
}

/** Fills `{name}` placeholders; a placeholder without a value is an error, as in Python. */
export function format(text: string, values?: TextValues): string {
  if (!values) return text;
  return text.replace(/\{\{|\}\}|\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string | undefined) => {
    if (match === "{{") return "{";
    if (match === "}}") return "}";
    const value = values[name!];
    if (value === undefined) throw new Error(`Missing text value: ${name}`);
    return String(value);
  });
}

/** `text` in `language`, with its placeholders filled from `values`. */
export function translate(language: Language, text: string, values?: TextValues): string {
  return format(CATALOGS[language][text] ?? text, values);
}

/** The placeholder names of a text, for checks of the German texts. */
export function placeholders(text: string): Set<string> {
  return new Set([...text.matchAll(/(?<!\{)\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1]!));
}
