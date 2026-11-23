// tests/test_email_settings.py of the Django version: Admin > Email, the connection, the
// confirmation, sending without a provider, SMTP for claims, the test email and the
// webhook. The encryption and SMTP adapter cases are in encryption.test.ts and
// services/smtp.test.ts.
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { translate } from "@reimbursements/shared/i18n";
import { FORM_EDITOR, TEMPLATE_ADMIN } from "../../auth/roles";
import { overrideConfigForTests } from "../../config";
import { getDb } from "../../db/client";
import {
  claims,
  confirmations,
  deliveries,
  deliveryAttempts,
  emailSettings,
  jobs,
  type User,
} from "../../db/schema";
import * as confirmationService from "../../services/confirmations";
import * as deliveryService from "../../services/delivery";
import {
  current,
  defaultEmailSettings,
  loadEmailSettings,
  ready,
  saveEmailSettings,
  secretOf,
  withSecret,
} from "../../services/email-connection";
import * as evidence from "../../services/evidence";
import { runOne } from "../../services/jobs";
import * as outbound from "../../services/outbound";
import * as queue from "../../services/queue";
import { DELIVERED, NotSetUp, PENDING } from "../../services/transport";
import { accepted, freshState, localSettings, readyDelivery, storageDirectory } from "../../test/back-office";
import { createForm } from "../../test/fixtures";
import { createUser, request, signInWithTestHeader } from "../../test/helpers";
import { post, prepared } from "../../test/intake";
import { FakeSmtpServer } from "../../test/smtp-server";

const URL = "/api/v1/admin/settings/email";
const TEST_URL = "/api/v1/admin/settings/email/test";

let restoreSignIn: () => void;
let admin: User;

beforeAll(() => {
  restoreSignIn = signInWithTestHeader();
});
afterAll(() => restoreSignIn());

beforeEach(async () => {
  await freshState();
  admin = await createUser("admin", [TEMPLATE_ADMIN]);
});

let server: FakeSmtpServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

/** A deployment that sends email and sets none of it in the environment. */
function unset() {
  localSettings({
    MAIL_DELIVERY_MODE: "send",
    MAILERSEND_API_TOKEN: "",
    MAILERSEND_WEBHOOK_SIGNING_SECRET: "",
    MAIL_FROM_ADDRESS: "",
    MAIL_REPLY_TO_ADDRESS: "",
  });
}

function emailForm(changes: Record<string, unknown> = {}) {
  const confirmation: Record<string, { subject: string; body: string }> = {};
  for (const code of ["de", "en"] as const) {
    const [subject, body] = confirmationService.standardTexts(code);
    // Browsers send line breaks as CRLF.
    confirmation[code] = { subject, body: body.replaceAll("\n", "\r\n") };
  }
  return {
    provider: "",
    fromAddress: "",
    replyToAddress: "",
    smtpHost: "",
    smtpPort: "587",
    smtpSecurity: "starttls",
    smtpUsername: "",
    confirmationEnabled: true,
    confirmation,
    ...changes,
  };
}

const SENDER = { fromAddress: "no-reply@example.invalid", replyToAddress: "finance@example.invalid" };
const mailersendForm = (changes: Record<string, unknown> = {}) =>
  emailForm({ provider: "mailersend", ...SENDER, ...changes });
const smtpForm = (changes: Record<string, unknown> = {}) =>
  emailForm({ provider: "smtp", ...SENDER, smtpHost: "127.0.0.1", ...changes });
/** One language's confirmation changed, the other standard. */
function confirmationChange(code: "de" | "en", part: "subject" | "body", value: string) {
  const form = emailForm();
  return { ...form.confirmation, [code]: { ...form.confirmation[code]!, [part]: value } };
}

const save = (data: Record<string, unknown>) => request("PUT", URL, { user: admin, body: data });
const page = async () => (await request("GET", URL, { user: admin })).body;

