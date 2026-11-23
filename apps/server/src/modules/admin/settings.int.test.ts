import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { darkAccent } from "@reimbursements/shared/theme";
import type { User } from "../../db/schema";
import { FORM_EDITOR, TEMPLATE_ADMIN } from "../../auth/roles";
import { loadFavicon, loadSettings, saveSettings } from "../../services/app-settings";
import { createUser, request, resetDatabase, signInWithTestHeader } from "../../test/helpers";
import { overrideConfigForTests } from "../../config";

/**
 * The General and Appearance pages: tests/test_appearance_settings.py and
 * the admin cases of tests/test_general_settings.py. The accent reaches
 * every page through /api/v1/meta (the browser writes the stylesheet), not
 * through Django's /theme/<digest>.css.
 */
let restore: () => void;
let admin: User;
let editor: User;

beforeAll(() => {
  restore = signInWithTestHeader();
});
afterAll(() => restore());

beforeEach(async () => {
  await resetDatabase();
  admin = await createUser("admin", [TEMPLATE_ADMIN]);
  editor = await createUser("editor", [FORM_EDITOR]);
});

const GENERAL = "/api/v1/admin/settings/general";
const APPEARANCE = "/api/v1/admin/settings/appearance";
const general = (changes: Record<string, string> = {}) => ({
  language: "de",
  timezone: "Europe/Berlin",
  dateFormat: "d.m.Y",
  numberFormat: "european",
  ...changes,
});

async function image(size = 32, format: "png" | "webp" = "png") {
  const pipeline = sharp({ create: { width: size, height: size, channels: 3, background: "teal" } });
  return (format === "png" ? pipeline.png() : pipeline.webp()).toBuffer();
}

function upload(content: Uint8Array, fields: Record<string, string> = {}) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  form.append("favicon", new Blob([new Uint8Array(content)]), "icon");
  return form;
}

describe("general settings", () => {
  it("are changed by template admins", async () => {
    const page = await request("GET", GENERAL, { user: admin });
    expect(page.body.settings).toEqual(general());
    expect(page.body.choices.numberFormats).toEqual([
      { value: "european", label: "1.234,56 (European)" },
      { value: "us", label: "1,234.56 (US)" },
    ]);
    expect(page.body.choices.timezones).toContainEqual({
      value: "America/New_York",
      label: "America/New York",
    });
    expect(page.body.version).toBe("Built from source");
    const response = await request("PUT", GENERAL, {
      user: admin,
      body: general({
        language: "en",
        timezone: "America/New_York",
        dateFormat: "Y-m-d",
        numberFormat: "us",
      }),
    });
    expect(response.status).toBe(200);
    expect(response.body.message).toBe("The general settings were saved.");
    const saved = await loadSettings();
    expect([saved.language, saved.timezone, saved.dateFormat, saved.numberFormat]).toEqual([
      "en",
      "America/New_York",
      "Y-m-d",
      "us",
    ]);
    const refused = await request("PUT", GENERAL, {
      user: admin,
      body: general({ timezone: "Mars/Olympus" }),
    });
    expect(refused.status).toBe(422);
    expect((await loadSettings()).timezone).toBe("America/New_York");
  });

  it("show the running version", async () => {
    const restoreConfig = overrideConfigForTests({ APP_VERSION: "0.5.0" });
    try {
      expect((await request("GET", GENERAL, { user: admin })).body.version).toBe("0.5.0");
    } finally {
      restoreConfig();
    }
  });

  it("are not for form editors", async () => {
    expect((await request("GET", GENERAL, { user: editor })).status).toBe(403);
    expect((await request("PUT", GENERAL, { user: editor, body: general({ language: "en" }) })).status).toBe(
      403,
    );
    expect((await loadSettings()).language).toBe("de");
  });

  it("leave the admin area in English whatever the app language", async () => {
    for (const language of ["de", "en"] as const) {
      await saveSettings({ language });
      const response = await request("PUT", GENERAL, {
        user: admin,
        body: general({ language, timezone: "x" }),
      });
      expect(response.headers.get("content-language")).toBe("en");
      expect(response.body.error.fields.timezone).toBe(
        "Select a valid choice. x is not one of the available choices.",
      );
    }
  });
});

