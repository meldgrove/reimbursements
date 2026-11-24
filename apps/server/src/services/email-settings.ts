/**
 * Admin > Email (EmailSettingsAdmin of portal/admin.py and portal/admin_email.py of the
 * Django version): what the page shows, how a save is checked, and the test email. The
 * admin routes (modules/admin/email.ts) and `cli settings` (commands/settings.ts) both
 * call these, so a setting saved either way passes the same checks, is sealed the same
 * way and leaves the same audit entry.
 *
 * A saved secret is never shown again: its field stays empty, and typing a new one
 * replaces it. The confirmation's subject and text start as the standard text in each
 * language; text that matches the standard one is not saved, so the standard text stays
 * in use.
 */
import { randomUUID } from "node:crypto";
import { isEmail } from "@reimbursements/shared/email";
import { LANGUAGES } from "@reimbursements/shared/i18n";
import {
  emailSettingsFormSchema,
  type EmailSecretName,
  type EmailSecretState,
  type EmailSettingsPage,
  type EmailTestAnswer,
} from "@reimbursements/shared/api/admin";
import type { z } from "zod";
import { config } from "../config";
import { APP_NAME } from "../constants";
import type { EmailSettingsRow } from "../db/schema";
import { atomic } from "../db/tx";
import { parseWith, validationError } from "../http/errors";
import { formatDateTime } from "../i18n";
import { logger } from "../logger";
import * as confirmations from "./confirmations";
import * as emailConnection from "./email-connection";
import { environmentNote } from "./moved-variables";
import { configuredTransport } from "./outbound";
import { lockSettings, recordSettingsChange, type SettingsActor } from "./settings-audit";
import { SmtpTransport } from "./smtp";
import { ACCEPTED, DELIVERED, FAILED, PAUSED, sendResult, type Message, type SendResult } from "./transport";

const TEST_TIMEOUT_SECONDS = 10;
export const SECRET_LABELS: Record<EmailSecretName, [label: string, deleteLabel: string]> = {
  mailersendToken: ["API token", "Delete the saved API token"],
  webhookSecret: ["Webhook signing secret", "Delete the saved signing secret"],
  smtpPassword: ["Password", "Delete the saved password"],
};
const DELETE_FIELDS: Record<
  EmailSecretName,
  "deleteMailersendToken" | "deleteWebhookSecret" | "deleteSmtpPassword"
> = {
  mailersendToken: "deleteMailersendToken",
  webhookSecret: "deleteWebhookSecret",
  smtpPassword: "deleteSmtpPassword",
};
const PROVIDER_CHOICES = [
  { value: "", label: "Not set up" },
  { value: emailConnection.MAILERSEND, label: "MailerSend" },
  { value: emailConnection.SMTP, label: "SMTP server" },
];
const SECURITY_CHOICES = [
  { value: "starttls", label: "STARTTLS (usually port 587)" },
  { value: "tls", label: "TLS (usually port 465)" },
  { value: "none", label: "None (only for a relay in a trusted network)" },
];
/** Django's RegexValidator of the server field. */
const HOST = /^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|[0-9A-Fa-f:]+)$/;

export function secretStates(saved: EmailSettingsRow): Record<EmailSecretName, EmailSecretState> {
  const states = {} as Record<EmailSecretName, EmailSecretState>;
  for (const name of emailConnection.SECRETS) {
    const value = emailConnection.secretOf(saved, name);
    const isSaved = emailConnection.secretSaved(saved, name);
    let placeholder = "";
    if (value === null) placeholder = "Saved, but can no longer be read: enter it again";
    else if (value) placeholder = "Saved · type a new one to replace it";
    states[name] = { saved: isSaved, unreadable: value === null, deletable: isSaved, placeholder };
  }
  return states;
}

function status(connection: emailConnection.Connection): EmailSettingsPage["status"] {
  let state: EmailSettingsPage["status"]["state"];
  let label: string;
  let text: string;
  if (connection.provider === emailConnection.LOCAL) {
    [state, label] = ["local", "Local outbox"];
    text =
      "Development: every email is kept as a file in the private outbox, and nothing is sent (MAIL_DELIVERY_MODE=local).";
  } else if (connection.ready) {
    [state, label] = ["ready", "Ready"];
    text = `Sends with ${connection.name} from ${connection.sender}.`;
  } else {
    [state, label] = ["not_set_up", "Not set up"];
    text = `Forms take no claims until email is set up. Missing: ${connection.missing.join(", ")}.`;
  }
  const warning =
    connection.provider === emailConnection.MAILERSEND && !connection.webhookSecret
      ? "Without a webhook signing secret, only reconcile-deliveries learns whether emails were delivered."
      : "";
  const unreadable = connection.unreadable.length
    ? `Saved but can no longer be read: ${connection.unreadable
        .map((name) => SECRET_LABELS[name][0].toLowerCase())
        .join(", ")}. Enter it again.`
    : "";
  return { state, label, text, warning, unreadable };
}

