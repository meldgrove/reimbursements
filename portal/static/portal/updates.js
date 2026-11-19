// The admins' update button in the header and the Updates tab (docs/updates.md).
// updates-state.js decides what they show; this file fetches and renders it.
(() => {
  const Updates = window.PortalUpdates;
  const configElement = document.getElementById("updates-config");
  if (!Updates || !configElement) return;
  const config = JSON.parse(configElement.textContent);
  const storageKey = "reimbursements-update-install";
  const POLL = 5 * 60_000;
  const FOCUS_POLL = 60_000;
  const INSTALL_POLL = 2000;
  const SLOW_POLL = 10_000;

  const root = document.querySelector("[data-updates-root]");
  const button = root?.querySelector("[data-updates-button]");
  const panel = root?.querySelector("[data-updates-popover]");
  const form = document.querySelector("[data-updates-settings]");
  const dialog = document.querySelector("[data-updates-confirm]");
  const toastElement = document.querySelector("[data-updates-toast]");
  const csrf = document.querySelector("[name=csrfmiddlewaretoken]")?.value || "";

  const state = {
    response: null,
    checking: false,
    waiting: null,
    restarting: false,
    outage: false,
    slow: false,
    failedVersion: null,
    // An installation the admin stopped waiting for: not adopted again from the status.
    dismissed: null,
    error: "",
  };
  let lastFetch = 0;
  let installTimer = 0;
  let chosen = null;
  let saving = false;

  // Network --------------------------------------------------------------------------

  // { status, body, signedOut }: body is an UpdatesResponse, or null when something else
  // answered (a proxy while the app restarts, a sign-in page); signedOut when the session
  // no longer reaches the routes.
  async function send(url, payload) {
    const options = { credentials: "same-origin", headers: { Accept: "application/json" } };
    if (payload !== undefined) {
      options.method = "POST";
      options.headers["Content-Type"] = "application/json";
      options.headers["X-CSRFToken"] = csrf;
      options.body = JSON.stringify(payload);
    }
    const response = await fetch(url, options);
    const signedOut = response.status === 401 || response.status === 403 || response.redirected;
    let body = null;
    try {
      body = await response.json();
    } catch {
      return { status: response.status, body: null, signedOut };
    }
    const valid = body && typeof body === "object" && typeof body.reachable === "boolean";
    return { status: response.status, body: valid ? body : null, signedOut };
  }

  // A refusal without the latest status keeps the status the page shows.
  function take(body) {
    if (!body) return;
    const keep = body.reachable && !body.updater && state.response?.updater;
    state.response = keep ? { ...body, updater: state.response.updater } : body;
  }

  async function refresh() {
    if (state.waiting) return;
    lastFetch = Date.now();
    try {
      const reply = await send(config.status);
      take(reply.body);
      if (adopt(reply.body)) return;
    } catch {
      // Offline for a moment: keep what the page shows.
    }
    render();
  }

  async function check({ open = false } = {}) {
    if (state.checking || state.waiting) return;
    state.checking = true;
    state.error = "";
    render();
    let reply = null;
    try {
      reply = await send(config.check, {});
      take(reply.body);
      if (reply.status !== 200) state.error = reply.body?.error || "The check did not finish. Try again.";
    } catch {
      state.error = "The app did not answer. Try again.";
    }
    state.checking = false;
    lastFetch = Date.now();
    if (adopt(reply?.body)) return;
    if (state.error) {
      fail(state.error, { open });
      return;
    }
    render();
    if (open) openPopover();
    // The updater answers a check that could not reach the registry with 200 and the
    // reason. The popover's footer and the Updates tab show it; otherwise a toast does.
    const failed = reply?.body?.reachable && reply.body.updater?.error;
    if (open && failed && panel?.hidden && !form) toast(`The last check failed: ${failed}`, "error");
  }

  async function install(action) {
    if (!(await confirmInstall(action))) return;
    // Remembered before the request: its answer can get lost while the server installs.
    const attempt = Updates.waitFor(action.version, state.response);
    Object.assign(state, { waiting: attempt, outage: false, restarting: false, slow: false, failedVersion: null, error: "" });
    remember(attempt);
    render();
    let reply = null;
    try {
      reply = await send(config.install, { version: action.version });
    } catch {
      reply = null;
    }
    if (state.waiting !== attempt) return;
    take(reply?.body);
    const answer = Updates.installAnswer(reply, attempt);
    if (answer.outcome === "refused") {
      stopWaiting();
      fail(answer.error, { open: true });
      return;
    }
    // Follow it, or poll until the status reports it (an ambiguous answer).
    wait(answer.attempt);
  }

  // Installation ---------------------------------------------------------------------

  function remember(waiting) {
    try {
      if (waiting) sessionStorage.setItem(storageKey, JSON.stringify(waiting));
      else sessionStorage.removeItem(storageKey);
    } catch {
      // Private browsing: a reload during the restart stops waiting.
    }
  }

  function remembered() {
    try {
      const waiting = JSON.parse(sessionStorage.getItem(storageKey) || "null");
      if (!waiting || typeof waiting.version !== "string" || !Number.isFinite(waiting.startedAt)) return null;
      return { ...waiting, confirmed: waiting.confirmed === true, since: Number.isFinite(waiting.since) ? waiting.since : null };
    } catch {
      return null;
    }
  }

  function wait(waiting, delay = INSTALL_POLL) {
    Object.assign(state, { waiting, outage: false, restarting: false, slow: false, failedVersion: null, error: "" });
    remember(waiting);
    render();
    window.clearTimeout(installTimer);
    installTimer = window.setTimeout(follow, delay);
  }

  function stopWaiting() {
    state.waiting = null;
    state.restarting = false;
    state.slow = false;
    remember(null);
    window.clearTimeout(installTimer);
  }

  // Follows an installation that a status reports (from a poll, a check or a refusal),
  // unless the admin stopped waiting for it.
  function adopt(body) {
    if (state.waiting) return false;
    const attempt = Updates.adopt(body);
    const dismissed = state.dismissed;
    if (!attempt || (dismissed?.version === attempt.version && dismissed.since === attempt.since)) return false;
    wait(attempt);
    return true;
  }

  // Stop waiting, after 15 minutes: forget the installation and poll as usual.
  function dismiss() {
    const waiting = state.waiting;
    state.dismissed = waiting && { version: waiting.version, since: waiting.since };
    stopWaiting();
    render();
    refresh();
  }

  async function follow() {
    const waiting = state.waiting;
    if (!waiting) return;
    const now = Date.now();
    let reply = null;
    try {
      reply = await send(config.status);
    } catch {
      reply = null;
    }
    if (state.waiting !== waiting) return;
    if (reply?.signedOut) {
      // Polling cannot go on; the remembered attempt resumes after the next sign-in.
      window.clearTimeout(installTimer);
      Object.assign(state, { waiting: null, restarting: false, slow: false });
      fail("The session ended. Sign in again to follow the installation.");
      return;
    }
    if (!reply?.body) {
      // Network errors, 502 and 503 while the app restarts.
      state.outage = true;
      state.restarting = true;
    } else {
      take(reply.body);
      // The updater restarts with the app when the image changes.
      state.restarting = !reply.body.reachable;
      const attempt = Updates.observe(reply.body, waiting, now);
      if (attempt !== waiting) {
        state.waiting = attempt;
        remember(attempt);
      }
      const result = Updates.progress(reply.body, attempt, { outage: state.outage, now });
      if (result === "done") {
        stopWaiting();
        render();
        toast(`Updated to ${attempt.version}`);
        window.setTimeout(() => window.location.reload(), 1500);
        return;
      }
      if (result === "failed") {
        stopWaiting();
        state.failedVersion = attempt.version;
        render();
        openPopover();
        return;
      }
      if (result === "lost") {
        stopWaiting();
        fail(["The installation did not start.", attempt.reason].filter(Boolean).join(" "), { open: true });
        return;
      }
    }
    state.slow = Updates.tooSlow(state.waiting, now);
    render();
    installTimer = window.setTimeout(follow, state.slow ? SLOW_POLL : INSTALL_POLL);
  }

  // Messages -------------------------------------------------------------------------

  let toastTimer = 0;
  function toast(message, variant = "success") {
    if (!toastElement) return;
    const failed = variant === "error";
    toastElement.classList.toggle("ui-alert-success", !failed);
    toastElement.classList.toggle("ui-alert-destructive", failed);
    toastElement.querySelector("[data-updates-toast-icon=success]").hidden = failed;
    toastElement.querySelector("[data-updates-toast-icon=error]").hidden = !failed;
    toastElement.querySelector("[data-updates-toast-text]").textContent = message;
    toastElement.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (toastElement.hidden = true), failed ? 8000 : 5000);
  }

  // An action's error: in the popover, on the Updates tab, or else as a toast.
  function fail(message, { open = false } = {}) {
    state.error = message;
    render();
    if (open) openPopover();
    if (panel && !panel.hidden) return;
    if (!form) toast(message, "error");
  }

  // Confirm dialog -------------------------------------------------------------------

  function confirmInstall(action) {
    if (!dialog) return Promise.resolve(false);
    closePopover();
    dialog.querySelector("[data-updates-confirm-title]").textContent = action.anyway
      ? `Install ${action.version} without its upgrade steps?`
      : `Install ${action.version} now?`;
    dialog.querySelector("[data-updates-confirm-steps]").hidden = !action.anyway;
    const notes = dialog.querySelector("[data-updates-confirm-notes]");
    if (action.url) notes.href = action.url;
    else notes.removeAttribute("href");
    const confirmButton = dialog.querySelector("[data-updates-confirm-install]");
    confirmButton.classList.toggle("ui-button-default", !action.anyway);
    confirmButton.classList.toggle("ui-button-destructive", action.anyway);
    dialog.returnValue = "";
    return new Promise((resolve) => {
      dialog.addEventListener("close", () => {
        button?.focus();
        resolve(dialog.returnValue === "install");
      }, { once: true });
      dialog.showModal();
    });
  }

  // Button and popover ---------------------------------------------------------------

  const MUTED = ["loading", "unknown", "current", "off", "unreachable", "checking"];

  function popoverView() {
    return Updates.popover(state.response, state, { timeZone: config.timezone, app: config.app });
  }

  function openPopover() {
    if (!panel || !popoverView()) return;
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    render();
  }

  function closePopover() {
    if (!panel || panel.hidden) return;
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    state.error = "";
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderPopover(view) {
    const body = panel.querySelector("[data-updates-body]");
    const nodes = [];
    if (state.error) {
      nodes.push(element("p", "rounded-md border border-error-border bg-error-background px-3 py-2 text-sm text-destructive", state.error));
    }
    const heading = element("div", "flex flex-wrap items-center gap-2");
    heading.append(element("h2", "text-sm font-semibold", view.title));
    if (view.preview) heading.append(element("span", "ui-badge ui-badge-warning", "Preview"));
    nodes.push(heading);
    if (view.meta) nodes.push(element("p", "-mt-2 text-sm text-muted-foreground", view.meta));
    for (const line of view.text || []) nodes.push(element("p", "text-sm break-words", line));
    if (view.notes?.length) {
      const list = element("ul", "flex list-disc flex-col gap-1 pl-5 text-sm");
      for (const note of view.notes) list.append(element("li", "break-words", note));
      nodes.push(list);
    }
    if (view.more) nodes.push(element("p", "-mt-2 text-sm text-muted-foreground", view.more));
    if (view.url) {
      const link = element("a", "inline-flex w-fit items-center gap-1 text-sm font-medium text-primary hover:underline", "Release notes");
      link.href = view.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      const icon = root.querySelector("[data-updates-external]");
      if (icon) link.append(icon.content.cloneNode(true));
      nodes.push(link);
    }
    if (view.schedule) nodes.push(element("p", "text-sm text-muted-foreground", view.schedule));
    if (view.slow) {
      nodes.push(element("p", "rounded-md border border-warning-border bg-warning-background px-3 py-2 text-sm text-warning", view.slow));
    }
    if (view.stop) {
      const stop = element("button", "ui-button ui-button-outline ui-button-sm w-full border-input", "Stop waiting");
      stop.type = "button";
      stop.addEventListener("click", dismiss);
      nodes.push(stop);
    }
    if (view.action) {
      const variant = view.action.anyway ? "ui-button-outline border-input" : "ui-button-default";
      const action = element("button", `ui-button ${variant} ui-button-sm w-full`, view.action.label);
      action.type = "button";
      action.addEventListener("click", () => install(view.action));
      nodes.push(action);
    }
    body.replaceChildren(...nodes);
    const footer = Updates.footer(state.response);
    panel.querySelector("[data-updates-installed]").textContent = footer.installed;
    panel.querySelector("[data-updates-checked]").textContent = footer.checked;
    const error = panel.querySelector("[data-updates-check-error]");
    error.textContent = footer.error;
    error.hidden = !footer.error;
    panel.querySelector("[data-updates-check]").disabled = state.checking || Boolean(state.waiting);
  }

  function renderButton() {
    if (!button) return;
    const view = Updates.button(state.response, state);
    const icon = { available: "download", attention: "download", failed: "failed", installing: "installing" }[view.kind] || "refresh";
    button.querySelectorAll("[data-updates-icon]").forEach((svg) => {
      svg.toggleAttribute("hidden", svg.dataset.updatesIcon !== icon);
    });
    button.querySelector("[data-updates-icon=refresh]").classList.toggle("motion-safe:animate-spin", view.kind === "checking");
    const dot = button.querySelector("[data-updates-dot]");
    dot.hidden = view.kind !== "available" && view.kind !== "attention";
    dot.classList.toggle("bg-primary", view.kind === "available");
    dot.classList.toggle("bg-warning", view.kind === "attention");
    button.classList.toggle("text-muted-foreground", MUTED.includes(view.kind));
    button.classList.toggle("text-destructive", view.kind === "failed");
    button.classList.toggle("opacity-60", view.kind === "unreachable");
    button.title = view.tooltip;
    button.setAttribute("aria-label", view.tooltip);
    const popover = popoverView();
    button.setAttribute("aria-haspopup", popover ? "dialog" : "false");
    if (!popover) closePopover();
    else if (!panel.hidden) renderPopover(popover);
  }

  // Updates tab ----------------------------------------------------------------------

  function renderSettings() {
    if (!form) return;
    const view = Updates.settings(state.response);
    const set = (selector, text) => (form.querySelector(selector).textContent = text);
    form.setAttribute("aria-busy", String(!state.response));
    if (!state.response) return;
    form.querySelector("[data-updates-unreachable]").hidden = view.reachable;
    set("[data-updates-unreachable-detail]", view.detail);
    form.querySelector("[data-updates-error]").hidden = !state.error;
    set("[data-updates-error-text]", state.error);
    set("[data-updates-version]", view.version);
    set("[data-updates-channel]", view.channel);
    set("[data-updates-automatic]", view.automatic);
    set("[data-updates-checked]", state.checking ? "Checking for updates…" : view.checked);
    const checkError = form.querySelector("[data-updates-check-error]");
    checkError.textContent = view.error;
    checkError.hidden = !view.error;
    form.querySelector("[data-updates-check]").disabled = !view.reachable || state.checking || Boolean(state.waiting) || saving;
    set("[data-updates-stable-text]", view.stable);
    const locked = form.querySelector("[data-updates-locked]");
    locked.textContent = view.locked;
    locked.hidden = !view.locked;
    const selected = chosen || view.selected;
    form.querySelectorAll("input[name=channel]").forEach((radio) => {
      radio.checked = radio.value === selected;
      radio.disabled = view.disabled || saving;
    });
    form.querySelector("[data-updates-save]").disabled = view.disabled || saving || !chosen || chosen === view.selected;
  }

  function render() {
    renderButton();
    renderSettings();
  }

  // Events ---------------------------------------------------------------------------

  if (button) {
    button.addEventListener("click", () => {
      if (!panel.hidden) {
        closePopover();
        return;
      }
      if (popoverView()) {
        openPopover();
        return;
      }
      const kind = Updates.button(state.response, state).kind;
      if (kind === "checking") return;
      if (kind === "loading" || kind === "unreachable") refresh();
      else check({ open: true });
    });
    panel.querySelector("[data-updates-check]").addEventListener("click", () => check({ open: true }));
    // Before admin.js, which would close the sidebar as well.
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || panel.hidden || document.querySelector("dialog[open]")) return;
      event.preventDefault();
      closePopover();
      button.focus();
    }, { capture: true });
    document.addEventListener("click", (event) => {
      if (!panel.hidden && !root.contains(event.target)) closePopover();
    });
  }

  if (form) {
    form.addEventListener("change", (event) => {
      if (event.target.name !== "channel") return;
      chosen = event.target.value;
      form.querySelector("[data-updates-saved]").textContent = "";
      renderSettings();
    });
    form.querySelector("[data-updates-check]").addEventListener("click", () => check());
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!chosen || saving) return;
      const saved = form.querySelector("[data-updates-saved]");
      saving = true;
      state.error = "";
      saved.textContent = "Saving …";
      render();
      try {
        const reply = await send(config.channel, { channel: chosen });
        take(reply.body);
        // Saved only when the updater reports the chosen channel.
        if (reply.status === 200 && reply.body?.reachable && reply.body.updater?.channel === chosen) {
          chosen = null;
          saved.textContent = `Saved. The channel is ${Updates.settings(state.response).channel}.`;
        } else {
          saved.textContent = "";
          state.error = reply.body?.error || "The channel was not saved. Try again.";
        }
      } catch {
        saved.textContent = "";
        state.error = "The app did not answer. Try again.";
      }
      saving = false;
      lastFetch = Date.now();
      render();
    });
  }

  window.setInterval(refresh, POLL);
  window.addEventListener("focus", () => {
    if (Date.now() - lastFetch >= FOCUS_POLL) refresh();
  });

  const waiting = remembered();
  if (waiting) {
    // A reload during the restart keeps waiting for the same installation.
    wait(waiting, 0);
  } else {
    refresh();
  }
})();
