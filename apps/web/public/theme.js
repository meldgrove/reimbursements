// The person's Appearance, as in every Meldgrove app (@meldgrove/ui's theme): light, dark
// or as the device is set, kept in this browser under "meldgrove.theme". Sets the class
// "dark" on <html> before the page shows; React's useThemePreference takes over after.
"use strict";
(function () {
  var preference = "system";
  try {
    var stored = window.localStorage.getItem("meldgrove.theme");
    if (stored === "light" || stored === "dark") preference = stored;
  } catch {
    // Some private windows refuse storage: the device setting applies.
  }
  var dark =
    preference === "dark" ||
    (preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
})();
