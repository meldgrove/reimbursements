// The settings that versions up to 0.5.0 read from the environment: each process copies
// them into the database once (environment-import.ts), and names those still set.
import { spawn } from "node:child_process";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { overrideConfigForTests } from "../config";
import { getDb } from "../db/client";
import { emailSettings, environmentImports, operations } from "../db/schema";
import { logger } from "../logger";
import { SERVER_ROOT } from "../paths";
import { freshState } from "../test/back-office";
import { TEST_DATABASE_URL } from "../test/env";
import { useEmailSettings } from "../test/helpers";
import { loadSettings, saveSettings } from "./app-settings";
import { current, loadEmailSettings, secretOf } from "./email-connection";
import { importEnvironment } from "./environment-import";
import { leftoverVariables, warnAboutLeftovers } from "./moved-variables";

/** The variables a server of 0.4 or 0.5.0 sets, as its .env.production.example had them. */
const OLD = {
  MAILERSEND_API_TOKEN: "synthetic-environment-token",
  MAILERSEND_WEBHOOK_SIGNING_SECRET: "synthetic-environment-signing-secret",
  MAIL_FROM_ADDRESS: "no-reply@example.invalid",
  MAIL_REPLY_TO_ADDRESS: "finance@example.invalid",
  PORTAL_OPERATOR: "Example e.V.",
  PORTAL_LEGAL_URL: "https://example.invalid/imprint",
};

beforeEach(async () => {
  await freshState();
  // A server whose admins never saved Admin > Email.
  await getDb().delete(emailSettings);
});

async function audit() {
  return (await getDb().select().from(operations).orderBy(operations.id)).map((row) => [
    row.action,
    row.actor,
    row.reason,
  ]);
}

