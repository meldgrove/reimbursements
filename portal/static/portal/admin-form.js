// Form settings save in order; publication and archive changes use the same queue.
(() => {
  const form = document.getElementById("form_form");
  const toggle = document.querySelector("[data-publication-toggle]");
  const archiveToggle = document.querySelector("[data-archive-toggle]");
  if (!form || !toggle || !archiveToggle) return;

  const status = document.querySelector("[data-autosave-status]");
  const saveIndicator = document.querySelector("[data-autosave-indicator]");
  const errors = document.querySelector("[data-autosave-errors]");
  const retry = document.querySelector("[data-autosave-retry]");
  const badge = document.querySelector("[data-form-status]");
  const title = document.querySelector("[data-form-title]");
  const preview = document.querySelector("[data-form-preview]");
  const deleteLink = document.querySelector("[data-form-delete]");
  const creationKey = window.crypto.randomUUID();
  let creating = !form.querySelector(".field-link");
  let timer;
  let revision = 0;
  let dirty = false;
  let saving = false;
  let publication = null;
  let failedPublication = null;
  let observed = serialize();

  // Each publication action: the status it leads to, and what the indicator says.
  const ACTIONS = {
    publish: { status: "published", progress: "Publishing …", error: "Publishing failed." },
    unpublish: { status: "draft", progress: "Unpublishing …", error: "Unpublishing failed." },
    archive: { status: "archived", progress: "Archiving …", error: "Archiving failed." },
    unarchive: { status: "draft", progress: "Unarchiving …", error: "Unarchiving failed." },
  };

  function publicationError(action) {
    return ACTIONS[action].error;
  }

  function disablePublication(disabled) {
    toggle.disabled = disabled;
    archiveToggle.disabled = disabled;
  }

  function setSaveStatus(state, message) {
    saveIndicator.dataset.saveState = state;
    saveIndicator.querySelectorAll("[data-save-symbol]").forEach((symbol) => {
      symbol.hidden = symbol.dataset.saveSymbol !== state;
    });
    status.classList.toggle("text-destructive", state === "error");
    status.textContent = message;
  }

  function serialize() {
    return new URLSearchParams(new FormData(form)).toString();
  }

  function clearErrors() {
    errors.replaceChildren();
    errors.hidden = true;
    form.querySelectorAll("[data-autosave-error]").forEach((node) => node.remove());
    form.querySelectorAll('[aria-invalid="true"]').forEach((field) => {
      field.removeAttribute("aria-invalid");
      const describedBy = (field.getAttribute("aria-describedby") || "")
        .split(" ").filter((id) => !id.startsWith("autosave-error-"));
      if (describedBy.length) field.setAttribute("aria-describedby", describedBy.join(" "));
      else field.removeAttribute("aria-describedby");
    });
  }

  function showErrors(data) {
    clearErrors();
    const summary = document.createElement("p");
    summary.textContent = data.error || "Please correct the marked fields.";
    errors.append(summary);
    for (const [name, messages] of Object.entries(data.errors || {})) {
      const fields = Array.from(form.elements).filter((field) =>
        field.name === name || field.name?.startsWith(`${name}_`));
      const message = messages.map((item) => item.message).join(" ");
      const container = fields[0]?.closest(".field-input");
      const node = document.createElement("p");
      node.textContent = message;
      node.className = "text-sm text-destructive";
      node.id = `autosave-error-${name}`;
      node.dataset.autosaveError = "true";
      (container || errors).append(node);
      fields.forEach((field) => {
        field.setAttribute("aria-invalid", "true");
        field.setAttribute("aria-describedby",
          `${field.getAttribute("aria-describedby") || ""} ${node.id}`.trim());
      });
    }
    errors.hidden = false;
  }

  function changed() {
    const current = serialize();
    if (current === observed) return;
    observed = current;
    revision += 1;
    dirty = true;
    setSaveStatus(saving ? "saving" : "pending",
      saving ? "Saving …" : "Unsaved changes …");
    window.clearTimeout(timer);
    timer = window.setTimeout(save, 600);
  }

  async function save() {
    window.clearTimeout(timer);
    if (saving || (!dirty && !publication)) return;
    const action = publication;
    publication = null;
    const slug = form.elements.namedItem("slug");
    if (creating && !slug.value) {
      const name = form.elements.namedItem("name").value;
      slug.value = window.URLify(name, slug.maxLength) || `form-${creationKey.slice(0, 12)}`;
    }
    // Freeze the generated link before sending, including when the first response is lost.
    window.django?.jQuery("#id_slug").data("_changed", true);
    const startedAt = revision;
    const data = new FormData(form);
    data.set("_autosave", "1");
    data.set("_creation_key", creationKey);
    if (action) data.set("_publication", action);
    saving = true;
    retry.hidden = true;
    setSaveStatus("saving", action ? ACTIONS[action].progress : "Saving …");
    try {
      const response = await fetch(form.action || window.location.href, {
        method: "POST",
        body: data,
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        signal: AbortSignal.timeout(20000),
      });
      if (response.redirected || !response.headers.get("Content-Type")?.includes("application/json")) {
        throw new Error("Your session may have expired. Please reload the page.");
      }
      const result = await response.json();
      if (!response.ok) {
        showErrors(result);
        throw new Error(action ? publicationError(action) : "Changes were not saved.");
      }
      clearErrors();
      if (action || ACTIONS[failedPublication]?.status === result.status) failedPublication = null;
      creating = false;
      form.action = result.url;
      window.history.replaceState(null, "", result.url);
      for (const name of ["name", "slug"]) {
        const field = form.elements.namedItem(name);
        if (field && field.value === data.get(name)) field.value = result[name];
      }
      // Archiving gives up the start page; a later save must not claim it back.
      const primary = form.elements.namedItem("primary");
      if (primary?.type === "checkbox" && primary.checked === data.has("primary")) {
        primary.checked = result.primary;
      }
      observed = serialize();
      title.textContent = form.elements.namedItem("name").value || result.name;
      badge.dataset.status = result.status;
      for (const name of ["draft", "published", "archived"]) {
        document.querySelector(`[data-${name}-badge]`).hidden = result.status !== name;
      }
      const archived = result.status === "archived";
      toggle.textContent = result.status === "published" ? "Unpublish" : "Publish";
      toggle.value = result.status === "published" ? "unpublish" : "publish";
      // An archived form is unarchived as a draft before it can be published again.
      toggle.hidden = archived;
      archiveToggle.querySelector("[data-archive-label]").textContent = archived ? "Unarchive" : "Archive";
      archiveToggle.value = archived ? "unarchive" : "archive";
      archiveToggle.hidden = false;
      preview.href = result.link;
      preview.hidden = false;
      deleteLink.href = result.delete_url;
      deleteLink.hidden = !result.can_delete;
      const link = form.querySelector(".field-link a");
      if (link) {
        link.href = result.link;
        link.textContent = new URL(result.link, window.location.origin).href;
      }
      dirty = revision !== startedAt;
      setSaveStatus(failedPublication ? "error" : dirty ? "pending" : "saved",
        failedPublication ? publicationError(failedPublication) :
          dirty ? "Unsaved changes …" : "All changes saved.");
      retry.hidden = !failedPublication;
    } catch (error) {
      dirty = true;
      if (action) failedPublication = action;
      setSaveStatus("error", failedPublication ? publicationError(failedPublication) :
        "Saving failed. Your changes are not saved yet.");
      if (errors.hidden) showErrors({ error: error.name === "TypeError" || error.name === "TimeoutError" ?
        "No connection. Please check your internet connection and try again." : error.message });
      retry.hidden = false;
      if (action) form.querySelector('[aria-invalid="true"]')?.focus();
    } finally {
      saving = false;
      disablePublication(Boolean(publication));
      if (publication || revision !== startedAt) timer = window.setTimeout(save, 0);
    }
  }

  form.addEventListener("input", changed);
  form.addEventListener("change", changed);
  // Django's date/time shortcuts assign values without dispatching input events.
  document.addEventListener("click", (event) => {
    if (event.target.closest(".datetimeshortcuts, .calendarbox, .clockbox")) {
      window.setTimeout(changed, 0);
    }
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    dirty = true;
    save();
  });
  for (const button of [toggle, archiveToggle]) {
    button.addEventListener("click", () => {
      failedPublication = null;
      publication = button.value;
      disablePublication(true);
      save();
    });
  }
  retry.addEventListener("click", () => {
    if (failedPublication) {
      publication = failedPublication;
      disablePublication(true);
    }
    save();
  });
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      save();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") save();
  });
  window.addEventListener("beforeunload", (event) => {
    if (dirty || saving || publication || failedPublication) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
})();
