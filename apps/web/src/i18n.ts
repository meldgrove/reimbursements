import { createContext, useCallback, useContext } from "react";
import { translate, type Language, type TextValues } from "@reimbursements/shared/i18n";

/**
 * Texts of the participant pages: in the app language of the General
 * settings (German or English), written in English with the German version
 * in @reimbursements/shared/i18n/de. The admin area is always English: its
 * pages write their texts as they are.
 *
 * `const t = useT();` then `t("Submit expenses")` or `t("Return on {date}", { date })`.
 * Keep the text a literal in the call: the German check (i18n.test.ts of the
 * shared package) finds the texts by `t("…")`.
 */
export const LanguageContext = createContext<Language>("en");

export function useLanguage(): Language {
  return useContext(LanguageContext);
}

export function useT(): (text: string, values?: TextValues) => string {
  const language = useLanguage();
  return useCallback((text: string, values?: TextValues) => translate(language, text, values), [language]);
}