describe("the email connection", () => {
  it("without settings sends nothing, and forms refuse claims", async () => {
    unset();
    const connection = await current();
    expect([connection.provider, connection.ready]).toEqual(["", false]);
    expect(connection.missing).toEqual(["a provider", "a sender address", "a reply address for Finance"]);
    expect(await outbound.configuredTransport()).toBeInstanceOf(NotSetUp);
    await createForm();
    const response = await request("GET", "/api/v1/public/forms/test");
    expect(response.status).toBe(503);
    expect(response.body.message).toBe("Das Formular ist derzeit nicht verfügbar.");
  });

  it("takes values from the environment over the admin settings", async () => {
    unset();
    await saveEmailSettings(
      withSecret(
        {
          ...defaultEmailSettings(),
          provider: "smtp",
          smtpHost: "smtp.example.invalid",
          fromAddress: "admin@example.invalid",
          replyToAddress: "reply@example.invalid",
        },
        "mailersendToken",
        "saved-token",
      ),
    );
    let connection = await current();
    expect([connection.provider, connection.sender, connection.mailersendToken]).toEqual([
      "smtp",
      "admin@example.invalid",
      "saved-token",
    ]);
    overrideConfigForTests({
      MAILERSEND_API_TOKEN: "environment-token",
      MAIL_FROM_ADDRESS: "env@example.invalid",
    });
    connection = await current();
    expect([connection.provider, connection.sender, connection.replyTo]).toEqual([
      "mailersend",
      "env@example.invalid",
      "reply@example.invalid",
    ]);
    expect([connection.mailersendToken, connection.ready]).toEqual(["environment-token", true]);
  });

  it("counts a secret the app's secret cannot open as missing", async () => {
    unset();
    await saveEmailSettings(
      withSecret(
        {
          ...defaultEmailSettings(),
          provider: "mailersend",
          fromAddress: "a@example.invalid",
          replyToAddress: "b@example.invalid",
        },
        "mailersendToken",
        "saved-token",
      ),
    );
    expect(await ready()).toBe(true);
    const restore = overrideConfigForTests({ AUTH_SECRET: "a-new-secret-key-".repeat(4) });
    try {
      const connection = await current();
      expect([connection.unreadable, connection.ready]).toEqual([["mailersendToken"], false]);
      expect(connection.missing).toEqual(["a MailerSend API token"]);
      // Which secret sealed it is unknown, so the page names none: the value has to be entered again.
      const shown = await page();
      expect(shown.secrets.mailersendToken.placeholder).toBe(
        "Saved, but can no longer be read: enter it again",
      );
      expect(shown.status.unreadable).toBe("Saved but can no longer be read: api token. Enter it again.");
    } finally {
      restore();
    }
  });
});

