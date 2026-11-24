/**
 * The email connection: which provider sends the app's email, and as whom
 * (portal/services/email_connection.py and the EmailSettings model of the Django version).
 *
 * Admins set it up under Admin > Email (the `portal_emailsettings` row), or the operator
 * with `cli settings apply email`: MailerSend with an API token, or an SMTP server. Up to
 * 0.5.0, MAILERSEND_API_TOKEN, MAILERSEND_WEBHOOK_SIGNING_SECRET, MAIL_FROM_ADDRESS and
 * MAIL_REPLY_TO_ADDRESS in the environment won over the fields; each process now copies
 * them into the row once (services/environment-import.ts) and never reads them again.
 * With MAIL_DELIVERY_MODE=local, in development, every email stays in a private outbox
 * instead, from placeholder addresses while none are saved.
 *
 * Forms take no claims until the connection is ready (`terms.refusal`).
 */
import { eq, sql } from "drizzle-orm";
import { config } from "../config";
import { emailSettings, type EmailSettingsRow } from "../db/schema";
import { q } from "../db/tx";
import { seal, unseal } from "../encryption";

export const LOCAL = "local";
export const MAILERSEND = "mailersend";
export const SMTP = "smtp";
export type Provider = "" | typeof LOCAL | typeof MAILERSEND | typeof SMTP;
/** What admins choose under Admin > Email. */
export type SavedProvider = "" | typeof MAILERSEND | typeof SMTP;
export const SAVED_PROVIDERS: readonly SavedProvider[] = ["", MAILERSEND, SMTP];
export const SECURITIES = ["starttls", "tls", "none"] as const;
export type Security = (typeof SECURITIES)[number];

export const PROVIDER_NAMES: Record<Provider, string> = {
  [LOCAL]: "Local outbox",
  [MAILERSEND]: "MailerSend",
  [SMTP]: "SMTP server",
  "": "",
};

/** The secrets admins enter, by the name of their field. */
export const SECRETS = ["mailersendToken", "webhookSecret", "smtpPassword"] as const;
export type SecretName = (typeof SECRETS)[number];

/** The addresses of the local outbox while none are saved (development only). */
export const LOCAL_SENDER = "no-reply@example.invalid";
export const LOCAL_REPLY_TO = "finance@example.invalid";

const SEALED: Record<SecretName, "mailersendTokenSealed" | "webhookSecretSealed" | "smtpPasswordSealed"> = {
  mailersendToken: "mailersendTokenSealed",
  webhookSecret: "webhookSecretSealed",
  smtpPassword: "smtpPasswordSealed",
};

/** What a send or a setup check that failed with this error code means for admins. */
export const PROBLEMS: Readonly<Record<string, string>> = {
  email_not_set_up: "Email is not set up yet. Choose a provider and save first.",
  test_recipient_blocked: "TEST_RECIPIENT_ALLOWLIST does not include the recipient.",
  unapproved_recipient: "APPROVED_DELIVERY_RECIPIENTS does not include the recipient.",
  provider_connection: "MailerSend could not be reached. Try again in a minute.",
  provider_throttled: "MailerSend limits requests right now. Try again in a minute.",
  recipient_suppressed: "MailerSend suppresses this recipient after an earlier bounce.",
  provider_outcome_unknown: "The provider gave no clear answer; the email may still arrive.",
  provider_response_invalid: "MailerSend gave an answer the app does not understand.",
  provider_message_id_missing: "MailerSend accepted the email without a message ID.",
  recipient_rejected: "The SMTP server refused the recipient.",
  smtp_connection: "The SMTP server could not be reached. Check the server, the port and the encryption.",
  smtp_tls_failed:
    "The encrypted connection to the SMTP server failed. Check the encryption and the port, and that the server has a valid certificate.",
  smtp_tls_unavailable: "The SMTP server does not offer STARTTLS. Choose TLS, or check the port.",
  smtp_login_unavailable:
    "The SMTP server does not offer a login. Leave the username empty, or choose encryption: many servers only offer a login over an encrypted connection.",
  smtp_login_failed: "The SMTP server refused the username or the password.",
  smtp_login_not_ascii: "The SMTP login takes only ASCII characters in the username and the password.",
  address_not_ascii: "SMTP takes only email addresses in ASCII characters.",
  smtp_sender_refused: "The SMTP server refused the sender address.",
  smtp_deferred: "The SMTP server deferred the email. Try again later.",
};
const REJECTED: Readonly<Record<string, string>> = {
  [MAILERSEND]:
    "MailerSend refused the email. Check the API token and that the sender address is on a verified MailerSend domain.",
  [SMTP]: "The SMTP server refused the email.",
};

/** What `errorCode` of a send with `provider` means, for admins. */
export function problem(errorCode: string, provider: string): string {
  if (errorCode === "provider_rejected" && provider in REJECTED) return REJECTED[provider]!;
  return PROBLEMS[errorCode] ?? `Sending failed (${errorCode}).`;
}

/** Development keeps every email in a private outbox. */
export function local(): boolean {
  const settings = config();
  return settings.MAIL_DELIVERY_MODE === "local" && settings.isDevelopment;
}

// -- The saved settings (EmailSettings) --------------------------------------------

export const EMAIL_SETTINGS_ID = 1;

export type EmailSettingsValues = Omit<EmailSettingsRow, "id" | "updatedAt">;

