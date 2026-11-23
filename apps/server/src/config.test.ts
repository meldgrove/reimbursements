// The production-settings tests of tests/test_operations.py of the Django
// version. This version also needs the public URL in production: the base
// environment names it as 0.4's compose.yaml did (CSRF_TRUSTED_ORIGINS).
import { afterEach, describe, expect, it } from "vitest";
import { config, originAllowed, publicUrl, resetConfigForTests } from "./config";

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
  resetConfigForTests();
});

/** Whether the app starts with exactly this environment. */
function starts(environment: Record<string, string>): boolean {
  process.env = { PATH: process.env.PATH ?? "", ...environment };
  resetConfigForTests();
  try {
    config();
    return true;
  } catch {
    return false;
  }
}

describe("production settings", () => {
  it.each([
    ["production", undefined, false],
    ["production", "1", false],
    ["staging", "1", false],
    ["development", "1", true],
  ])("production cannot silently use development defaults (%s, DJANGO_DEBUG=%s)", (mode, debug, accepted) => {
    const environment: Record<string, string> = {
      PRIVATE_STORAGE_ROOT: "/tmp/private",
      DEPLOYMENT_ENV: mode,
    };
    if (debug !== undefined) environment.DJANGO_DEBUG = debug;
    expect(starts(environment)).toBe(accepted);
  });

  const BASE = {
    PRIVATE_STORAGE_ROOT: "/tmp/private",
    DEPLOYMENT_ENV: "production",
    DJANGO_DEBUG: "0",
    DJANGO_SECRET_KEY: "synthetic-key-".repeat(8),
    DATABASE_URL: "postgresql://test:test@localhost/test",
    ALLOWED_HOSTS: "reimbursements.example.invalid",
    CSRF_TRUSTED_ORIGINS: "https://reimbursements.example.invalid",
    MAILERSEND_API_TOKEN: "synthetic",
    MAILERSEND_WEBHOOK_SIGNING_SECRET: "synthetic",
    APPROVED_DELIVERY_RECIPIENTS: "test@example.invalid",
    HEALTHCHECK_TOKEN: "synthetic",
    OIDC_CLIENT_ID: "synthetic-client",
    OIDC_CLIENT_SECRET: "synthetic-secret",
    KEYCLOAK_BASE_URL: "https://auth.example.invalid",
    KEYCLOAK_REALM: "reimbursements",
    MAIL_FROM_ADDRESS: "no-reply@example.invalid",
    MAIL_REPLY_TO_ADDRESS: "finance@example.invalid",
  };

  it.each([
    [{ DATABASE_URL: "sqlite:///:memory:" }],
    [{ UPLOAD_SCANNER: "disabled" }],
    [{ DOCUMENT_SANDBOX_ENABLED: "0" }],
    [{ MAIL_DELIVERY_MODE: "local" }],
    [{ REQUIRE_WORKER_HEARTBEAT: "0" }],
    [{ DJANGO_SECRET_KEY: "development-secret" }],
    [{ KEYCLOAK_BASE_URL: "" }],
    [{ KEYCLOAK_REALM: "" }],
    [{ MAIL_FROM_ADDRESS: "" }],
    [{ MAIL_REPLY_TO_ADDRESS: "" }],
    [{}],
  ])("unsafe production settings refuse to start (%o)", (override) => {
    expect(starts({ ...BASE, ...override })).toBe(Object.keys(override).length === 0);
  });
});

