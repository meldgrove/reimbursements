import type { MeUser } from "@reimbursements/shared/api/meta";

/**
 * The admin area's sidebar (portal/admin_navigation.py of the Django
 * version): Claims and Forms for everyone in the admin area, the Admin group
 * for template admins. "G then O" opens Claims (the start page), "G then F"
 * Forms; admin pages have no key.
 */
export type NavItem = { label: string; to: string; shortcut?: string };
export type NavGroup = { label?: string; items: NavItem[] };

export const START_PATH = "/admin/claims";
/** The person's own settings (appearance, keyboard shortcuts, account), outside the sidebar. */
export const SETTINGS_PATH = "/admin/settings";

export function navigationFor(me: Pick<MeUser, "isTemplateAdmin">): NavGroup[] {
  const groups: NavGroup[] = [
    {
      items: [
        { label: "Claims", to: "/admin/claims", shortcut: "o" },
        { label: "Forms", to: "/admin/forms", shortcut: "f" },
      ],
    },
  ];
  if (me.isTemplateAdmin) {
    groups.push({
      label: "Admin",
      items: [
        { label: "General", to: "/admin/general" },
        { label: "Appearance", to: "/admin/appearance" },
        { label: "Templates", to: "/admin/templates" },
        { label: "Privacy notice", to: "/admin/privacy-notice" },
        { label: "Updates", to: "/admin/updates" },
      ],
    });
  }
  return groups;
}

export type Crumb = { label: string; href?: string };

/** Labels of the pages below a sidebar item. */
const SUB_PAGES: Record<string, string> = { new: "New", delete: "Delete" };
/** Labels of the pages below a record, e.g. Claims › R-2026-0001 › Process again. */
const RECORD_PAGES: Record<string, string> = { retry: "Process again" };
/** The search's page with every result. */
export const SEARCH_PATH = "/admin/search";

/**
 * Where a page sits: the sidebar item it belongs to, then the record by its
 * name (until its page has loaded it, "Details"), or "New".
 */
export function breadcrumbsFor(
  pathname: string,
  options: { items: { label: string; href: string }[]; record?: string },
): Crumb[] {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (path === SETTINGS_PATH) return [{ label: "Settings" }];
  if (path === SEARCH_PATH) return [{ label: "Search" }];
  const item = options.items
    .filter((candidate) => path === candidate.href || path.startsWith(`${candidate.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
  if (!item) return [];
  if (path === item.href) return [{ label: item.label }];
  const parent = { label: item.label, href: item.href };
  const [first, second] = path.slice(item.href.length + 1).split("/");
  if (first && SUB_PAGES[first]) return [parent, { label: SUB_PAGES[first]! }];
  const record = { label: options.record ?? "Details" };
  if (second && RECORD_PAGES[second])
    return [parent, { ...record, href: `${item.href}/${first}` }, { label: RECORD_PAGES[second]! }];
  return [parent, record];
}
