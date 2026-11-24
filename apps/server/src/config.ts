import path from "node:path";
import { z } from "zod";
import { SERVER_ROOT } from "./paths";
import { OperatorError } from "./operator-error";

/**
 * Settings from the environment. Read them only through `config()`; blank
 * values count as unset (compose.yaml passes optional variables as empty
 * strings). Everything an admin changes while the app runs (General,
 * Appearance and Email settings, templates, forms) lives in the database,
 * and so does everything about outside services: the environment keeps what
 * the app needs before it can read its database, and limits on admins.
 *
 * The app starts with an unchanged `.env` of the Django version (0.1 to 0.4):
 * DJANGO_SECRET_KEY for AUTH_SECRET,
 * CSRF_TRUSTED_ORIGINS for APP_URL (`publicUrl`) and the origins it trusts, DJANGO_DEBUG=1 for a
 * development deployment, KEYCLOAK_BASE_URL and KEYCLOAK_REALM for the
 * sign-in provider. ALLOWED_HOSTS is no longer read: every address the app
 * builds comes from APP_URL. Neither are its email, operator and legal page
 * variables: 0.5.1 copied those into the database.
 *
 * The limits that were Django settings without a variable are here too, as
 * fixed values, so tests can change them (`overrideConfigForTests`).
 */
const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema.optional());
const withDefault = <T extends z.ZodType>(schema: T, fallback: z.input<T>) =>
  z.preprocess(blankToUndefined, schema.default(fallback as never));
const YES = ["1", "true", "yes", "on"];
/** A yes or no; unset uses the fallback. Django read only "1" as yes; so does this, plus true/yes/on. */
const flag = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() !== "" ? YES.includes(value.trim().toLowerCase()) : undefined,
  z.boolean().optional(),
);
const integer = (fallback: number, min = 0) => withDefault(z.coerce.number().int().min(min), fallback);
const list = withDefault(z.string(), "");

