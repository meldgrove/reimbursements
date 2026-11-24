/**
 * The one-time import of the settings that versions up to 0.5.0 read from the
 * environment (moved-variables.ts). Every process (web, worker, migrate, the operator
 * command) copies each moved variable it sees into the settings when they have no value
 * for it yet, with the checks of the admin pages, and remembers the variable in
 * `portal_environmentimport`. A remembered variable is never read again: the settings
 * win from then on, also after an admin clears the field.
 */
import { inArray } from "drizzle-orm";
import { isEmail } from "@reimbursements/shared/email";
import { environmentImports } from "../db/schema";
import { atomic, q } from "../db/tx";
import { logger } from "../logger";
import {
  legalUrlProblem,
  loadSettings,
  operatorProblem,
  saveSettings,
  type SettingsChanges,
} from "./app-settings";
import * as emailConnection from "./email-connection";
import { charField, MAX_ADDRESS_LENGTH, MAX_SECRET_LENGTH } from "./email-settings";
import {
  MOVED_VARIABLES,
  movedVariablesSet,
  warnAboutLeftovers,
  type MovedVariable,
} from "./moved-variables";
import { lockSettings, recordSettingsChange, type SettingName } from "./settings-audit";

export type ImportResult = {
  /** Variables whose value went into the settings. */
  copied: MovedVariable[];
  /** Variables the settings already had a value for. */
  kept: MovedVariable[];
  /** Variables whose value the page would refuse; their field stays as it was. */
  refused: MovedVariable[];
};

/**
 * Copies the moved variables this process sees into the settings, each once (see the
 * module's comment). Processes that start together, and saves of the pages, wait for
 * each other on a lock, so a variable is imported by one of them. Each setting that changed gets an audit entry
 * with the actor `environment`. The result names variables only, never values.
 */
export async function importEnvironment(): Promise<ImportResult> {
  const result: ImportResult = { copied: [], kept: [], refused: [] };
  const given = movedVariablesSet();
  if (given.length === 0) return result;
  await atomic(async () => {
    // Also waits for a save of the pages, so the rows read below are current.
    await lockSettings();
    const done = new Set(
      (
        await q()
          .select({ variable: environmentImports.variable })
          .from(environmentImports)
          .where(
            inArray(
              environmentImports.variable,
              given.map(([name]) => name),
            ),
          )
      ).map((row) => row.variable),
    );
    const pending = given.filter(([name]) => !done.has(name));
    if (pending.length === 0) return;

    const email = await emailConnection.loadEmailSettings();
    const { id: _id, updatedAt: _updatedAt, ...stored } = email;
    let values: emailConnection.EmailSettingsValues = stored;
    const general = await loadSettings();
    const changes: SettingsChanges = {};
    const changed = new Map<SettingName, MovedVariable[]>();
    for (const [name, value] of pending) {
      const outcome = copy(name, value);
      result[outcome].push(name);
      if (outcome === "copied") {
        const setting = MOVED_VARIABLES[name];
        changed.set(setting, [...(changed.get(setting) ?? []), name]);
      }
    }

    /** Copies one variable into `values` or `changes`, as the page's field would take it. */
    function copy(name: MovedVariable, value: string): keyof ImportResult {
      switch (name) {
        case "MAILERSEND_API_TOKEN": {
          const outcome = secret("mailersendToken", value);
          // The variable chose MailerSend until now, whatever provider was saved.
          if (outcome === "refused" || values.provider === emailConnection.MAILERSEND) return outcome;
          values = { ...values, provider: emailConnection.MAILERSEND };
          return "copied";
        }
        case "MAILERSEND_WEBHOOK_SIGNING_SECRET":
          return secret("webhookSecret", value);
        case "MAIL_FROM_ADDRESS":
          return address("fromAddress", value);
        case "MAIL_REPLY_TO_ADDRESS":
          return address("replyToAddress", value);
        case "PORTAL_OPERATOR":
          if (general.operator) return "kept";
          if (operatorProblem(value)) return "refused";
          changes.operator = value;
          return "copied";
        case "PORTAL_LEGAL_URL":
          if (general.legalUrl) return "kept";
          if (legalUrlProblem(value)) return "refused";
          changes.legalUrl = value;
          return "copied";
      }
    }
    function secret(field: emailConnection.SecretName, value: string): keyof ImportResult {
      // An unreadable saved value counts as none: the app sent with the variable's.
      if (emailConnection.secretOf(email, field)) return "kept";
      if (charField(value, MAX_SECRET_LENGTH).error) return "refused";
      values = emailConnection.withSecret(values, field, value);
      return "copied";
    }
    function address(field: "fromAddress" | "replyToAddress", value: string): keyof ImportResult {
      if (email[field]) return "kept";
      if (charField(value, MAX_ADDRESS_LENGTH).error || !isEmail(value)) return "refused";
      values = { ...values, [field]: value };
      return "copied";
    }

    if (changed.has("email")) await emailConnection.saveEmailSettings(values);
    if (changed.has("general")) await saveSettings(changes);
    for (const [setting, names] of changed) {
      await recordSettingsChange(setting, { name: "environment", via: `${names.join(", ")} (environment)` });
    }
    await q()
      .insert(environmentImports)
      .values(pending.map(([name]) => ({ variable: name, copied: result.copied.includes(name) })))
      .onConflictDoNothing();
  });
  return result;
}

const REFUSED =
  "values in the environment that the admin pages refuse were not copied: enter these settings there";

/** Logs what an import did, with the variables' names only. */
export function logImport(result: ImportResult): void {
  if (result.copied.length) {
    logger.info({ variables: result.copied }, "settings copied from the environment");
  }
  if (result.refused.length) logger.warn({ variables: result.refused }, REFUSED);
}

/**
 * What every operator command does before it reads the settings, as a process start
 * does: import, then name the variables still set. Notes go to stderr; stdout is the answer.
 */
export async function importForCommand(): Promise<void> {
  for (const line of describeImport(await importEnvironment())) process.stderr.write(`${line}\n`);
  warnAboutLeftovers();
}

/** What an import did, as lines for the operator command's stderr (its stdout is the answer). */
export function describeImport(result: ImportResult): string[] {
  const lines: string[] = [];
  if (result.copied.length) lines.push(`Settings copied from the environment: ${result.copied.join(", ")}.`);
  if (result.refused.length)
    lines.push(`Not copied, the admin pages refuse their values: ${result.refused.join(", ")}.`);
  return lines;
}
