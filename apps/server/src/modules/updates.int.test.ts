import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFakeUpdater, updaterStatus, type FakeUpdater } from "@meldgrove/ui/updates/testing";
import { overrideConfigForTests, resetConfigForTests } from "../config";
import type { User } from "../db/schema";
import { FORM_EDITOR, TEMPLATE_ADMIN } from "../auth/roles";
import { createUser, request, resetDatabase, signInWithTestHeader } from "../test/helpers";

/**
 * The routes of the update button and the Updates page (docs/updates.md).
 * `@meldgrove/ui/updates/server` answers them and has its own tests of how it
 * reads the updater; these check what the app adds: who may ask, the origin
 * check, the token, and that each route reaches the updater.
 */
const TOKEN = "0f3a9c41d2e8b7a65c4d3e2f1a0b9c8d";
const STATUS = updaterStatus({ apiToken: true });

const ROUTES: [string, string, unknown][] = [
  ["GET", "/api/v1/admin/updates", undefined],
  ["POST", "/api/v1/admin/updates/check", {}],
  ["POST", "/api/v1/admin/updates/install", { version: "0.2.1" }],
  ["POST", "/api/v1/admin/updates/channel", { channel: "preview" }],
];

let updater: FakeUpdater;
let stopTestHeader: () => void;
let admin: User;

const calls = () =>
  updater.calls.map((call) => [`${call.method} ${call.path}`, call.body, call.authorization]);

beforeAll(async () => {
  stopTestHeader = signInWithTestHeader();
  updater = await startFakeUpdater({ token: TOKEN });
});
afterAll(async () => {
  stopTestHeader();
  await updater.close();
  resetConfigForTests();
});
beforeEach(async () => {
  resetConfigForTests();
  overrideConfigForTests({ UPDATER_URL: updater.url, UPDATER_TOKEN: TOKEN, APP_VERSION: "0.2.0" });
  await resetDatabase();
  admin = await createUser("admin", [TEMPLATE_ADMIN]);
  updater.calls.length = 0;
  updater.respond(() => ({ body: STATUS }));
});

describe("the update routes", () => {
  it.each([null, FORM_EDITOR] as const)("are for template admins only (%s)", async (role) => {
    const user = role ? await createUser("editor", [role]) : null;
    for (const [method, url, body] of ROUTES) {
      const response = await request(method, url, { user, body });
      expect(response.status, url).toBe(404);
      // The button stops its automatic requests on this mark, as after a sign-in redirect.
      expect(response.body).toEqual({
        error: "Sign in as a template admin to manage updates.",
        signedOut: true,
      });
    }
    expect(updater.calls).toEqual([]);
  });

  it("answer admins with the updater's status, asked with the token", async () => {
    const response = await request("GET", "/api/v1/admin/updates", { user: admin });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      app: { version: "0.2.0" },
      reachable: true,
      updater: STATUS,
      error: null,
    });
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    // Headers the app's middleware set before the route stay on the handler's answer.
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls()).toEqual([["GET /v1/status", null, `Bearer ${TOKEN}`]]);
  });

  it("check, install and switch the channel at the updater", async () => {
    updater.respond((call) =>
      call.path === "/v1/install"
        ? { status: 202, body: { ...STATUS, installing: null } }
        : call.path === "/v1/channel"
          ? { body: { ...STATUS, channel: "preview" } }
          : { body: STATUS },
    );
    expect((await request("POST", "/api/v1/admin/updates/check", { user: admin, body: {} })).status).toBe(
      200,
    );
    const install = await request("POST", "/api/v1/admin/updates/install", {
      user: admin,
      body: { version: "0.2.1" },
    });
    expect(install.status).toBe(202);
    const channel = await request("POST", "/api/v1/admin/updates/channel", {
      user: admin,
      body: { channel: "preview" },
    });
    expect(channel.status).toBe(200);
    expect(channel.body.updater.channel).toBe("preview");
    expect(calls()).toEqual([
      ["POST /v1/check", null, `Bearer ${TOKEN}`],
      ["POST /v1/install", { version: "0.2.1" }, `Bearer ${TOKEN}`],
      ["POST /v1/channel", { channel: "preview" }, `Bearer ${TOKEN}`],
    ]);
  });

  it("install nothing but a version, without calling the updater", async () => {
    for (const body of [{}, { version: "latest" }, "version=0.2.1"]) {
      const response = await request("POST", "/api/v1/admin/updates/install", {
        user: admin,
        body,
        headers: typeof body === "string" ? { "content-type": "text/plain" } : {},
      });
      expect(response.status).toBe(400);
    }
    expect(updater.calls).toEqual([]);
  });

  it("take changes only from the app's own pages", async () => {
    for (const [method, url, body] of ROUTES.slice(1)) {
      const response = await request(method!, url!, {
        user: admin,
        body,
        headers: { origin: "https://evil.example.invalid" },
      });
      expect(response.status, url).toBe(403);
    }
    expect(updater.calls).toEqual([]);
  });

  it("name UPDATER_TOKEN when the updater needs a token the app does not have", async () => {
    overrideConfigForTests({ UPDATER_TOKEN: undefined });
    const response = await request("GET", "/api/v1/admin/updates", { user: admin });
    expect(response.status).toBe(409);
    expect(response.body.error).toContain("UPDATER_TOKEN");
    expect(calls()).toEqual([["GET /v1/status", null, null]]);
  });

  it("switch the service off with an empty UPDATER_URL, without a call", async () => {
    overrideConfigForTests({ UPDATER_URL: "", APP_VERSION: undefined });
    for (const [method, url, body] of ROUTES.slice(0, 2)) {
      const response = await request(method, url, { user: admin, body });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ app: { version: null }, reachable: false, updater: null, error: null });
    }
    expect(updater.calls).toEqual([]);
  });
});

describe("the update button", () => {
  it("shows to template admins, without waiting for the updater", async () => {
    const meta = await request("GET", "/api/v1/meta", { user: admin });
    expect(meta.body.updatesButton).toBe(true);
    expect(updater.calls).toEqual([]);
  });

  it("does not show to form editors", async () => {
    const editor = await createUser("editor", [FORM_EDITOR]);
    expect((await request("GET", "/api/v1/meta", { user: editor })).body.updatesButton).toBe(false);
  });

  it("is hidden with an empty UPDATER_URL, while the Updates page answers", async () => {
    overrideConfigForTests({ UPDATER_URL: "" });
    expect((await request("GET", "/api/v1/meta", { user: admin })).body.updatesButton).toBe(false);
    expect((await request("GET", "/api/v1/admin/updates", { user: admin })).status).toBe(200);
  });
});