const schema = z
  .object({
    NODE_ENV: optional(z.enum(["development", "test", "production"])),
    /** Which part of the application this process runs. */
    APP_ROLE: withDefault(z.enum(["all", "web", "worker", "migrate"]), "all"),
    PORT: withDefault(z.coerce.number().int().min(1).max(65535), 8000),
    /** The address the web process listens on: all in production (the image), only this machine in development. */
    HOST: optional(z.string()),
    /** The public URL, e.g. https://reimbursements.example.invalid. */
    APP_URL: optional(z.string()),
    /** Django version: the public origins. Stands in for APP_URL (publicUrl). */
    CSRF_TRUSTED_ORIGINS: optional(z.string()),
    /** Django version: 1 for development. Must agree with DEPLOYMENT_ENV when both are set. */
    DJANGO_DEBUG: optional(z.enum(["0", "1"])),
    /** development, staging or production. Staging sends email only to TEST_RECIPIENT_ALLOWLIST. */
    DEPLOYMENT_ENV: optional(z.enum(["development", "staging", "production"])),
    DATABASE_URL: optional(z.string().min(1)),
    DATABASE_POOL_SIZE: withDefault(z.coerce.number().int().min(1).max(200), 10),
    /** Longest database statement of the web app and the worker, in seconds; 0: no limit. */
    DATABASE_STATEMENT_TIMEOUT_SECONDS: withDefault(z.coerce.number().int().min(0).max(86_400), 60),
    /** Signs sessions, the sign-in state and the participants' draft binding. */
    AUTH_SECRET: optional(z.string()),
    /** Django version: the same secret under its old name. */
    DJANGO_SECRET_KEY: optional(z.string()),
    LOG_LEVEL: withDefault(z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]), "info"),
    /** Apply database migrations when the process starts (single-container setups). */
    RUN_MIGRATIONS: flag,
    /** Directory with the built web app. */
    WEB_DIST_DIR: optional(z.string()),
    MIGRATIONS_DIR: optional(z.string()),
    /** Receipts, PDFs and the worker heartbeat: a private volume. */
    PRIVATE_STORAGE_ROOT: optional(z.string()),
    /** Sign-in: Keycloak by base URL and realm, or any OpenID Connect provider (OIDC_ISSUER). */
    KEYCLOAK_BASE_URL: optional(z.string()),
    /** The name IAM uses for KEYCLOAK_BASE_URL. */
    KEYCLOAK_URL: optional(z.string()),
    KEYCLOAK_REALM: optional(z.string()),
    OIDC_ISSUER: optional(z.string()),
    OIDC_CLIENT_ID: withDefault(z.string(), ""),
    OIDC_CLIENT_SECRET: withDefault(z.string(), ""),
    OIDC_PROVIDER_NAME: optional(z.string().max(60)),
    OIDC_SCOPES: withDefault(z.string(), "openid email profile"),
    OIDC_SIGN_ALGO: withDefault(z.string().regex(/^(RS|ES|PS|HS)(256|384|512)$|^EdDSA$/), "RS256"),
    OIDC_GROUPS_CLAIM: withDefault(z.string().min(1).max(100), "groups"),
    /** The provider group whose members are template admins. */
    KEYCLOAK_ADMIN_GROUP: withDefault(z.string(), "/reimbursements/admins"),
    /** The provider group whose members are form editors. */
    KEYCLOAK_EDITOR_GROUP: withDefault(z.string(), "/reimbursements/editors"),
    /** Only for providers without a discovery document; they win over its values. */
    OIDC_AUTHORIZATION_ENDPOINT: optional(z.string()),
    OIDC_TOKEN_ENDPOINT: optional(z.string()),
    OIDC_USERINFO_ENDPOINT: optional(z.string()),
    OIDC_JWKS_ENDPOINT: optional(z.string()),
    OIDC_LOGOUT_ENDPOINT: optional(z.string()),
    /** Development only: sign in as any user without a provider. */
    DEV_LOGIN: flag,
    /** Trust X-Forwarded-For from TRUSTED_PROXY_CIDRS (the reverse proxy). */
    TRUST_PROXY_HEADERS: flag,
    TRUSTED_PROXY_CIDRS: list,
    HEALTHCHECK_TOKEN: withDefault(z.string(), ""),
    /** Version of a release image, set by the release workflow; unset in images built from source. */
    APP_VERSION: optional(z.string().max(100)),
    /**
     * The Meldgrove Updater's API, for the update button of template admins.
     * Unlike other settings, an empty value is not unset: it switches the
     * button off. compose.yaml never passes it empty (`${UPDATER_URL:-…}`).
     */
    UPDATER_URL: z.preprocess(
      (value) => (typeof value === "string" ? value.trim().replace(/\/+$/, "") : "http://updater:8080"),
      z.union([z.literal(""), z.url({ protocol: /^https?$/ })], {
        error: "Must be empty or a URL such as http://updater:8080",
      }),
    ),
    /**
     * Sent to the updater as `Authorization: Bearer <token>`. compose.yaml gives
     * the updater the same value (API_TOKEN), and it then refuses requests
     * without it. Unset: no token.
     */
    UPDATER_TOKEN: optional(
      z
        .string()
        .regex(/^[\x21-\x7e]+$/, "Only visible ASCII characters, without spaces (openssl rand -hex 32)"),
    ),
    // Limits (docs/operations.md).
    MAX_FINAL_PDF_BYTES: integer(10_000_000, 1),
    MAX_UPLOADS_PER_NETWORK: integer(5000),
    MAX_UPLOAD_BYTES_PER_NETWORK: integer(15_000_000_000),
    MAX_UPLOADS_PER_NETWORK_PER_MINUTE: integer(1000),
    MAX_PENDING_VALIDATIONS: integer(1000),
    /** The web processes that accept uploads at once; sizes the upload headroom. */
    TOTAL_WEB_WORKERS: integer(2, 1),
    DOCUMENT_SANDBOX_ENABLED: flag,
    MAX_JOB_AGE_SECONDS: integer(900),
    REQUIRE_WORKER_HEARTBEAT: flag,
    MAX_ACTIVE_DRAFTS: integer(10_000),
    MAX_DRAFTS_PER_NETWORK: integer(300),
    MIN_FREE_STORAGE_BYTES: integer(1_000_000_000),
    JOB_TIMEOUT_SECONDS: integer(240, 1),
    UPLOAD_SCANNER: optional(z.enum(["clamav", "disabled"])),
    CLAMAV_HOST: withDefault(z.string(), "scanner"),
    CLAMAV_PORT: withDefault(z.coerce.number().int().min(1).max(65535), 3310),
    /**
     * "local" keeps every email as a private file (development only); "send" sends it
     * with the provider set up under Admin > Email. "mailersend" is the former name of "send".
     */
    MAIL_DELIVERY_MODE: optional(
      z.enum(["local", "send", "mailersend"], { message: "MAIL_DELIVERY_MODE must be local or send." }),
    ),
    /** The accounting inboxes forms may send claims to, comma-separated. */
    APPROVED_DELIVERY_RECIPIENTS: optional(z.string()),
    /** Staging: the only addresses that receive email. */
    TEST_RECIPIENT_ALLOWLIST: list,
    /** Error reports and performance data to Sentry or a compatible service; off when unset. */
    SENTRY_DSN: optional(z.url()),
    SENTRY_ENVIRONMENT: optional(z.string().max(64)),
    SENTRY_RELEASE: optional(z.string().max(200)),
    /** Share of requests and page loads traced for performance data, 0 to 1. */
    SENTRY_TRACES_SAMPLE_RATE: withDefault(z.coerce.number().min(0).max(1), 0),
  })
  .superRefine((value, ctx) => {
    if (value.DJANGO_DEBUG && value.DEPLOYMENT_ENV) {
      if ((value.DJANGO_DEBUG === "1") !== (value.DEPLOYMENT_ENV === "development")) {
        ctx.addIssue({
          code: "custom",
          path: ["DJANGO_DEBUG"],
          message: "Only explicit development mode may enable DJANGO_DEBUG.",
        });
      }
    }
  });