describe("appearance", () => {
  it("is opened by template admins, with the standard colors and favicon", async () => {
    const page = await request("GET", APPEARANCE, { user: admin });
    expect(page.body).toEqual({
      accentColor: "",
      inUse: { custom: false, light: "#171717", dark: "#e5e5e5" },
      favicon: { custom: false, url: "/favicon.svg", type: "image/svg+xml" },
    });
  });

  it("is not for form editors", async () => {
    expect((await request("GET", APPEARANCE, { user: editor })).status).toBe(403);
    expect(
      (await request("POST", APPEARANCE, { user: editor, body: { accentColor: "#1d4ed8" } })).status,
    ).toBe(403);
    expect((await loadSettings()).accentColor).toBe("");
  });

  it.each([
    ["#1D4ED8", "#1d4ed8"],
    [" 1d4ed8 ", "#1d4ed8"],
    ["#abc", "#aabbcc"],
    ["", ""],
  ])("takes the accent color as a hex code (%s)", async (entered, saved) => {
    const response = await request("POST", APPEARANCE, { user: admin, body: { accentColor: entered } });
    expect(response.status).toBe(200);
    expect((await loadSettings()).accentColor).toBe(saved);
  });

  it.each(["teal", "#12345", "#1d4ed8ff", "#ggg"])(
    "refuses an accent color that is not a hex code (%s)",
    async (entered) => {
      await saveSettings({ accentColor: "#1d4ed8" });
      const response = await request("POST", APPEARANCE, { user: admin, body: { accentColor: entered } });
      expect(response.status).toBe(422);
      expect(response.body.error.fields.accentColor).toBe("Enter a hex code such as #0f766e.");
      expect((await loadSettings()).accentColor).toBe("#1d4ed8");
    },
  );

  it("keeps the general settings", async () => {
    await saveSettings({ language: "en", timezone: "UTC", dateFormat: "Y-m-d" });
    expect(
      (await request("POST", APPEARANCE, { user: admin, body: { accentColor: "#1d4ed8" } })).status,
    ).toBe(200);
    const saved = await loadSettings();
    expect([saved.language, saved.timezone, saved.dateFormat, saved.accentColor]).toEqual([
      "en",
      "UTC",
      "Y-m-d",
      "#1d4ed8",
    ]);
  });

  it("restyles public pages and the admin area through the meta answer", async () => {
    const meta = async () => (await request("GET", "/api/v1/meta")).body.settings.accentColor;
    expect(await meta()).toBe("");
    const response = await request("POST", APPEARANCE, { user: admin, body: { accentColor: "#1d4ed8" } });
    expect(response.body.inUse).toEqual({ custom: true, light: "#1d4ed8", dark: darkAccent("#1d4ed8") });
    expect(await meta()).toBe("#1d4ed8");
    await request("POST", APPEARANCE, { user: admin, body: { accentColor: "" } });
    expect(await meta()).toBe("");
  });

  it("warns that links in a light accent are hard to read", async () => {
    const light = await request("POST", APPEARANCE, { user: admin, body: { accentColor: "#facc15" } });
    expect(light.body.warning).toBe(
      "Links in #facc15 are hard to read on white. A darker color reads better.",
    );
    expect((await loadSettings()).accentColor).toBe("#facc15");
    const dark = await request("POST", APPEARANCE, { user: admin, body: { accentColor: "#1d4ed8" } });
    expect(dark.body.warning).toBeUndefined();
  });

  it.each([
    ["png", "image/png"],
    ["webp", "image/webp"],
  ] as const)("replaces the standard favicon with a custom one (%s)", async (format, type) => {
    const content = await image(32, format);
    const response = await request("POST", APPEARANCE, { user: admin, body: upload(content) });
    expect(response.status).toBe(200);
    const settings = await loadSettings();
    expect(settings.faviconType).toBe(type);
    expect((await loadFavicon())!.content.equals(Buffer.from(content))).toBe(true);
    const url = `/favicon/${settings.faviconDigest}/`;
    expect(response.body.favicon).toEqual({ custom: true, url, type });
    const served = await request("GET", url);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe(type);
    expect(served.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(served.headers.get("content-security-policy")).toContain("sandbox");
    const removed = await request("POST", APPEARANCE, {
      user: admin,
      body: { accentColor: "", removeFavicon: true },
    });
    expect(removed.body.favicon.custom).toBe(false);
    expect(await loadFavicon()).toBeNull();
    expect((await request("GET", url)).status).toBe(404);
  });

  it.each([
    [Buffer.from("GIF89a not accepted"), "Upload a PNG, ICO, SVG or WebP file."],
    [Buffer.from("<html><script>alert(1)</script></html>"), "Upload a PNG, ICO, SVG or WebP file."],
    [Buffer.from("RIFF\x24\x00\x00\x00WAVEfmt ", "latin1"), "Upload a PNG, ICO, SVG or WebP file."],
    [Buffer.from("WEBP"), "Upload a PNG, ICO, SVG or WebP file."],
    ["large", "The favicon may be at most 100 KB."],
  ] as const)("takes only small PNG, ICO, SVG or WebP favicons", async (content, error) => {
    const bytes = content === "large" ? Buffer.concat([await image(400), Buffer.alloc(100_000)]) : content;
    const response = await request("POST", APPEARANCE, { user: admin, body: upload(bytes) });
    expect(response.status).toBe(422);
    expect(response.body.error.fields.favicon).toBe(error);
    expect(await loadFavicon()).toBeNull();
  });

  it("takes SVG and ICO favicons", async () => {
    for (const [content, type] of [
      [Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'), "image/svg+xml"],
      [Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.alloc(40)]), "image/x-icon"],
    ] as const) {
      expect((await request("POST", APPEARANCE, { user: admin, body: upload(content) })).status).toBe(200);
      expect((await loadSettings()).faviconType).toBe(type);
    }
  });
});
