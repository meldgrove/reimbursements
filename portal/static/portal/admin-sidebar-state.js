// Runs before the first paint so a collapsed sidebar does not flash open.
try {
  document.documentElement.dataset.sidebarCollapsed = String(
    localStorage.getItem("reimbursements-sidebar-collapsed") === "true",
  );
} catch {
  document.documentElement.dataset.sidebarCollapsed = "false";
}
