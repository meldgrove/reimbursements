import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { users, type User } from "../db/schema";
import { createApp } from "../http/app";
import { authentication } from "../http/middleware";
import { assign, type RoleName } from "../auth/roles";
import {
  defaultEmailSettings,
  saveEmailSettings,
  withSecret,
  type EmailSettingsValues,
  type SecretName,
} from "../services/email-connection";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Every table this version writes, in one truncate (Django's own tables stay untouched). */
const TABLES = [
  "portal_session",
  "portal_workspacereservation",
  "portal_job",
  "portal_operation",
  "portal_deliveryevent",
  "portal_deliveryattempt",
  "portal_delivery",
  "portal_confirmation",
  "portal_upload",
  "portal_expense",
  "portal_draft",
  "portal_claim",
  "portal_draftadmission",
  "portal_claimreferencecounter",
  "portal_capacitylock",
  "portal_form_owners",
  "portal_form",
  "portal_templatefield",
  "portal_formtemplate",
  "portal_privacynotice",
  "portal_appsettings",
  "portal_emailsettings",
  "portal_environmentimport",
  "auth_user_groups",
  "auth_group",
  "auth_user",
];

/** The rows a new installation starts with (the INSERTs of the baseline migration). */
const INITIAL_ROWS = fs
  .readFileSync(path.join(here, "../../drizzle/0000_django_baseline.sql"), "utf8")
  .split("--> statement-breakpoint")
  .map((statement) => statement.replace(/^\s*--.*$/gm, "").trim())
  .filter((statement) => statement.startsWith("INSERT INTO"));

/**
 * Empties every table between tests and puts back what a new installation
 * has: the privacy notice version 1 and the template "Externe Erstattung"
 * with its fields (as the Django tests found them after the migrations).
 */
export async function resetDatabase() {
  await getDb().execute(sql.raw(`truncate table ${TABLES.join(", ")} restart identity cascade`));
  for (const statement of INITIAL_ROWS) await getDb().execute(sql.raw(statement));
}

/**
 * A user of the admin area with roles (Django's create_user and
 * roles.assign): template admin, form editor, both or none.
 */
export async function createUser(
  username: string,
  granted: RoleName[] = [],
  values: Partial<typeof users.$inferInsert> = {},
): Promise<User> {
  const [user] = await getDb()
    .insert(users)
    .values({ username, email: `${username}@example.invalid`, ...values })
    .returning();
  await assign(user!, granted);
  const [updated] = await getDb().select().from(users).where(eq(users.id, user!.id));
  return updated!;
}

let app: ReturnType<typeof createApp> | undefined;

export function testApp() {
  app ??= createApp();
  return app;
}

/**
 * API tests act as a user through the x-test-user header, instead of a
 * session from the sign-in provider (auth tests use the fake provider).
 */
export function signInWithTestHeader() {
  const original = authentication.resolve;
  authentication.resolve = async (c) => {
    const id = Number(c.req.header("x-test-user") ?? 0);
    if (!id) return original(c);
    const [user] = await getDb().select().from(users).where(eq(users.id, id));
    return user && user.isActive ? user : null;
  };
  return () => {
    authentication.resolve = original;
  };
}

/** The cookies of one browser across requests (participant sessions, admin sessions). */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  /** The Cookie header for a request; undefined when empty. */
  header(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  /** Keeps the cookies a response sets, and forgets those it deletes. */
  store(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";");
      const at = pair!.indexOf("=");
      const name = pair!.slice(0, at).trim();
      const value = pair!.slice(at + 1).trim();
      const expired = attributes.some((attribute) => {
        const [key, raw] = attribute.split("=").map((part) => part.trim().toLowerCase());
        return (
          (key === "max-age" && Number(raw) <= 0) || (key === "expires" && Date.parse(raw ?? "") < Date.now())
        );
      });
      if (expired || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  clear() {
    this.cookies.clear();
  }
}

export type TestResponse = {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test responses are read loosely
  body: any;
  headers: Headers;
  text: string;
  raw: Response;
};

/**
 * A request to the app, sent with the app's origin: as `user`
 * (x-test-user), with a browser's cookies (`jar`, which keeps what the
 * response sets) and from a peer address (`remoteAddress`, default
 * 127.0.0.1). JSON bodies are sent as JSON; FormData as multipart.
 */
export async function request(
  method: string,
  url: string,
  options: {
    user?: Pick<User, "id"> | null;
    body?: unknown;
    headers?: Record<string, string>;
    jar?: CookieJar;
    remoteAddress?: string;
  } = {},
): Promise<TestResponse> {
  const headers: Record<string, string> = {
    origin: "http://localhost:8000",
    accept: "application/json",
    ...options.headers,
  };
  if (options.user) headers["x-test-user"] = String(options.user.id);
  const cookie = options.jar?.header();
  if (cookie) headers.cookie = headers.cookie ? `${headers.cookie}; ${cookie}` : cookie;
  let body: BodyInit | undefined;
  if (
    options.body instanceof FormData ||
    typeof options.body === "string" ||
    options.body instanceof Uint8Array
  ) {
    body = options.body as BodyInit;
  } else if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const response = await testApp().request(url, { method, headers, body }, peer(options.remoteAddress));
  options.jar?.store(response);
  const text = await response.clone().text();
  const type = response.headers.get("content-type") ?? "";
  return {
    status: response.status,
    body: type.includes("json") && text ? JSON.parse(text) : text,
    headers: response.headers,
    text,
    raw: response,
  };
}

/** The environment @hono/node-server gives a request: its peer address (getConnInfo). */
export function peer(remoteAddress = "127.0.0.1") {
  return {
    incoming: {
      socket: {
        remoteAddress,
        remotePort: 50000,
        remoteFamily: remoteAddress.includes(":") ? "IPv6" : "IPv4",
      },
    },
  };
}

/** Waits until `check` returns a value (not undefined), polling every 100 ms. */
export async function eventually<T>(check: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The addresses and MailerSend API token of the tests' email settings. */
export const TEST_EMAIL = {
  fromAddress: "no-reply@example.invalid",
  replyToAddress: "finance@example.invalid",
  mailersendToken: "synthetic-test-token",
};

/**
 * Saves the tests' email settings: MailerSend with TEST_EMAIL, as 0.5.0's tests set
 * them in the environment, with `changes` (secrets in plain text, sealed here).
 * MAIL_DELIVERY_MODE=local still keeps every email in the outbox.
 */
export async function useEmailSettings(
  changes: Partial<Omit<EmailSettingsValues, `${SecretName}Sealed`>> &
    Partial<Record<SecretName, string>> = {},
) {
  const { mailersendToken, webhookSecret, smtpPassword, ...fields } = changes;
  const { id: _id, updatedAt: _updatedAt, ...defaults } = defaultEmailSettings();
  let values: EmailSettingsValues = {
    ...defaults,
    provider: "mailersend",
    fromAddress: TEST_EMAIL.fromAddress,
    replyToAddress: TEST_EMAIL.replyToAddress,
    ...fields,
  };
  values = withSecret(values, "mailersendToken", mailersendToken ?? TEST_EMAIL.mailersendToken);
  values = withSecret(values, "webhookSecret", webhookSecret ?? "");
  values = withSecret(values, "smtpPassword", smtpPassword ?? "");
  return saveEmailSettings(values);
}
