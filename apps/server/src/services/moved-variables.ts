/**
 * Settings that versions up to 0.5.0 read from the environment and that now live in the
 * database (meldgrove-master docs/settings.md, "Moving a setting out of .env"):
 * MailerSend's API token and webhook signing secret and the two addresses moved to
 * Admin > Email, the operator's name and legal page to Admin > General. Each process
 * copies them into the settings once (environment-import.ts) and never reads them again.
 *
 * The pages, `cli settings list` and one warning at start name the variables that are
 * still set, so the operator can delete them once a rollback to 0.4, which reads them,
 * is no longer planned.
 */
import { config } from "../config";
import { logger } from "../logger";
import type { SettingName } from "./settings-audit";

/** The variables and the setting each moved to. */
export const MOVED_VARIABLES = {
  MAILERSEND_API_TOKEN: "email",
  MAILERSEND_WEBHOOK_SIGNING_SECRET: "email",
  MAIL_FROM_ADDRESS: "email",
  MAIL_REPLY_TO_ADDRESS: "email",
  PORTAL_OPERATOR: "general",
  PORTAL_LEGAL_URL: "general",
} as const satisfies Record<string, SettingName>;
export type MovedVariable = keyof typeof MOVED_VARIABLES;

const PAGES: Record<SettingName, string> = {
  email: "Admin > Email",
  general: "Admin > General",
  appearance: "Admin > Appearance",
};

/** The moved variables this process sees, with their values; blank ones count as unset. */
export function movedVariablesSet(): [MovedVariable, string][] {
  const settings = config();
  return (Object.keys(MOVED_VARIABLES) as MovedVariable[])
    .map((name): [MovedVariable, string] => [name, (settings[name] ?? "").trim()])
    .filter(([, value]) => value !== "");
}

/** The moved variables that are still set (of `setting`, or all), in a fixed order. */
export function leftoverVariables(setting?: SettingName): MovedVariable[] {
  return movedVariablesSet()
    .map(([name]) => name)
    .filter((name) => !setting || MOVED_VARIABLES[name] === setting);
}

/**
 * When the operator may delete the variables: 0.4 and 0.5.0 read them, and 0.4's
 * compose.yaml, which a server may still use with this version, requires the email
 * variables.
 */
export const DELETE_WHEN =
  "once a rollback to 0.5.0 or older is no longer planned and compose.yaml is no longer 0.4's, which requires the email variables";

/** What the page of `setting` says about its variables that are still set; "" for none. */
export function environmentNote(setting: SettingName): string {
  const names = leftoverVariables(setting);
  if (names.length === 0) return "";
  const [verb, pronoun] = names.length === 1 ? ["is", "it"] : ["are", "them"];
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${list} ${verb} still set in the environment. The app no longer reads ${pronoun}: this page holds the setting. Delete ${pronoun} from .env ${DELETE_WHEN}.`;
}

/** One warning at start that names the moved variables still set (never their values). */
export function warnAboutLeftovers(): void {
  const names = leftoverVariables();
  if (names.length === 0) return;
  const pages = [...new Set(names.map((name) => PAGES[MOVED_VARIABLES[name]]))].join(" and ");
  logger.warn(
    { variables: names },
    `variables no longer read: their settings are under ${pages}. Delete them from .env ${DELETE_WHEN}`,
  );
}
