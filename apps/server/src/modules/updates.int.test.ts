import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdaterStatus } from "@reimbursements/shared/api/updates";
import { overrideConfigForTests, resetConfigForTests } from "../config";
import type { User } from "../db/schema";
import { FORM_EDITOR, TEMPLATE_ADMIN } from "../auth/roles";
import { askUpdater } from "../updates/updater";
import { startFakeUpdater, updaterStatus } from "../test/fake-updater";
import { createUser, request, resetDatabase, signInWithTestHeader } from "../test/helpers";

/**
 * Port of tests/test_updates.py and tests/test_updater_answers.py: the
 * routes of the update button and the Updates page in front of the
 * Meldgrove Updater (docs/updates.md). The Django version rendered the
 * button's elements into its pages; here the web app shows @meldgrove/ui's
 * button, and /api/v1/meta says whether to.
 */
const STATUS: UpdaterStatus = updaterStatus({ available: null, checkedAt: "2026-11-19T10:00:00Z" });

const ROUTES: [string, string, unknown][] = [
  ["GET", "/api/v1/admin/updates", undefined],
  ["POST", "/api/v1/admin/updates/check", {}],
  ["POST", "/api/v1/admin/updates/install", { version: "0.2.1" }],
  ["POST", "/api/v1/admin/updates/channel", { channel: "preview" }],
];

type Reply = { status?: number; body?: unknown; delayMs?: number; raw?: string };

let updater: Awaited<ReturnType<typeof startFakeUpdater>>;
let stopTestHeader: () => void;
let admin: User;

/** Answers `"METHOD /path"` with its reply, everything else with 200 and STATUS. */
function answer(routes: Record<string, Reply> = {}) {
  updater.respond((call) => routes[`${call.method} ${call.path}`] ?? { body: STATUS });
}

const calls = () => updater.calls.map((call) => [`${call.method} ${call.path}`, call.body]);
const timeout = AbortSignal.timeout.bind(AbortSignal);

