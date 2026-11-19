// Dark mode follows the device's setting. The shared colors (vendor/tokens.css in
// ui.css) and the update button turn dark with the class "dark" on <html>: this script
// sets it before the page shows (loaded in <head>, not deferred) and follows changes.
// An inline script would need an exception in the Content Security Policy.
"use strict";

(() => {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => document.documentElement.classList.toggle("dark", media.matches);
  apply();
  media.addEventListener("change", apply);
})();
