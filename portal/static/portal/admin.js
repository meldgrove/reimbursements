// Admin pages: the filter popovers of the lists and the messages that fade out.
"use strict";

(() => {
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
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("dialog[open]")) return;
    const open = popovers.find((popover) => popover.open);
    if (!open) return;
    open.open = false;
    open.querySelector("summary")?.focus();
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
})();
