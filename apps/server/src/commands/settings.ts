/**
 * `cli settings`: Admin > Email, General and Appearance without a browser
 * (meldgrove-master docs/settings.md; docs/deployment.md, Operator commands).
 *
 * Each subcommand calls the function the admin page's route calls
 * (services/email-settings.ts, services/general-settings.ts), so a setting passes the
 * same checks, is sealed the same way and leaves the same audit entry. The command acts
 * as the operator: an actor that only this module creates, with a template admin's
 * rights, logged as `operator` with the command. Secrets come only on stdin, in the
 * JSON body the page sends; nothing prints or logs them (the pages show none either).
 * Like every process, the command first copies the variables of earlier versions into
 * the settings (services/environment-import.ts), once its arguments and body are read.
 */
import { parseArgs } from "node:util";
import { config } from "../config";
import { AppError } from "../http/errors";
import { applied, loadSettings, settingsSaved } from "../services/app-settings";
import * as emailConnection from "../services/email-connection";
import { emailPage, saveEmail, SECRET_LABELS, testEmail } from "../services/email-settings";
import {
  appearanceFromJson,
  appearancePage,
  generalPage,
  saveAppearance,
  saveGeneral,
} from "../services/general-settings";
import { importForCommand } from "../services/environment-import";
import { DELETE_WHEN, leftoverVariables } from "../services/moved-variables";
import { SETTING_NAMES, type SettingName, type SettingsActor } from "../services/settings-audit";
import { CommandError, registerCommand, UsageError } from "./registry";

const USAGE = `Usage:
  cli settings list [--json]                  every setting: set or not, hints, never a secret
  cli settings show <name>                    what the admin page shows, as JSON
  cli settings apply <name> < body.json       saves the JSON body the admin page sends
  cli settings test email --to <address>      sends the test email of Admin > Email
Names: ${SETTING_NAMES.join(", ")}. None of them is a list, so there is no --id and no remove.
Secrets go only into the body on stdin. docs/deployment.md (Operator commands) has a body for each name.`;

/** The operator: who the audit log names for a change made with `cli settings <command>`. */
function operator(command: string): SettingsActor {
  return { name: "operator", via: `cli settings ${command}` };
}

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}
function note(text: string): void {
  process.stderr.write(`${text}\n`);
}

const OPTIONS = { id: { type: "string" }, json: { type: "boolean" }, to: { type: "string" } } as const;

/** The subcommand's arguments; an unknown option, or one it does not take, is a usage error. */
function parse(args: string[], allowed: ("json" | "to")[] = []) {
  let parsed;
  try {
    parsed = parseArgs({ args, options: OPTIONS, allowPositionals: true });
  } catch {
    throw new UsageError(USAGE);
  }
  for (const key of ["json", "to"] as const) {
    if (parsed.values[key] !== undefined && !allowed.includes(key)) throw new UsageError(USAGE);
  }
  return parsed;
}

/** The one setting a subcommand names. */
function settingOf(positionals: string[], id: string | undefined): SettingName {
  const [name, ...extra] = positionals;
  if (!name || extra.length || !(SETTING_NAMES as readonly string[]).includes(name)) {
    throw new UsageError(`Name one setting: ${SETTING_NAMES.join(", ")}.`);
  }
  if (id !== undefined) throw new UsageError(`${name} is not a list: it takes no --id.`);
  return name as SettingName;
}

/** A refusal of the page (a 4xx AppError) as the operator reads it: the message and each field's. */
function refusal(error: AppError): CommandError {
  const fields = Object.entries(error.fields ?? {}).map(([field, message]) => `  ${field}: ${message}`);
  return new CommandError([error.message, ...fields].join("\n"));
}

async function asOperator<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AppError && error.status < 500) throw refusal(error);
    throw error;
  }
}

/**
 * What `show` prints for `name`: the admin API's answer for its page, with dates in the
 * saved date format and timezone, as the admin area shows them (always in English).
 */
async function shown(name: SettingName): Promise<unknown> {
  const general = await loadSettings();
  return applied(general, "en", async () => {
    if (name === "email") return emailPage(await emailConnection.loadEmailSettings(), "");
    if (name === "general") return generalPage(general);
    return appearancePage(general);
  });
}

type Summary = { name: SettingName; state: "set" | "not set" | "incomplete"; hints: string[] };