function isLocal(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/**
 * The public URL: APP_URL, or else CSRF_TRUSTED_ORIGINS of the Django
 * version. APP_URL names exactly one address: sign-in sends the provider
 * back to it. CSRF_TRUSTED_ORIGINS may list several, as Django allowed (the
 * development example of 0.4 names localhost and 127.0.0.1); the first one
 * with https wins, else the first one. Origins with a wildcard name no
 * address; all of them stay trusted origins (`originAllowed`).
 */
export function publicUrl(
  appUrl: string | undefined,
  trustedOrigins: string | undefined,
): { url?: string; problem?: string } {
  const listed = splitList(appUrl ?? "");
  if (listed.length > 0) {
    const addresses = listed.filter((origin) => !origin.includes("*"));
    if (addresses.length === 1 && listed.length === 1) return { url: addresses[0] };
    return { problem: "APP_URL names several addresses or a wildcard. Set it to the public URL of the app" };
  }
  const origins = splitList(trustedOrigins ?? "");
  if (origins.length === 0) return {};
  const addresses = origins.filter((origin) => !origin.includes("*"));
  const url = addresses.find((origin) => /^https:/i.test(origin)) ?? addresses[0];
  if (url) return { url };
  return {
    problem:
      "CSRF_TRUSTED_ORIGINS (Django version) names only origins with a wildcard. Set APP_URL to the public URL, e.g. https://reimbursements.example.invalid",
  };
}

/**
 * Whether a browser's Origin may change data (the Django version's CSRF
 * check): the origin of APP_URL, or one of CSRF_TRUSTED_ORIGINS, where
 * `https://*.example.invalid` stands for the domain and its subdomains.
 */
export function originAllowed(origin: string, settings: Pick<Config, "APP_URL" | "trustedOrigins">): boolean {
  if (!URL.canParse(origin)) return false;
  const given = new URL(origin);
  if (given.origin === new URL(settings.APP_URL).origin) return true;
  return settings.trustedOrigins.some((trusted) => {
    const wildcard = /^([a-z][a-z0-9+.-]*):\/\/\*\.([^/]+)\/?$/i.exec(trusted);
    if (!wildcard) return URL.canParse(trusted) && new URL(trusted).origin === given.origin;
    const domain = wildcard[2]!.toLowerCase();
    return (
      given.protocol === `${wildcard[1]!.toLowerCase()}:` &&
      (given.host === domain || given.host.endsWith(`.${domain}`))
    );
  });
}

export function splitList(value: string, lower = false): string[] {
  return value
    .split(",")
    .map((item) => (lower ? item.trim().toLowerCase() : item.trim()))
    .filter(Boolean);
}

type Parsed = z.infer<typeof schema>;

type Derived =
  | "APP_URL"
  | "AUTH_SECRET"
  | "HOST"
  | "DATABASE_URL"
  | "PRIVATE_STORAGE_ROOT"
  | "DEPLOYMENT_ENV"
  | "RUN_MIGRATIONS"
  | "DEV_LOGIN"
  | "TRUST_PROXY_HEADERS"
  | "TRUSTED_PROXY_CIDRS"
  | "DOCUMENT_SANDBOX_ENABLED"
  | "REQUIRE_WORKER_HEARTBEAT"
  | "UPLOAD_SCANNER"
  | "MAIL_DELIVERY_MODE"
  | "APPROVED_DELIVERY_RECIPIENTS"
  | "TEST_RECIPIENT_ALLOWLIST";

export type Config = Omit<Parsed, Derived> & {
  APP_URL: string;
  HOST: string;
  AUTH_SECRET: string;
  DATABASE_URL: string;
  PRIVATE_STORAGE_ROOT: string;
  DEPLOYMENT_ENV: "development" | "staging" | "production";
  RUN_MIGRATIONS: boolean;
  DEV_LOGIN: boolean;
  TRUST_PROXY_HEADERS: boolean;
  TRUSTED_PROXY_CIDRS: string[];
  DOCUMENT_SANDBOX_ENABLED: boolean;
  REQUIRE_WORKER_HEARTBEAT: boolean;
  UPLOAD_SCANNER: "clamav" | "disabled";
  /** "send" (or its former name "mailersend") sends; "local" keeps every email as a file. */
  MAIL_DELIVERY_MODE: "local" | "send" | "mailersend";
  /** Lower case. */
  APPROVED_DELIVERY_RECIPIENTS: string[];
  /** Lower case. */
  TEST_RECIPIENT_ALLOWLIST: string[];
  /** DEPLOYMENT_ENV is development (Django's DEBUG). */
  isDevelopment: boolean;
  /** CSRF_TRUSTED_ORIGINS of the Django version: origins besides APP_URL's that may change data. */
  trustedOrigins: string[];
  /** The issuer of the sign-in provider without a trailing slash; empty: sign-in not set up. */
  oidcIssuer: string;
  /** The issuer as configured: ID tokens name it so when the provider has no discovery document. */
  oidcIssuerConfigured: string;
  oidcProviderKind: "keycloak" | "oidc";
  /**
   * Sign-in set up as in the Django version (KEYCLOAK_BASE_URL and
   * KEYCLOAK_REALM): Keycloak's endpoints of the realm, no discovery, and
   * the exact realm URL as issuer (src/auth/oidc.ts).
   */
  oidcLegacyKeycloak: boolean;
  oidcProviderName: string;
  oidcEnabled: boolean;
  // Fixed limits (Django settings without a variable).
  MAX_RECEIPT_BYTES: number;
  MAX_SUBMISSION_BYTES: number;
  MAX_SIGNATURE_BYTES: number;
  MAX_EXPENSES: number;
  MAX_FILES_PER_EXPENSE: number;
  MAX_CLAIM_PAGES: number;
  MAX_DRAFT_DERIVED_BYTES: number;
  MAX_RENDER_WORKSPACE_BYTES: number;
  MAX_UPLOADS_PER_DRAFT: number;
  MAX_UPLOAD_BYTES_PER_DRAFT: number;
  /** Request bodies other than uploads (Django's DATA_UPLOAD_MAX_MEMORY_SIZE). */
  MAX_REQUEST_BODY_BYTES: number;
  /** Space kept free for uploads the web processes are receiving. */
  UPLOAD_TEMP_HEADROOM_BYTES: number;
  JOB_LEASE_SECONDS: number;
  /** After delivery the PDF is deleted after this many days; the privacy notice states it. */
  PDF_RETENTION_DAYS: number;
  /** All other claim content this many days after submission; the privacy notice states it. */
  CONTENT_RETENTION_DAYS: number;
  /** Admin sessions end this long after sign-in, however they are used. */
  ADMIN_SESSION_SECONDS: number;
  /** Participant sessions (their drafts) last this long. */
  PARTICIPANT_SESSION_SECONDS: number;
};

let cached: Config | undefined;

const DEV_SECRET = "development-only-do-not-use-in-production-development-only";
const DEV_DATABASE_URL = "postgresql://reimbursement:reimbursement@127.0.0.1:55468/reimbursement";

/** The deployment: DEPLOYMENT_ENV, else DJANGO_DEBUG=1 or NODE_ENV development/test, else production. */
function deploymentOf(value: Parsed): Config["DEPLOYMENT_ENV"] {
  if (value.DEPLOYMENT_ENV) return value.DEPLOYMENT_ENV;
  if (value.DJANGO_DEBUG === "1") return "development";
  if (value.DJANGO_DEBUG === "0") return "production";
  return value.NODE_ENV === "development" || value.NODE_ENV === "test" ? "development" : "production";
}

export function config(): Config {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new OperatorError(`Invalid configuration:\n${problems}`);
  }
  const value = parsed.data;
  const problems: string[] = [];
  const deployment = deploymentOf(value);
  const isDevelopment = deployment === "development";
  const env = (name: string) => process.env[name]?.trim() ?? "";

  const named = publicUrl(value.APP_URL, value.CSRF_TRUSTED_ORIGINS);
  let appUrl = named.url ?? (isDevelopment && !named.problem ? `http://localhost:${value.PORT}` : "");
  appUrl = appUrl.replace(/\/+$/, "");
  // Scheme and host in lower case, no default port, no slash at the end: the
  // callback URL built from it must match what openid-client sends.
  if (appUrl && URL.canParse(appUrl)) appUrl = new URL(appUrl).href.replace(/\/+$/, "");
  if (named.problem) problems.push(`APP_URL: ${named.problem}`);
  else if (!appUrl)
    problems.push("APP_URL: Set the public HTTPS origin, e.g. https://reimbursements.example.invalid");
  else if (!z.url({ protocol: /^https?$/ }).safeParse(appUrl).success) {
    problems.push("APP_URL: Must be an http:// or https:// URL");
  } else if (!isDevelopment && !/^https:/i.test(appUrl) && !isLocal(appUrl)) {
    // Sessions travel in cookies that only HTTPS keeps secret.
    problems.push("APP_URL: Must be an https:// URL in production (http only for localhost)");
  }

  const secret = value.AUTH_SECRET ?? value.DJANGO_SECRET_KEY ?? (isDevelopment ? DEV_SECRET : "");
  if (!isDevelopment) {
    // The rule of the Django version: long, not trivially repetitive, not an example.
    if (!secret) problems.push("AUTH_SECRET: Set a random secret of at least 50 characters");
    else if (secret.startsWith("development-") || secret.length < 50 || new Set(secret).size < 5) {
      problems.push("AUTH_SECRET: Must be a random secret of at least 50 characters");
    }
  } else if (secret.length < 32) {
    problems.push("AUTH_SECRET: Must have at least 32 characters");
  }

  const databaseUrl = value.DATABASE_URL ?? (isDevelopment ? DEV_DATABASE_URL : "");
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    problems.push("DATABASE_URL: Set the PostgreSQL URL");
  }

  const keycloakUrl = (value.KEYCLOAK_BASE_URL ?? value.KEYCLOAK_URL ?? "").replace(/\/+$/, "");
  const fromKeycloak = Boolean(keycloakUrl && value.KEYCLOAK_REALM);
  const oidcIssuer = fromKeycloak
    ? `${keycloakUrl}/realms/${value.KEYCLOAK_REALM}`
    : (value.OIDC_ISSUER ?? "").replace(/\/+$/, "");
  const oidcProviderKind = fromKeycloak || oidcIssuer.includes("/realms/") ? "keycloak" : "oidc";

  const requireHeartbeat = value.REQUIRE_WORKER_HEARTBEAT ?? !isDevelopment;
  const sandbox = value.DOCUMENT_SANDBOX_ENABLED ?? true;
  const scanner = value.UPLOAD_SCANNER ?? (isDevelopment ? "disabled" : "clamav");
  const mailMode = value.MAIL_DELIVERY_MODE ?? (isDevelopment ? "local" : "send");
  const trustedProxies = splitList(value.TRUSTED_PROXY_CIDRS);
  const trustProxyHeaders = value.TRUST_PROXY_HEADERS ?? false;
  const approved = splitList(
    value.APPROVED_DELIVERY_RECIPIENTS ?? (isDevelopment ? "finance@example.invalid" : ""),
    true,
  );
  const testRecipients = splitList(value.TEST_RECIPIENT_ALLOWLIST, true);
  const devLogin = value.DEV_LOGIN ?? false;
  if (devLogin && !isDevelopment) problems.push("DEV_LOGIN: Only for development");

  if (!isDevelopment) {
    // The production checks of the Django version (config/settings.py).
    if (!requireHeartbeat)
      problems.push("REQUIRE_WORKER_HEARTBEAT: Production requires worker heartbeat checks");
    const required: [string, unknown][] = [
      ["DATABASE_URL", value.DATABASE_URL],
      ["HEALTHCHECK_TOKEN", value.HEALTHCHECK_TOKEN],
      ["APPROVED_DELIVERY_RECIPIENTS", approved.length > 0],
      ["OIDC_CLIENT_ID", value.OIDC_CLIENT_ID],
      ["OIDC_CLIENT_SECRET", value.OIDC_CLIENT_SECRET],
      ["KEYCLOAK_BASE_URL and KEYCLOAK_REALM (or OIDC_ISSUER)", oidcIssuer],
    ];
    const missing = required.filter(([, given]) => !given).map(([name]) => name);
    if (missing.length > 0) problems.push(`Missing production configuration: ${missing.join(", ")}`);
    if (scanner !== "clamav" || mailMode === "local") {
      problems.push("UPLOAD_SCANNER, MAIL_DELIVERY_MODE: Production requires ClamAV and sending email");
    }
    if (!sandbox) problems.push("DOCUMENT_SANDBOX_ENABLED: Production requires the document sandbox");
    if (trustProxyHeaders && trustedProxies.length === 0) {
      problems.push("TRUSTED_PROXY_CIDRS: Trusted proxy headers require TRUSTED_PROXY_CIDRS");
    }
    if (deployment === "staging" && testRecipients.length === 0) {
      problems.push("TEST_RECIPIENT_ALLOWLIST: Staging requires TEST_RECIPIENT_ALLOWLIST");
    }
  }
  for (const cidr of trustedProxies) {
    if (!isCidr(cidr)) problems.push(`TRUSTED_PROXY_CIDRS: Not a network: ${cidr}`);
  }
  if (problems.length > 0) throw new OperatorError(`Invalid configuration:\n  ${problems.join("\n  ")}`);

  const MAX_RECEIPT_BYTES = 10_000_000;
  const JOB_TIMEOUT_SECONDS = value.JOB_TIMEOUT_SECONDS;
  cached = {
    ...value,
    APP_URL: appUrl,
    HOST: value.HOST ?? (env("NODE_ENV") === "production" ? "0.0.0.0" : "127.0.0.1"),
    AUTH_SECRET: secret,
    DATABASE_URL: databaseUrl,
    PRIVATE_STORAGE_ROOT: path.resolve(
      value.PRIVATE_STORAGE_ROOT ?? path.resolve(SERVER_ROOT, "../../var/private"),
    ),
    DEPLOYMENT_ENV: deployment,
    RUN_MIGRATIONS: value.RUN_MIGRATIONS ?? false,
    DEV_LOGIN: devLogin,
    TRUST_PROXY_HEADERS: trustProxyHeaders,
    // As in the Django version, the networks count on their own: TRUST_PROXY_HEADERS
    // only made Django trust X-Forwarded-Proto, which this version does not read.
    TRUSTED_PROXY_CIDRS: trustedProxies,
    DOCUMENT_SANDBOX_ENABLED: sandbox,
    REQUIRE_WORKER_HEARTBEAT: requireHeartbeat,
    UPLOAD_SCANNER: scanner,
    MAIL_DELIVERY_MODE: mailMode,
    APPROVED_DELIVERY_RECIPIENTS: approved,
    TEST_RECIPIENT_ALLOWLIST: testRecipients,
    isDevelopment,
    trustedOrigins: splitList(value.CSRF_TRUSTED_ORIGINS ?? ""),
    oidcIssuer,
    oidcIssuerConfigured: fromKeycloak ? oidcIssuer : (value.OIDC_ISSUER ?? "").trim(),
    oidcProviderKind,
    oidcLegacyKeycloak: fromKeycloak,
    oidcProviderName:
      value.OIDC_PROVIDER_NAME ?? (oidcProviderKind === "keycloak" ? "Keycloak" : "single sign-on"),
    oidcEnabled: Boolean(oidcIssuer && value.OIDC_CLIENT_ID && value.OIDC_CLIENT_SECRET),
    MAX_RECEIPT_BYTES,
    MAX_SUBMISSION_BYTES: 50_000_000,
    MAX_SIGNATURE_BYTES: 1_000_000,
    MAX_EXPENSES: 30,
    MAX_FILES_PER_EXPENSE: 3,
    MAX_CLAIM_PAGES: 100,
    MAX_DRAFT_DERIVED_BYTES: 100_000_000,
    MAX_RENDER_WORKSPACE_BYTES: 600_000_000,
    MAX_UPLOADS_PER_DRAFT: 200,
    MAX_UPLOAD_BYTES_PER_DRAFT: 150_000_000,
    MAX_REQUEST_BODY_BYTES: 128 * 1024,
    UPLOAD_TEMP_HEADROOM_BYTES: value.TOTAL_WEB_WORKERS * (MAX_RECEIPT_BYTES + 128_000),
    JOB_LEASE_SECONDS: JOB_TIMEOUT_SECONDS + 120,
    PDF_RETENTION_DAYS: 7,
    CONTENT_RETENTION_DAYS: 90,
    ADMIN_SESSION_SECONDS: 8 * 3600,
    PARTICIPANT_SESSION_SECONDS: 7 * 24 * 3600,
  };
  return cached;
}

/** Whether a value is an IPv4 or IPv6 network such as 10.0.0.0/8 or a single address. */
function isCidr(value: string): boolean {
  const [address, prefix, extra] = value.split("/");
  if (extra !== undefined || !address) return false;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  const max = v4 ? 32 : address.includes(":") ? 128 : -1;
  if (max < 0) return false;
  if (v4 && v4.slice(1).some((part) => Number(part) > 255)) return false;
  return prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= max);
}

/** Tests only: forget the cached configuration after changing process.env. */
export function resetConfigForTests() {
  cached = undefined;
}

/** Tests only: change settings of the cached configuration for one test (like Django's override_settings). */
export function overrideConfigForTests(values: Partial<Config>): () => void {
  const current = config();
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, current[key as keyof Config]]));
  Object.assign(current, values);
  return () => Object.assign(current, previous);
}