/** The settings of an installation that saved none (the model's defaults). */
export function defaultEmailSettings(): EmailSettingsRow {
  return {
    id: EMAIL_SETTINGS_ID,
    provider: "",
    fromAddress: "",
    replyToAddress: "",
    mailersendTokenSealed: "",
    webhookSecretSealed: "",
    smtpHost: "",
    smtpPort: 587,
    smtpSecurity: "starttls",
    smtpUsername: "",
    smtpPasswordSealed: "",
    confirmationEnabled: true,
    confirmationTexts: {},
    webhookReceivedAt: null,
    updatedAt: new Date(),
  };
}

/** The saved settings, or the defaults while none are saved. */
export async function loadEmailSettings(): Promise<EmailSettingsRow> {
  const [row] = await q().select().from(emailSettings).where(eq(emailSettings.id, EMAIL_SETTINGS_ID));
  return row ?? defaultEmailSettings();
}

/** Saves the whole row (id 1), creating it first; the last save wins, as with Django's admin. */
export async function saveEmailSettings(values: EmailSettingsValues): Promise<EmailSettingsRow> {
  const now = new Date();
  const [row] = await q()
    .insert(emailSettings)
    .values({ ...values, id: EMAIL_SETTINGS_ID, updatedAt: now })
    .onConflictDoUpdate({ target: emailSettings.id, set: { ...values, updatedAt: now } })
    .returning();
  return row!;
}

/** Whether a value of the secret `name` is saved, readable or not. */
export function secretSaved(saved: EmailSettingsRow, name: SecretName): boolean {
  return Boolean(saved[SEALED[name]]);
}

/** The secret `name`: "" while none is saved, null when the current secret cannot open it. */
export function secretOf(saved: EmailSettingsRow, name: SecretName): string | null {
  return unseal(saved[SEALED[name]]);
}

/** `saved` with the secret `name` sealed anew ("" deletes it). */
export function withSecret<T extends EmailSettingsValues>(saved: T, name: SecretName, value: string): T {
  return { ...saved, [SEALED[name]]: seal(value) };
}

/** Remembers that a signed MailerSend webhook arrived just now. */
export async function noteWebhook(): Promise<void> {
  const now = new Date();
  await q()
    .insert(emailSettings)
    .values({ ...defaultEmailSettings(), webhookReceivedAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: emailSettings.id,
      set: { webhookReceivedAt: sql`excluded.webhook_received_at` },
    });
}

// -- The connection ------------------------------------------------------------------

export type SmtpAccount = {
  host: string;
  port: number;
  security: Security;
  username: string;
  password: string;
};

export class Connection {
  constructor(
    /** LOCAL, MAILERSEND or SMTP; "" while no provider is chosen. */
    readonly provider: Provider,
    readonly sender: string,
    readonly replyTo: string,
    /**
     * Saved credentials, also while another provider sends: MailerSend's evidence
     * about emails it sent earlier still needs them.
     */
    readonly mailersendToken: string,
    readonly webhookSecret: string,
    readonly smtp: SmtpAccount,
    /** Saved secrets the current secret cannot open; they count as missing. */
    readonly unreadable: readonly SecretName[] = [],
  ) {}

  get name(): string {
    return PROVIDER_NAMES[this.provider];
  }

  /** What the connection needs before it can send, as the admin's field labels. */
  get missing(): string[] {
    const missing: string[] = [];
    if (!this.provider) missing.push("a provider");
    if (!this.sender) missing.push("a sender address");
    if (!this.replyTo) missing.push("a reply address for Finance");
    if (this.provider === MAILERSEND && !this.mailersendToken) missing.push("a MailerSend API token");
    if (this.provider === SMTP) {
      if (!this.smtp.host) missing.push("an SMTP server");
      if (this.smtp.username && !this.smtp.password) missing.push("an SMTP password");
    }
    return missing;
  }

  get ready(): boolean {
    return this.missing.length === 0;
  }
}

function savedProvider(value: string): Provider {
  return value === MAILERSEND || value === SMTP ? value : "";
}

function security(value: string): Security {
  return (SECURITIES as readonly string[]).includes(value) ? (value as Security) : "starttls";
}

/** The connection the app sends with now; `saved` defaults to the saved settings. */
export async function current(saved?: EmailSettingsRow): Promise<Connection> {
  const row = saved ?? (await loadEmailSettings());
  const secrets = {} as Record<SecretName, string>;
  const unreadable: SecretName[] = [];
  for (const name of SECRETS) {
    const value = secretOf(row, name);
    if (value === null) unreadable.push(name);
    secrets[name] = value ?? "";
  }
  const isLocal = local();
  return new Connection(
    isLocal ? LOCAL : savedProvider(row.provider),
    row.fromAddress || (isLocal ? LOCAL_SENDER : ""),
    row.replyToAddress || (isLocal ? LOCAL_REPLY_TO : ""),
    secrets.mailersendToken,
    secrets.webhookSecret,
    {
      host: row.smtpHost,
      port: row.smtpPort,
      security: security(row.smtpSecurity),
      username: row.smtpUsername,
      password: secrets.smtpPassword,
    },
    unreadable,
  );
}

/** Whether the app can send email now, so forms may take claims. */
export async function ready(): Promise<boolean> {
  return (await current()).ready;
}
