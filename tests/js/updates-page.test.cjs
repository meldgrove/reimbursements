// The update button's own timers and requests (portal/static/portal/updates.js), on a
// stand-in page with fake timers: its limits run on their own, whatever the requests do.
const { test, mock, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Updates = require("../../portal/static/portal/updates-state.js");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "..", "portal", "static", "portal", "updates.js"), "utf8");
const NOW = Date.parse("2026-11-19T12:00:00Z");
const STORAGE_KEY = "reimbursements-update-install";
const CONFIG = { app: "Meldgrove Reimbursement", timezone: "UTC", status: "/status", check: "/check", install: "/install", channel: "/channel" };

// Elements made on first lookup, enough for updates.js.
class Element {
  constructor(tag = "div") {
    this.tagName = tag;
    this.hidden = false;
    this.textContent = "";
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.found = {};
    this.dataset = {};
    this.classList = { toggle() {}, add() {}, remove() {} };
  }
  querySelector(selector) {
    this.found[selector] ??= new Element();
    return this.found[selector];
  }
  querySelectorAll(selector) {
    return [this.querySelector(selector)];
  }
  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  dispatch(type) {
    const listeners = this.listeners[type] || [];
    this.listeners[type] = [];
    for (const listener of listeners) listener({ target: this });
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes) {
    this.children = nodes;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  toggleAttribute() {}
  contains() {
    return true;
  }
  focus() {}
}

const json = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  type: "basic",
  headers: { get: () => "application/json" },
  json: async () => body,
});
const page = (status) => ({
  status,
  ok: status >= 200 && status < 300,
  type: "basic",
  headers: { get: () => "text/html; charset=utf-8" },
  json: async () => {
    throw new SyntaxError("Unexpected token <");
  },
});
const redirect = { status: 0, ok: false, type: "opaqueredirect", headers: { get: () => null }, json: async () => { throw new SyntaxError(); } };
// A request that never answers, until it is aborted.
const stalled = (options) =>
  new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted"))));

function status(changes = {}) {
  return {
    updater: "0.2.0",
    mode: "host",
    channel: "stable",
    channelLocked: null,
    installed: "0.2.0",
    available: { version: "0.2.1", preview: false, publishedAt: null, url: null, notes: [], changes: 0, installsAt: null, failed: null },
    attention: null,
    installing: null,
    last: null,
    checking: false,
    checkedAt: "2026-11-19T11:00:00Z",
    error: null,
    automatic: true,
    cooldown: "3d",
    window: null,
    timezone: "UTC",
    ...changes,
  };
}
const answer = (updater, changes = {}) => ({ app: { version: "0.2.0" }, reachable: true, updater, error: null, ...changes });

// Loads the button with `routes` answering its requests: { "/status": (options) => response }.
function load(routes, stored = null) {
  const storage = new Map(stored ? [[STORAGE_KEY, JSON.stringify(stored)]] : []);
  const requests = [];
  const elements = {};
  const lookup = (selector) => {
    if (selector === "[data-updates-settings]" || selector === "dialog[open]") return null;
    if (selector === "[name=csrfmiddlewaretoken]") return { value: "token" };
    elements[selector] ??= new Element();
    return elements[selector];
  };
  const root = lookup("[data-updates-root]");
  const panel = root.querySelector("[data-updates-popover]");
  panel.hidden = true;
  lookup("[data-updates-toast]").hidden = true;
  // The confirm dialog answers Install.
  const dialog = lookup("[data-updates-confirm]");
  dialog.showModal = () =>
    queueMicrotask(() => {
      dialog.returnValue = "install";
      dialog.dispatch("close");
    });
  const windowListeners = {};
  const window = {
    PortalUpdates: Updates,
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (...args) => setInterval(...args),
    addEventListener: (type, listener) => (windowListeners[type] ??= []).push(listener),
    location: { reload() {} },
  };
  const document = {
    getElementById: () => ({ textContent: JSON.stringify(CONFIG) }),
    querySelector: lookup,
    createElement: (tag) => new Element(tag),
    addEventListener() {},
  };
  const sessionStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
  const fetch = (url, options) => {
    requests.push(url);
    return Promise.resolve(routes[url](options));
  };
  new Function("window", "document", "fetch", "sessionStorage", SOURCE)(window, document, fetch, sessionStorage);
  const button = root.querySelector("[data-updates-button]");
  const body = panel.querySelector("[data-updates-body]");
  return {
    requests,
    remembered: () => JSON.parse(storage.get(STORAGE_KEY) ?? "null"),
    tooltip: () => button.title,
    // What the popover and the toast say.
    shown: () => [
      ...(panel.hidden ? [] : body.children.map((node) => node.textContent)),
      ...(lookup("[data-updates-toast]").hidden ? [] : [lookup("[data-updates-toast]").querySelector("[data-updates-toast-text]").textContent]),
    ],
    click: () => button.dispatch("click"),
    press: (label) => body.children.find((node) => node.textContent === label).dispatch("click"),
    focus: () => (windowListeners.focus || []).forEach((listener) => listener()),
  };
}

