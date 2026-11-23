import { Hono } from "hono";
import { and, asc, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import type { SearchGroup, SearchItem } from "@reimbursements/shared/api/admin";
import { claims, formTemplates, forms, type User } from "../../db/schema";
import { q } from "../../db/tx";
import type { AppEnv } from "../../http/env";
import { requireEditor } from "../../http/middleware";
import { isTemplateAdmin, managedForms, visibleClaims } from "../../auth/roles";
import { contains } from "./common";

/**
 * The admin area's search (portal/admin_navigation.py): claims, forms and
 * templates, exactly what the person may open from the lists, also archived
 * claims and forms, which the lists leave out, marked as such. The frame
 * finds the pages itself; the full results page lists matching pages too.
 */
const router = new Hono<AppEnv>();

export const SUGGESTION_LIMIT = 5;
export const RESULT_LIMIT = 50;

/** The sidebar's pages, as the full results page finds them. */
const PAGES: { label: string; url: string; templateAdmins: boolean }[] = [
  { label: "Claims", url: "/admin/claims", templateAdmins: false },
  { label: "Forms", url: "/admin/forms", templateAdmins: false },
  { label: "General", url: "/admin/general", templateAdmins: true },
  { label: "Appearance", url: "/admin/appearance", templateAdmins: true },
  { label: "Templates", url: "/admin/templates", templateAdmins: true },
  { label: "Privacy notice", url: "/admin/privacy-notice", templateAdmins: true },
  { label: "Updates", url: "/admin/updates", templateAdmins: true },
];

/** Every word must match one of the columns (Django admin search). */
function words(term: string, match: (word: string) => SQL): SQL | undefined {
  return and(...term.split(/\s+/).filter(Boolean).map(match));
}

function claimSearch(term: string): SQL | undefined {
  const hex = term.replace(/^urn:uuid:/i, "").replace(/[{}-]/g, "");
  if (/^[0-9a-f]{32}$/i.test(hex)) {
    // A participant quotes the full reference.
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    return eq(claims.id, id.toLowerCase());
  }
  return words(term, (word) =>
    or(
      ilike(claims.fullName, contains(word)),
      ilike(claims.email, contains(word)),
      eq(claims.bookkeepingReference, word),
    )!,
  );
}

/** Groups of records matching `query`, each at most `limit` long (none for less than 2 characters). */
export async function search(user: User, query: string, limit: number): Promise<SearchGroup[]> {
  const term = query.trim().slice(0, 100);
  if (term.length < 2) return [];
  const groups: SearchGroup[] = [];
  const claimRows = await q()
    .select({ claim: claims, formName: forms.name })
    .from(claims)
    .innerJoin(forms, eq(forms.id, claims.formId))
    .where(and(await visibleClaims(user), claimSearch(term)))
    .orderBy(desc(claims.submittedAt), desc(claims.id))
    .limit(limit);
  const claimItems: SearchItem[] = claimRows.map(({ claim, formName }) => {
    const archived = claim.archivedAt !== null;
    const detail = `${formName} · ${claim.bookkeepingReference ?? claim.id}`;
    return {
      name: claim.fullName || "Claim",
      detail: archived ? `${detail} · Archived` : detail,
      reference: claim.bookkeepingReference ?? claim.id.slice(0, 8),
      kind: archived ? "Archived" : "Claim",
      url: `/admin/claims/${claim.id}`,
    };
  });
  if (claimItems.length) groups.push({ label: "Claims", items: claimItems });
  const formRows = await q()
    .select()
    .from(forms)
    .where(
      and(
        await managedForms(user),
        words(term, (word) => or(ilike(forms.name, contains(word)), ilike(forms.slug, contains(word)))!),
      ),
    )
    .orderBy(asc(forms.name), asc(forms.id))
    .limit(limit);
  const formItems: SearchItem[] = formRows.map((form) => {
    const archived = form.status === "archived";
    const detail = `/f/${form.slug}/`;
    return {
      name: form.name,
      detail: archived ? `${detail} · Archived` : detail,
      kind: archived ? "Archived" : "Form",
      url: `/admin/forms/${form.id}`,
    };
  });
  if (formItems.length) groups.push({ label: "Forms", items: formItems });
  if (await isTemplateAdmin(user)) {
    const templateRows = await q()
      .select()
      .from(formTemplates)
      .where(
        words(term, (word) =>
          or(ilike(formTemplates.name, contains(word)), ilike(formTemplates.description, contains(word)))!,
        ),
      )
      .orderBy(asc(formTemplates.name))
      .limit(limit);
    const templateItems: SearchItem[] = templateRows.map((template) => ({
      name: template.name,
      detail: template.description.split(/\r\n|\r|\n/)[0] ?? "",
      kind: "Template",
      url: `/admin/templates/${template.id}`,
    }));
    if (templateItems.length) groups.push({ label: "Templates", items: templateItems });
  }
  return groups;
}

/** The records for the frame's search; it finds the pages itself, in the sidebar. */
router.get("/admin/search", async (c) => {
  const user = await requireEditor(c);
  const groups = await search(user, c.req.query("q") ?? "", SUGGESTION_LIMIT);
  return c.json(
    groups.flatMap((group) =>
      group.items.map((item) => ({
        href: item.url,
        title: item.name,
        reference: item.reference ?? "",
        kind: item.kind,
      })),
    ),
  );
});

/** Every result of a query, matching pages first (the search page). */
router.get("/admin/search/all", async (c) => {
  const user = await requireEditor(c);
  const query = c.req.query("q") ?? "";
  const term = query.trim().slice(0, 100);
  if (term.length < 2) return c.json([]);
  const templateAdmin = await isTemplateAdmin(user);
  const needle = term.toLocaleLowerCase("en");
  const pages: SearchItem[] = PAGES.filter(
    (page) => (templateAdmin || !page.templateAdmins) && page.label.toLocaleLowerCase("en").includes(needle),
  ).map((page) => ({ name: page.label, detail: "Page", url: page.url, kind: "Page" }));
  const groups = await search(user, term, RESULT_LIMIT);
  return c.json([
    ...(pages.length ? [{ label: "Pages", items: pages }] : []),
    ...groups,
  ] satisfies SearchGroup[]);
});

export default router;