describe("the public URL from the Django version's CSRF_TRUSTED_ORIGINS", () => {
  /** The .env.example of 0.4, as `cp .env.example .env` made it (every line). */
  const DJANGO_EXAMPLE = {
    COMPOSE_FILE: "compose.dev.yaml",
    DJANGO_DEBUG: "1",
    DJANGO_SECRET_KEY: "development-only-replace-with-a-random-secret",
    ALLOWED_HOSTS: "localhost,127.0.0.1",
    CSRF_TRUSTED_ORIGINS: "http://localhost:8000,http://127.0.0.1:8000",
    POSTGRES_PASSWORD: "local-development-only",
    DATABASE_URL: "postgresql://reimbursement:local-development-only@database:5432/reimbursement",
    PRIVATE_STORAGE_ROOT: "/app/var/private",
    DEPLOYMENT_ENV: "development",
    TRUST_PROXY_HEADERS: "0",
    TRUSTED_PROXY_CIDRS: "",
    MAX_DRAFTS_PER_NETWORK: "300",
    MAX_UPLOADS_PER_NETWORK: "5000",
    MAX_UPLOADS_PER_NETWORK_PER_MINUTE: "1000",
    MAX_UPLOAD_BYTES_PER_NETWORK: "15000000000",
    MAX_PENDING_VALIDATIONS: "1000",
    MAX_JOB_AGE_SECONDS: "900",
    DOCUMENT_SANDBOX_ENABLED: "1",
    REQUIRE_WORKER_HEARTBEAT: "1",
    HEALTHCHECK_TOKEN: "local-development-health-token",
    MAIL_DELIVERY_MODE: "local",
    MAILERSEND_API_TOKEN: "",
    MAILERSEND_WEBHOOK_SIGNING_SECRET: "",
    APPROVED_DELIVERY_RECIPIENTS: "finance@example.invalid",
    TEST_RECIPIENT_ALLOWLIST: "",
    UPLOAD_SCANNER: "clamav",
    CLAMAV_HOST: "scanner",
    CLAMAV_PORT: "3310",
    MAX_FINAL_PDF_BYTES: "10000000",
    MIN_FREE_STORAGE_BYTES: "1000000000",
    JOB_TIMEOUT_SECONDS: "240",
    OIDC_CLIENT_ID: "",
    OIDC_CLIENT_SECRET: "",
    PORTAL_OPERATOR: "",
    PORTAL_LEGAL_URL: "",
    MAIL_FROM_ADDRESS: "no-reply@example.invalid",
    MAIL_REPLY_TO_ADDRESS: "finance@example.invalid",
    KEYCLOAK_BASE_URL: "https://auth.example.invalid",
    KEYCLOAK_REALM: "reimbursements",
    SENTRY_DSN: "",
    SENTRY_ENVIRONMENT: "",
    SENTRY_RELEASE: "",
    UPDATER_URL: "",
  };

  it("starts with the development example of 0.4 and trusts both of its origins", () => {
    expect(starts(DJANGO_EXAMPLE)).toBe(true);
    const settings = config();
    expect(settings.APP_URL).toBe("http://localhost:8000");
    expect(originAllowed("http://localhost:8000", settings)).toBe(true);
    expect(originAllowed("http://127.0.0.1:8000", settings)).toBe(true);
    expect(originAllowed("http://127.0.0.1:8001", settings)).toBe(false);
    expect(originAllowed("https://evil.example.invalid", settings)).toBe(false);
  });

  it("takes the first https origin of several, and trusts wildcard origins as Django did", () => {
    expect(
      publicUrl(
        undefined,
        "http://localhost:8000,https://*.example.invalid,https://reimbursements.example.invalid",
      ).url,
    ).toBe("https://reimbursements.example.invalid");
    expect(publicUrl(undefined, "https://*.example.invalid").problem).toMatch(/only origins with a wildcard/);
    expect(
      publicUrl(["https://a.example.invalid", "https://b.example.invalid"].join(","), undefined).problem,
    ).toMatch(/APP_URL/);
    const settings = {
      APP_URL: "https://reimbursements.example.invalid",
      trustedOrigins: ["https://*.example.invalid", "https://reimbursements.example.invalid"],
    };
    expect(originAllowed("https://other.example.invalid", settings)).toBe(true);
    expect(originAllowed("https://example.invalid", settings)).toBe(true);
    expect(originAllowed("http://other.example.invalid", settings)).toBe(false);
    expect(originAllowed("https://example.invalid.slack.com", settings)).toBe(false);
    expect(originAllowed("null", settings)).toBe(false);
  });
});
