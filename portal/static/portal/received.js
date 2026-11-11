"use strict";
(() => {
  const target = document.getElementById("processing-status");
  const text = JSON.parse(document.getElementById("status-text").textContent);
  // Participants see three outcomes; the detailed states stay internal.
  const messages = {
    delivered: text.delivered,
    delivery_failed: text.problem,
    processing_failed: text.problem,
  };
  function show(state) {
    target.textContent = messages[state] || text.processing;
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
      target.textContent = text.unavailable;
    } finally {
      clearTimeout(deadline);
    }
    if (++polls < 120) {
      const delay = document.hidden
        ? 30000
        : Math.min(30000, 5000 * 1.1 ** polls);
      setTimeout(refresh, delay + Math.random() * 1000);
    } else {
      target.textContent += ` ${text.reload}`;
    }
  }
  if (target.dataset.final !== "true") setTimeout(refresh, 3000);
})();
