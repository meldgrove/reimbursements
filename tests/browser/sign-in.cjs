/* Signs in to the admin area through the sign-in provider and saves the session for
 * admin-form-recovery.cjs (ADMIN_STORAGE_STATE). Made for the development Keycloak of
 * compose.dev.yaml: admin@example.invalid / admin is a template admin there.
 *
 *   BASE_URL=http://localhost:8000 ADMIN_STORAGE_STATE=/tmp/admin.json node sign-in.cjs
 */
const { chromium } = require("playwright");
const assert = require("node:assert/strict");

const base = process.env.BASE_URL || "http://localhost:8000";
const username = process.env.KEYCLOAK_USERNAME || "admin";
const password = process.env.KEYCLOAK_PASSWORD || "admin";
const storageState = process.env.ADMIN_STORAGE_STATE;
if (!storageState) throw new Error("Set ADMIN_STORAGE_STATE to the file for the session.");

(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${base}/admin/login`);
    await page.getByRole("link", { name: /^Sign in with / }).click();
    // The provider's own page.
    await page.locator("#username").fill(username);
    await page.locator("#password").fill(password);
    await page.locator("#kc-login").click();
    await page.waitForURL(
      (url) =>
        url.origin === new URL(base).origin &&
        url.pathname.startsWith("/admin/") &&
        !url.pathname.startsWith("/admin/login"),
    );
    const meta = await page.evaluate(async () => (await fetch("/api/v1/meta")).json());
    assert.ok(meta.user, "Not signed in after the provider's redirect.");
    assert.ok(meta.user.isTemplateAdmin, "The signed-in user is not a template admin.");
    await context.storageState({ path: storageState });
    console.log(`Signed in as ${meta.user.email}; session saved.`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
