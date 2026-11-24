/**
 * Who changes the settings of Admin > General, Appearance and Email, for the audit log:
 * an admin on the page, the operator command (`cli settings`), or the import of earlier
 * versions' environment (services/environment-import.ts). Each change is an operation
 * without a claim (portal_operation), as the retention's purges are.
 */
import { sql } from "drizzle-orm";
import { operations } from "../db/schema";
import { q } from "../db/tx";

/** The settings as the admin pages and `cli settings` name them. */
export const SETTING_NAMES = ["email", "general", "appearance"] as const;
export type SettingName = (typeof SETTING_NAMES)[number];

export type SettingsActor = {
  /** The admin's email or username, `operator` for the command, `environment` for the import. */
  name: string;
  /** Where the change came from, e.g. "Admin > Email" or "cli settings apply email". */
  via: string;
};

/** The actor of a save on an admin page. */
export function adminActor(name: string, page: string): SettingsActor {
  return { name, via: `Admin > ${page}` };
}

/**
 * Serializes changes to the settings rows until the transaction ends: a save of Admin >
 * Email or General and the import of the environment each read the row after the other
 * committed, so neither writes back a value the other just replaced.
 */
export async function lockSettings(): Promise<void> {
  await q().execute(sql`select pg_advisory_xact_lock(hashtext('reimbursements.settings'))`);
}

/** Writes the audit entry of a change to `setting`; call it in the save's transaction. */
export async function recordSettingsChange(setting: SettingName, actor: SettingsActor): Promise<void> {
  await q()
    .insert(operations)
    .values({
      action: `settings_${setting}`,
      actor: actor.name.slice(0, 254),
      reason: actor.via.slice(0, 500),
      claimId: null,
    });
}
