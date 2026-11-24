// `cli settings` as an operator runs it: a process of its own, the body on stdin, and the
// exit code. It saves through the admin pages' functions, as the operator.
import { spawn } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../db/client";
import { appSettings, emailSettings, environmentImports, operations } from "../db/schema";
import { loadSettings } from "../services/app-settings";
import * as confirmations from "../services/confirmations";
import { loadEmailSettings, secretOf } from "../services/email-connection";
import { SERVER_ROOT } from "../paths";
import { freshState } from "../test/back-office";
import { FakeSmtpServer } from "../test/smtp-server";

const PASSWORD = "synthetic-smtp-password-7f3a";
const TOKEN = "synthetic-mailersend-token-9c2e";

type Run = { code: number | null; stdout: string; stderr: string };

/** Runs `cli <args>` with `input` on stdin, against the test database. */
function cli(args: string[], input = "", environment: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(SERVER_ROOT, "src/cli.ts"), ...args],
      {
        cwd: SERVER_ROOT,
        // The tests' environment (test/env.ts), with logs on, as a server writes them.
        env: { ...process.env, MAIL_DELIVERY_MODE: "send", LOG_LEVEL: "debug", ...environment },
      },
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }),
    );
    child.stdin.end(input);
  });
}

/** The body the Email page sends (PUT /api/v1/admin/settings/email). */
function emailBody(changes: Record<string, unknown> = {}) {
  const confirmation: Record<string, { subject: string; body: string }> = {};
  for (const code of ["de", "en"] as const) {
    const [subject, body] = confirmations.standardTexts(code);
    confirmation[code] = { subject, body };
  }
  return JSON.stringify({
    provider: "smtp",
    fromAddress: "no-reply@example.invalid",
    replyToAddress: "finance@example.invalid",
    smtpHost: "127.0.0.1",
    smtpPort: 587,
    smtpSecurity: "none",
    smtpUsername: "kim",
    smtpPassword: PASSWORD,
    confirmationEnabled: true,
    confirmation,
    ...changes,
  });
}

let server: FakeSmtpServer | null = null;

beforeEach(async () => {
  await freshState();
  await getDb().delete(emailSettings);
});
afterEach(async () => {
  await server?.stop();
  server = null;
});

async function audit() {
  return (await getDb().select().from(operations).orderBy(operations.id)).map((row) => [
    row.action,
    row.actor,
    row.reason,
  ]);
}