beforeAll(async () => {
  stopTestHeader = signInWithTestHeader();
  updater = await startFakeUpdater();
});
afterAll(async () => {
  stopTestHeader();
  await updater.close();
  resetConfigForTests();
});
beforeEach(async () => {
  resetConfigForTests();
  overrideConfigForTests({ UPDATER_URL: updater.url, APP_VERSION: "0.2.0" });
  await resetDatabase();
  admin = await createUser("admin", [TEMPLATE_ADMIN]);
  updater.calls.length = 0;
  answer();
});
afterEach(() => vi.restoreAllMocks());

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

  it("answer with the updater's status", async () => {
    const response = await request("GET", "/api/v1/admin/updates", { user: admin });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      app: { version: "0.2.0" },
      reachable: true,
      updater: STATUS,
      error: null,
    });
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(calls()).toEqual([["GET /v1/status", null]]);
    expect((await request("POST", "/api/v1/admin/updates", { user: admin, body: {} })).status).toBe(404);
    expect((await request("GET", "/api/v1/admin/updates/check", { user: admin })).status).toBe(404);
  });

  it("call the updater, each with its timeout", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => timeout(ms));
    answer({ "POST /v1/install": { status: 202, body: { ...STATUS, installing: null } } });
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
      body: { channel: "stable" },
    });
    expect(channel.status).toBe(200);
    expect(calls()).toEqual([
      ["POST /v1/check", null],
      ["POST /v1/install", { version: "0.2.1" }],
      ["POST /v1/channel", { channel: "stable" }],
    ]);
    expect(spy.mock.calls.map(([ms]) => ms)).toEqual([35_000, 10_000, 35_000]);
  });

  it.each(["0.2.1", "10.20.30", "0.2.1-preview.3", "sha256:0123456789ab"])(
    "install a version or an image digest (%s)",
    async (version) => {
      const response = await request("POST", "/api/v1/admin/updates/install", {
        user: admin,
        body: { version },
      });
      expect(response.status).toBe(200);
      expect(updater.calls[0]!.body).toEqual({ version });
    },
  );

  it.each([
    {},
    { version: "latest" },
    { version: "0.2" },
    { version: "v0.2.1" },
    { version: "0.2.1-rc.1" },
    { version: "0.2.1\n" },
    { version: "0.2.1 && reboot" },
    { version: "sha256:0123456789AB" },
    { version: "sha256:0123456789abc" },
    { version: 21 },
    ["0.2.1"],
  ])("install nothing else, without calling the updater (%j)", async (payload) => {
    const response = await request("POST", "/api/v1/admin/updates/install", { user: admin, body: payload });
    expect(response.status).toBe(400);
    // The envelope the update button reads, as Django's `_invalid` answered.
    expect(response.body).toMatchObject({
      error: "Name the version to install, such as 0.2.1.",
      reachable: true,
      updater: null,
    });
    expect(updater.calls).toEqual([]);
  });

  it.each([{}, { channel: "beta" }, { channel: "Stable" }, "preview"])(
    "switch only to stable or preview (%j)",
    async (payload) => {
      const response = await request("POST", "/api/v1/admin/updates/channel", {
        user: admin,
        body: typeof payload === "string" ? JSON.stringify(payload) : payload,
        headers: { "content-type": "application/json" },
      });
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        error: "The channel is stable or preview.",
        reachable: true,
        updater: null,
      });
      expect(updater.calls).toEqual([]);
    },
  );

  it("refuse a body that is not JSON", async () => {
    const response = await request("POST", "/api/v1/admin/updates/install", {
      user: admin,
      body: "version=0.2.1",
      headers: { "content-type": "text/plain" },
    });
    expect(response.status).toBe(400);
    expect(updater.calls).toEqual([]);
  });

  it("answer an updater's refusal with 409, its error and the latest status", async () => {
    answer({ "POST /v1/install": { status: 409, body: { error: "0.2.1 is being installed." } } });
    const response = await request("POST", "/api/v1/admin/updates/install", {
      user: admin,
      body: { version: "0.2.2" },
    });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      app: { version: "0.2.0" },
      reachable: true,
      updater: STATUS,
      error: "0.2.1 is being installed.",
    });
    expect(calls().map(([route]) => route)).toEqual(["POST /v1/install", "GET /v1/status"]);
    answer({ "POST /v1/channel": { status: 409, body: { error: "Change the tag there." } } });
    const channel = await request("POST", "/api/v1/admin/updates/channel", {
      user: admin,
      body: { channel: "preview" },
    });
    expect(channel.status).toBe(409);
    expect(channel.body.error).toBe("Change the tag there.");
  });

  it.each([500, 503])("keep an updater's server error of an installation (%i)", async (code) => {
    answer({ "POST /v1/install": { status: code, body: { error: "The state file is busy." } } });
    const response = await request("POST", "/api/v1/admin/updates/install", {
      user: admin,
      body: { version: "0.2.1" },
    });
    // Never a 409: the button takes that as a refusal, and the installation may have started.
    expect(response.status).toBe(code);
    expect(response.body).toEqual({
      app: { version: "0.2.0" },
      reachable: true,
      updater: STATUS,
      error: "The state file is busy.",
    });
    answer({ "POST /v1/install": { status: 503, raw: "Service Unavailable" } });
    updater.respond((call) =>
      call.path === "/v1/install" ? { status: 503, body: "Service Unavailable" } : { body: STATUS },
    );
    const plain = await request("POST", "/api/v1/admin/updates/install", {
      user: admin,
      body: { version: "0.2.1" },
    });
    expect(plain.status).toBe(503);
    expect(plain.body.error).toBe("The update service answered with HTTP 503.");
  });

  it("answer 409 for an updater error on the status itself", async () => {
    answer({ "GET /v1/status": { status: 500, body: { error: "The state file is broken." } } });
    const response = await request("GET", "/api/v1/admin/updates", { user: admin });
    expect(response.status).toBe(409);
    expect(response.body.updater).toBeNull();
    expect(response.body.error).toBe("The state file is broken.");
  });

  it.each([
    ["no service", null],
    ["a web page", { status: 200, body: "<html>Welcome to nginx</html>" }],
    ["not found", { status: 404, body: "Not found" }],
    ["another JSON", { status: 200, body: { status: "ok" } }],
  ] as const)("answer unreachable without an updater (%s)", async (_name, reply) => {
    if (reply === null) overrideConfigForTests({ UPDATER_URL: "http://127.0.0.1:9" });
    else answer({ "GET /v1/status": reply });
    const response = await request("GET", "/api/v1/admin/updates", { user: admin });
    expect(response.status).toBe(200);
    expect([response.body.reachable, response.body.updater]).toEqual([false, null]);
    expect(response.body.error).toContain(reply === null ? "http://127.0.0.1:9" : updater.url);
  });

  it("count an updater that does not answer in time as unreachable", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => timeout(ms / 1000));
    updater.respond(() => ({ delayMs: 200, body: STATUS }));
    const response = await request("POST", "/api/v1/admin/updates/check", { user: admin, body: {} });
    expect(response.status).toBe(200);
    expect(response.body.reachable).toBe(false);
    expect(response.body.error).toBe("The update service did not answer within 35 s.");
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

  it("take changes only from the app's own pages", async () => {
    for (const [method, url, body] of ROUTES.slice(1)) {
      const response = await request(method!, url!, {
        user: admin,
        body,
        headers: { origin: "https://evil.example.invalid" },
      });
      expect(response.status).toBe(403);
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

describe("answers of Meldgrove Updater 0.2", () => {
  const folder = path.join(path.dirname(fileURLToPath(import.meta.url)), "../test/fixtures/updater-0.2");
  const samples = fs
    .readdirSync(folder)
    .filter((name) => name.endsWith(".json"))
    .sort();

  it("are all here", () => {
    expect(samples).toHaveLength(7);
  });

  it.each(samples)("pass the client unchanged (%s)", async (name) => {
    const expected = JSON.parse(fs.readFileSync(path.join(folder, name), "utf8"));
    overrideConfigForTests({ APP_VERSION: "0.1.1" });
    updater.respond(() => ({ body: expected }));
    expect(await askUpdater({ call: "status" })).toEqual({
      status: 200,
      body: { app: { version: "0.1.1" }, reachable: true, updater: expected, error: null },
    });
  });

  it("keep the 202 of an installation", async () => {
    const expected = JSON.parse(fs.readFileSync(path.join(folder, "install-202.json"), "utf8"));
    updater.respond(() => ({ status: 202, body: expected }));
    expect(await askUpdater({ call: "install", version: "0.1.3" })).toMatchObject({
      status: 202,
      body: { reachable: true, updater: expected },
    });
  });
});