/** The page as GET /admin/settings/email answers it; `testRecipient` is the admin's address. */
export async function emailPage(saved: EmailSettingsRow, testRecipient: string): Promise<EmailSettingsPage> {
  const connection = await emailConnection.current(saved);
  const url = new URL("/webhooks/mailersend/", config().APP_URL).toString();
  const received = saved.webhookReceivedAt
    ? `Last signed event: ${formatDateTime(saved.webhookReceivedAt)}.`
    : "No signed event has arrived yet.";
  return {
    settings: {
      provider: saved.provider as EmailSettingsPage["settings"]["provider"],
      fromAddress: saved.fromAddress,
      replyToAddress: saved.replyToAddress,
      smtpHost: saved.smtpHost,
      smtpPort: saved.smtpPort,
      smtpSecurity: saved.smtpSecurity as EmailSettingsPage["settings"]["smtpSecurity"],
      smtpUsername: saved.smtpUsername,
      confirmationEnabled: saved.confirmationEnabled,
      confirmation: Object.fromEntries(
        LANGUAGES.map(([code]) => {
          const [subject, text] = confirmations.texts(saved, code);
          return [code, { subject, body: text }];
        }),
      ),
    },
    secrets: secretStates(saved),
    environmentNote: environmentNote("email"),
    status: status(connection),
    webhook: {
      url,
      receivedAt: saved.webhookReceivedAt ? formatDateTime(saved.webhookReceivedAt) : null,
      text: `In MailerSend, create a webhook for ${url} with the events sent, delivered, deferred, soft bounced, hard bounced and suppressed, and enter its signing secret here. ${received}`,
    },
    choices: {
      providers: PROVIDER_CHOICES,
      securities: SECURITY_CHOICES,
      languages: LANGUAGES.map(([value, label]) => ({ value, label })),
    },
    placeholders: Object.entries(confirmations.PLACEHOLDERS).map(([name, description]) => ({
      name,
      description,
    })),
    testRecipient,
  };
}

// -- Saving: the field rules of Django's EmailSettingsForm -------------------------------

const characters = (value: string) => [...value].length;
const tooLong = (value: string, max: number) =>
  characters(value) > max
    ? `Ensure this value has at most ${max} characters (it has ${characters(value)}).`
    : "";
const choiceError = (value: string) => `Select a valid choice. ${value} is not one of the available choices.`;

/** A CharField's value: stripped (unless `strip` is false) and checked, or its first error. */
export function charField(value: string, max: number, strip = true): { value: string; error: string } {
  const cleaned = strip ? confirmations.stripSpaces(value) : value;
  if (cleaned.includes("\0")) return { value: cleaned, error: "Null characters are not allowed." };
  return { value: cleaned, error: tooLong(cleaned, max) };
}

/** The port as Django's IntegerField and the model's validators read it. */
function portField(raw: string | number): { value: number; error: string } {
  const text = confirmations.stripSpaces(String(raw));
  if (!text) return { value: 0, error: "This field is required." };
  const number = /^[+-]?\d+$/.test(text.replace(/\.0*$/, ""))
    ? Number(text.replace(/\.0*$/, ""))
    : Number.NaN;
  if (!Number.isSafeInteger(number)) return { value: 0, error: "Enter a whole number." };
  if (number < 0) return { value: number, error: "Ensure this value is greater than or equal to 0." };
  if (number < 1) return { value: number, error: "Ensure this value is greater than or equal to 1." };
  if (number > 65535) return { value: number, error: "Ensure this value is less than or equal to 65535." };
  return { value: number, error: "" };
}

/** The longest secret the page takes. */
export const MAX_SECRET_LENGTH = 1000;
/** The longest address the page takes. */
export const MAX_ADDRESS_LENGTH = 254;

/**
 * Checks and saves the page's form (PUT /admin/settings/email): the body is validated
 * with the shared schema first. Throws a 422 with the field errors; returns the saved row.
 */