async function summary(name: SettingName): Promise<Summary> {
  if (name === "email") {
    const saved = await emailConnection.loadEmailSettings();
    const connection = await emailConnection.current(saved);
    // Whether each part is there, never its value: `show` has the values.
    const hints: string[] = [];
    if (connection.provider) hints.push(connection.name);
    if (connection.sender) hints.push("sender set");
    if (connection.replyTo) hints.push("reply address set");
    if (saved.provider === emailConnection.SMTP && saved.smtpHost) hints.push("server set");
    for (const secret of emailConnection.SECRETS) {
      if (!emailConnection.secretSaved(saved, secret)) continue;
      const label = SECRET_LABELS[secret][0].toLowerCase();
      hints.push(emailConnection.secretOf(saved, secret) === null ? `${label} unreadable` : `${label} saved`);
    }
    if (!connection.ready && connection.provider) hints.push(`missing ${connection.missing.join(", ")}`);
    const state = connection.ready ? "set" : saved.provider ? "incomplete" : "not set";
    return { name, state, hints };
  }
  const settings = await loadSettings();
  if (name === "general") {
    const hints = [
      settings.operator ? "operator set" : "no operator",
      settings.legalUrl ? "legal page set" : "no legal page",
    ];
    return { name, state: (await settingsSaved()) ? "set" : "not set", hints };
  }
  const hints = [
    settings.accentColor ? "own accent color" : "standard colors",
    settings.faviconDigest ? "own favicon" : "standard favicon",
  ];
  return { name, state: settings.accentColor || settings.faviconDigest ? "set" : "not set", hints };
}

async function list(args: string[]) {
  const { values, positionals } = parse(args, ["json"]);
  if (positionals.length || values.id !== undefined) throw new UsageError(USAGE);
  await importForCommand();
  const rows = [];
  for (const name of SETTING_NAMES)
    rows.push({ ...(await summary(name)), environment: leftoverVariables(name) });
  if (values.json) {
    out(JSON.stringify(rows, null, 2));
    return;
  }
  for (const row of rows) {
    out(`${row.name.padEnd(11)} ${row.state.padEnd(11)} ${row.hints.join(", ")}`);
    if (row.environment.length) {
      out(`${" ".repeat(24)}also still in the environment, no longer read: ${row.environment.join(", ")}`);
    }
  }
  if (rows.some((row) => row.environment.length)) {
    out(`Delete the variables still in the environment from .env ${DELETE_WHEN}.`);
  }
}

/** The JSON body on stdin, at most as large as the page may send. */
async function readBody(): Promise<unknown> {
  if (process.stdin.isTTY) {
    throw new UsageError("Pipe the JSON body into the command, e.g. cli settings apply email < body.json.");
  }
  const limit = config().MAX_REQUEST_BODY_BYTES;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit)
      throw new CommandError(`The body is larger than the ${limit / 1024} KB the page may send.`);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new UsageError("The body on stdin is not JSON.");
  }
}

/** The body as the routes of General and Appearance take it (`body()` of modules/admin/common.ts). */
function jsonObject(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  throw new CommandError("The request body must be a JSON object");
}

async function apply(args: string[]) {
  const { values, positionals } = parse(args);
  if (positionals.length > 1) {
    // Never echo them: a secret given as an argument does not belong in a log either.
    throw new UsageError("apply reads the body from stdin and takes no other arguments.");
  }
  const name = settingOf(positionals, values.id);
  // The whole body first: nothing is read or locked while stdin is open.
  const body = await readBody();
  await importForCommand();
  const actor = operator(`apply ${name}`);
  await asOperator(async () => {
    if (name === "email") await saveEmail(body, actor);
    else if (name === "general") await saveGeneral(jsonObject(body), actor);
    else {
      const page = await saveAppearance(appearanceFromJson(jsonObject(body)), actor);
      if (page.warning) note(page.warning);
    }
  });
  note(`The ${name} settings were saved.`);
  out(JSON.stringify(await shown(name), null, 2));
}

async function test(args: string[]) {
  const { values, positionals } = parse(args, ["to"]);
  const name = settingOf(positionals, values.id);
  if (name !== "email") throw new UsageError(`${name} has no test; only email has one.`);
  if (!values.to) throw new UsageError("Name the recipient: cli settings test email --to <address>.");
  const to = values.to;
  await importForCommand();
  const answer = await asOperator(() => testEmail(to));
  if (!answer.reached) throw new CommandError(answer.message);
  out(answer.message);
}

registerCommand("settings", {
  usage: "settings list|show|apply|test <name>   Admin > Email, General and Appearance (cli settings help)",
  run: async (args) => {
    const [subcommand, ...rest] = args;
    switch (subcommand) {
      case "list":
        return list(rest);
      case "show": {
        const { values, positionals } = parse(rest);
        const name = settingOf(positionals, values.id);
        await importForCommand();
        out(JSON.stringify(await shown(name), null, 2));
        return;
      }
      case "apply":
        return apply(rest);
      case "test":
        return test(rest);
      case "remove":
        settingOf(parse(rest).positionals, undefined);
        throw new UsageError("No setting of this app is a list: there is nothing to remove.");
      case "help":
        out(USAGE);
        return;
      default:
        throw new UsageError(USAGE);
    }
  },
});