describe("cli settings apply, show and list", () => {
  it("saves the Email page's body from stdin, sealed, and shows only hints", async () => {
    const applied = await cli(["settings", "apply", "email"], emailBody());
    expect(applied.code, applied.stderr).toBe(0);
    expect(applied.stderr).toContain("The email settings were saved.");
    const saved = await loadEmailSettings();
    expect([saved.provider, saved.smtpUsername, secretOf(saved, "smtpPassword")]).toEqual([
      "smtp",
      "kim",
      PASSWORD,
    ]);
    expect(saved.smtpPasswordSealed).not.toContain(PASSWORD);
    // apply prints what show prints: the page's answer, with the password's state only.
    const shown = await cli(["settings", "show", "email"]);
    expect(shown.code).toBe(0);
    expect(JSON.parse(applied.stdout)).toEqual(JSON.parse(shown.stdout));
    const page = JSON.parse(shown.stdout);
    expect(page.settings).toMatchObject({ provider: "smtp", smtpHost: "127.0.0.1", smtpUsername: "kim" });
    expect(page.secrets.smtpPassword).toMatchObject({ saved: true, deletable: true });
    expect(page.status.state).toBe("ready");
    const listed = await cli(["settings", "list"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toMatch(
      /^email +set +SMTP server, sender set, reply address set, server set, password saved$/m,
    );
    expect(listed.stdout).toMatch(/^general +not set +no operator, no legal page$/m);
    // Hints only: the values are for `show`.
    expect(listed.stdout).not.toContain("example.invalid");
    expect(listed.stdout).toMatch(/^appearance +not set +standard colors, standard favicon$/m);
    const json = JSON.parse((await cli(["settings", "list", "--json"])).stdout);
    expect(json.map((row: { name: string; state: string }) => [row.name, row.state])).toEqual([
      ["email", "set"],
      ["general", "not set"],
      ["appearance", "not set"],
    ]);
    for (const run of [applied, shown, listed]) expect(run.stdout + run.stderr).not.toContain(PASSWORD);
    expect(await audit()).toEqual([["settings_email", "operator", "cli settings apply email"]]);
  }, 60_000);

  it("keeps a saved secret that the body leaves out, as the page does", async () => {
    const body = emailBody({ provider: "mailersend", mailersendToken: TOKEN, smtpPassword: "" });
    expect((await cli(["settings", "apply", "email"], body)).code).toBe(0);
    const again = await cli(
      ["settings", "apply", "email"],
      emailBody({ provider: "mailersend", fromAddress: "other@example.invalid", smtpPassword: "" }),
    );
    expect(again.code, again.stderr).toBe(0);
    const saved = await loadEmailSettings();
    expect([saved.fromAddress, secretOf(saved, "mailersendToken")]).toEqual(["other@example.invalid", TOKEN]);
    expect(again.stdout).not.toContain(TOKEN);
  }, 60_000);

  it("refuses what the page refuses, with its message and exit code 1", async () => {
    const refused = await cli(
      ["settings", "apply", "email"],
      emailBody({ provider: "mailersend", fromAddress: "not an address", smtpPassword: "" }),
    );
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      "Please correct the errors below.\n  fromAddress: Enter a valid email address.\n  mailersendToken: Enter the MailerSend API token.",
    );
    expect(refused.stdout).toBe("");
    expect(await getDb().select().from(emailSettings)).toEqual([]);
    const general = await cli(
      ["settings", "apply", "general"],
      JSON.stringify({
        language: "de",
        timezone: "Europe/Berlin",
        dateFormat: "d.m.Y",
        numberFormat: "european",
        legalUrl: "javascript:alert(1)",
      }),
    );
    expect(general.code).toBe(1);
    expect(general.stderr).toContain(
      "legalUrl: Enter a full address such as https://example.invalid/imprint.",
    );
    expect(await audit()).toEqual([]);
  }, 60_000);

  it("saves General and Appearance as their pages do", async () => {
    const general = await cli(
      ["settings", "apply", "general"],
      JSON.stringify({
        language: "en",
        timezone: "Europe/Berlin",
        dateFormat: "Y-m-d",
        numberFormat: "us",
        operator: "Example e.V.",
        legalUrl: "https://example.invalid/imprint",
      }),
    );
    expect(general.code, general.stderr).toBe(0);
    expect(JSON.parse(general.stdout).settings).toMatchObject({
      language: "en",
      operator: "Example e.V.",
      legalUrl: "https://example.invalid/imprint",
    });
    const appearance = await cli(
      ["settings", "apply", "appearance"],
      JSON.stringify({ accentColor: "#ffff00" }),
    );
    expect(appearance.code, appearance.stderr).toBe(0);
    expect(appearance.stderr).toContain("Links in #ffff00 are hard to read on white.");
    expect(JSON.parse(appearance.stdout)).toMatchObject({ accentColor: "#ffff00", inUse: { custom: true } });
    const saved = await loadSettings();
    expect([saved.language, saved.operator, saved.accentColor]).toEqual(["en", "Example e.V.", "#ffff00"]);
    const refused = await cli(["settings", "apply", "appearance"], JSON.stringify({ accentColor: "teal" }));
    expect([refused.code, refused.stderr]).toEqual([
      1,
      "Please correct the errors below.\n  accentColor: Enter a hex code such as #0f766e.\n",
    ]);
    expect(await audit()).toEqual([
      ["settings_general", "operator", "cli settings apply general"],
      ["settings_appearance", "operator", "cli settings apply appearance"],
    ]);
    const listed = await cli(["settings", "list"]);
    expect(listed.stdout).toMatch(/^general +set +operator set, legal page set$/m);
    expect(listed.stdout).toMatch(/^appearance +set +own accent color, standard favicon$/m);
  }, 60_000);

  it("names the variables of earlier versions that are still set", async () => {
    const listed = await cli(["settings", "list"], "", { MAIL_FROM_ADDRESS: "no-reply@example.invalid" });
    expect(listed.code).toBe(0);
    // Every process imports them first; the command says so on stderr.
    expect(listed.stderr).toContain("Settings copied from the environment: MAIL_FROM_ADDRESS.");
    // And names it in the warning of every start, on stderr.
    expect(listed.stderr).toContain('"variables":["MAIL_FROM_ADDRESS"]');
    expect(listed.stderr).toContain("variables no longer read");
    expect(listed.stdout).toContain("also still in the environment, no longer read: MAIL_FROM_ADDRESS");
    expect(listed.stdout).toContain(
      "Delete the variables still in the environment from .env once a rollback to 0.5.0 or older is no longer planned and compose.yaml is no longer 0.4's, which requires the email variables.",
    );
    expect((await loadEmailSettings()).fromAddress).toBe("no-reply@example.invalid");
    const json = JSON.parse((await cli(["settings", "list", "--json"], "", { PORTAL_OPERATOR: "X" })).stdout);
    expect(json.map((row: { environment: string[] }) => row.environment)).toEqual([
      [],
      ["PORTAL_OPERATOR"],
      [],
    ]);
    expect(await getDb().select().from(appSettings)).toHaveLength(1);
  }, 60_000);
});

describe("cli settings test", () => {
  it("sends the test email through the saved SMTP server, with the saved password", async () => {
    server = await new FakeSmtpServer().start();
    server.credentials = ["kim", PASSWORD];
    expect((await cli(["settings", "apply", "email"], emailBody({ smtpPort: server.port }))).code).toBe(0);
    const sent = await cli(["settings", "test", "email", "--to", "kim@example.invalid"]);
    expect([sent.code, sent.stdout]).toEqual([
      0,
      "The SMTP server accepted the test email to kim@example.invalid.\n",
    ]);
    expect(server.received).toHaveLength(1);
    server.rcptReply = "550 No such user";
    const refused = await cli(["settings", "test", "email", "--to=kim@example.invalid"]);
    expect([refused.code, refused.stderr]).toEqual([1, "The SMTP server refused the recipient.\n"]);
    // The recipient rules of the page.
    const blocked = await cli(["settings", "test", "email", "--to", "kim@example.invalid"], "", {
      TEST_RECIPIENT_ALLOWLIST: "finance@example.invalid",
    });
    expect([blocked.code, blocked.stderr]).toEqual([
      1,
      "TEST_RECIPIENT_ALLOWLIST does not include the recipient.\n",
    ]);
    const invalid = await cli(["settings", "test", "email", "--to", "kim"]);
    expect([invalid.code, invalid.stderr]).toEqual([
      1,
      "Enter the email address for the test email.\n  to: Enter the email address for the test email.\n",
    ]);
    expect(server.received).toHaveLength(1);
    for (const run of [sent, refused, blocked, invalid])
      expect(run.stdout + run.stderr).not.toContain(PASSWORD);
  }, 60_000);
});

describe("cli settings called the wrong way", () => {
  it.each([
    [["settings"], "Usage:"],
    [["settings", "show"], "Name one setting: email, general, appearance."],
    [["settings", "show", "slack"], "Name one setting: email, general, appearance."],
    [["settings", "show", "email", "--id", "1"], "email is not a list: it takes no --id."],
    [
      ["settings", "remove", "email", "--id", "1"],
      "No setting of this app is a list: there is nothing to remove.",
    ],
    [["settings", "test", "general"], "general has no test; only email has one."],
    [["settings", "test", "email"], "Name the recipient: cli settings test email --to <address>."],
    [["settings", "list", "--verbose"], "Usage:"],
    [
      ["settings", "apply", "email", "secret-as-argument"],
      "apply reads the body from stdin and takes no other arguments.",
    ],
  ])(
    "exits with 2: %j",
    async (args, message) => {
      const run = await cli(args);
      expect([run.code, run.stdout]).toEqual([2, ""]);
      expect(run.stderr).toContain(message);
      expect(run.stderr).not.toContain("secret-as-argument");
    },
    60_000,
  );

  it("exits with 2 for a body that is not JSON, and with 1 for JSON the page refuses", async () => {
    for (const body of ["", "provider=smtp"]) {
      const run = await cli(["settings", "apply", "email"], body);
      expect([run.code, run.stderr]).toEqual([2, "The body on stdin is not JSON.\n"]);
    }
    for (const name of ["general", "appearance"]) {
      const run = await cli(["settings", "apply", name], "[1]");
      expect([run.code, run.stderr]).toEqual([1, "The request body must be a JSON object\n"]);
    }
    const run = await cli(["settings", "apply", "email"], "null");
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("Check the highlighted fields");
    expect(await getDb().select().from(emailSettings)).toEqual([]);
  }, 60_000);

  it("checks the arguments before it copies variables of earlier versions", async () => {
    const run = await cli(["settings", "show"], "", { MAIL_FROM_ADDRESS: "no-reply@example.invalid" });
    expect(run.code).toBe(2);
    expect(await getDb().select().from(environmentImports)).toEqual([]);
  }, 60_000);

  it("lists the setting names in cli help", async () => {
    const help = await cli(["help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("settings list|show|apply|test <name>");
    expect(help.stdout).toContain("Settings: email, general, appearance.");
  }, 60_000);
});