const settle = async () => {
  for (let round = 0; round < 10; round += 1) await new Promise((resolve) => setImmediate(resolve));
};
// Moves the clock in steps, letting answers arrive in between.
async function advance(ms, step = 250) {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    mock.timers.tick(Math.min(step, ms - elapsed));
    await settle();
  }
}

beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: NOW }));
afterEach(() => mock.timers.reset());

// Opens the popover of the available update and installs it.
async function install(button) {
  await settle();
  button.click();
  button.press("Install now");
  await settle();
}

test("the 60 s end the wait while every request stalls or fails: could not be confirmed", async () => {
  const button = load({
    "/status": (options) => (Date.now() === NOW ? json(200, answer(status())) : stalled(options)),
    "/install": stalled,
  });
  await install(button);
  assert.deepEqual(button.remembered().version, "0.2.1");
  assert.equal(button.tooltip(), "Installing 0.2.1…");
  // The stalled install request ends after 15 s; the status requests stall as well.
  await advance(59_500);
  assert.equal(button.tooltip(), "Restarting…");
  assert.ok(button.remembered());
  await advance(750);
  assert.equal(button.remembered(), null);
  assert.ok(button.shown().includes("The installation could not be confirmed. The app did not answer."), button.shown());
});

test("a proxy error of every status request ends the wait after 60 s with that error", async () => {
  const button = load({
    "/status": () => (Date.now() === NOW ? json(200, answer(status())) : page(502)),
    "/install": () => page(504),
  });
  await install(button);
  await advance(60_250);
  assert.equal(button.remembered(), null);
  assert.ok(button.shown().includes("The installation could not be confirmed. The app answered with HTTP 502."), button.shown());
});

test("a reachable status without the attempt at the deadline: the installation did not start", async () => {
  const button = load({ "/status": () => json(200, answer(status())), "/install": () => page(504) });
  await install(button);
  await advance(59_750);
  assert.ok(button.remembered());
  await advance(500);
  assert.equal(button.remembered(), null);
  assert.ok(button.shown().includes("The installation did not start. The app answered with HTTP 504."), button.shown());
});

test("the 15 minutes show Stop waiting while a status request stalls", async () => {
  const running = status({ available: null, installing: { version: "0.2.1", startedAt: "2026-11-19T12:00:00Z", manual: true, stage: "starting" } });
  let stall = false;
  const button = load({ "/status": (options) => (stall ? stalled(options) : json(200, answer(running))) });
  await settle();
  assert.equal(button.tooltip(), "Installing 0.2.1…");
  await advance(14 * 60_000, 1000);
  stall = true;
  button.click();
  await advance(60_000 + 1000, 1000);
  assert.ok(button.shown().includes("Stop waiting"), button.shown());
  // Stop waiting forgets it, and the status reporting it again does not bring it back.
  stall = false;
  button.press("Stop waiting");
  await settle();
  assert.equal(button.remembered(), null);
  assert.ok(!button.shown().includes("Stop waiting"));
  assert.ok(!button.shown().some((line) => /reloads/.test(line)), button.shown());
});

for (const [name, signedOut] of [
  ["a redirect to the sign-in page", () => redirect],
  ["an HTML sign-in page", () => page(200)],
  ["the routes' 404 for a session without admin rights", () => json(404, { error: "Sign in as a template admin to manage updates.", signedOut: true })],
]) {
  test(`${name} stops every automatic status request and keeps the attempt`, async () => {
    const attempt = { ...Updates.waitFor("0.2.1", answer(status()), NOW, true), since: NOW };
    const button = load({ "/status": signedOut }, attempt);
    await advance(1);
    assert.deepEqual(button.requests, ["/status"]);
    assert.ok(button.shown().includes("The session ended. Sign in again to follow the installation."), button.shown());
    assert.deepEqual(button.remembered(), attempt);
    // Neither the interval nor a regained focus asks again.
    await advance(11 * 60_000, 30_000);
    button.focus();
    await settle();
    assert.deepEqual(button.requests, ["/status"]);
    assert.deepEqual(button.remembered(), attempt);
  });
}

test("a check from the header that cannot reach the updater says why", async () => {
  const current = status({ available: null });
  const unreachable = { app: { version: "0.2.0" }, reachable: false, updater: null, error: "The update service did not answer within 35 s." };
  const button = load({ "/status": () => json(200, answer(current)), "/check": () => json(200, unreachable) });
  await settle();
  assert.equal(button.tooltip(), "Up to date · 0.2.0");
  button.click();
  await settle();
  assert.equal(button.tooltip(), "No update service. See the deployment guide.");
  assert.deepEqual(button.shown(), ["The update service did not answer within 35 s."]);
});