describe("the Email page", () => {
  it("is for template admins only", async () => {
    const editor = await createUser("editor", [FORM_EDITOR]);
    expect((await request("GET", URL, { user: editor })).status).toBe(403);
    expect((await request("PUT", URL, { user: editor, body: mailersendForm() })).status).toBe(403);
    const test = await request("POST", TEST_URL, { user: editor, body: { to: "kim@example.invalid" } });
    expect(test.status).toBe(403);
  });

  it("takes a MailerSend token that is never shown again", async () => {
    unset();
    let shown = await page();
    expect(shown.status.label).toBe("Not set up");
    expect(shown.status.text).toContain("Forms take no claims until email is set up");
    const response = await save(
      mailersendForm({ mailersendToken: "mlsn.synthetic-token", webhookSecret: "whsec" }),
    );
    expect(response.status).toBe(200);
    expect(response.body.message).toBe("The email settings were saved.");
    let saved = await loadEmailSettings();
    expect(secretOf(saved, "mailersendToken")).toBe("mlsn.synthetic-token");
    expect(saved.mailersendTokenSealed).not.toContain("mlsn");
    expect(secretOf(saved, "webhookSecret")).toBe("whsec");
    shown = await page();
    expect(JSON.stringify(shown)).not.toContain("mlsn.synthetic-token");
    expect(JSON.stringify(shown)).not.toContain("whsec");
    expect(shown.secrets.mailersendToken.placeholder).toBe("Saved · type a new one to replace it");
    expect(shown.status.text).toBe("Sends with MailerSend from no-reply@example.invalid.");
    // An empty field keeps the saved token; a new one replaces it.
    expect((await save(mailersendForm())).status).toBe(200);
    expect(secretOf(await loadEmailSettings(), "mailersendToken")).toBe("mlsn.synthetic-token");
    await save(mailersendForm({ mailersendToken: "mlsn.new" }));
    expect(secretOf(await loadEmailSettings(), "mailersendToken")).toBe("mlsn.new");
    // Deleting the webhook secret keeps the token.
    await save(mailersendForm({ deleteWebhookSecret: true }));
    saved = await loadEmailSettings();
    expect([secretOf(saved, "webhookSecret"), secretOf(saved, "mailersendToken")]).toEqual(["", "mlsn.new"]);
  });

  it.each([
    [mailersendForm(), { mailersendToken: "Enter the MailerSend API token." }],
    [
      emailForm({ provider: "mailersend", mailersendToken: "t" }),
      {
        fromAddress: "Enter the address every email comes from.",
        replyToAddress: "Enter where Finance's replies go.",
      },
    ],
    [smtpForm({ smtpHost: "" }), { smtpHost: "Enter the SMTP server." }],
    [
      smtpForm({ smtpHost: "smtp example" }),
      { smtpHost: "Enter a host name such as smtp.example.org, or an IP address." },
    ],
    [smtpForm({ smtpUsername: "kim" }), { smtpPassword: "Enter the password for this username." }],
    [smtpForm({ smtpPort: "70000" }), { smtpPort: "Ensure this value is less than or equal to 65535." }],
    [
      mailersendForm({
        confirmation: confirmationChange("de", "subject", "Eingang {referenz}"),
        mailersendToken: "t",
      }),
      {
        "confirmation.de.subject":
          "{referenz} is not a placeholder. Use {name}, {form}, {reference}, {payment_timing}, {support}, {app_name}.",
      },
    ],
    [
      mailersendForm({ confirmation: confirmationChange("en", "body", "Hi {name!r}"), mailersendToken: "t" }),
      { "confirmation.en.body": "Write the placeholder as {name}, without “:” or “!”." },
    ],
    [
      mailersendForm({ confirmation: confirmationChange("en", "body", "Hi } there"), mailersendToken: "t" }),
      { "confirmation.en.body": "Write a single brace as {{ or }}; braces otherwise enclose a placeholder." },
    ],
  ])("needs the settings of the chosen provider (%#)", async (data, fields) => {
    unset();
    const response = await save(data);
    expect(response.status).toBe(422);
    expect(response.body.error.fields).toEqual(fields);
    expect(await getDb().select().from(emailSettings)).toEqual([]);
  });

  it("keeps the spaces of an SMTP password", async () => {
    unset();
    await save(smtpForm({ smtpUsername: "kim", smtpPassword: " s3cret " }));
    expect(secretOf(await loadEmailSettings(), "smtpPassword")).toBe(" s3cret ");
  });

  it("says what MailerSend misses without a signing secret", async () => {
    unset();
    await save(mailersendForm({ mailersendToken: "mlsn.synthetic-token" }));
    let shown = await page();
    expect(shown.status.label).toBe("Ready");
    expect(shown.status.warning).toContain("Without a webhook signing secret");
    await save(mailersendForm({ webhookSecret: "whsec" }));
    shown = await page();
    expect(shown.status.warning).toBe("");
  });

  it("refuses entering and deleting a secret at once", async () => {
    unset();
    await save(smtpForm({ smtpUsername: "kim", smtpPassword: "first" }));
    const response = await save(
      smtpForm({ smtpUsername: "kim", smtpPassword: "second", deleteSmtpPassword: true }),
    );
    expect(response.body.error.fields).toEqual({
      deleteSmtpPassword: "Delete it or enter a new one, not both.",
    });
    expect(secretOf(await loadEmailSettings(), "smtpPassword")).toBe("first");
  });

  it("shows settings from the environment, but does not change them", async () => {
    unset();
    overrideConfigForTests({
      MAILERSEND_API_TOKEN: "environment-token",
      MAIL_FROM_ADDRESS: "env@example.invalid",
    });
    const shown = await page();
    expect(shown.locked.fromAddress).toBe("Set by MAIL_FROM_ADDRESS in the environment.");
    expect(shown.locked.provider).toBe("MAILERSEND_API_TOKEN in the environment chooses MailerSend.");
    expect([shown.settings.provider, shown.settings.fromAddress]).toEqual([
      "mailersend",
      "env@example.invalid",
    ]);
    expect(JSON.stringify(shown)).not.toContain("environment-token");
    const response = await save(
      smtpForm({
        fromAddress: "other@example.invalid",
        mailersendToken: "ignored",
        replyToAddress: "reply@example.invalid",
      }),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const saved = await loadEmailSettings();
    // The environment's values stay out of the database.
    expect([saved.provider, saved.fromAddress, secretOf(saved, "mailersendToken")]).toEqual(["", "", ""]);
    expect(saved.replyToAddress).toBe("reply@example.invalid");
    const connection = await current();
    expect([connection.provider, connection.sender]).toEqual(["mailersend", "env@example.invalid"]);
  });

  it("does not save unchanged standard texts", async () => {
    expect((await save(emailForm())).status).toBe(200);
    expect((await loadEmailSettings()).confirmationTexts).toEqual({});
    const form = emailForm();
    await save({
      ...form,
      confirmation: {
        en: { ...form.confirmation.en!, subject: "  Got   it: {reference} " },
        de: { ...form.confirmation.de!, body: "" },
      },
    });
    expect((await loadEmailSettings()).confirmationTexts).toEqual({ en: { subject: "Got it: {reference}" } });
    const shown = await page();
    expect(shown.settings.confirmation.en.subject).toBe("Got it: {reference}");
    // An emptied field shows the standard text again.
    expect(shown.settings.confirmation.de.body).toContain("Hallo {name},");
  });

  it("names why an open form takes no claims: email not set up", async () => {
    await createForm();
    let row = (await request("GET", "/api/v1/admin/forms", { user: admin })).body.rows[0];
    expect([row.openNow, row.unavailable]).toEqual([true, ""]);
    unset();
    row = (await request("GET", "/api/v1/admin/forms", { user: admin })).body.rows[0];
    expect([row.openNow, row.unavailable]).toEqual([false, "Email not set up"]);
  });
});

describe("the confirmation", () => {
  it("uses the admins' own text", async () => {
    const { claim } = await accepted();
    await saveEmailSettings({
      ...defaultEmailSettings(),
      confirmationTexts: {
        de: {
          subject: "Eingang {reference}",
          body: "Liebe*r {name}, danke für {form}. Fragen an {support}. {{Klammern}}\n",
        },
      },
    });
    const [confirmation] = await getDb()
      .select()
      .from(confirmations)
      .where(eq(confirmations.claimId, claim.id));
    let message = await confirmationService.compose(confirmation!);
    expect(message.subject).toBe(`Eingang ${claim.bookkeepingReference}`);
    expect(message.text).toBe(
      "Liebe*r Alex Beispiel, danke für Test Workshop. Fragen an finance@example.invalid. {Klammern}\n",
    );
    // English claims keep the standard text.
    await getDb()
      .update(claims)
      .set({ snapshot: { ...claim.snapshot, language: "en" } })
      .where(eq(claims.id, claim.id));
    message = await confirmationService.compose(confirmation!);
    expect(message.subject.startsWith("Confirmation of receipt: reimbursement claim")).toBe(true);
  });

  it("is not sent while turned off", async () => {
    await saveEmailSettings({ ...defaultEmailSettings(), confirmationEnabled: false });
    const current_ = await prepared();
    const shown = await request("GET", "/api/v1/public/forms/test", { jar: current_.jar });
    expect(shown.body.confirmation).toBe(false);
    expect(translate("de", "For questions about your claim.")).toBe("Für Rückfragen zu deinem Antrag.");
    const response = await post(current_);
    expect(response.status, response.text).toBe(202);
    expect(await getDb().select().from(confirmations)).toEqual([]);
    expect(await getDb().select().from(jobs).where(eq(jobs.kind, "confirm"))).toEqual([]);
  });
});

describe("sending", () => {
  it("waits and retries without a provider", async () => {
    const { delivery } = await readyDelivery();
    unset();
    const [attempt] = await getDb().insert(deliveryAttempts).values({ deliveryId: delivery.id }).returning();
    const result = await outbound.send(deliveryService.compose, attempt!);
    expect([result.state, result.errorCode, result.retryAfter]).toEqual([PENDING, "email_not_set_up", 900]);
  });

  it("sends claims to Finance and participants through an SMTP server", async () => {
    const { claim } = await readyDelivery();
    unset();
    server = await new FakeSmtpServer().start();
    await saveEmailSettings({
      ...defaultEmailSettings(),
      provider: "smtp",
      fromAddress: "no-reply@example.invalid",
      replyToAddress: "finance@example.invalid",
      smtpHost: "127.0.0.1",
      smtpPort: server.port,
      smtpSecurity: "none",
    });
    await deliveryService.schedule(claim);
    await queue.enqueue("confirm", claim);
    while (await runOne()) {
      // until the queue is empty
    }
    const [delivery] = await getDb().select().from(deliveries).where(eq(deliveries.claimId, claim.id));
    const [confirmation] = await getDb()
      .select()
      .from(confirmations)
      .where(eq(confirmations.claimId, claim.id));
    expect([delivery!.state, Boolean(delivery!.deliveredAt)]).toEqual([DELIVERED, true]);
    expect(confirmation!.state).toBe(DELIVERED);
    expect(server.received).toHaveLength(2);
    // SMTP sends no evidence: nothing is left to reconcile.
    expect(await evidence.reconcile(100)).toEqual({ checked: 0, deferred: 0, failed: 0 });
  });
});

describe("the test email", () => {
  it("goes out with the saved settings", async () => {
    const response = await request("POST", TEST_URL, { user: admin, body: { to: "kim@example.invalid" } });
    expect(response.body).toEqual({
      reached: true,
      message: "The test email to kim@example.invalid is in the local outbox; nothing was sent.",
    });
    const outbox = path.join(storageDirectory(), "outbox");
    const [file] = readdirSync(outbox);
    expect(readFileSync(path.join(outbox, file!), "utf8")).toContain(
      "Test email from Meldgrove Reimbursement",
    );
    expect((await request("GET", TEST_URL, { user: admin })).status).toBe(405);
  });

  it("explains what is wrong", async () => {
    unset();
    server = await new FakeSmtpServer().start();
    const test = async () =>
      (await request("POST", TEST_URL, { user: admin, body: { to: "kim@example.invalid" } })).body.message;
    expect(await test()).toContain("Email is not set up yet. Missing: a provider, a sender address");
    const response = await save(smtpForm({ smtpPort: String(server.port), smtpSecurity: "none" }));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    server.rcptReply = "550 No such user";
    expect(await test()).toBe("The SMTP server refused the recipient.");
    server.rcptReply = "250 OK";
    expect(await test()).toBe("The SMTP server accepted the test email to kim@example.invalid.");
    localSettings({
      MAIL_DELIVERY_MODE: "send",
      MAILERSEND_API_TOKEN: "",
      MAIL_FROM_ADDRESS: "",
      MAIL_REPLY_TO_ADDRESS: "",
      TEST_RECIPIENT_ALLOWLIST: ["finance@example.invalid"],
    });
    expect(await test()).toBe("TEST_RECIPIENT_ALLOWLIST does not include the recipient.");
    expect(server.received).toHaveLength(1);
  });
});

describe("the webhook", () => {
  it("is signed with the saved secret, and its last event is shown", async () => {
    unset();
    await saveEmailSettings(
      withSecret(
        { ...defaultEmailSettings(), provider: "mailersend" },
        "webhookSecret",
        "saved-signing-secret",
      ),
    );
    const body = JSON.stringify({
      type: "activity.delivered",
      created_at: new Date().toISOString(),
      data: { id: "event-1", message_id: "m-1", recipient: "a@example.invalid" },
    });
    const sign = (secret: string) => createHmac("sha256", secret).update(body).digest("hex");
    const webhook = (signature: string) =>
      request("POST", "/webhooks/mailersend/", {
        body,
        headers: { "content-type": "application/json", signature },
      });
    expect((await webhook(sign("other"))).status).toBe(401);
    expect((await loadEmailSettings()).webhookReceivedAt).toBeNull();
    expect((await webhook(sign("saved-signing-secret"))).status).toBe(200);
    expect((await loadEmailSettings()).webhookReceivedAt).not.toBeNull();
    expect((await page()).webhook.text).toContain("Last signed event:");
  });
});
