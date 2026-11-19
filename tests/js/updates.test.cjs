const { test } = require("node:test");
const assert = require("node:assert/strict");
const Updates = require("../../portal/static/portal/updates-state.js");

const NOW = Date.parse("2026-11-19T12:00:00Z");
const hoursAgo = (hours) => new Date(NOW - hours * 3_600_000).toISOString();

function status(changes = {}) {
  return {
    updater: "0.2.0",
    mode: "host",
    channel: "stable",
    channelLocked: null,
    installed: "0.2.0",
    available: null,
    attention: null,
    installing: null,
    last: null,
    checking: false,
    checkedAt: hoursAgo(0.1),
    error: null,
    automatic: true,
    cooldown: "3d",
    window: "02:00-05:00",
    timezone: "UTC",
    ...changes,
  };
}

function update(version, changes = {}) {
  return {
    version,
    preview: false,
    publishedAt: hoursAgo(48),
    url: `https://github.com/meldgrove/reimbursements/releases/tag/v${version}`,
    notes: ["Fix a", "Add b"],
    changes: 2,
    installsAt: hoursAgo(-24),
    failed: null,
    ...changes,
  };
}

const answer = (updater, app = "0.2.0") => ({ app: { version: app }, reachable: true, updater, error: null });
const kind = (response, local) => Updates.button(response, local).kind;

test("the button state follows the status", () => {
  assert.equal(kind(null), "loading");
  assert.deepEqual(Updates.button(answer(status())), { kind: "current", tooltip: "Up to date · 0.2.0" });
  assert.equal(kind(answer(status({ checking: true }))), "checking");
  assert.equal(kind(answer(status()), { checking: true }), "checking");
  assert.equal(kind(answer(status({ available: update("0.2.1") }))), "available");
  assert.equal(kind(answer(status({ attention: update("0.3.0") }))), "attention");
  assert.equal(kind(answer(status({ available: update("0.2.1"), attention: update("0.3.0") }))), "available");
  const installing = { version: "0.2.1", startedAt: hoursAgo(0), manual: true, stage: "pulling" };
  assert.deepEqual(Updates.button(answer(status({ installing }))), { kind: "installing", version: "0.2.1", tooltip: "Installing 0.2.1…" });
  assert.deepEqual(Updates.button(answer(status({ mode: "off", automatic: false }))), {
    kind: "off",
    tooltip: "Automatic updates are off on this server",
  });
  assert.deepEqual(Updates.button({ app: { version: null }, reachable: false, updater: null, error: "No answer" }), {
    kind: "unreachable",
    tooltip: "No update service. See the deployment guide.",
  });
});

test("a failed installation shows until a newer version is offered", () => {
  const last = { version: "0.2.1", result: "rolled-back", message: "web is unhealthy", finishedAt: hoursAgo(1) };
  const failed = answer(status({ last, available: update("0.2.1", { failed: "web is unhealthy" }) }));
  assert.equal(kind(failed), "failed");
  const view = Updates.popover(failed, {}, { now: NOW });
  assert.equal(view.title, "Update to 0.2.1 failed");
  assert.deepEqual(view.text, ["web is unhealthy", "0.2.0 is still running."]);
  assert.deepEqual(view.action, { label: "Try again", version: "0.2.1", anyway: false });
  assert.equal(kind(answer(status({ last, available: update("0.2.2") }))), "available");
  // The page that watched the installation fail shows it, even before the updater
  // marks the version.
  assert.equal(kind(answer(status({ last, available: update("0.2.1") })), { failedVersion: "0.2.1" }), "failed");
});

test("the available popover lists at most eight notes and when it installs", () => {
  const notes = Array.from({ length: 10 }, (_, index) => `Change ${index + 1}`);
  const response = answer(status({ available: update("0.2.1", { notes, changes: 12 }) }));
  const view = Updates.popover(response, {}, { now: NOW, timeZone: "UTC" });
  assert.equal(view.title, "Update available");
  assert.equal(view.meta, "0.2.1 · 2 days ago");
  assert.equal(view.notes.length, 8);
  assert.equal(view.more, "and 4 more changes");
  assert.equal(view.schedule, "Installs automatically on Fri 20 Nov, 12:00");
  assert.deepEqual(view.action, { label: "Install now", version: "0.2.1", anyway: false });
  const due = answer(status({ available: update("0.2.1", { installsAt: hoursAgo(1) }) }));
  assert.equal(Updates.popover(due, {}, { now: NOW }).schedule, "Installs automatically at the next check");
  const manual = answer(status({ available: update("0.2.1", { installsAt: null, changes: 2 }) }));
  assert.equal(Updates.popover(manual, {}, { now: NOW }).schedule, "");
  assert.equal(Updates.popover(manual, {}, { now: NOW }).more, "");
});

test("previews show a badge and only web links", () => {
  const preview = update("0.2.1-preview.3", { preview: true, url: "javascript:alert(1)" });
  const view = Updates.popover(answer(status({ channel: "preview", available: preview })), {}, { now: NOW });
  assert.equal(view.preview, true);
  assert.equal(view.url, null);
});

test("a release that needs upgrade steps asks before it installs", () => {
  const view = Updates.popover(answer(status({ attention: update("0.3.0") })), {}, { now: NOW });
  assert.equal(view.title, "0.3.0 needs upgrade steps");
  assert.equal(view.action.label, "Install anyway…");
  assert.equal(view.action.anyway, true);
  assert.match(view.action.url, /v0\.3\.0$/);
});