describe("the import of the environment of earlier versions", () => {
  it("copies each variable into the settings, sealed, with an audit entry", async () => {
    overrideConfigForTests(OLD);
    const result = await importEnvironment();
    expect(result).toEqual({ copied: Object.keys(OLD), kept: [], refused: [] });
    const saved = await loadEmailSettings();
    expect([saved.provider, saved.fromAddress, saved.replyToAddress]).toEqual([
      "mailersend",
      "no-reply@example.invalid",
      "finance@example.invalid",
    ]);
    expect(secretOf(saved, "mailersendToken")).toBe(OLD.MAILERSEND_API_TOKEN);
    expect(secretOf(saved, "webhookSecret")).toBe(OLD.MAILERSEND_WEBHOOK_SIGNING_SECRET);
    // Sealed: the database holds no secret in plain text.
    expect(JSON.stringify(saved)).not.toContain(OLD.MAILERSEND_API_TOKEN);
    expect(JSON.stringify(saved)).not.toContain(OLD.MAILERSEND_WEBHOOK_SIGNING_SECRET);
    const general = await loadSettings();
    expect([general.operator, general.legalUrl]).toEqual([OLD.PORTAL_OPERATOR, OLD.PORTAL_LEGAL_URL]);
    expect((await current()).ready).toBe(true);
    expect(await audit()).toEqual([
      [
        "settings_email",
        "environment",
        "MAILERSEND_API_TOKEN, MAILERSEND_WEBHOOK_SIGNING_SECRET, MAIL_FROM_ADDRESS, MAIL_REPLY_TO_ADDRESS (environment)",
      ],
      ["settings_general", "environment", "PORTAL_OPERATOR, PORTAL_LEGAL_URL (environment)"],
    ]);
    const remembered = await getDb().select().from(environmentImports);
    expect(remembered.map((row) => [row.variable, row.copied]).sort()).toEqual(
      Object.keys(OLD)
        .map((name) => [name, true])
        .sort(),
    );
  });

  it("imports once: the settings win afterwards, also over a cleared field", async () => {
    overrideConfigForTests(OLD);
    await importEnvironment();
    // An admin changes the sender and clears the operator.
    await getDb().update(emailSettings).set({ fromAddress: "changed@example.invalid" });
    await saveSettings({ operator: "" });
    overrideConfigForTests({ MAIL_FROM_ADDRESS: "other@example.invalid", PORTAL_OPERATOR: "Other" });
    expect(await importEnvironment()).toEqual({ copied: [], kept: [], refused: [] });
    expect((await loadEmailSettings()).fromAddress).toBe("changed@example.invalid");
    expect((await loadSettings()).operator).toBe("");
    expect(await audit()).toHaveLength(2);
  });

  it("keeps values the settings already have", async () => {
    await useEmailSettings({
      provider: "smtp",
      smtpHost: "smtp.example.invalid",
      fromAddress: "saved@example.invalid",
      mailersendToken: "saved-token",
    });
    await saveSettings({ legalUrl: "https://example.invalid/saved" });
    overrideConfigForTests(OLD);
    const result = await importEnvironment();
    expect(result.kept).toEqual(["MAIL_FROM_ADDRESS", "MAIL_REPLY_TO_ADDRESS", "PORTAL_LEGAL_URL"]);
    const saved = await loadEmailSettings();
    expect([saved.fromAddress, secretOf(saved, "mailersendToken")]).toEqual([
      "saved@example.invalid",
      "saved-token",
    ]);
    // MAILERSEND_API_TOKEN chose MailerSend over the saved provider until now, and still does.
    expect(saved.provider).toBe("mailersend");
    expect(result.copied).toContain("MAILERSEND_API_TOKEN");
    expect((await loadSettings()).legalUrl).toBe("https://example.invalid/saved");
  });

  it("copies no value the pages would refuse", async () => {
    overrideConfigForTests({
      MAIL_FROM_ADDRESS: "not an address",
      PORTAL_LEGAL_URL: "javascript:alert(1)",
      PORTAL_OPERATOR: "Example e.V.",
    });
    const warn = vi.spyOn(logger, "warn");
    const result = await importEnvironment();
    expect(result).toEqual({
      copied: ["PORTAL_OPERATOR"],
      kept: [],
      refused: ["MAIL_FROM_ADDRESS", "PORTAL_LEGAL_URL"],
    });
    expect((await loadEmailSettings()).fromAddress).toBe("");
    expect((await loadSettings()).legalUrl).toBe("");
    const [refusedRow] = await getDb()
      .select()
      .from(environmentImports)
      .where(eq(environmentImports.variable, "PORTAL_LEGAL_URL"));
    expect(refusedRow!.copied).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("imports once when processes start together", async () => {
    overrideConfigForTests(OLD);
    const results = await Promise.all([importEnvironment(), importEnvironment(), importEnvironment()]);
    expect(results.map((result) => result.copied.length).sort()).toEqual([0, 0, 6]);
    expect(await audit()).toHaveLength(2);
  });

  it("does nothing without the variables", async () => {
    expect(await importEnvironment()).toEqual({ copied: [], kept: [], refused: [] });
    expect(await getDb().select().from(environmentImports)).toEqual([]);
  });
});

describe("variables still set", () => {
  it("are named in one warning at start, without their values", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    warnAboutLeftovers();
    expect(warn).not.toHaveBeenCalled();
    overrideConfigForTests({ ...OLD, MAIL_REPLY_TO_ADDRESS: " " });
    expect(leftoverVariables("general")).toEqual(["PORTAL_OPERATOR", "PORTAL_LEGAL_URL"]);
    warnAboutLeftovers();
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toEqual({
      variables: [
        "MAILERSEND_API_TOKEN",
        "MAILERSEND_WEBHOOK_SIGNING_SECRET",
        "MAIL_FROM_ADDRESS",
        "PORTAL_OPERATOR",
        "PORTAL_LEGAL_URL",
      ],
    });
    expect(message).toBe(
      "variables no longer read: their settings are under Admin > Email and Admin > General. Delete them from .env once a rollback to 0.5.0 or older is no longer planned and compose.yaml is no longer 0.4's, which requires the email variables",
    );
    for (const value of Object.values(OLD)) expect(JSON.stringify(warn.mock.calls)).not.toContain(value);
  });
});

/** Runs the image's entry point (src/main.ts) with `environment` and the test database. */
function start(environment: Record<string, string>): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.join(SERVER_ROOT, "src/main.ts")], {
      cwd: SERVER_ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        DEPLOYMENT_ENV: "development",
        DATABASE_URL: TEST_DATABASE_URL,
        AUTH_SECRET: process.env.AUTH_SECRET!,
        PRIVATE_STORAGE_ROOT: process.env.PRIVATE_STORAGE_ROOT!,
        LOG_LEVEL: "info",
        ...environment,
      },
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output: Buffer.concat(chunks).toString() }));
  });
}

describe("a start with the variables of an earlier compose file", () => {
  it("migrates, copies them and names them, without a value in the log", async () => {
    const { code, output } = await start({ APP_ROLE: "migrate", MAIL_DELIVERY_MODE: "send", ...OLD });
    expect(code, output).toBe(0);
    expect(output).toContain("settings copied from the environment");
    expect(output).toContain('"variables":["MAILERSEND_API_TOKEN"');
    expect(output).toContain("variables no longer read");
    for (const value of Object.values(OLD)) expect(output).not.toContain(value);
    const saved = await loadEmailSettings();
    expect([saved.provider, secretOf(saved, "mailersendToken")]).toEqual([
      "mailersend",
      OLD.MAILERSEND_API_TOKEN,
    ]);
    expect((await loadSettings()).operator).toBe(OLD.PORTAL_OPERATOR);
    // A second process, e.g. the worker with fewer variables, finds them imported.
    const again = await start({ APP_ROLE: "migrate", MAILERSEND_API_TOKEN: "another-token" });
    expect(again.code, again.output).toBe(0);
    expect(again.output).not.toContain("settings copied from the environment");
    expect(secretOf(await loadEmailSettings(), "mailersendToken")).toBe(OLD.MAILERSEND_API_TOKEN);
  }, 120_000);
});
