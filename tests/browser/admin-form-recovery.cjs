// Publication and archive regressions of the form editor in a real browser; every save is intercepted.
// Needs the app at BASE_URL with DEV_LOGIN=1 (development) and a template admin ADMIN_USERNAME, or
// ADMIN_STORAGE_STATE with a session of one. The script makes a draft of its own and leaves it.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");

const base = process.env.BASE_URL || "http://localhost:5173";
const username = process.env.ADMIN_USERNAME;
const storageState = process.env.ADMIN_STORAGE_STATE;
const scenario = process.env.SCENARIO || "all";
if (!username && !storageState)
  throw new Error("Set ADMIN_USERNAME (with DEV_LOGIN=1) or ADMIN_STORAGE_STATE.");

(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext(storageState ? { storageState } : {});
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto(`${base}/admin/login`);
    if (username) {
      const status = await page.evaluate(
        async (name) =>
          (
            await fetch("/api/v1/auth/dev-login", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ username: name }),
            })
          ).status,
        username,
      );
      assert.equal(status, 200, "Development sign-in failed: is DEV_LOGIN=1 set?");
    }
    // A draft of the first template, for this test alone.
    const draft = await page.evaluate(async () => {
      const templates = await (await fetch("/api/v1/admin/forms/templates")).json();
      const response = await fetch(`/api/v1/admin/forms?template=${templates[0].id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Browser check", instructions: "Synthetic" }),
      });
      return response.json();
    });
    const pathname = `/api/v1/admin/forms/${draft.id}`;
    await page.goto(`${base}/admin/forms/${draft.id}`);

    const toggle = () => page.getByRole("button", { name: /^(Publish|Unpublish)$/ });
    const archiveToggle = () => page.getByRole("button", { name: /^(Archive|Unarchive)$/ });
    const retry = page.getByRole("button", { name: "Try again", exact: true });
    const status = page.locator("[data-save-state]");
    const deleteButton = page.getByRole("button", { name: "Delete", exact: true });
    await status.waitFor();
    let serverStatus = draft.status;
    assert.equal(serverStatus, "draft");
    const statusAfter = { publish: "published", unpublish: "draft", archive: "archived", unarchive: "draft" };
    const labels = { draft: "Draft", published: "Published", archived: "Archived" };
    const actions = [];
    let failure = null;
    let delayNextSave = null;

    await page.route(
      (url) => url.pathname === pathname,
      async (route) => {
        if (route.request().method() !== "PUT") return route.continue();
        const body = JSON.parse(route.request().postData() || "{}");
        const action = body.action || null;
        actions.push(action);
        const fail = failure;
        failure = null;
        const delay = delayNextSave;
        delayNextSave = null;
        if (delay) await delay;
        if (fail === "network") return route.abort("failed");
        if (fail === "http")
          return route.fulfill({
            status: 503,
            json: { error: { code: "unavailable", message: "Synthetic server failure" } },
          });
        if (action) serverStatus = statusAfter[action];
        if (fail === "response-lost") return route.abort("failed");
        return route.fulfill({
          json: {
            id: draft.id,
            name: body.name,
            slug: draft.slug,
            status: serverStatus,
            primary: false,
            link: `/f/${draft.slug}/`,
            canDelete: serverStatus !== "published",
          },
        });
      },
    );

    async function saved() {
      await page.getByText("All changes saved.", { exact: true }).waitFor();
      assert.equal(await status.getAttribute("data-save-state"), "saved");
      assert.equal(await deleteButton.isVisible(), serverStatus !== "published");
      for (const [name, label] of Object.entries(labels)) {
        assert.equal(await page.getByText(label, { exact: true }).isVisible(), serverStatus === name, label);
      }
      // An archived form is unarchived as a draft before it can be published again.
      assert.equal(await toggle().isVisible(), serverStatus !== "archived");
      assert.equal(
        (await archiveToggle().textContent()).trim(),
        serverStatus === "archived" ? "Unarchive" : "Archive",
      );
    }

    async function failedThenRetry(action, mode, editWhileFailed = false) {
      failure = mode;
      const before = actions.length;
      await (action.endsWith("archive") ? archiveToggle() : toggle()).click();
      await retry.waitFor({ state: "visible" });
      assert.equal(await status.getAttribute("data-save-state"), "error");
      assert.equal(actions.at(-1), action);
      await page.waitForTimeout(700);
      assert.equal(actions.length, before + 1, "Failures must wait for an explicit retry.");
      if (editWhileFailed) {
        const unchangedStatus = serverStatus;
        const response = page.waitForResponse(
          (response) =>
            response.request().method() === "PUT" && new URL(response.url()).pathname === pathname,
        );
        await page.getByLabel("Notes for participants").fill(`Synthetic edit after failed ${action}`);
        await response;
        if (mode === "response-lost") {
          // The ordinary save confirms the state of an earlier committed transition.
          await saved();
          assert.equal(serverStatus, statusAfter[action]);
          assert.equal(actions.at(-1), null);
          assert.equal(await retry.isVisible(), false);
          return;
        }
        await retry.waitFor({ state: "visible" });
        assert.equal(serverStatus, unchangedStatus, "Autosave must not replay publication actions.");
        assert.equal(actions.at(-1), null);
        assert.notEqual((await status.textContent()).trim(), "All changes saved.");
      }
      await retry.click();
      await saved();
      assert.equal(actions.at(-1), action, "Explicit retry must preserve the requested transition.");
      assert.equal(serverStatus, statusAfter[action]);
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
        const name = page.getByLabel(/^Name/);
        await name.fill(`Synthetic ${expected} keyboard edit`);
        await name.press("Enter");
        await saved();
        assert.equal(serverStatus, expected, "Enter in a text input must preserve publication status.");
        assert.ok(actions.length > before);
        assert.ok(actions.slice(before).every((action) => action === null));
        // Enter on the publication button remains an explicit keyboard activation.
        await toggle().focus();
        await toggle().press("Enter");
        await saved();
        assert.equal(serverStatus, expected === "draft" ? "published" : "draft");
      }
      console.log("Passed implicit Enter submissions and explicit keyboard publication.");
    }

    if (scenario === "all" || scenario === "archive") {
      for (const mode of ["network", "http", "response-lost"]) {
        await failedThenRetry("archive", mode);
        await failedThenRetry("unarchive", mode);
      }
      await failedThenRetry("archive", "response-lost", true);
      await failedThenRetry("unarchive", "network", true);
      console.log("Passed archiving and unarchiving retries through the save queue.");
    }

    if (scenario === "all") {
      let finishSave;
      delayNextSave = new Promise((resolve) => {
        finishSave = resolve;
      });
      const requested = page.waitForRequest(
        (request) => request.method() === "PUT" && new URL(request.url()).pathname === pathname,
      );
      await page.getByLabel("Notes for participants").fill("Synthetic save indicator check");
      await requested;
      assert.equal(await status.getAttribute("data-save-state"), "saving");
      finishSave();
      await saved();
      const boxes = await Promise.all([
        toggle().boundingBox(),
        archiveToggle().boundingBox(),
        page.getByRole("link", { name: "Preview", exact: true }).boundingBox(),
        deleteButton.boundingBox(),
      ]);
      assert.ok(
        boxes.every((box) => box && Math.abs(box.y - boxes[0].y) < 1),
        "Toolbar buttons on one line.",
      );
      await deleteButton.click();
      const dialog = page.getByRole("alertdialog");
      await dialog
        .getByText("The draft and its form link are deleted permanently.", { exact: false })
        .waitFor();
      assert.equal(
        await dialog.getByRole("button", { name: "Delete draft for good", exact: true }).isVisible(),
        true,
      );
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      await toggle().waitFor();
      console.log(
        "Passed save indicators, toolbar alignment, draft deletion visibility, and confirmation cancellation.",
      );
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
