import { describe, expect, it } from "vitest";
import { breadcrumbsFor, navigationFor } from "./navigation";

describe("admin navigation", () => {
  it("shows the Admin group to template admins only, with keys for Claims and Forms", () => {
    expect(
      navigationFor({ isTemplateAdmin: false }).flatMap((group) => group.items.map((item) => item.label)),
    ).toEqual(["Claims", "Forms"]);
    const groups = navigationFor({ isTemplateAdmin: true });
    expect(groups[1]?.label).toBe("Admin");
    expect(groups[1]?.items.map((item) => item.label)).toEqual([
      "General",
      "Email",
      "Appearance",
      "Templates",
      "Privacy notice",
      "Updates",
    ]);
    const shortcuts = groups.flatMap((group) => group.items).filter((item) => item.shortcut);
    expect(shortcuts.map((item) => [item.label, item.shortcut])).toEqual([
      ["Claims", "o"],
      ["Forms", "f"],
    ]);
  });

  it("names the place of a page in its breadcrumbs", () => {
    const items = navigationFor({ isTemplateAdmin: true }).flatMap((group) =>
      group.items.map((item) => ({ label: item.label, href: item.to })),
    );
    expect(breadcrumbsFor("/admin/claims", { items })).toEqual([{ label: "Claims" }]);
    expect(breadcrumbsFor("/admin/claims/abc", { items, record: "R-2026-0001" })).toEqual([
      { label: "Claims", href: "/admin/claims" },
      { label: "R-2026-0001" },
    ]);
    expect(breadcrumbsFor("/admin/forms/new", { items })).toEqual([
      { label: "Forms", href: "/admin/forms" },
      { label: "New" },
    ]);
    expect(breadcrumbsFor("/admin/settings", { items })).toEqual([{ label: "Settings" }]);
  });
});
