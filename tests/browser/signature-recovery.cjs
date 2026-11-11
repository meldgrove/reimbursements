// Fault-injection browser test. Uploads and submissions are intercepted locally.
// Requires the demo form, Playwright, and synthetic train.png/signature.png fixtures.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const path = require("node:path");

const base = process.env.BASE_URL || "http://127.0.0.1:8000";
const fixtures = process.env.FIXTURES_DIR;
if (!fixtures)
  throw new Error("Set FIXTURES_DIR to synthetic browser fixtures.");

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext();
  // Exercise the full delayed-poll window without waiting several minutes.
  await context.addInitScript(() => {
    const original = window.setTimeout.bind(window);
    window.setTimeout = (fn, delay, ...args) =>
      original(fn, delay >= 2000 && delay < 15000 ? 0 : delay, ...args);
  });
  const page = await context.newPage();
  await require("./offline.cjs")(page, base);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const uploads = new Map();
  let mode = "failed",
    rejectDelete = false,
    signatureCount = 0,
    quotaRejections = 0,
    submitted;
  const signatures = () =>
    [...uploads.values()].filter((item) => item.kind === "signature");
  const json = (route, status, value) => route.fulfill({ status, json: value });
  await page.route("**/f/demo/uploads/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST") {
      const kind = /name="kind"\r\n\r\nsignature/.test(
        request.postDataBuffer().toString(),
      )
        ? "signature"
        : "receipt";
      if (kind === "signature" && signatures().length >= 3) {
        quotaRejections++;
        return json(route, 400, { error: "Synthetic three-signature limit" });
      }
      const id = randomUUID();
      const item = {
        id,
        kind,
        mode: kind === "signature" ? mode : "ready",
        name: `${kind}.png`,
        state: "pending",
        pages: 1,
        status_url: `/f/demo/uploads/${id}/status/`,
        delete_url: `/f/demo/uploads/${id}/`,
      };
      uploads.set(id, item);
      if (kind === "signature") signatureCount++;
      return json(route, 202, item);
    }
    const id = pathname.split("/")[4];
    const item = uploads.get(id);
    if (!item) return json(route, 404, { error: "Missing synthetic upload" });
    if (request.method() === "DELETE") {
      if (rejectDelete) {
        rejectDelete = false;
        return json(route, 409, {
          error: "Synthetic validation still running",
        });
      }
      uploads.delete(id);
      return json(route, 200, { removed: true });
    }
    if (item.mode === "network")
      return json(route, 503, { error: "Synthetic polling failure" });
    return json(route, 200, {
      id,
      pages: 1,
      state: item.mode === "timeout" ? "pending" : item.mode,
      message: item.mode === "failed" ? "Synthetic invalid signature" : "",
    });
  });
  await page.route("**/f/demo/submit/", async (route) => {
    submitted = route.request().postDataJSON();
    assert.equal(uploads.get(submitted.signature)?.mode, "ready");
    return json(route, 400, { error: "Synthetic submission captured" });
  });
  try {
    await page.goto(`${base}/f/demo/`);
    await page.locator("#id_purpose_0").check();
    await page.locator("#add-expense").click();
    await page.locator("#receipt-travel summary").click();
    for (const [id, value] of Object.entries({
      id_full_name: "Alex Beispiel",
      id_street: "Teststraße 1",
      id_postal_code: "12345",
      id_city: "Berlin",
      id_email: "participant@example.invalid",
      id_iban: "DE89370400440532013000",
      id_trip_destination: "Berlin",
      id_trip_start: "2026-10-20",
      id_trip_end: "2026-10-21",
    }))
      await page.locator(`#${id}`).fill(value);
    const row = page.locator(".expense-card");
    for (const [field, value] of Object.entries({
      merchant: "Belegverkauf",
      amount: "12,50",
    }))
      await row.locator(`[data-field="${field}"]`).fill(value);
    await row
      .locator("input[type=file]")
      .setInputFiles(path.join(fixtures, "train.png"));
    await row.locator(".file-status.ready").waitFor();
    await page.locator("#review-button").click();

    async function uploadSignature(nextMode) {
      mode = nextMode;
      const response = page.waitForResponse(
        (result) =>
          result.request().method() === "POST" &&
          result.url().endsWith("/uploads/"),
      );
      await page
        .locator("#signature-file")
        .setInputFiles(path.join(fixtures, "signature.png"));
      await response;
      await page.waitForFunction(
        () => !document.getElementById("signature-file").disabled,
      );
    }
    for (const failure of [
      "failed",
      "failed",
      "failed",
      "network",
      "timeout",
    ]) {
      await uploadSignature(failure);
      assert.equal(
        signatures().length,
        1,
        "Replacing failed signatures must remove their server records",
      );
      if (failure === "failed") {
        assert.equal(await page.locator("#form-error").isVisible(), true);
      } else {
        assert.equal(await page.locator("#retry-signature").isVisible(), true);
        const before = signatureCount;
        signatures()[0].mode = "ready";
        await page.locator("#retry-signature").click();
        await page.waitForFunction(
          () => !document.getElementById("retry-signature").disabled,
        );
        assert.equal(
          signatureCount,
          before,
          "Delayed signatures must reuse their upload",
        );
        assert.match(
          await page.locator("#signature-status").innerText(),
          /geprüft/,
        );
      }
    }
    rejectDelete = true;
    await page.locator("#clear-signature").click();
    await page.waitForFunction(
      () => !document.getElementById("clear-signature").disabled,
    );
    assert.equal(
      signatures().length,
      1,
      "A rejected deletion must preserve the handle",
    );
    await page.locator("#clear-signature").click();
    await page.waitForFunction(
      () => !document.getElementById("clear-signature").disabled,
    );
    assert.equal(signatures().length, 0);
    await uploadSignature("timeout");
    const supersededSignature = signatures()[0].id;
    signatures()[0].mode = "ready";

    const canvas = page.locator("#signature-canvas");
    await canvas.scrollIntoViewIfNeeded();
    const bounds = await canvas.boundingBox();
    await page.mouse.move(bounds.x + 30, bounds.y + 80);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 120, bounds.y + 20, { steps: 5 });
    await page.mouse.move(bounds.x + 240, bounds.y + 90, { steps: 5 });
    await page.mouse.up();
    assert.equal(
      await page.locator("#retry-signature").isVisible(),
      false,
      "Drawing a replacement must invalidate polling the old signature",
    );
    // A queued click for the obsolete upload must also be harmless.
    await page.evaluate(() =>
      document.getElementById("retry-signature").click(),
    );
    await page.waitForFunction(
      () => !document.getElementById("signature-file").disabled,
    );
    await page.locator("#declaration").check();
    await page.locator("#privacy_acknowledged").check();
    for (const [index, failure] of [
      "failed",
      "network",
      "timeout",
      "ready",
    ].entries()) {
      // A changed drawing deliberately replaces the preceding signature.
      if (index) {
        await page.mouse.move(bounds.x + 50, bounds.y + 90);
        await page.mouse.down();
        await page.mouse.move(bounds.x + 120, bounds.y + 40, { steps: 3 });
        await page.mouse.up();
      }
      mode = failure;
      const response = page.waitForResponse(
        (result) =>
          result.request().method() === "POST" &&
          result.url().endsWith("/uploads/"),
      );
      await page.locator("#submit-button").click();
      await response;
      await page.waitForFunction(
        () => !document.getElementById("submit-button").disabled,
      );
      assert.equal(
        signatures().length,
        1,
        "Drawing retries must replace the previous server record",
      );
      if (["network", "timeout"].includes(failure)) {
        const before = signatureCount;
        signatures()[0].mode = "ready";
        await page.locator("#retry-signature").click();
        await page.waitForFunction(
          () => !document.getElementById("retry-signature").disabled,
        );
        assert.equal(signatureCount, before);
      }
    }
    assert.equal(submitted.signature, signatures()[0].id);
    assert.notEqual(submitted.signature, supersededSignature);
    assert.equal(signatureCount, 10);
    assert.equal(quotaRejections, 0);
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        result: "passed",
        signatureUploads: signatureCount,
        quotaRejections,
        validationFailure: true,
        pollingFailure: true,
        pollingTimeout: true,
        busyDeletionRetry: true,
        drawnRetrySubmission: true,
        obsoleteSignatureCannotRevive: true,
      }),
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
