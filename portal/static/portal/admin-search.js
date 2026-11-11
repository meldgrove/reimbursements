// Global search: Cmd/Ctrl+K or "/" opens a command palette with server suggestions.
(() => {
  const dialog = document.querySelector("[data-search-dialog]");
  const triggers = Array.from(document.querySelectorAll("[data-search-trigger]"));
  if (!dialog) return;

  const form = dialog.querySelector("[data-search-form]");
  const input = dialog.querySelector("[data-search-input]");
  const results = dialog.querySelector("[data-search-results]");
  const status = dialog.querySelector("[data-search-status]");
  const viewAll = dialog.querySelector("[data-search-all]");
  const initialMessage = status.textContent;
  const platform = navigator.userAgentData?.platform || navigator.platform || "";
  const shortcut = /Mac|iPhone|iPad|iPod/i.test(platform) ? "⌘K" : "Ctrl K";
  triggers.forEach((trigger) => {
    const hint = trigger.querySelector("[data-search-shortcut]");
    if (hint) hint.textContent = shortcut;
    trigger.title = `Search (${shortcut} or /)`;
  });

  let timer;
  let pendingRequest;
  let options = [];
  let activeOption = -1;
  let previousFocus;

  function clearResults() {
    window.clearTimeout(timer);
    pendingRequest?.abort();
    pendingRequest = null;
    results.replaceChildren();
    results.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    options = [];
    activeOption = -1;
  }

  function setStatus(message, visible = true) {
    status.textContent = message;
    status.classList.toggle("sr-only", !visible);
  }

  function openSearch() {
    if (dialog.open) {
      input.focus();
      input.select();
      return;
    }
    previousFocus = document.activeElement;
    clearResults();
    input.value = "";
    viewAll.disabled = true;
    setStatus(initialMessage);
    dialog.showModal();
    document.documentElement.classList.add("overflow-hidden");
    input.focus();
  }

  function setActiveOption(index) {
    options.forEach((option, position) => {
      option.setAttribute("aria-selected", String(position === index));
    });
    activeOption = index;
    const option = options[index];
    if (option) {
      input.setAttribute("aria-activedescendant", option.id);
      option.scrollIntoView({ block: "nearest" });
    }
  }

  function showResults(groups) {
    results.replaceChildren();
    options = [];
    groups.forEach((group, groupIndex) => {
      const element = document.createElement("div");
      element.setAttribute("role", "group");
      const label = document.createElement("div");
      label.id = `search-group-${groupIndex}`;
      label.className = "px-2 py-1.5 text-xs font-medium text-muted-foreground";
      label.textContent = group.label;
      element.setAttribute("aria-labelledby", label.id);
      element.append(label);
      group.items.forEach((item) => {
        const option = document.createElement("a");
        option.id = `search-option-${options.length}`;
        option.href = item.url;
        option.tabIndex = -1;
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", "false");
        option.className =
          "flex items-center gap-2 rounded-sm px-2 py-2 text-sm outline-none aria-selected:bg-accent aria-selected:text-accent-foreground";
        const name = document.createElement("span");
        name.className = "truncate font-medium";
        name.textContent = item.name;
        const detail = document.createElement("span");
        detail.className = "ml-auto truncate text-xs text-muted-foreground";
        detail.textContent = item.detail;
        option.append(name, detail);
        option.addEventListener("pointermove", () => {
          const index = options.indexOf(option);
          if (index !== activeOption) setActiveOption(index);
        });
        option.addEventListener("click", () => dialog.close());
        options.push(option);
        element.append(option);
      });
      results.append(element);
    });
    results.hidden = options.length === 0;
    input.setAttribute("aria-expanded", String(options.length > 0));
    if (options.length) {
      setStatus(`${options.length} ${options.length === 1 ? "result" : "results"}. Use the arrow keys to select.`, false);
      setActiveOption(0);
    } else {
      setStatus("No results.");
    }
  }

  async function fetchSuggestions() {
    const controller = new AbortController();
    pendingRequest = controller;
    const url = new URL(form.dataset.suggestionsUrl, window.location.origin);
    url.searchParams.set("q", input.value.trim());
    try {
      const response = await fetch(url, {
        headers: { "X-Requested-With": "XMLHttpRequest" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Search unavailable");
      const payload = await response.json();
      if (pendingRequest === controller && dialog.open) showResults(payload.groups || []);
    } catch (error) {
      if (error.name !== "AbortError" && pendingRequest === controller && dialog.open) {
        setStatus("Suggestions are unavailable right now. Show all results instead.");
      }
    } finally {
      if (pendingRequest === controller) pendingRequest = null;
    }
  }

  input.addEventListener("input", () => {
    // Clear at once so Enter cannot open a match for the previous query.
    clearResults();
    const query = input.value.trim();
    viewAll.disabled = query.length < 2;
    if (query.length < 2) {
      setStatus(query ? "Enter at least two characters." : initialMessage);
      return;
    }
    setStatus("Searching …");
    timer = window.setTimeout(fetchSuggestions, 200);
  });

  input.addEventListener("keydown", (event) => {
    if (event.isComposing || !options.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveOption((activeOption + direction + options.length) % options.length);
    } else if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      options[activeOption]?.click();
    }
  });

  form.addEventListener("submit", (event) => {
    if (input.value.trim().length < 2) event.preventDefault();
  });
  triggers.forEach((trigger) => trigger.addEventListener("click", openSearch));
  dialog.querySelector("[data-search-close]").addEventListener("click", () => dialog.close());
  dialog.addEventListener("keydown", (event) => {
    if (event.isComposing || event.key !== "Tab") return;
    const controls = Array.from(dialog.querySelectorAll("input, button:not(:disabled)"));
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => {
    clearResults();
    // The mobile sidebar drawer, which holds the search trigger, keeps its scroll lock.
    if (document.documentElement.dataset.sidebarOpen !== "true") {
      document.documentElement.classList.remove("overflow-hidden");
    }
    if (previousFocus?.isConnected) previousFocus.focus();
  });

  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey) return;
    const commandK = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
    const editing =
      event.target instanceof Element &&
      (event.target.closest("input, textarea, select") || event.target.isContentEditable);
    const slash = event.key === "/" && !event.metaKey && !event.ctrlKey && !editing;
    if (!commandK && !slash) return;
    if (document.querySelector("dialog[open]") && !dialog.open) return;
    event.preventDefault();
    openSearch();
  });
})();
