// The frame of every Meldgrove app (@meldgrove/ui's AppFrame) for the server-rendered
// admin pages (admin/base.html): the sidebar (a sheet on phones), the user menu with
// Appearance, the search, the keyboard shortcuts and the person's settings page.
//
// Keys, as in the package: ⌘K or Ctrl+K and "/" search, "G then a letter" opens a main
// page, Ctrl+/ lists the shortcuts, ⌘B or Ctrl+B shows or hides the sidebar. Single
// letters ("G then …", "/") can be turned off on the settings page (WCAG 2.1.4); the
// choice is kept in this browser under "meldgrove.shortcuts".
"use strict";

(() => {
  const root = document.documentElement;
  const apple = /Mac|iPhone|iPad/.test(navigator.userAgent);
  const phone = window.matchMedia("(max-width: 767px)");
  const sidebar = document.querySelector("[data-frame-sidebar]");
  const container = sidebar?.querySelector("[data-sidebar-container]");
  const theme = window.meldgroveTheme;

  // ⌘ on Apple devices, Ctrl elsewhere; the overview (Ctrl+/) is Ctrl everywhere.
  document.querySelectorAll("[data-mod]").forEach((key) => {
    key.textContent = apple ? "⌘" : "Ctrl";
  });
  document.querySelectorAll("[data-search-key]").forEach((key) => {
    key.textContent = apple ? "⌘K" : "Ctrl K";
  });

  // Shortcuts with single letters, on unless turned off in this browser.
  const SHORTCUTS_KEY = "meldgrove.shortcuts";
  const SHORTCUTS_EVENT = "meldgrove:shortcuts";
  let unsavedShortcuts = true;
  function singleKeys() {
    try {
      return window.localStorage.getItem(SHORTCUTS_KEY) !== "off";
    } catch {
      return unsavedShortcuts;
    }
  }
  function setSingleKeys(enabled) {
    try {
      if (enabled) window.localStorage.removeItem(SHORTCUTS_KEY);
      else window.localStorage.setItem(SHORTCUTS_KEY, "off");
    } catch {
      unsavedShortcuts = enabled;
    }
    window.dispatchEvent(new Event(SHORTCUTS_EVENT));
  }

  // In fields and editors, letters are typing, not shortcuts.
  function isTyping(target) {
    return (
      target instanceof Element &&
      ((target instanceof HTMLElement && target.isContentEditable) ||
        target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']") !== null)
    );
  }
  // A dialog or menu is open: its keys win.
  function layerOpen() {
    return document.querySelector("dialog[open], [role='menu'][data-state='open']") !== null;
  }
  function plain(event) {
    return !event.defaultPrevented && !event.isComposing && !event.altKey;
  }

  // Dialogs: the search and the shortcuts. Focus returns to where it was, or to the page
  // when that is gone (a closed phone sheet or menu), as the package's frame does.
  function openDialog(dialog, onOpen) {
    if (!dialog || dialog.open) return;
    const previous = document.activeElement;
    dialog.addEventListener(
      "close",
      () => {
        delete dialog.dataset.state;
        const gone =
          !(previous instanceof HTMLElement) ||
          previous === document.body ||
          !previous.isConnected ||
          previous.closest("[hidden]") !== null ||
          (phone.matches && root.dataset.sidebarOpen !== "true" && container?.contains(previous));
        if (!gone) previous.focus();
        if (gone || document.activeElement !== previous) document.getElementById("main")?.focus();
      },
      { once: true },
    );
    closeMenus(false);
    if (root.dataset.sidebarOpen === "true") setSheet(false);
    dialog.showModal();
    dialog.dataset.state = "open";
    onOpen?.();
  }
  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.querySelectorAll("[data-dialog-close]").forEach((button) => {
      button.addEventListener("click", () => dialog.close());
    });
  });

  // The sidebar: hidden completely when folded (cookie "sidebar_state", as the package
  // keeps it), a sheet on phones that closes once a page is chosen.
  function setFolded(folded) {
    sidebar.dataset.state = folded ? "collapsed" : "expanded";
    sidebar.dataset.collapsible = folded ? "offcanvas" : "";
    document.cookie = `sidebar_state=${!folded}; path=/; max-age=${60 * 60 * 24 * 7}; SameSite=Lax`;
    syncTriggers();
  }
  function setSheet(open) {
    const inside = container?.contains(document.activeElement);
    root.dataset.sidebarOpen = String(open);
    root.classList.toggle("overflow-hidden", open);
    syncTriggers();
    if (open) container?.querySelector("a, button")?.focus();
    // Closed, the sheet's controls are hidden: keep the focus on the header's toggle.
    else if (inside) document.querySelector("[data-sidebar-trigger]")?.focus();
  }
  function syncTriggers() {
    const open = phone.matches ? root.dataset.sidebarOpen === "true" : sidebar?.dataset.state === "expanded";
    document.querySelectorAll("[data-sidebar-trigger]").forEach((trigger) => {
      trigger.setAttribute("aria-expanded", String(open));
    });
  }
  function toggleSidebar() {
    if (!sidebar) return;
    const inside = container?.contains(document.activeElement);
    closeMenus(false);
    if (phone.matches) setSheet(root.dataset.sidebarOpen !== "true");
    else setFolded(sidebar.dataset.state === "expanded");
    // Folded, the sidebar's controls are hidden: keep the focus on the header's toggle.
    if (inside && sidebar.dataset.state === "collapsed" && !phone.matches) {
      document.querySelector("[data-sidebar-trigger]")?.focus();
    }
  }
  document.querySelectorAll("[data-sidebar-trigger], [data-sidebar-rail]").forEach((button) => {
    button.addEventListener("click", toggleSidebar);
  });
  document.querySelectorAll("[data-sidebar-close]").forEach((overlay) => {
    overlay.addEventListener("click", () => setSheet(false));
  });
  container?.querySelectorAll("a[href]").forEach((link) => {
    link.addEventListener("click", () => {
      if (phone.matches) setSheet(false);
    });
  });
  phone.addEventListener("change", () => {
    if (!phone.matches && root.dataset.sidebarOpen === "true") setSheet(false);
    syncTriggers();
  });
  // The sheet keeps the focus inside while it is open.
  container?.addEventListener("keydown", (event) => {
    if (event.key !== "Tab" || root.dataset.sidebarOpen !== "true" || !phone.matches) return;
    const focusable = Array.from(container.querySelectorAll("a[href], button:not([disabled])")).filter(
      (element) => element.offsetParent !== null && !element.closest("[hidden]") && element.tabIndex >= 0,
    );
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  });
  syncTriggers();

  document.querySelector("[data-skip-link]")?.addEventListener("click", (event) => {
    // Focus only: the address stays as it is.
    event.preventDefault();
    document.getElementById("main")?.focus();
  });

  // The user menu (a dropdown menu) and its Appearance submenu.
  const menuTrigger = document.querySelector("[data-menu-trigger]");
  const menu = document.getElementById(menuTrigger?.getAttribute("aria-controls") || "");
  const subTrigger = menu?.querySelector("[data-submenu-trigger]");
  const submenu = document.getElementById(subTrigger?.getAttribute("aria-controls") || "");

  function itemsOf(list) {
    return Array.from(list.querySelectorAll("[role^='menuitem']")).filter((item) => item.closest("[role='menu']") === list);
  }
  function showMenu(list, opener, focus) {
    list.hidden = false;
    list.dataset.state = "open";
    opener.setAttribute("aria-expanded", "true");
    const items = itemsOf(list);
    if (focus === "first") items[0]?.focus();
    else if (focus === "last") items.at(-1)?.focus();
    else if (focus === "checked") (items.find((item) => item.getAttribute("aria-checked") === "true") || items[0])?.focus();
    else if (focus !== "none") list.focus();
  }
  function hideMenu(list, opener) {
    if (!list || list.hidden) return;
    list.hidden = true;
    delete list.dataset.state;
    opener?.setAttribute("aria-expanded", "false");
  }
  function closeMenus(returnFocus) {
    if (!menu || menu.hidden) return;
    hideMenu(submenu, subTrigger);
    hideMenu(menu, menuTrigger);
    if (returnFocus) menuTrigger.focus();
  }
  function moveFocus(list, event) {
    const items = itemsOf(list);
    const index = items.indexOf(document.activeElement);
    let next = null;
    if (event.key === "ArrowDown") next = items[Math.min(index + 1, items.length - 1)] || items[0];
    else if (event.key === "ArrowUp") next = index === -1 ? items.at(-1) : items[Math.max(index - 1, 0)];
    else if (event.key === "Home") next = items[0];
    else if (event.key === "End") next = items.at(-1);
    if (!next) return false;
    event.preventDefault();
    next.focus();
    return true;
  }
  function syncThemeChoices() {
    const preference = theme?.read() || "system";
    document.querySelectorAll("[data-theme-option]").forEach((option) => {
      option.setAttribute("aria-checked", String(option.dataset.themeOption === preference));
    });
    document.querySelectorAll("[data-theme-choice] input").forEach((input) => {
      input.checked = input.value === preference;
    });
  }

  if (menu && menuTrigger) {
    menuTrigger.addEventListener("click", () => {
      if (menu.hidden) showMenu(menu, menuTrigger, null);
      else closeMenus(true);
    });
    menuTrigger.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        showMenu(menu, menuTrigger, event.key === "ArrowDown" ? "first" : "last");
      }
    });
    menu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenus(true);
      } else if (event.key === "Tab") {
        closeMenus(false);
      } else if (submenu && !submenu.hidden && submenu.contains(document.activeElement)) {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          hideMenu(submenu, subTrigger);
          subTrigger.focus();
        } else {
          moveFocus(submenu, event);
        }
      } else if (event.target === subTrigger && ["ArrowRight", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        showMenu(submenu, subTrigger, "checked");
      } else {
        moveFocus(menu, event);
      }
    });
    // A click opens the submenu, also when hovering opened it already.
    subTrigger?.addEventListener("click", () => showMenu(submenu, subTrigger, "checked"));
    subTrigger?.addEventListener("pointerenter", () => {
      if (submenu.hidden) showMenu(submenu, subTrigger, "none");
    });
    itemsOf(menu).forEach((item) => {
      if (item !== subTrigger) item.addEventListener("pointerenter", () => hideMenu(submenu, subTrigger));
    });
    submenu?.querySelectorAll("[data-theme-option]").forEach((option) => {
      option.addEventListener("click", () => {
        theme?.set(option.dataset.themeOption);
        closeMenus(true);
      });
    });
    document.addEventListener("pointerdown", (event) => {
      if (!menu.hidden && !menu.contains(event.target) && !menuTrigger.contains(event.target)) closeMenus(false);
    });
  }
  window.addEventListener("meldgrove:theme", syncThemeChoices);
  window.addEventListener("storage", syncThemeChoices);
  syncThemeChoices();

  // The person's settings page: Appearance and the single-letter shortcuts.
  document.querySelectorAll("[data-theme-choice] input").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) theme?.set(input.value);
    });
  });
  const singleKeysSwitch = document.querySelector("[data-single-keys-switch]");
  singleKeysSwitch?.addEventListener("click", () => setSingleKeys(!singleKeys()));

  // The shortcuts overview.
  const shortcutsDialog = document.querySelector("[data-shortcuts-dialog]");
  function syncSingleKeys() {
    const enabled = singleKeys();
    singleKeysSwitch?.setAttribute("aria-checked", String(enabled));
    document.querySelectorAll("[data-single-key]").forEach((row) => row.classList.toggle("opacity-50", !enabled));
    document.querySelectorAll("[data-single-keys-on]").forEach((text) => (text.hidden = !enabled));
    document.querySelectorAll("[data-single-keys-off]").forEach((text) => (text.hidden = enabled));
  }
  function openShortcuts() {
    openDialog(shortcutsDialog);
  }
  window.addEventListener(SHORTCUTS_EVENT, syncSingleKeys);
  window.addEventListener("storage", (event) => {
    if (event.key === SHORTCUTS_KEY || event.key === null) syncSingleKeys();
  });
  syncSingleKeys();
  document.querySelectorAll("[data-shortcuts-open]").forEach((button) => {
    button.addEventListener("click", () => {
      closeMenus(false);
      openShortcuts();
    });
  });

  // "G then a letter": the main pages of the sidebar.
  const targets = Array.from(document.querySelectorAll("[data-frame-nav] a[data-shortcut]")).map((link) => ({
    key: link.dataset.shortcut.toLowerCase(),
    href: link.href,
  }));
  const goHint = document.querySelector("[data-go-hint]");
  const GO_WAIT_MS = 1500;
  let waiting = false;
  let waitTimer;
  function stopWaiting() {
    window.clearTimeout(waitTimer);
    if (!waiting) return;
    waiting = false;
    if (goHint) goHint.hidden = true;
  }

  // The search: the sidebar's pages and, from the server, claims, forms and templates.
  const search = setupSearch();

  document.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    if (plain(event) && (event.metaKey || event.ctrlKey) && !event.shiftKey && key === "k") {
      if (!search || search.isOpen() || layerOpen()) return;
      event.preventDefault();
      stopWaiting();
      search.open();
      return;
    }
    if (plain(event) && event.ctrlKey && !event.metaKey && event.key === "/") {
      if (layerOpen()) return;
      event.preventDefault();
      stopWaiting();
      openShortcuts();
      return;
    }
    if (plain(event) && (event.metaKey || event.ctrlKey) && key === "b") {
      event.preventDefault();
      toggleSidebar();
      return;
    }
    if (event.key === "Escape" && root.dataset.sidebarOpen === "true" && !layerOpen()) {
      setSheet(false);
      document.querySelector("[data-sidebar-trigger]")?.focus();
      return;
    }
    if (!singleKeys()) return;
    const typing = isTyping(event.target);
    if (plain(event) && !event.metaKey && !event.ctrlKey && event.key === "/" && !typing) {
      if (!search || layerOpen()) return;
      event.preventDefault();
      stopWaiting();
      search.open();
      return;
    }
    const letter =
      plain(event) && !event.ctrlKey && !event.metaKey && !event.repeat && !typing && /^[a-z]$/i.test(event.key)
        ? key
        : null;
    if (letter === null || layerOpen()) {
      stopWaiting();
      return;
    }
    if (waiting) {
      stopWaiting();
      const target = targets.find((candidate) => candidate.key === letter);
      if (target) {
        event.preventDefault();
        window.location.assign(target.href);
      }
      return;
    }
    if (letter === "g" && targets.length) {
      event.preventDefault();
      waiting = true;
      if (goHint) goHint.hidden = false;
      waitTimer = window.setTimeout(stopWaiting, GO_WAIT_MS);
    }
  });

  function setupSearch() {
    const dialog = document.querySelector("[data-search-dialog]");
    if (!dialog) return null;
    const form = dialog.querySelector("[data-search-form]");
    const input = dialog.querySelector("[data-search-input]");
    const list = dialog.querySelector("[data-search-results]");
    const status = dialog.querySelector("[data-search-status]");
    const allResults = dialog.querySelector("[data-search-all]");
    const keyboardIcon = document.getElementById("search-shortcuts-icon");
    const pages = Array.from(document.querySelectorAll("[data-frame-nav] a")).map((link) => ({
      label: link.textContent.trim(),
      href: link.href,
      shortcut: link.dataset.shortcut || "",
      group: link.closest("[data-group]")?.dataset.group || "",
    }));
    let found = null; // { term, results } once the server answered for a term
    let controller = null;
    let timer;
    let options = [];
    let active = -1;

    function setStatus(text) {
      status.textContent = text || "";
      status.classList.toggle("sr-only", !text);
      status.classList.toggle("py-6", Boolean(text));
    }
    function select(index) {
      active = index;
      options.forEach((option, position) => option.setAttribute("aria-selected", String(position === index)));
      const option = options[index];
      if (option) {
        input.setAttribute("aria-activedescendant", option.id);
        option.scrollIntoView({ block: "nearest" });
      } else {
        input.removeAttribute("aria-activedescendant");
      }
    }
    function group(heading, items) {
      const element = document.createElement("div");
      element.className = "frame-command-group";
      element.setAttribute("role", "group");
      const label = document.createElement("div");
      label.className = "frame-command-heading";
      label.id = `search-heading-${heading.toLowerCase()}`;
      label.textContent = heading;
      element.setAttribute("aria-labelledby", label.id);
      element.append(label, ...items);
      return element;
    }
    function option(content, onChoose, className = "") {
      const element = document.createElement("div");
      element.id = `search-option-${options.length}`;
      element.className = `frame-command-item ${className}`.trim();
      element.setAttribute("role", "option");
      element.setAttribute("aria-selected", "false");
      element.append(...content);
      const index = options.length;
      element.addEventListener("pointermove", () => {
        if (active !== index) select(index);
      });
      element.addEventListener("click", onChoose);
      element.choose = onChoose;
      options.push(element);
      return element;
    }
    function span(className, text) {
      const element = document.createElement("span");
      element.className = className;
      element.textContent = text;
      return element;
    }
    function go(href) {
      dialog.close();
      window.location.assign(href);
    }

    function render() {
      const term = input.value.trim();
      const lower = term.toLowerCase();
      const ready = found?.term === term;
      const results = term && ready ? found.results : undefined;
      const matching = pages.filter((page) => page.label.toLowerCase().includes(lower));
      options = [];
      const groups = [];
      if (results?.length) {
        groups.push(
          group(
            "Results",
            results.map((result) => {
              const parts = [];
              if (result.reference) {
                const reference = span("w-16 shrink-0 truncate text-xs text-muted-foreground tabular-nums", result.reference);
                reference.title = result.reference;
                parts.push(reference);
              }
              parts.push(span("min-w-0 flex-1 truncate", result.title));
              if (result.kind) parts.push(span("ui-badge ui-badge-outline shrink-0 font-normal", result.kind));
              return option(parts, () => go(result.href), "gap-3");
            }),
          ),
        );
      }
      if (matching.length) {
        groups.push(
          group(
            "Pages",
            matching.map((page) => {
              const parts = [document.createTextNode(page.label)];
              if (page.group && pages.filter((other) => other.label === page.label).length > 1) {
                parts.push(span("text-xs text-muted-foreground", page.group));
              }
              if (singleKeys() && page.shortcut) {
                parts.push(span("ml-auto text-xs tracking-widest text-muted-foreground", `G ${page.shortcut.toUpperCase()}`));
              }
              return option(parts, () => go(page.href));
            }),
          ),
        );
      }
      if (!term || "keyboard shortcuts".includes(lower)) {
        const parts = [];
        if (keyboardIcon) parts.push(keyboardIcon.content.cloneNode(true));
        parts.push(document.createTextNode("Keyboard shortcuts"));
        parts.push(span("ml-auto text-xs tracking-widest text-muted-foreground", "Ctrl /"));
        groups.push(
          group("Actions", [
            option(parts, () => {
              dialog.close();
              openShortcuts();
            }),
          ]),
        );
      }
      list.replaceChildren(...groups);
      allResults.hidden = !term;

      if (term && !ready) setStatus("Searching…");
      else if (results === null) setStatus("The search is not available right now. Try again.");
      else if (!matching.length && !results?.length) setStatus("Nothing found.");
      else setStatus("");
      select(options.length ? 0 : -1);
    }

    async function find(term) {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      const url = new URL(form.dataset.suggestionsUrl, window.location.origin);
      url.searchParams.set("q", term);
      try {
        const response = await fetch(url, { headers: { "X-Requested-With": "XMLHttpRequest" }, signal });
        if (!response.ok) throw new Error(`Search answered ${response.status}`);
        const payload = await response.json();
        if (!signal.aborted) found = { term, results: payload.results || [] };
      } catch {
        if (signal.aborted) return;
        found = { term, results: null };
      }
      if (dialog.open && input.value.trim() === term) render();
    }

    input.addEventListener("input", () => {
      window.clearTimeout(timer);
      controller?.abort();
      const term = input.value.trim();
      render();
      if (term) timer = window.setTimeout(() => find(term), 200);
    });
    input.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && options.length) {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        select((active + step + options.length) % options.length);
      } else if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        options[active]?.choose();
      }
    });
    form.addEventListener("submit", (event) => {
      if (!input.value.trim()) event.preventDefault();
    });
    dialog.querySelector("[data-search-close]")?.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => {
      window.clearTimeout(timer);
      controller?.abort();
    });
    document.querySelectorAll("[data-search-trigger]").forEach((trigger) => {
      trigger.addEventListener("click", () => api.open());
    });

    const api = {
      isOpen: () => dialog.open,
      open() {
        openDialog(dialog, () => {
          input.value = "";
          found = null;
          render();
          input.focus();
        });
      },
    };
    return api;
  }
})();