export async function saveEmail(body: unknown, actor: SettingsActor): Promise<EmailSettingsRow> {
  const input: z.infer<typeof emailSettingsFormSchema> = parseWith(emailSettingsFormSchema, body);
  return atomic(async () => {
    await lockSettings();
    const saved = await emailConnection.loadEmailSettings();
    const errors: Record<string, string> = {};
    const fail = (field: string, message: string) => {
      if (message) errors[field] ??= message;
    };

    // The fields, as the form cleans each.
    let provider: emailConnection.SavedProvider = "";
    if ((emailConnection.SAVED_PROVIDERS as readonly string[]).includes(input.provider)) {
      provider = input.provider as emailConnection.SavedProvider;
    } else fail("provider", choiceError(input.provider));
    const address = (field: "fromAddress" | "replyToAddress") => {
      const { value, error } = charField(input[field], MAX_ADDRESS_LENGTH);
      if (value && !isEmail(value)) fail(field, "Enter a valid email address.");
      fail(field, error);
      return value;
    };
    const fromAddress = address("fromAddress");
    const replyToAddress = address("replyToAddress");
    const host = charField(input.smtpHost, 253);
    fail("smtpHost", host.error);
    if (host.value && !HOST.test(host.value)) {
      fail("smtpHost", "Enter a host name such as smtp.example.org, or an IP address.");
    }
    const port = portField(input.smtpPort);
    fail("smtpPort", port.error);
    if (!input.smtpSecurity) fail("smtpSecurity", "This field is required.");
    else if (!(emailConnection.SECURITIES as readonly string[]).includes(input.smtpSecurity)) {
      fail("smtpSecurity", choiceError(input.smtpSecurity));
    }
    const username = charField(input.smtpUsername, 254);
    fail("smtpUsername", username.error);
    const secrets = {} as Record<EmailSecretName, string>;
    for (const name of emailConnection.SECRETS) {
      // A password may begin or end with a space.
      const field = charField(input[name], MAX_SECRET_LENGTH, name !== "smtpPassword");
      fail(name, field.error);
      secrets[name] = field.error ? "" : field.value;
    }
    const texts: Record<string, { subject: string; body: string }> = {};
    for (const [code] of LANGUAGES) {
      const given = input.confirmation[code] ?? { subject: "", body: "" };
      const subject = charField(given.subject, confirmations.MAX_SUBJECT_LENGTH);
      const text = charField(given.body, confirmations.MAX_BODY_LENGTH);
      fail(`confirmation.${code}.subject`, subject.error);
      fail(`confirmation.${code}.body`, text.error);
      texts[code] = { subject: subject.value, body: text.value };
    }

    // The rules between fields (EmailSettingsForm.clean).
    const hasSecret = (name: EmailSecretName) =>
      Boolean(secrets[name]) ||
      (Boolean(emailConnection.secretOf(saved, name)) && !input[DELETE_FIELDS[name]]);
    if (provider) {
      if (!fromAddress && !errors.fromAddress)
        fail("fromAddress", "Enter the address every email comes from.");
      if (!replyToAddress && !errors.replyToAddress)
        fail("replyToAddress", "Enter where Finance's replies go.");
    }
    if (provider === emailConnection.MAILERSEND && !hasSecret("mailersendToken")) {
      fail("mailersendToken", "Enter the MailerSend API token.");
    }
    if (provider === emailConnection.SMTP) {
      if (!host.value && !errors.smtpHost) fail("smtpHost", "Enter the SMTP server.");
      if (username.value && !username.error && !hasSecret("smtpPassword")) {
        fail("smtpPassword", "Enter the password for this username.");
      }
    }
    for (const name of emailConnection.SECRETS) {
      if (secrets[name] && input[DELETE_FIELDS[name]]) {
        fail(DELETE_FIELDS[name], "Delete it or enter a new one, not both.");
      }
    }
    for (const [code] of LANGUAGES) {
      const { subject, body: text } = texts[code]!;
      if (/[\r\n]/.test(subject)) fail(`confirmation.${code}.subject`, "Write the subject on one line.");
      fail(`confirmation.${code}.subject`, confirmations.placeholderProblem(subject));
      fail(`confirmation.${code}.body`, confirmations.placeholderProblem(text));
    }
    if (Object.keys(errors).length > 0) throw validationError(errors, "Please correct the errors below.");

    let values: emailConnection.EmailSettingsValues = {
      ...saved,
      provider,
      fromAddress,
      replyToAddress,
      smtpHost: host.value,
      smtpPort: port.value,
      smtpSecurity: input.smtpSecurity,
      smtpUsername: username.value,
      confirmationEnabled: input.confirmationEnabled,
      confirmationTexts: ownTexts(texts),
    };
    for (const name of emailConnection.SECRETS) {
      if (secrets[name]) values = emailConnection.withSecret(values, name, secrets[name]);
      else if (input[DELETE_FIELDS[name]]) values = emailConnection.withSecret(values, name, "");
    }
    const { id: _id, updatedAt: _updatedAt, ...stored } = values as EmailSettingsRow;
    const row = await emailConnection.saveEmailSettings(stored);
    await recordSettingsChange("email", actor);
    return row;
  });
}