test("with automatic updates off, new versions show but offer no installation", () => {
  const off = { mode: "off", automatic: false };
  const available = answer(status({ ...off, available: update("0.2.1") }));
  assert.equal(kind(available), "available");
  const view = Updates.popover(available, {}, { now: NOW });
  assert.equal(view.action, null);
  assert.match(view.schedule, /^Automatic updates are off on this server/);
  const attention = answer(status({ ...off, attention: update("0.3.0") }));
  assert.equal(kind(attention), "attention");
  assert.equal(Updates.popover(attention, {}, { now: NOW }).action, null);
});

test("installing shows the stage and that the app restarts", () => {
  const installing = { version: "0.2.1", startedAt: hoursAgo(0), manual: true, stage: "rolling-back" };
  const response = answer(status({ installing }));
  const view = Updates.popover(response, {}, { now: NOW, app: "Meldgrove Reimbursement" });
  assert.equal(view.title, "Installing 0.2.1…");
  assert.deepEqual(view.text, ["Going back to 0.2.0", "Meldgrove Reimbursement restarts. This page reloads when it is back."]);
  const waiting = Updates.waitFor("0.2.1", answer(status()), NOW);
  const restarting = Updates.popover(null, { waiting, restarting: true, slow: true }, { now: NOW });
  assert.equal(restarting.text[0], "Restarting…");
  assert.match(restarting.slow, /journalctl -u meldgrove-updater-reimbursements/);
  assert.equal(Updates.button(null, { waiting, restarting: true }).tooltip, "Restarting…");
});

test("an installation is done when the app runs the version or the server installed it", () => {
  const before = answer(status({ last: { version: "0.2.1", result: "failed", message: "x", finishedAt: hoursAgo(2) } }));
  const waiting = Updates.waitFor("0.2.1", before, NOW);
  // The earlier failure of the same version is not this installation's result.
  assert.equal(Updates.progress(before, waiting), "waiting");
  assert.equal(Updates.progress(answer(status(), "0.2.1"), waiting), "done");
  const result = (outcome, app = "0.2.0") =>
    answer(status({ last: { version: "0.2.1", result: outcome, message: null, finishedAt: hoursAgo(0) } }), app);
  assert.equal(Updates.progress(result("installed", null), waiting), "done");
  assert.equal(Updates.progress(result("failed"), waiting), "failed");
  assert.equal(Updates.progress(result("rolled-back"), waiting), "failed");
  // The platform accepts a deployment before it runs it.
  assert.equal(Updates.progress(result("accepted"), waiting), "waiting");
  assert.equal(Updates.progress(result("accepted"), waiting, { outage: true }), "done");
  assert.equal(Updates.progress(result("accepted", "0.2.0-dirty"), waiting), "done");
});

test("an installation without a result asks to check the server after 15 minutes", () => {
  const waiting = Updates.waitFor("0.2.1", null, NOW);
  assert.equal(Updates.tooSlow(waiting, NOW + 14 * 60_000), false);
  assert.equal(Updates.tooSlow(waiting, NOW + 16 * 60_000), true);
});

test("the footer and times read naturally", () => {
  assert.deepEqual(Updates.footer(answer(status({ checkedAt: hoursAgo(5 / 60), error: "registry timeout" })), NOW), {
    installed: "Installed: 0.2.0 · Stable",
    checked: "Checked 5 min ago",
    error: "The last check failed: registry timeout",
  });
  assert.equal(Updates.ago(hoursAgo(0), NOW), "just now");
  assert.equal(Updates.ago(hoursAgo(1), NOW), "1 hour ago");
  assert.equal(Updates.ago(hoursAgo(-1), NOW), "just now");
  assert.equal(Updates.duration("3d"), "3 days");
  assert.equal(Updates.duration("12h"), "12 hours");
  assert.equal(Updates.duration("1m"), "1 minute");
  assert.equal(Updates.duration("86400"), "1 day");
  assert.equal(Updates.duration("90"), "90 seconds");
  assert.equal(Updates.duration("0"), null);
  assert.equal(Updates.duration(null), null);
});

test("the Updates tab says how updates install", () => {
  const stable = Updates.settings(answer(status(), null), NOW);
  assert.equal(stable.version, "development");
  assert.equal(stable.channel, "Stable");
  assert.equal(stable.automatic, "On: releases install automatically after 3 days, between 02:00 and 05:00 (UTC).");
  assert.equal(stable.stable, "Releases. Updates that need no action install automatically after 3 days.");
  assert.equal(stable.disabled, false);
  const preview = Updates.settings(answer(status({ channel: "preview", cooldown: null, window: null })), NOW);
  assert.equal(preview.automatic, "On: previews and releases install automatically at the next check.");
  assert.equal(preview.selected, "preview");
  const off = Updates.settings(answer(status({ mode: "off", automatic: false })), NOW);
  assert.equal(off.automatic, "Off on this server: nothing installs automatically.");
  const locked = "The platform's image tag latest decides which updates install. Change it there.";
  const platform = Updates.settings(answer(status({ mode: "platform", channelLocked: locked })), NOW);
  assert.equal(platform.automatic, "On: releases install automatically after 3 days, between 02:00 and 05:00 (UTC). The platform installs them (deploy link).");
  assert.equal(platform.locked, locked);
  assert.equal(platform.disabled, true);
  const unreachable = Updates.settings({ app: { version: "0.2.0" }, reachable: false, updater: null, error: "No update service answers at http://updater:8080." }, NOW);
  assert.equal(unreachable.reachable, false);
  assert.equal(unreachable.disabled, true);
  assert.equal(unreachable.detail, "No update service answers at http://updater:8080.");
});
