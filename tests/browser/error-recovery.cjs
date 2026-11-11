// Real server validation plus isolated upload/status faults. No mail is sent.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const base = process.env.BASE_URL || "http://127.0.0.1:8000";
const fixtures = process.env.FIXTURES_DIR;
const output = process.env.OUTPUT_DIR || "/tmp/reimbursement-browser";
if (!fixtures)
  throw new Error("Set FIXTURES_DIR to synthetic browser fixtures");

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  await context.addInitScript(() => {
    const original = window.setTimeout.bind(window);
    window.setTimeout = (fn, delay, ...args) =>
      original(fn, delay >= 2000 && delay < 15000 ? 0 : delay, ...args);
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let mode = "ready",
    polls = 0,
    uploads = 0;
  await page.route("**/f/demo/uploads/**", async (route) => {
    if (route.request().method() === "POST") {
      uploads++;
      const id = randomUUID();
      return route.fulfill({
        status: 202,
        json: {
          id,
          name: "synthetic.png",
          size: 100,
          state: "pending",
          status_url: `/f/demo/uploads/${id}/status/`,
          delete_url: `/f/demo/uploads/${id}/`,
        },
      });
    }
    if (route.request().method() === "DELETE")
      return route.fulfill({ status: 200, json: { removed: true } });
    polls++;
    if (mode === "transient" && polls === 1)
      return route.fulfill({
        status: 503,
        json: { error: "Synthetic outage" },
      });
    return route.fulfill({
      status: 200,
      json: { state: "ready", pages: 1, message: "" },
    });
  });
  async function fill(invalidField) {
    await page.goto(`${base}/f/demo/`);
    await page.locator("#id_purpose_0").check();
    await page.locator("#add-expense").click();
    await page.locator("#receipt-travel summary").click();
    const values = {
      full_name: "Synthetic Reviewer",
      street: "Teststrasse 1",
      postal_code: "12345",
      city: "Berlin",
      email: "review@example.invalid",
      iban: "DE89370400440532013000",
      trip_destination: "Berlin",
      trip_start: "2026-10-20",
      trip_end: "2026-10-21",
    };
    for (const [field, value] of Object.entries(values))
      await page.locator(`#id_${field}`).fill(value);
    for (const [field, value] of Object.entries({
      merchant: "Synthetic Rail",
      amount: "12,50",
    }))
      await page.locator(`[data-field="${field}"]`).fill(value);
    await page
      .locator(".receipt-input")
      .setInputFiles(path.join(fixtures, "train.png"));
    await page.locator(".file-status.ready").waitFor();
    await page.locator("#review-button").click();
    await page.locator("#review-panel").waitFor({ state: "visible" });
    assert.equal(
      await page.evaluate(() => document.activeElement.tagName),
      "H2",
    );
    await page
      .locator("#signature-file")
      .setInputFiles(path.join(fixtures, "signature.png"));
    await page.waitForFunction(() =>
      document
        .getElementById("signature-status")
        .textContent.includes("Unterschrift geprüft"),
    );
    await page.locator("#declaration").check();
    await page.locator("#privacy_acknowledged").check();
    // Simulate data changing after review, so submission must still reject it.
    // Invalid entries before review are now caught by the shared live rules.
    await page.evaluate((field) => {
      document.getElementById(`id_${field}`).value = field === "iban"
        ? "DE89370400440532013001" : "2026-10-19";
    }, invalidField);
  }
  try {
    for (const field of ["iban", "trip_end"]) {
      await fill(field);
      const response = page.waitForResponse((result) =>
        result.url().endsWith("/submit/"),
      );
      await page.locator("#submit-button").click();
      assert.equal((await response).status(), 400);
      await page.locator(`#error-${field}`).waitFor({ state: "visible" });
      assert.equal(await page.locator("#details-panel").isVisible(), true);
      assert.equal(await page.locator("#review-panel").isVisible(), false);
      assert.equal(
        await page.evaluate(() => document.activeElement.id),
        `id_${field}`,
      );
      assert.equal(await page.locator("#declaration").isChecked(), false);
      assert.equal(
        await page.locator("#privacy_acknowledged").isChecked(),
        false,
      );
    }
    fs.mkdirSync(output, { recursive: true });
    await page.screenshot({
      path: path.join(output, "visible-validation-error.png"),
      fullPage: true,
    });
    mode = "transient";
    polls = 0;
    uploads = 0;
    await page.goto(`${base}/f/demo/`);
    await page.locator("#add-expense").click();
    await page
      .locator(".receipt-input")
      .setInputFiles(path.join(fixtures, "train.png"));
    await page.locator(".file-status.ready").waitFor();
    assert.equal(polls, 2);
    assert.equal(uploads, 1);
    assert.equal(await page.locator(".file-status.failed").count(), 0);
    let receiptPolls = 0;
    await page.route("**/received/synthetic/**", (route) => {
      if (!route.request().url().includes("?format=json"))
        return route.fulfill({
          contentType: "text/html",
          body: '<meta charset="utf-8"><p id="processing-status" data-status="received"></p><script src="/static/portal/received.js"></script>',
        });
      receiptPolls++;
      return route.fulfill(
        receiptPolls === 1
          ? { status: 503, json: {} }
          : { status: 200, json: { state: "delivered", final: true } },
      );
    });
    await page.goto(`${base}/received/synthetic/`);
    await page.waitForFunction(() =>
      document
        .getElementById("processing-status")
        .textContent.includes("wurde an Finance übermittelt"),
    );
    assert.equal(receiptPolls, 2);
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        result: "passed",
        visibleServerErrors: ["iban", "trip_end"],
        transientUploadRecovery: true,
        receiptStatusRecovery: true,
        uploadReused: true,
        pageErrors: errors,
      }),
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
