"use strict";
(() => {
  const target = document.getElementById("processing-status");
  // Participants see three outcomes; the detailed states stay internal.
  const processing = "Dein Antrag wird verarbeitet und an Finance übermittelt.";
  const problem =
    "Bei der Verarbeitung ist ein Problem aufgetreten. Dein Antrag bleibt gespeichert; bitte reiche ihn nicht erneut ein, sondern melde dich mit deiner Referenz.";
  const messages = {
    delivered: "Dein Antrag wurde an Finance übermittelt.",
    delivery_failed: problem,
    processing_failed: problem,
  };
  function show(state) {
    target.textContent = messages[state] || processing;
  }
  show(target.dataset.status);
  let polls = 0;
  async function refresh() {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${window.location.pathname}?format=json`, {
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("status_unavailable");
      const result = await response.json();
      show(result.state);
      if (result.final) return;
    } catch {
      target.textContent =
        "Der Status ist gerade nicht erreichbar. Dein Antrag bleibt gespeichert; bitte reiche ihn nicht erneut ein.";
    } finally {
      clearTimeout(deadline);
    }
    if (++polls < 120) {
      const delay = document.hidden
        ? 30000
        : Math.min(30000, 5000 * 1.1 ** polls);
      setTimeout(refresh, delay + Math.random() * 1000);
    } else {
      target.textContent +=
        " Lade diese Seite später neu, um den aktuellen Status zu prüfen.";
    }
  }
  if (target.dataset.final !== "true") setTimeout(refresh, 3000);
})();
