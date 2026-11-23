// The production-settings tests of tests/test_operations.py of the Django
// version. This version also needs the public URL in production: the base
// environment names it as 0.4's compose.yaml did (CSRF_TRUSTED_ORIGINS).
import { afterEach, describe, expect, it } from "vitest";
import { config, resetConfigForTests } from "./config";

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
    ALLOWED_HOSTS: "test.invalid",
    CSRF_TRUSTED_ORIGINS: "https://test.invalid",
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
