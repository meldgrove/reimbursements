// The person's Appearance, as in every Meldgrove app (@meldgrove/ui's theme): light, dark
// or as the device is set, kept in this browser under "meldgrove.theme". The shared
// colors (vendor/tokens.css in ui.css) and the update button turn dark with the class
// "dark" on <html>: this script sets it before the page shows (loaded in <head>, not
// deferred) and follows changes. An inline script would need an exception in the
// Content Security Policy.
"use strict";

(() => {
  const KEY = "meldgrove.theme";
  const EVENT = "meldgrove:theme";
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  // The choice when the browser refuses storage (some private windows): it lasts for this page.
  let unsaved = "system";

  function read() {
    try {
      const stored = window.localStorage.getItem(KEY);
      return stored === "light" || stored === "dark" ? stored : "system";
    } catch {
      return unsaved;
    }
  }

  function apply() {
    const preference = read();
    const dark = preference === "dark" || (preference === "system" && media.matches);
    document.documentElement.classList.toggle("dark", dark);
  }

  // For the user menu and the settings page (frame.js).
  window.meldgroveTheme = {
    read,
    set(preference) {
      try {
        if (preference === "system") window.localStorage.removeItem(KEY);
        else window.localStorage.setItem(KEY, preference);
      } catch {
        unsaved = preference;
      }
      window.dispatchEvent(new Event(EVENT));
    },
  };

  apply();
  media.addEventListener("change", apply);
  window.addEventListener(EVENT, apply);
  // Another tab of the app changed it.
  window.addEventListener("storage", (event) => {
    if (event.key === KEY || event.key === null) apply();
  });
})();
