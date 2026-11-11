/* Run against the local demo with a worker and local-only email delivery.
 * Requires Playwright in Node's module path. No production data or recipients.
 */
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const base = process.env.BASE_URL || "http://127.0.0.1:8000";
const formSlug = process.env.FORM_SLUG || "demo";
const fixtures = process.env.FIXTURES_DIR;
const output = process.env.OUTPUT_DIR || "/tmp/reimbursement-browser";
if (!fixtures)
  throw new Error(
    "Set FIXTURES_DIR to synthetic train.png, hotel.pdf, and signature.png fixtures.",
  );
fs.mkdirSync(output, { recursive: true });

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const references = [];
  try {
    for (const signatureMode of ["draw", "upload", "mileage"]) {
      await page.goto(`${base}/f/${formSlug}/`);
      await page.locator("#id_full_name").fill("Alex Beispiel");
      assert.equal(
        await page.locator("#id_account_holder").inputValue(),
        "Alex Beispiel",
      );
      await page.locator("#id_street").fill("Teststraße 1");
      await page.locator("#id_postal_code").fill("12345");
      await page.locator("#id_city").fill("Berlin");
      await page.locator("#id_email").fill("participant@example.invalid");
      await page.locator("#id_iban").fill("DE89370400440532013000");
      if (await page.locator("#id_purpose_0").count())
        await page.locator("#id_purpose_0").check();
      else
        assert.equal(
          await page.locator('#id_purpose[type="hidden"]').count(),
          1,
        );
      assert.equal(await page.locator(".expense-card").count(), 0);
      await page.locator("#review-button").click();
      assert.equal(await page.locator("#review-panel").isVisible(), false);
      assert.match(await page.locator("#form-error").innerText(), /position/i);
      if (signatureMode === "mileage") {
        await page.locator("#add-expense").click();
        await page.locator('[data-action="remove"]').click();
        assert.equal(await page.locator(".expense-card").count(), 0);
        await page.locator("#add-mileage").click();
        assert.equal(await page.locator("#receipt-travel").isVisible(), false);
        assert.equal(await page.locator('[data-field="purpose"]').count(), 0);
        for (const [field, value] of Object.entries({
          travel_date: "2026-10-20",
          vehicle_registration: "B-AB 123",
          route_from: "Hamburg",
          route_to: "Berlin",
          distance_km: "100",
        }))
          await page.locator(`[data-field="${field}"]`).fill(value);
        assert.match(await page.locator("#totals").innerText(), /30,00/);
        await page.locator('[data-field="round_trip"]').check();
        await page.locator('[data-field="return_date"]').fill("2026-10-19");
        await page.locator("#review-button").click();
        assert.equal(await page.locator("#review-panel").isVisible(), false);
        await page.locator('[data-field="return_date"]').fill("2026-10-21");
        assert.match(await page.locator("#totals").innerText(), /60,00/);
      } else {
        await page.locator("#add-expense").click();
        await page.locator("#receipt-travel summary").click();
        await page.locator("#id_trip_destination").fill("Berlin");
        await page.locator("#id_trip_start").fill("2026-10-20");
        await page.locator("#id_trip_end").fill("2026-10-21");
        for (const [index, merchant, amount, file] of [
          [0, "Belegverkauf", "10,10", "train.png"],
          [1, "Test Hotel", "20,20", "hotel.pdf"],
        ]) {
          if (index) await page.locator("#add-expense").click();
          const row = page.locator(".expense-card").nth(index);
          await row.locator('[data-field="merchant"]').fill(merchant);
          await row
            .locator('[data-field="receipt_reference"]')
            .fill(`TEST-${index + 1}`);
          await row.locator('[data-field="amount"]').fill(amount);
          await row
            .locator("input[type=file]")
            .setInputFiles(path.join(fixtures, file));
          await row
            .locator(".file-status")
            .filter({ hasText: /^Geprüft$/ })
            .waitFor({ timeout: 60000 });
        }
        assert.match(await page.locator("#totals").innerText(), /30,30/);
        await page
          .locator(".expense-card")
          .nth(1)
          .getByRole("button", { name: "Position nach oben verschieben" })
          .click();
        assert.equal(
          await page
            .locator(".expense-card")
            .first()
            .locator('[data-field="merchant"]')
            .inputValue(),
          "Test Hotel",
        );
        assert.match(
          await page
            .locator(".expense-card")
            .first()
            .locator(".file-list")
            .innerText(),
          /hotel.pdf/,
        );
      }
      if (signatureMode === "draw") {
        await page.screenshot({
          path: path.join(output, "desktop-form.png"),
          fullPage: true,
        });
        await page.setViewportSize({ width: 390, height: 844 });
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          "Mobile form overflows",
        );
        await page.screenshot({
          path: path.join(output, "mobile-form.png"),
          fullPage: true,
        });
      }
      await page.locator("#review-button").click();
      await page.locator("#review-panel").waitFor({ state: "visible" });
      assert.match(
        await page.locator("#review-content").innerText(),
        signatureMode === "mileage" ? /60,00/ : /30,30/,
      );
      if (signatureMode === "mileage") {
        const text = await page.locator("#review-content").innerText();
        assert.match(text, /B-AB 123/);
        assert.match(text, /21.10.2026/);
      }
      assert.match(
        await page.locator("#review-content").innerText(),
        /Alex Beispiel/,
      );
      if (signatureMode === "draw") {
        await page.locator("#declaration").check();
        await page.locator("#edit-button").click();
        await page.locator("#review-button").click();
        assert.equal(await page.locator("#declaration").isChecked(), false);
        await page.locator("#signature-canvas").scrollIntoViewIfNeeded();
        const bounds = await page.locator("#signature-canvas").boundingBox();
        await page.mouse.move(
          bounds.x + bounds.width * 0.1,
          bounds.y + bounds.height * 0.7,
        );
        await page.mouse.down();
        for (const [x, y] of [
          [0.2, 0.2],
          [0.4, 0.8],
          [0.6, 0.3],
          [0.8, 0.7],
        ])
          await page.mouse.move(
            bounds.x + bounds.width * x,
            bounds.y + bounds.height * y,
          );
        await page.mouse.up();
        assert.match(
          await page.locator("#signature-status").innerText(),
          /gezeichnet/,
        );
      } else {
        await page
          .locator("#signature-file")
          .setInputFiles(path.join(fixtures, "signature.png"));
        await page.waitForFunction(
          () =>
            document
              .getElementById("signature-status")
              .textContent.includes("Unterschrift geprüft"),
          null,
          { timeout: 60000 },
        );
      }
      await page.locator("#declaration").check();
      await page.locator("#privacy_acknowledged").check();
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "Review overflows",
      );
      await page.locator("#submit-button").click();
      await page.waitForURL(/\/received\/[0-9a-f-]+\//, { timeout: 60000 });
      const reference = await page.locator("#claim-reference").innerText();
      references.push(reference);
      assert.match(
        reference,
        /^Erst\/\d{4}-\d{2}-\d{2}\/[^/]+\/beispiel\/\d{6}$/,
      );
      assert.equal(reference.split("/")[2], formSlug);
      assert.match(await page.locator("body").innerText(), /binnen einer Woche/);
      await page.waitForFunction(
        () =>
          document
            .getElementById("processing-status")
            .textContent.includes("wurde an Finance übermittelt"),
        null,
        { timeout: 60000 },
      );
      assert.equal(
        await page
          .locator("body")
          .innerText()
          .then((text) => text.includes("DE89370400440532013000")),
        false,
      );
      await page.reload();
      assert.equal(
        await page.locator("#claim-reference").innerText(),
        reference,
      );
      const anonymous = await browser.newContext();
      const response = await anonymous.request.get(page.url());
      assert.equal(response.status(), 404);
      await anonymous.close();
      await page.screenshot({
        path: path.join(output, `received-${signatureMode}.png`),
        fullPage: true,
      });
    }
    assert.equal(new Set(references).size, 3);
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        result: "passed",
        flows: ["drawn signature", "uploaded signature", "mileage only"],
        references,
        desktopAndMobile: true,
        pageErrors: errors,
      }),
    );
  } catch (error) {
    await page.screenshot({
      path: path.join(output, "failure.png"),
      fullPage: true,
    });
    console.error(
      await page.evaluate(() => ({
        url: location.href,
        error: document.getElementById("form-error")?.textContent,
        invalid: [...document.querySelectorAll("input,textarea,select")]
          .filter((element) => !element.checkValidity())
          .map((element) => ({
            name: element.name || element.dataset.field,
            validation: element.validationMessage,
          })),
        pageErrors: [],
      })),
    );
    throw error;
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
