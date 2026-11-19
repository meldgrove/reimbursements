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
  // A check that could not reach the registry does not say "Up to date".
  assert.deepEqual(Updates.button(answer(status({ error: "registry timeout" }))), {
    kind: "current",
    tooltip: "The last check failed: registry timeout",
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

test("a failed release that needs upgrade steps stays failed and retries with its confirmation", () => {
  const last = { version: "0.3.0", result: "rolled-back", message: "migrate failed", finishedAt: hoursAgo(1) };
  // After a reload, the updater's mark on the attention offer keeps the failure.
  const failed = answer(status({ last, attention: update("0.3.0", { failed: "migrate failed" }) }));
  assert.equal(kind(failed), "failed");
  const view = Updates.popover(failed, {}, { now: NOW });
  assert.deepEqual(view.text, ["migrate failed", "0.2.0 is still running."]);
  assert.match(view.url, /v0\.3\.0$/);
  assert.deepEqual(view.action, { label: "Try again", version: "0.3.0", anyway: true, url: view.url });
  // A failure of another version than the offered one is not this offer's.
  assert.equal(kind(answer(status({ last, attention: update("0.4.0", { failed: "x" }) }))), "attention");
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

test("where an image tag decides, a release that needs upgrade steps offers no installation", () => {
  const channelLocked = "The image tag 0.2 set where the app is deployed decides which updates install.";
  const locked = answer(status({ mode: "platform", channelLocked, attention: update("0.3.0") }));
  const view = Updates.popover(locked, {}, { now: NOW, app: "Meldgrove Reimbursement" });
  assert.equal(view.action, null);
  assert.equal(
    view.text[0],
    "This release changes the setup. The image tag set where Meldgrove Reimbursement is deployed does not reach 0.3.0: take the upgrade steps from its release notes, then change the tag there.",
  );
  assert.match(view.url, /v0\.3\.0$/);
  // An available update still installs through the platform.
  const available = answer(status({ mode: "platform", channelLocked, available: update("0.2.1") }));
  assert.equal(Updates.popover(available, {}, { now: NOW }).action.label, "Install now");
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

test("installing shows the stage, and that the page reloads only while it waits", () => {
  const installing = { version: "0.2.1", startedAt: hoursAgo(0), manual: true, stage: "rolling-back" };
  const response = answer(status({ installing }));
  const options = { now: NOW, app: "Meldgrove Reimbursement" };
  const view = Updates.popover(response, {}, options);
  assert.equal(view.title, "Installing 0.2.1…");
  assert.deepEqual(view.text, ["Going back to 0.2.0"]);
  const waiting = Updates.waitFor("0.2.1", answer(status()), NOW);
  assert.deepEqual(Updates.popover(response, { waiting }, options).text, [
    "Going back to 0.2.0",
    "Meldgrove Reimbursement restarts. This page reloads when it is back.",
  ]);
  const restarting = Updates.popover(null, { waiting, restarting: true, slow: true }, { now: NOW });
  assert.equal(restarting.text[0], "Restarting…");
  assert.match(restarting.slow, /journalctl -u meldgrove-updater-reimbursements/);
  assert.equal(restarting.stop, true);
  assert.equal(Updates.popover(null, { waiting }, { now: NOW }).stop, false);
  assert.equal(Updates.button(null, { waiting, restarting: true }).tooltip, "Restarting…");
});

// A status answer while following an installation of 0.2.1 that started at NOW.
const following = (changes = {}, app = "0.2.0") => answer(status(changes), app);
const result = (outcome, finishedAt = hoursAgo(-0.01)) => ({ version: "0.2.1", result: outcome, message: `${outcome}: web is unhealthy`, finishedAt });
const installing = (stage = "starting") => ({ version: "0.2.1", startedAt: hoursAgo(0), manual: true, stage });

test("an installation is done once the server reports it, or the app runs it and nothing else reports it", () => {
  const attempt = Updates.waitFor("0.2.1", answer(status()), NOW, true);
  assert.equal(Updates.progress(following({ last: result("installed") }, null), attempt), "done");
  assert.equal(Updates.progress(following({ last: result("failed") }), attempt), "failed");
  assert.equal(Updates.progress(following({ last: result("rolled-back") }), attempt), "failed");
  assert.equal(Updates.progress(following({}, "0.2.1"), attempt), "done");
  // Without the updater's answer nothing says that the server is done.
  assert.equal(Updates.progress({ app: { version: "0.2.1" }, reachable: false, updater: null, error: "No answer" }, attempt), "waiting");
});

test("the app answering with the new version does not end an installation the server still runs", () => {
  const attempt = Updates.waitFor("0.2.1", answer(status()), NOW, true);
  const response = following({ installed: "0.2.1", installing: installing("starting") }, "0.2.1");
  assert.equal(Updates.progress(response, attempt), "waiting");
  // It may still go back to the version before.
  assert.equal(Updates.progress(following({ installing: installing("rolling-back") }, "0.2.1"), attempt), "waiting");
  assert.equal(Updates.progress(following({ last: result("rolled-back") }, "0.2.0"), attempt), "failed");
});

test("a fresh failure shows its message, also before the updater marks the offer", () => {
  const attempt = Updates.waitFor("0.2.1", answer(status()), NOW, true);
  const response = following({ last: result("rolled-back"), available: update("0.2.1") });
  assert.equal(Updates.progress(response, attempt), "failed");
  const view = Updates.popover(response, { failedVersion: "0.2.1" }, { now: NOW });
  assert.equal(view.title, "Update to 0.2.1 failed");
  assert.deepEqual(view.text, ["rolled-back: web is unhealthy", "0.2.0 is still running."]);
  assert.deepEqual(view.action, { label: "Try again", version: "0.2.1", anyway: false });
});

test("a result that finished before the installation started is not its result", () => {
  const attempt = Updates.waitFor("0.2.1", answer(status()), NOW, true);
  assert.equal(Updates.progress(following({ last: result("failed", hoursAgo(2)) }), attempt), "waiting");
  assert.equal(Updates.progress(following({ last: result("installed", hoursAgo(2)) }), attempt), "waiting");
  // Once the updater reported when it started the installation, its own clock counts.
  const reported = Updates.observe(following({ installing: { ...installing(), startedAt: hoursAgo(0.05) } }), attempt, NOW);
  assert.equal(reported.since, NOW - 0.05 * 3_600_000);
  assert.equal(Updates.progress(following({ last: result("failed", hoursAgo(0.02)) }), reported), "failed");
});

test("a platform deployment is done once the app runs it", () => {
  const attempt = Updates.waitFor("0.2.1", answer(status()), NOW, true);
  const restarted = Updates.outage(attempt, "The app did not answer.");
  assert.equal(Updates.progress(following({ last: result("accepted") }), attempt), "waiting");
  assert.equal(Updates.progress(following({ last: result("accepted") }), restarted), "waiting");
  assert.equal(Updates.progress(following({ last: result("accepted") }, "0.2.1"), attempt), "done");
  // Without an app version (development), a restart tells.
  assert.equal(Updates.progress(following({ last: result("accepted") }, null), attempt), "waiting");
  assert.equal(Updates.progress(following({ last: result("accepted") }, null), restarted), "done");
});

test("reachable: false while following is an outage; a reachable accepted then completes", () => {
  const attempt = Updates.waitFor("0.2.1", answer(status()), NOW, true);
  const unreachable = { app: { version: null }, reachable: false, updater: null, error: "The update service did not answer within 3 s." };
  const after = Updates.outage(attempt, Updates.problem({ status: 200, body: unreachable }));
  assert.equal(after.outage, true);
  assert.equal(after.error, "The update service did not answer within 3 s.");
  assert.equal(Updates.progress(unreachable, after), "waiting");
  assert.equal(Updates.progress(following({ last: result("accepted") }, null), after), "done");
});

test("a platform deployment accepted in the same second as an ambiguous request is fresh", () => {
  // The updater writes whole seconds; the browser started the attempt 700 ms into one.
  const started = NOW + 700;
  const attempt = Updates.waitFor("0.2.1", answer(status()), started);
  const ambiguous = Updates.installAnswer(null, attempt, started).attempt;
  const accepted = following({ last: result("accepted", new Date(NOW).toISOString()) }, null);
  const confirmed = Updates.observe(accepted, ambiguous, started + 2000);
  assert.equal(confirmed.confirmed, true);
  assert.equal(Updates.progress(accepted, confirmed), "waiting");
  assert.equal(Updates.progress(accepted, Updates.outage(confirmed, "The app did not answer.")), "done");
  // A result of the second before is not.
  const before = following({ last: result("accepted", new Date(NOW - 1000).toISOString()) }, null);
  assert.equal(Updates.observe(before, ambiguous, started + 2000).confirmed, false);
});

test("a retry in the same second does not take the earlier failure as its own", () => {
  const failedAt = new Date(NOW).toISOString();
  const failure = result("failed", failedAt);
  const shown = answer(status({ last: failure, available: update("0.2.1", { failed: failure.message }) }));
  // Try again, 400 ms into the second the first attempt failed in.
  const attempt = Updates.waitFor("0.2.1", shown, NOW + 400);
  assert.deepEqual(attempt.earlier, failure);
  const ambiguous = Updates.installAnswer({ status: 504, body: null }, attempt, NOW + 400).attempt;
  assert.equal(Updates.observe(shown, ambiguous, NOW + 2400).confirmed, false);
  assert.equal(Updates.progress(shown, ambiguous), "waiting");
  // Its own result, in the same second as well, differs from the earlier one.
  const again = answer(status({ last: { ...failure, result: "rolled-back" } }));
  assert.equal(Updates.observe(again, ambiguous, NOW + 2400).confirmed, true);
  assert.equal(Updates.progress(again, ambiguous), "failed");
});

test("the install answer decides whether the attempt is followed, forgotten or reconciled", () => {
  const attempt = Updates.waitFor("0.2.1", answer(status()), NOW);
  assert.equal(attempt.confirmed, false);
  const accepted = Updates.installAnswer({ status: 202, body: following({ installing: installing("requested") }) }, attempt, NOW);
  assert.equal(accepted.outcome, "follow");
  assert.equal(accepted.attempt.confirmed, true);
  assert.equal(accepted.attempt.since, NOW);
  // 202 confirms, also when its answer cannot be read.
  const unread = Updates.installAnswer({ status: 202, body: null }, attempt, NOW);
  assert.deepEqual([unread.outcome, unread.attempt.confirmed], ["follow", true]);
  // No answer, a timeout of the updater, a proxy error: the server may install anyway.
  for (const reply of [
    null,
    { status: 200, body: { app: { version: "0.2.0" }, reachable: false, updater: null, error: "The update service did not answer within 10 s." } },
    { status: 502, body: null },
    { status: 503, body: { ...following(), error: "The state file is broken." } },
    { status: 504, body: null },
    { status: 200, body: null },
  ]) {
    const ambiguous = Updates.installAnswer(reply, attempt, NOW);
    assert.equal(ambiguous.outcome, "ambiguous");
    assert.equal(ambiguous.attempt.version, "0.2.1");
    assert.equal(ambiguous.attempt.confirmed, false);
  }
  assert.equal(Updates.installAnswer(null, attempt, NOW).attempt.reason, "The app did not answer.");
  // A refusal forgets it.
  const refusal = { ...following(), error: "0.2.1 is not offered; check again." };
  assert.deepEqual(Updates.installAnswer({ status: 409, body: refusal }, attempt, NOW), {
    outcome: "refused",
    attempt: null,
    error: "0.2.1 is not offered; check again.",
  });
  assert.equal(Updates.installAnswer({ status: 403, body: null, signedOut: true }, attempt, NOW).outcome, "refused");
  assert.equal(Updates.installAnswer({ status: 0, body: null, signedOut: true }, attempt, NOW).outcome, "refused");
  // Any 4xx refuses, also without the app's error.
  assert.equal(Updates.installAnswer({ status: 400, body: null }, attempt, NOW).outcome, "refused");
  // A refusal whose status reports an installation follows that one.
  const faster = { ...following({ installing: { ...installing(), version: "0.2.2" } }), error: "0.2.2 is being installed." };
  const adopted = Updates.installAnswer({ status: 409, body: faster }, attempt, NOW);
  assert.equal(adopted.outcome, "follow");
  assert.deepEqual([adopted.attempt.version, adopted.attempt.confirmed], ["0.2.2", true]);
  const same = { ...following({ installing: installing() }), error: "0.2.1 is being installed." };
  assert.equal(Updates.installAnswer({ status: 409, body: same }, attempt, NOW).attempt.version, "0.2.1");
});

test("an attempt with a lost answer is followed once the status reports it, or forgotten after a minute", () => {
  const attempt = Updates.installAnswer(null, Updates.waitFor("0.2.1", answer(status()), NOW), NOW).attempt;
  assert.equal(Updates.deadline(attempt), NOW + Updates.RECONCILE);
  // A reachable status without it: it did not start.
  const nothing = following();
  const answered = Updates.observe(nothing, attempt, NOW + 2000);
  assert.equal(Updates.progress(nothing, answered), "waiting");
  assert.equal(Updates.unconfirmed(answered), "The installation did not start. The app did not answer.");
  // Without the updater's answer, nothing confirms whether it started.
  const failed = Updates.outage(answered, "The app answered with HTTP 502.");
  assert.equal(Updates.unconfirmed(failed), "The installation could not be confirmed. The app answered with HTTP 502.");
  // The status reports it: confirmed, and followed beyond the minute.
  const reported = Updates.observe(following({ installing: installing("pulling") }), attempt, NOW + 4000);
  assert.equal(reported.confirmed, true);
  assert.equal(Updates.deadline(reported), null);
  assert.equal(Updates.progress(nothing, reported), "waiting");
  // ... or its fresh result does.
  const finished = following({ last: result("failed") });
  assert.equal(Updates.observe(finished, attempt, NOW + 4000).confirmed, true);
  assert.equal(Updates.progress(finished, attempt), "failed");
});

test("an installation that a status reports is followed", () => {
  assert.equal(Updates.adopt(following()), null);
  assert.equal(Updates.adopt({ app: { version: "0.2.0" }, reachable: false, updater: null, error: null }), null);
  const adopted = Updates.adopt(following({ installing: installing() }), NOW);
  assert.deepEqual(adopted, {
    version: "0.2.1",
    before: "0.2.0",
    startedAt: NOW,
    confirmed: true,
    since: NOW,
    earlier: null,
    outage: false,
    answered: false,
  });
  // Following one installation, the status reports another instead.
  const other = Updates.observe(following({ installing: { ...installing(), version: "0.2.2" } }), adopted, NOW);
  assert.equal(other.version, "0.2.2");
});

test("Stop waiting ignores that installation by its identity, also after the updater was unreachable", () => {
  // Followed, then the updater went away; the admin stopped waiting meanwhile.
  const followed = Updates.observe(following({ installing: installing("pulling") }), Updates.waitFor("0.2.1", answer(status()), NOW + 3000), NOW + 5000);
  assert.equal(followed.since, NOW);
  const dismissed = Updates.identity(Updates.outage(followed, "No update service answers at http://updater:8080."));
  // The updater is back and still reports it: not followed again.
  assert.equal(Updates.adopt(following({ installing: installing("starting") }), NOW + 20 * 60_000, dismissed), null);
  // Another installation is.
  const next = { ...installing(), startedAt: hoursAgo(-0.5) };
  assert.equal(Updates.adopt(following({ installing: next }), NOW + 40 * 60_000, dismissed).version, "0.2.1");
  // Never reported: the version and when this page asked for it.
  const asked = Updates.identity(Updates.waitFor("0.2.1", answer(status()), NOW + 400));
  assert.equal(Updates.adopt(following({ installing: installing() }), NOW + 60_000, asked), null);
  const older = { ...installing(), startedAt: hoursAgo(1) };
  assert.equal(Updates.adopt(following({ installing: older }), NOW + 60_000, asked).version, "0.2.1");
});

test("a newer offer replaces an old failure and keeps its message", () => {
  const last = { version: "0.2.1", result: "rolled-back", message: "web is unhealthy", finishedAt: hoursAgo(1) };
  const newer = answer(status({ last, available: update("0.2.2") }));
  assert.equal(kind(newer, { failedVersion: "0.2.1" }), "available");
  const view = Updates.popover(newer, { failedVersion: "0.2.1" }, { now: NOW });
  assert.equal(view.title, "Update available");
  assert.equal(view.failure, "0.2.1 failed: web is unhealthy");
  assert.deepEqual(view.action, { label: "Install now", version: "0.2.2", anyway: false });
  const attention = Updates.popover(answer(status({ last, attention: update("0.3.0") })), {}, { now: NOW });
  assert.equal(attention.failure, "0.2.1 failed: web is unhealthy");
  assert.equal(Updates.popover(answer(status({ available: update("0.2.2") })), {}, { now: NOW }).failure, "");
});

test("an installation without a result asks to check the server after 15 minutes", () => {
  const waiting = Updates.waitFor("0.2.1", null, NOW);
  assert.equal(Updates.tooSlow(waiting, NOW + 14 * 60_000), false);
  assert.equal(Updates.tooSlow(waiting, NOW + 16 * 60_000), true);
  // An adopted installation counts from when the updater started it.
  assert.equal(Updates.tooSlow({ ...waiting, since: NOW - 10 * 60_000 }, NOW + 6 * 60_000), true);
  assert.equal(Updates.slowAt(waiting), NOW + Updates.PATIENCE);
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
