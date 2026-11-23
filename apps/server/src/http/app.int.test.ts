import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { overrideConfigForTests } from "../config";
import { getDb } from "../db/client";
import { sessions } from "../db/schema";
import { saveSettings, setFavicon } from "../services/app-settings";
import { RequestParticipant } from "../participants";
import { CookieJar, peer, request, resetDatabase, testApp } from "../test/helpers";
import { legacyAdminPath } from "../modules/assets";
import { applySettings } from "./middleware";
import type { AppEnv } from "./env";

beforeEach(async () => {
  await resetDatabase();
});

describe("health checks", () => {
  it("answer only with the health token outside development", async () => {
    overrideConfigForTests({ isDevelopment: false });
    expect((await request("GET", "/-/healthz")).status).toBe(404);
    expect((await request("GET", "/-/readyz", { headers: { "x-health-token": "wrong" } })).status).toBe(404);
    const health = await request("GET", "/-/healthz", { headers: { "x-health-token": "test-health-token" } });
    expect(health.status).toBe(200);
    expect(health.body.status).toBe("OK");
    const ready = await request("GET", "/-/readyz", {
      headers: { "x-health-token": "test-health-token", "x-forwarded-proto": "https" },
    });
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ status: "OK", oldest_job_age_seconds: 0 });
    expect(ready.headers.get("cache-control")).toBe("no-store, private");
  });

  it("answer in development without the token", async () => {
    expect((await request("GET", "/-/healthz")).status).toBe(200);
  });
});

describe("the frame of every request", () => {
  it("sends security headers and keeps pages out of caches", async () => {
    const response = await request("GET", "/api/v1/meta");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("cache-control")).toBe("no-store, private");
  });

  it("refuses changes from another origin", async () => {
    const response = await request("POST", "/api/v1/auth/logout", {
      headers: { origin: "https://evil.example.invalid" },
    });
    expect(response.status).toBe(403);
  });

  it("refuses large requests with the participant's message", async () => {
    await saveSettings({ language: "en" });
    const response = await request("POST", "/api/v1/public/forms/test/validate", {
      body: "x".repeat(200_000),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(413);
    expect(response.body.error.message).toBe("The file or request is too large.");
    // Uploads may carry a receipt.
    const upload = await request("POST", "/api/v1/public/forms/test/uploads", {
      body: "x".repeat(200_000),
      headers: { "content-type": "application/octet-stream" },
    });
    expect(upload.status).not.toBe(413);
  });

  it("answers in the app language on public paths and English in the admin area", async () => {
    await saveSettings({ language: "de" });
    expect((await request("GET", "/api/v1/meta")).headers.get("content-language")).toBe("de");
    expect((await request("GET", "/api/v1/admin/updates")).headers.get("content-language")).toBe("en");
  });
});

describe("meta", () => {
  it("tells every page the settings, and nobody signed in", async () => {
    await saveSettings({ language: "en", dateFormat: "Y-m-d", numberFormat: "us", accentColor: "#0f766e" });
    const { body } = await request("GET", "/api/v1/meta");
    expect(body).toMatchObject({
      appName: "Meldgrove Reimbursement",
      user: null,
      updatesButton: false,
      settings: {
        language: "en",
        dateFormat: "Y-m-d",
        numberFormat: "us",
        accentColor: "#0f766e",
        faviconDigest: "",
      },
    });
  });
});

describe("favicon", () => {
  it("serves the Appearance favicon by digest, sandboxed", async () => {
    expect((await request("GET", "/favicon/abc/")).status).toBe(404);
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const { faviconDigest } = await setFavicon(png, "image/png");
    const response = await testApp().request(`/favicon/${faviconDigest}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    expect((await testApp().request("/favicon/old/")).headers.get("cache-control")).toBe("public, no-cache");
  });
});

describe("addresses of the Django version", () => {
  it.each([
    ["/admin/portal/claim/", "/admin/claims"],
    [
      "/admin/portal/claim/5a0f0b1e-3c1d-4b4e-9a55-2b7f1f3a9c10/change/",
      "/admin/claims/5a0f0b1e-3c1d-4b4e-9a55-2b7f1f3a9c10",
    ],
    [
      "/admin/portal/claim/5a0f0b1e-3c1d-4b4e-9a55-2b7f1f3a9c10/retry/",
      "/admin/claims/5a0f0b1e-3c1d-4b4e-9a55-2b7f1f3a9c10",
    ],
    ["/admin/portal/form/", "/admin/forms"],
    ["/admin/portal/form/add/", "/admin/forms/new"],
    ["/admin/portal/form/12/change/", "/admin/forms/12"],
    ["/admin/portal/formtemplate/3/change/", "/admin/templates/3"],
    ["/admin/portal/privacynotice/add/", "/admin/privacy-notice/new"],
    ["/admin/portal/appsettings/1/change/", "/admin/general"],
    ["/admin/portal/appearance/1/change/", "/admin/appearance"],
    ["/admin/portal/updates/", "/admin/updates"],
    ["/admin/login/", "/admin/login"],
  ])("sends %s to %s", async (old, now) => {
    expect(legacyAdminPath(old)).toBe(now);
    const response = await testApp().request(old, { headers: { accept: "text/html" } });
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(now);
  });

  it("leaves the new pages alone", () => {
    expect(legacyAdminPath("/admin/claims")).toBeNull();
    expect(legacyAdminPath("/admin/")).toBeNull();
  });
});

describe("participant sessions", () => {
  const app = new Hono<AppEnv>();
  app.use("*", applySettings);
  app.get("/binding", async (c) => {
    const participant = new RequestParticipant(c);
    return c.json({ binding: await participant.binding(), network: participant.network });
  });
  app.post("/admit", async (c) => {
    const participant = new RequestParticipant(c);
    const binding = await participant.binding({ create: true });
    await participant.remember("test", "draft-1", "token-1");
    return c.json({ binding });
  });
  app.get("/remembered", async (c) => c.json(await new RequestParticipant(c).remembered("test")));

  const call = async (jar: CookieJar, method: string, path: string) => {
    const response = await app.request(
      path,
      { method, headers: { cookie: jar.header() ?? "" } },
      peer("192.0.2.7"),
    );
    jar.store(response);
    return response.json();
  };

  it("start only when a draft is admitted, and remember drafts for 7 days", async () => {
    const jar = new CookieJar();
    expect(await call(jar, "GET", "/binding")).toEqual({ binding: null, network: "192.0.2.7/32" });
    const { binding } = await call(jar, "POST", "/admit");
    expect(binding).toMatch(/^[0-9a-f]{64}$/);
    expect(await call(jar, "GET", "/binding")).toMatchObject({ binding });
    expect(await call(jar, "GET", "/remembered")).toEqual({ id: "draft-1", token: "token-1" });
    const [row] = await getDb().select().from(sessions);
    expect(row!.kind).toBe("participant");
    const days = (row!.expiresAt.getTime() - row!.createdAt.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(7);
    // Another browser has its own binding.
    const other = new CookieJar();
    expect((await call(other, "POST", "/admit")).binding).not.toBe(binding);
  });
});
