// Publication regressions against a real admin editor; all save requests are intercepted.
// Requires FORM_ADMIN_URL for an unused local draft and ADMIN_STORAGE_STATE for a local admin session.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");

const editorUrl = process.env.FORM_ADMIN_URL;
const storageState = process.env.ADMIN_STORAGE_STATE;
const scenario = process.env.SCENARIO || "all";
if (!editorUrl || !storageState)
  throw new Error("Set FORM_ADMIN_URL and ADMIN_STORAGE_STATE for a local draft editor.");

(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto(editorUrl);
    const toggle = page.locator("[data-publication-toggle]");
    const retry = page.locator("[data-autosave-retry]");
    const status = page.locator("[data-autosave-status]");
    const badge = page.locator("[data-form-status]");
    const indicator = page.locator("[data-autosave-indicator]");
    const deleteLink = page.locator("[data-form-delete]");
    const pathname = new URL(editorUrl).pathname;
    const slug = await page.locator("#id_slug").inputValue();
    let serverStatus = await badge.getAttribute("data-status");
    assert.equal(serverStatus, "draft", "Use a draft form for this test.");
    const actions = [];
    let failure = null;
    let delayNextSave = null;

    const field = (body, name) =>
      body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r\\n]*)`))?.[1] || "";
    await page.route((url) => url.pathname === pathname, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const body = route.request().postDataBuffer().toString();
      const action = field(body, "_publication") || null;
      actions.push(action);
      const fail = failure;
      failure = null;
      const delay = delayNextSave;
      delayNextSave = null;
      if (delay) await delay;
      if (fail === "network") return route.abort("failed");
      if (fail === "http")
        return route.fulfill({ status: 503, json: { error: "Synthetic server failure" } });
      if (action) serverStatus = action === "publish" ? "published" : "draft";
      if (fail === "response-lost") return route.abort("failed");
      return route.fulfill({
        json: {
          url: pathname,
          name: field(body, "name"),
          slug,
          status: serverStatus,
          status_label: serverStatus === "published" ? "Veröffentlicht" : "Entwurf",
          link: `/f/${slug}/`,
          delete_url: pathname.replace(/change\/$/, "delete/"),
          can_delete: serverStatus === "draft",
        },
      });
    });

    async function saved() {
      await page.getByText("Alle Änderungen gespeichert.", { exact: true }).waitFor();
      assert.equal(await indicator.getAttribute("data-save-state"), "saved");
      assert.equal(await page.locator('[data-save-symbol="saved"]').isVisible(), true);
      assert.equal(await deleteLink.isVisible(), serverStatus === "draft");
    }

    async function failedThenRetry(action, mode, editWhileFailed = false) {
      failure = mode;
      const before = actions.length;
      await toggle.click();
      await retry.waitFor({ state: "visible" });
      assert.equal(await indicator.getAttribute("data-save-state"), "error");
      assert.equal(await page.locator('[data-save-symbol="error"]').isVisible(), true);
      assert.equal(actions.at(-1), action);
      await page.waitForTimeout(700);
      assert.equal(actions.length, before + 1, "Failures must wait for an explicit retry.");
      if (editWhileFailed) {
        const unchangedStatus = serverStatus;
        const response = page.waitForResponse((response) =>
          response.request().method() === "POST" && new URL(response.url()).pathname === pathname);
        await page.locator("#id_instructions").fill(`Synthetic edit after failed ${action}`);
        await response;
        if (mode === "response-lost") {
          // The ordinary save confirms the state of an earlier committed transition.
          await saved();
          assert.equal(serverStatus, action === "publish" ? "published" : "draft");
          assert.equal(actions.at(-1), null);
          assert.equal(await retry.isVisible(), false);
          return;
        }
        await retry.waitFor({ state: "visible" });
        assert.equal(serverStatus, unchangedStatus, "Autosave must not replay publication actions.");
        assert.equal(actions.at(-1), null);
        assert.notEqual(await status.textContent(), "Alle Änderungen gespeichert.");
      }
      await retry.click();
      await saved();
      assert.equal(actions.at(-1), action, "Explicit retry must preserve the requested transition.");
      assert.equal(serverStatus, action === "publish" ? "published" : "draft");
      assert.equal(await badge.getAttribute("data-status"), serverStatus);
      assert.equal(await retry.isVisible(), false);
    }

    if (scenario === "all" || scenario === "retry") {
      for (const mode of ["network", "http", "response-lost"]) {
        await failedThenRetry("publish", mode);
        await failedThenRetry("unpublish", mode);
      }
      await failedThenRetry("publish", "network", true);
      await failedThenRetry("unpublish", "network", true);
      await failedThenRetry("publish", "response-lost", true);
      await failedThenRetry("unpublish", "response-lost", true);
      console.log("Passed publication retries, lost responses, and edits after failures.");
    }

    if (scenario === "all" || scenario === "keyboard") {
      for (const expected of ["draft", "published"]) {
        const before = actions.length;
        const name = page.locator("#id_name");
        await name.fill(`Synthetic ${expected} keyboard edit`);
        await name.press("Enter");
        await saved();
        assert.equal(serverStatus, expected, "Enter in a text input must preserve publication status.");
        assert.equal(await badge.getAttribute("data-status"), expected);
        assert.ok(actions.length > before);
        assert.ok(actions.slice(before).every((action) => action === null));
        // Enter on the publication button remains an explicit keyboard activation.
        await toggle.focus();
        await toggle.press("Enter");
        await saved();
        assert.equal(serverStatus, expected === "draft" ? "published" : "draft");
      }
      console.log("Passed implicit Enter submissions and explicit keyboard publication.");
    }
    if (scenario === "all") {
      let finishSave;
      delayNextSave = new Promise((resolve) => { finishSave = resolve; });
      const requested = page.waitForRequest((request) =>
        request.method() === "POST" && new URL(request.url()).pathname === pathname);
      await page.locator("#id_instructions").fill("Synthetic save indicator check");
      await requested;
      assert.equal(await indicator.getAttribute("data-save-state"), "saving");
      assert.equal(await page.locator('[data-save-symbol="saving"]').isVisible(), true);
      assert.equal(await page.locator('[data-save-symbol="saved"]').isVisible(), false);
      finishSave();
      await saved();
      const toolbar = page.locator("[data-form-toolbar]");
      const controls = await Promise.all([
        toolbar.locator("[data-publication-toggle]").boundingBox(),
        toolbar.getByRole("link", { name: "Vorschau", exact: true }).boundingBox(),
        toolbar.getByRole("link", { name: "Verlauf", exact: true }).boundingBox(),
      ]);
      assert.ok(controls.every((box) => box && Math.abs(box.y - controls[0].y) < 1));
      await deleteLink.click();
      await page.getByRole("heading", { name: "Entwurf löschen?", exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Entwurf endgültig löschen", exact: true }).isVisible(), true);
      await page.getByRole("link", { name: "Abbrechen", exact: true }).click();
      await page.locator("[data-publication-toggle]").waitFor();
      console.log("Passed save indicators, toolbar alignment, draft deletion visibility, and confirmation cancellation.");
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
