// Admin shell: sidebar, keyboard shortcuts, popovers and messages.
(() => {
  const root = document.documentElement;
  const storageKey = "reimbursements-sidebar-collapsed";
  const platform = navigator.userAgentData?.platform || navigator.platform || "";
  const isMac = /Mac|iPhone|iPad|iPod/i.test(platform);
  const desktop = window.matchMedia("(min-width: 48rem)");
  const sidebar = document.querySelector("[data-sidebar]");
  const triggers = Array.from(document.querySelectorAll("[data-sidebar-trigger]"));
  const shortcutLinks = Array.from(
    document.querySelectorAll("[data-sidebar-navigation] [data-nav-shortcut]"),
  ).slice(0, 9);
  const toggleHint = isMac ? "⌘B" : "Strg+B";

  function updateTriggers() {
    const expanded = desktop.matches
      ? root.dataset.sidebarCollapsed !== "true"
      : root.dataset.sidebarOpen === "true";
    triggers.forEach((trigger) => {
      trigger.setAttribute("aria-expanded", String(expanded));
      trigger.title = `Seitenleiste ${expanded ? "einklappen" : "ausklappen"} (${toggleHint})`;
    });
  }

  function setCollapsed(collapsed) {
    root.dataset.sidebarCollapsed = String(collapsed);
    try {
      localStorage.setItem(storageKey, String(collapsed));
    } catch {
      // Private browsing: the state lasts for this page only.
    }
    updateTriggers();
  }

  function setOpen(open) {
    root.dataset.sidebarOpen = String(open);
    root.classList.toggle("overflow-hidden", open);
    updateTriggers();
    if (open) sidebar?.querySelector("a, button")?.focus();
  }

  function toggleSidebar() {
    if (desktop.matches) setCollapsed(root.dataset.sidebarCollapsed !== "true");
    else setOpen(root.dataset.sidebarOpen !== "true");
  }

  triggers.forEach((trigger) => trigger.addEventListener("click", toggleSidebar));
  document.querySelectorAll("[data-sidebar-close]").forEach((element) => {
    element.addEventListener("click", () => setOpen(false));
  });
  desktop.addEventListener("change", () => {
    if (desktop.matches) setOpen(false);
    updateTriggers();
  });

  shortcutLinks.forEach((link, index) => {
    link.setAttribute("aria-keyshortcuts", `Control+${index + 1}`);
    link.title = `${link.title || link.textContent.trim()} (${isMac ? "⌃" : "Strg+"}${index + 1})`;
  });

  // Popovers built on <details>: one at a time, closed by outside clicks and Escape.
  const popovers = Array.from(document.querySelectorAll("details[data-popover]"));
  popovers.forEach((popover) => {
    popover.addEventListener("toggle", () => {
      if (!popover.open) return;
      popovers.forEach((other) => {
        if (other !== popover) other.open = false;
      });
    });
  });
  document.addEventListener("click", (event) => {
    popovers.forEach((popover) => {
      if (popover.open && !popover.contains(event.target)) popover.open = false;
    });
  });

  document.querySelectorAll("[data-dismiss-after]").forEach((message) => {
    window.setTimeout(() => {
      message.classList.add("transition-opacity", "duration-300", "opacity-0");
      window.setTimeout(() => {
        const item = message.closest("li") || message;
        const list = item.parentElement;
        item.remove();
        if (list?.matches("[data-messages]") && !list.children.length) list.remove();
      }, 300);
    }, Number(message.dataset.dismissAfter));
  });

  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing) return;
    if (event.key === "Escape") {
      // An open dialog closes itself; Escape closes only the topmost layer.
      if (document.querySelector("dialog[open]")) return;
      const open = popovers.find((popover) => popover.open);
      if (open) {
        open.open = false;
        open.querySelector("summary")?.focus();
        return;
      }
      if (root.dataset.sidebarOpen === "true") {
        setOpen(false);
        triggers[0]?.focus();
      }
      return;
    }
    if (document.querySelector("dialog[open]")) return;
    if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && /^[1-9]$/.test(event.key)) {
      const link = shortcutLinks[Number(event.key) - 1];
      if (link) {
        event.preventDefault();
        link.click();
      }
      return;
    }
    // Cmd+B or Cmd+. on a Mac, Ctrl+B or Ctrl+. elsewhere.
    const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (!modifier || event.altKey || event.shiftKey) return;
    if (event.key.toLowerCase() !== "b" && event.key !== ".") return;
    event.preventDefault();
    toggleSidebar();
  });

  updateTriggers();
})();
