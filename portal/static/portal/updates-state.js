"use strict";
// What the update button, its popover and the Updates tab show for an UpdatesResponse
// from /admin/updates/ (docs/updates.md). No DOM: updates.js renders these views.
((root) => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  // Without a result after this long, an installation asks the admin to look at the server.
  const PATIENCE = 15 * MINUTE;
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
  const offered = (status, version) =>
    [status?.available?.version, status?.attention?.version].includes(version);
  const installable = (status) => Boolean(status) && status.mode !== "off";

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
    if (last && FAILED.includes(last.result) && (status.available?.failed || local.failedVersion === last.version)) {
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
    const version = installed(response);
    return { kind: "current", tooltip: version ? `Up to date · ${version}` : "Up to date" };
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
      return { kind: state.kind, title: `Installing ${state.version}…`, text: text.filter(Boolean), slow };
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
      return {
        kind: state.kind,
        title: `${update.version} needs upgrade steps`,
        text: ["This release changes the setup. Take the upgrade steps from its release notes on the server first."],
        url: safeUrl(update.url),
        schedule: installable(status) ? "" : OFF_NOTE,
        action: installable(status)
          ? { label: "Install anyway…", version: update.version, anyway: true, url: safeUrl(update.url) }
          : null,
      };
    }
    if (state.kind === "failed") {
      const message = status.last.message || status.available?.failed || "";
      return {
        kind: state.kind,
        title: `Update to ${state.version} failed`,
        text: [message, running ? `${running} is still running.` : ""].filter(Boolean),
        action:
          installable(status) && offered(status, state.version)
            ? { label: "Try again", version: state.version, anyway: false }
            : null,
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

  // An installation this page waits for, from the status before it was requested.
  function waitFor(version, response, now = Date.now()) {
    return {
      version,
      before: response?.app?.version ?? null,
      lastBefore: response?.updater?.last?.finishedAt ?? null,
      startedAt: now,
    };
  }

  // "done", "failed" or "waiting". `outage`: the app did not answer at some point since.
  function progress(response, waiting, { outage = false } = {}) {
    const app = response?.app?.version ?? null;
    if (app && app === waiting.version) return "done";
    const last = response?.updater?.last;
    if (!last || last.version !== waiting.version || last.finishedAt === waiting.lastBefore) return "waiting";
    if (FAILED.includes(last.result)) return "failed";
    // The server reports "installed" once the new version is healthy. The platform
    // reports "accepted" before it deploys, so the app's restart tells it is done.
    if (last.result === "installed") return "done";
    if (last.result === "accepted" && (app !== waiting.before || outage)) return "done";
    return "waiting";
  }

  const tooSlow = (waiting, now = Date.now()) => now - waiting.startedAt > PATIENCE;

  const api = { ago, duration, installs, button, popover, footer, automatic, settings, waitFor, progress, tooSlow, PATIENCE };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PortalUpdates = api;
})(globalThis);
