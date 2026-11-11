// Receipt removal keeps cleanup handles until the server confirms deletion.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const base = process.env.BASE_URL || "http://127.0.0.1:8000";

(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await require("./offline.cjs")(page, base);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const handles = new Set();
    let releaseUpload, uploadStarted, rejectDeletion = false, deletions = 0;
    const started = new Promise((resolve) => { uploadStarted = resolve; });
    const held = new Promise((resolve) => { releaseUpload = resolve; });
    await page.route("**/f/demo/uploads/**", async (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        if (!handles.size) {
          uploadStarted();
          await held;
        }
        const id = randomUUID();
        handles.add(id);
        return route.fulfill({ status: 202, json: {
          id, state: "pending", pages: 1,
          status_url: `/f/demo/uploads/${id}/status/`,
          delete_url: `/f/demo/uploads/${id}/`,
        } });
      }
      if (request.method() === "DELETE") {
        deletions++;
        if (rejectDeletion && deletions === 2)
          return route.fulfill({ status: 409, json: { error: "Datei wird noch geprüft." } });
        const id = new URL(request.url()).pathname.split("/").filter(Boolean).at(-1);
        if (!handles.delete(id))
          return route.fulfill({ status: 404, json: { error: "Datei nicht gefunden." } });
        return route.fulfill({ json: { removed: true } });
      }
      return route.fulfill({ json: { state: "ready", pages: 1 } });
    });
    await page.goto(`${base}/f/demo/`);
    await page.locator("#add-expense").click();
    const row = page.locator(".expense-card");
    const remove = row.locator('[data-action="remove"]');
    const fixture = (name) => ({ name, mimeType: "image/png", buffer: Buffer.alloc(100, 1) });
    await row.locator(".receipt-input").setInputFiles([fixture("one.png"), fixture("two.png")]);
    await started;
    assert.equal(await remove.isDisabled(), true, "active upload must keep its row");
    releaseUpload();
    await page.waitForFunction(() => document.querySelectorAll(".file-status.ready").length === 2);
    assert.equal(await remove.isEnabled(), true);

    rejectDeletion = true;
    await remove.click();
    await page.locator("#form-error").filter({ hasText: "Datei wird noch geprüft." }).waitFor();
    assert.equal(await row.count(), 1, "a failed deletion must retain the row");
    assert.equal(await row.locator(".file-list li").count(), 1, "only deleted files leave the list");
    assert.equal(await row.locator(".file-name").innerText(), "two.png");
    assert.equal(handles.size, 1);

    rejectDeletion = false;
    await remove.click();
    await page.waitForFunction(() => !document.querySelector(".expense-card"));
    assert.equal(handles.size, 0, "row removal must release all server handles");
    assert.equal(deletions, 3, "retry must not delete the already removed file again");
    await page.locator("#add-expense").click();
    await row.locator(".receipt-input").setInputFiles(fixture("replacement.png"));
    await page.waitForFunction(() => document.querySelector(".file-status.ready"));
    handles.clear();
    await remove.click();
    await page.waitForFunction(() => !document.querySelector(".expense-card"));
    assert.deepEqual(errors, []);
    console.log("Passed active-upload protection, partial deletion failure, retry, replacement and missing-file cleanup.");
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