/** The confirmation texts that differ from the standard ones, per language. */
function ownTexts(texts: Record<string, { subject: string; body: string }>) {
  const own: Record<string, { subject?: string; body?: string }> = {};
  for (const [code] of LANGUAGES) {
    const [standardSubject, standardBody] = confirmations.standardTexts(code);
    const subject = confirmations.collapseSpaces(texts[code]!.subject);
    const body = confirmations.stripSpaces(texts[code]!.body.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
    const changed: { subject?: string; body?: string } = {};
    if (subject && subject !== confirmations.collapseSpaces(standardSubject)) changed.subject = subject;
    if (body && body !== confirmations.stripSpaces(standardBody)) changed.body = `${body}\n`;
    if (Object.keys(changed).length) own[code] = changed;
  }
  return own;
}

// -- The test email --------------------------------------------------------------------

/**
 * Sends a test email to `recipient` with the saved connection. No record keeps the
 * email: it belongs to no claim.
 */
export async function sendTest(recipient: string): Promise<[emailConnection.Connection, SendResult]> {
  const connection = await emailConnection.current();
  const allowlist = config().TEST_RECIPIENT_ALLOWLIST;
  if (allowlist.length && !allowlist.includes(recipient.toLowerCase())) {
    return [connection, sendResult(FAILED, { errorCode: "test_recipient_blocked" })];
  }
  const message: Message = {
    attemptId: randomUUID(),
    sender: connection.sender,
    replyTo: connection.replyTo || connection.sender,
    recipient,
    subject: `Test email from ${APP_NAME}`,
    text: `This is a test email from ${APP_NAME}, sent from Admin > Email.\n\nIt came through ${connection.name} from ${connection.sender}. Participants and Finance receive their emails the same way.\n`,
  };
  // Within the admin's request, so a slow SMTP server cannot hold it for long.
  const transport =
    connection.ready && connection.provider === emailConnection.SMTP
      ? new SmtpTransport(connection.smtp, TEST_TIMEOUT_SECONDS)
      : await configuredTransport(connection);
  return [connection, await transport.send(message)];
}

/** What to tell the admin about a test email's `result`, and whether it reached the provider. */
export function testOutcome(
  connection: emailConnection.Connection,
  recipient: string,
  result: SendResult,
): EmailTestAnswer {
  if (result.state === DELIVERED && connection.provider === emailConnection.LOCAL) {
    return {
      reached: true,
      message: `The test email to ${recipient} is in the local outbox; nothing was sent.`,
    };
  }
  if (result.state === DELIVERED) {
    return { reached: true, message: `The SMTP server accepted the test email to ${recipient}.` };
  }
  if (result.state === ACCEPTED) {
    return { reached: true, message: `MailerSend accepted the test email to ${recipient}.` };
  }
  if (result.state === PAUSED) {
    return {
      reached: false,
      message: `MailerSend accepted the test email to ${recipient}, but sending is paused for this account; see its dashboard.`,
    };
  }
  if (result.errorCode === "email_not_set_up" && connection.missing.length) {
    return { reached: false, message: `Email is not set up yet. Missing: ${connection.missing.join(", ")}.` };
  }
  return { reached: false, message: emailConnection.problem(result.errorCode, connection.provider) };
}

/**
 * The test button (POST /admin/settings/email/test): one test email to `to`, which must
 * be an email address. Throws a 422 for anything else; a failed send is an answer.
 */
export async function testEmail(to: unknown): Promise<EmailTestAnswer> {
  const recipient = typeof to === "string" ? confirmations.stripSpaces(to) : "";
  if (!recipient || !isEmail(recipient)) {
    throw validationError(
      { to: "Enter the email address for the test email." },
      "Enter the email address for the test email.",
    );
  }
  try {
    const [connection, result] = await sendTest(recipient);
    return testOutcome(connection, recipient, result);
  } catch (error) {
    logger.error({ err: error }, "email_test_failed");
    return { reached: false, message: "Sending failed unexpectedly; the email may still arrive." };
  }
}
