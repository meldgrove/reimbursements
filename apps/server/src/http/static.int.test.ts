import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { overrideConfigForTests } from "../config";
import { createApp } from "./app";
import { peer, resetDatabase } from "../test/helpers";

/** A built web app of its own: index.html and the theme script, as `vite build` writes them. */
const dist = fs.mkdtempSync(path.join(os.tmpdir(), "reimbursements-web-"));

beforeAll(() => {
  fs.writeFileSync(
    path.join(dist, "index.html"),
    '<!doctype html><script src="/theme.js"></script><div id="root"></div>',
  );
  fs.writeFileSync(path.join(dist, "theme.js"), '"use strict";');
});
afterAll(() => fs.rmSync(dist, { recursive: true, force: true }));
beforeEach(async () => {
  await resetDatabase();
});

const get = (app: ReturnType<typeof createApp>, url: string, accept = "*/*") =>
  app.request(url, { headers: { accept } }, peer());

describe("the built web app", () => {
  it("serves the theme script that index.html loads before the page shows", async () => {
    overrideConfigForTests({ WEB_DIST_DIR: dist });
    const response = await get(createApp(), "/theme.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(response.headers.get("cache-control")).toBe("no-cache");
  });

  it("answers its pages whatever the request accepts, as the Django version did", async () => {
    overrideConfigForTests({ WEB_DIST_DIR: dist });
    const app = createApp();
    for (const page of [
      "/",
      "/datenschutz/",
      "/f/demo/",
      "/f/demo",
      "/received/0b9a6a2e-6f3c-4b0e-9d43-0d5c2f1e3a77/",
      "/admin/",
      "/admin/claims",
    ]) {
      const response = await get(app, page);
      expect(response.status, page).toBe(200);
      expect(await response.text(), page).toContain('<div id="root">');
    }
    // Other paths stay 404 unless a browser asks for a page.
    expect((await get(app, "/nothing-here")).status).toBe(404);
    expect((await get(app, "/nothing-here", "text/html")).status).toBe(200);
    expect((await get(app, "/api/v1/nothing")).status).toBe(404);
  });
});
