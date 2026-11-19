// The button state of answers captured from Meldgrove Updater 0.2 (tests/fixtures/updater-0.2).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Updates = require("../../portal/static/portal/updates-state.js");

const FIXTURES = path.join(__dirname, "..", "fixtures", "updater-0.2");
const sample = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
const answer = (updater) => ({ app: { version: updater.installed }, reachable: true, updater, error: null });

const EXPECTED = {
  "status-off-available-attention.json": "available",
  "status-host-available.json": "available",
  "status-platform-locked.json": "current",
  "status-installing.json": "installing",
  "status-failed.json": "failed",
  "status-preview.json": "failed",
  "install-202.json": "installing",
};

test("every sample has an expected state", () => {
  const names = fs.readdirSync(FIXTURES).filter((name) => name.endsWith(".json"));
  assert.deepEqual(names.sort(), Object.keys(EXPECTED).sort());
});

for (const [name, kind] of Object.entries(EXPECTED)) {
  test(`${name} is ${kind}`, () => {
    const response = answer(sample(name));
    assert.equal(Updates.button(response).kind, kind);
    // Each state with a popover has something to show.
    const view = Updates.popover(response, {}, { now: Date.parse("2026-11-19T04:00:00Z"), timeZone: "UTC" });
    if (["available", "failed", "installing"].includes(kind)) assert.ok(view.title);
  });
}

test("with automatic updates off, the sample offers no installation", () => {
  const view = Updates.popover(answer(sample("status-off-available-attention.json")), {}, { now: Date.now() });
  assert.equal(view.title, "Update available");
  assert.equal(view.action, null);
});

test("the failed preview names why and offers to try again", () => {
  const view = Updates.popover(answer(sample("status-preview.json")), {}, { now: Date.now() });
  assert.equal(view.title, "Update to 0.1.3 failed");
  assert.deepEqual(view.text, ["container library-web-1 is unhealthy", "0.1.1 is still running."]);
  assert.deepEqual(view.action, { label: "Try again", version: "0.1.3", anyway: false });
});
