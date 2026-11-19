"use strict";
// What the update button, its popover and the Updates tab show for an UpdatesResponse
// from /admin/updates/ (docs/updates.md). No DOM: updates.js renders these views.
((root) => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  // Without a result after this long, an installation asks the admin to look at the server.
  const PATIENCE = 15 * MINUTE;
  // An install request whose answer got lost counts as not started when the status has
  // not reported it after this long.
  const RECONCILE = MINUTE;
  const NOTES_SHOWN = 8;
  const CHANNELS = { stable: "Stable", preview: "Preview" };
  const STAGES = {
    requested: "Waiting for the server",
    pulling: "Downloading",
    starting: "Starting",
    deploying: "Deploying",
  };
  const FAILED = ["failed", "rolled-back"];
  // The updater refuses installations while automatic updates are off.
  const OFF_NOTE =
    "Automatic updates are off on this server, so nothing can install. Set them up as the deployment guide describes.";
  const SERVICE = "meldgrove-updater-reimbursements";

  const plural = (count, unit) => `${count} ${unit}${count === 1 ? "" : "s"}`;

  function ago(iso, now) {
    const time = Date.parse(iso);
    if (Number.isNaN(time)) return "";
    const elapsed = Math.max(0, now - time);
    if (elapsed < MINUTE) return "just now";
    if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
    if (elapsed < DAY) return `${plural(Math.floor(elapsed / HOUR), "hour")} ago`;
    return `${plural(Math.floor(elapsed / DAY), "day")} ago`;
  }

  // The cooldown as the updater reports it: "3d", "12h", "30m" or seconds.
  function duration(value) {
    const text = String(value ?? "").trim();
    const match = /^(\d+)([dhms]?)$/.exec(text);
    if (!match) return text || null;
    let count = Number(match[1]);
    if (count === 0) return null;
    let unit = { d: "day", h: "hour", m: "minute" }[match[2]] || "second";
    if (unit === "second") {
      const whole = [[86_400, "day"], [3600, "hour"], [60, "minute"]].find(([size]) => count % size === 0);
      if (whole) [count, unit] = [count / whole[0], whole[1]];
    }
    return plural(count, unit);
  }

  function dateTime(iso, timeZone) {
    const options = { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
    try {
      return new Intl.DateTimeFormat("en-GB", { ...options, timeZone }).format(new Date(iso));
    } catch {
      return new Intl.DateTimeFormat("en-GB", options).format(new Date(iso));
    }
  }

  function installs(update, now, timeZone) {
    const time = Date.parse(update?.installsAt ?? "");
    if (Number.isNaN(time)) return "";
    if (time <= now) return "Installs automatically at the next check";
    return `Installs automatically on ${dateTime(update.installsAt, timeZone)}`;
  }

  const installed = (response) => response?.updater?.installed || response?.app?.version || null;
  const safeUrl = (url) => (typeof url === "string" && /^https?:\/\//i.test(url) ? url : null);
  // The available or attention update with this version.
  const offer = (status, version) =>
    [status?.available, status?.attention].find((update) => update && update.version === version) || null;
  const installable = (status) => Boolean(status) && status.mode !== "off";
  // The attention offer: a release that needs upgrade steps.
  const needsSteps = (status, update) => Boolean(update) && update === status?.attention;

  // local: { checking, waiting: an installation this page waits for, restarting,
  // failedVersion: an installation this page saw fail }
  function button(response, local = {}) {
    const status = response?.updater;
    if (local.waiting) {
      const version = local.waiting.version;
      return { kind: "installing", version, tooltip: local.restarting ? "Restarting…" : `Installing ${version}…` };
    }
    if (!response) return { kind: "loading", tooltip: "Check for updates" };
    if (!response.reachable) return { kind: "unreachable", tooltip: "No update service. See the deployment guide." };
    if (status?.installing) {
      const version = status.installing.version;
      return { kind: "installing", version, tooltip: `Installing ${version}…` };
    }
    if (local.checking || status?.checking) return { kind: "checking", tooltip: "Checking for updates…" };
    if (!status) return { kind: "unknown", tooltip: response.error || "Check for updates" };
    const last = status.last;
    if (last && FAILED.includes(last.result) && (offer(status, last.version)?.failed || local.failedVersion === last.version)) {
      return { kind: "failed", version: last.version, tooltip: `Update to ${last.version} failed` };
    }
    if (status.available) {
      const version = status.available.version;
      return { kind: "available", version, tooltip: `Update available · ${version}` };
    }
    if (status.attention) {
      const version = status.attention.version;
      return { kind: "attention", version, tooltip: `${version} needs upgrade steps` };
    }
    // Off shows new versions above, but installs nothing.
    if (status.mode === "off") return { kind: "off", tooltip: "Automatic updates are off on this server" };
    // A check that could not reach the registry does not know.
    if (status.error) return { kind: "current", tooltip: `The last check failed: ${status.error}` };
    const version = installed(response);
    return { kind: "current", tooltip: version ? `Up to date · ${version}` : "Up to date" };
  }

  // Installing `update` (offered by `status`) from the popover, or null where it cannot.
  // A release that needs upgrade steps keeps its confirmation, also on a retry. Where an
  // image tag decides (channelLocked), only a new tag reaches it.
  function installAction(label, status, update) {
    if (!update || !installable(status)) return null;
    if (!needsSteps(status, update)) return { label, version: update.version, anyway: false };
    if (status.channelLocked) return null;
    return { label, version: update.version, anyway: true, url: safeUrl(update.url) };
  }

  // The popover of a button state, or null when a click checks instead.
  function popover(response, local = {}, { now = Date.now(), timeZone, app = "The app" } = {}) {
    const state = button(response, local);
    const status = response?.updater;
    const running = installed(response);
    if (state.kind === "installing") {
      const stage = status?.installing?.version === state.version ? status.installing.stage : "requested";
      const before = local.waiting?.before || running;
      const text = [
        local.restarting ? "Restarting…" : STAGES[stage] || (stage === "rolling-back" ? `Going back to ${before || "the version before"}` : ""),
        `${app} restarts. This page reloads when it is back.`,
      ];
      const slow = local.slow ? `This takes longer than expected. Check the server (journalctl -u ${SERVICE}).` : "";
      // Stop waiting: forget the installation and poll as usual again.
      const stop = Boolean(local.slow && local.waiting);
      return { kind: state.kind, title: `Installing ${state.version}…`, text: text.filter(Boolean), slow, stop };
    }
    if (state.kind === "available") {
      const update = status.available;
      const notes = (update.notes || []).slice(0, NOTES_SHOWN);
      const more = Math.max(0, (update.changes || 0) - notes.length);
      return {
        kind: state.kind,
        title: "Update available",
        meta: [update.version, update.publishedAt ? ago(update.publishedAt, now) : ""].filter(Boolean).join(" · "),
        preview: Boolean(update.preview),
        notes,
        more: more ? `and ${plural(more, "more change")}` : "",
        url: safeUrl(update.url),
        schedule: installable(status) ? installs(update, now, timeZone) : OFF_NOTE,
        action: installable(status) ? { label: "Install now", version: update.version, anyway: false } : null,
      };
    }
    if (state.kind === "attention") {
      const update = status.attention;
      const locked = Boolean(status.channelLocked);
      return {
        kind: state.kind,
        title: `${update.version} needs upgrade steps`,
        text: [
          locked
            ? `This release changes the setup. The image tag set where ${app} is deployed does not reach ${update.version}: take the upgrade steps from its release notes, then change the tag there.`
            : "This release changes the setup. Take the upgrade steps from its release notes on the server first.",
        ],
        url: safeUrl(update.url),
        schedule: installable(status) ? "" : OFF_NOTE,
        action: installAction("Install anyway…", status, update),
      };
    }
    if (state.kind === "failed") {
      const update = offer(status, state.version);
      const message = status.last.message || update?.failed || "";
      return {
        kind: state.kind,
        title: `Update to ${state.version} failed`,
        text: [message, running ? `${running} is still running.` : ""].filter(Boolean),
        url: needsSteps(status, update) ? safeUrl(update.url) : null,
        action: installAction("Try again", status, update),
      };
    }
    return null;
  }

  function footer(response, now = Date.now()) {
    const status = response?.updater;
    const channel = CHANNELS[status?.channel];
    return {
      installed: `Installed: ${installed(response) || "unknown"}${channel ? ` · ${channel}` : ""}`,
      checked: status?.checkedAt ? `Checked ${ago(status.checkedAt, now)}` : "Not checked yet",
      error: status?.error ? `The last check failed: ${status.error}` : "",
    };
  }

  function automatic(status) {
    if (!status) return "";
    if (status.mode === "off" || !status.automatic) return "Off on this server: nothing installs automatically.";
    const what = status.channel === "preview" ? "previews and releases" : "releases";
    const after = duration(status.cooldown);
    let text = `On: ${what} install automatically ${after ? `after ${after}` : "at the next check"}`;
    const window = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(status.window || "");
    if (window) text += `, between ${window[1]} and ${window[2]} (${status.timezone || "UTC"})`;
    text += ".";
    if (status.mode === "platform") text += " The platform installs them (deploy link).";
    return text;
  }

  // The Updates tab.
  function settings(response, now = Date.now()) {
    const status = response?.updater;
    const reachable = Boolean(response?.reachable && status);
    const after = duration(status?.cooldown);
    return {
      reachable,
      detail: response && !response.reachable ? response.error || "" : "",
      version: response?.app?.version || "development",
      channel: status ? CHANNELS[status.channel] || status.channel : "Unknown",
      selected: status?.channel || null,
      automatic: status ? automatic(status) : "Unknown",
      checked: status?.checkedAt ? ago(status.checkedAt, now) : status ? "Not checked yet" : "Unknown",
      error: status?.error ? `The last check failed: ${status.error}` : "",
      stable: `Releases. Updates that need no action install automatically${after ? ` after ${after}` : ""}.`,
      locked: status?.channelLocked || "",
      disabled: !reachable || Boolean(status?.channelLocked),
    };
  }

  // An installation this page follows (docs/updates.md, install flow): one requested
  // here, remembered before the request and unconfirmed until the updater reports it, or
  // one a status reports. `since`: when the updater started it, once a status said so.
  function waitFor(version, response, now = Date.now(), confirmed = false) {
    return { version, before: response?.app?.version ?? null, startedAt: now, confirmed, since: null };
  }

  const statusOf = (response) => (response?.reachable && response.updater) || null;
  const startOf = (installing) => {
    const time = Date.parse(installing?.startedAt ?? "");
    return Number.isNaN(time) ? null : time;
  };

  // A result counts when it finished after the attempt started. The updater's own start
  // time of the installation also counts, so a browser clock ahead of the server's does
  // not hide the result.
  function fresh(last, attempt) {
    const finished = Date.parse(last?.finishedAt ?? "");
    if (Number.isNaN(finished)) return false;
    return finished >= Math.min(attempt.startedAt, attempt.since ?? Infinity);
  }

  // The installation a status reports, to follow, or null.
  function adopt(response, now = Date.now()) {
    const installing = statusOf(response)?.installing;
    if (!installing?.version) return null;
    return { ...waitFor(installing.version, response, now, true), since: startOf(installing) };
  }

  // `attempt` after a status answer: confirmed once the status reports it or its result,
  // or replaced by another installation the status reports instead.
  function observe(response, attempt, now = Date.now()) {
    const status = statusOf(response);
    if (!status) return attempt;
    const installing = status.installing;
    if (installing?.version === attempt.version) {
      const since = startOf(installing) ?? attempt.since;
      return attempt.confirmed && attempt.since === since ? attempt : { ...attempt, confirmed: true, since };
    }
    if (status.last?.version === attempt.version && fresh(status.last, attempt)) {
      return attempt.confirmed ? attempt : { ...attempt, confirmed: true };
    }
    return installing?.version ? adopt(response, now) : attempt;
  }

  // What the answer to the install request means: "follow" the attempt (or the
  // installation that a refusal reports instead), "refused" (forget it), or "ambiguous"
  // (keep it and poll until the status reports it). `reply`: { status, body, signedOut },
  // or null when no answer arrived.
  function installAnswer(reply, attempt, now = Date.now()) {
    const body = reply?.body ?? null;
    if (reply?.status === 202 && body?.reachable) {
      return { outcome: "follow", attempt: observe(body, { ...attempt, confirmed: true }, now) };
    }
    const refused = (reply?.status >= 400 && reply.status < 500 && body?.error) || reply?.signedOut;
    if (refused) {
      // Another admin or an automatic installation was faster: follow that one.
      if (adopt(body, now)) return { outcome: "follow", attempt: observe(body, attempt, now) };
      const error = body?.error || "The app refused the request. Reload the page and try again.";
      return { outcome: "refused", attempt: null, error };
    }
    const reason = body?.error || (reply ? `The app answered with HTTP ${reply.status}.` : "The app did not answer.");
    return { outcome: "ambiguous", attempt: { ...attempt, reason } };
  }

  // "done", "failed", "waiting", or "lost" (an unconfirmed attempt the status never
  // reported) for a status answer while following `attempt`, in the order of
  // docs/updates.md. `outage`: the app did not answer at some point since.
  function progress(response, attempt, { outage = false, now = Date.now() } = {}) {
    const status = statusOf(response);
    const app = response?.app?.version ?? null;
    const { version } = attempt;
    const last = status?.last?.version === version && fresh(status.last, attempt) ? status.last : null;
    if (last && FAILED.includes(last.result)) return "failed";
    // On a server, the result comes once every service is healthy; the new version may
    // answer before that and still roll back.
    if (status?.installing?.version === version) return "waiting";
    if (last?.result === "installed") return "done";
    // A platform accepts a deployment before it runs it.
    if (last?.result === "accepted") return (app ? app === version : outage) ? "done" : "waiting";
    // Only the updater can say that nothing reports the installation any more.
    if (status && app === version) return "done";
    if (status && !attempt.confirmed && now - attempt.startedAt >= RECONCILE) return "lost";
    return "waiting";
  }

  // Counted from when the installation started, as far as this page knows.
  const tooSlow = (waiting, now = Date.now()) => now - Math.min(waiting.startedAt, waiting.since ?? Infinity) > PATIENCE;

  const api = {
    ago,
    duration,
    installs,
    button,
    popover,
    footer,
    automatic,
    settings,
    waitFor,
    adopt,
    observe,
    installAnswer,
    progress,
    tooSlow,
    PATIENCE,
    RECONCILE,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PortalUpdates = api;
})(globalThis);
