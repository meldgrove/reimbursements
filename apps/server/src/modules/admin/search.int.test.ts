import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../db/client";
import { claims, formOwners, forms, type Claim, type FormTemplate, type User } from "../../db/schema";
import { FORM_EDITOR, TEMPLATE_ADMIN } from "../../auth/roles";
import { createClaim, createForm, template as testTemplate } from "../../test/fixtures";
import { createUser, request, resetDatabase, signInWithTestHeader } from "../../test/helpers";

/** The search cases of tests/test_admin.py. */
let restore: () => void;
let admin: User;
let editor: User;
let template: FormTemplate;
let accepted: Claim;

beforeAll(() => {
  restore = signInWithTestHeader();
});
afterAll(() => restore());

beforeEach(async () => {
  await resetDatabase();
  admin = await createUser("admin", [TEMPLATE_ADMIN]);
  editor = await createUser("editor", [FORM_EDITOR]);
  template = await testTemplate();
  accepted = await createClaim(await createForm());
});

const results = async (user: User, query: string) => {
  const response = await request("GET", `/api/v1/admin/search?q=${encodeURIComponent(query)}`, { user });
  expect(response.status).toBe(200);
  return response.body;
};

describe("search", () => {
  it("finds only what the person may open", async () => {
    expect(await results(editor, "Alex")).toEqual([]);
    expect(await results(editor, template.name.slice(0, 6))).toEqual([]);
    await getDb().insert(formOwners).values({ formId: accepted.formId, userId: editor.id });
    expect(await results(editor, "Alex")).toEqual([
      {
        href: `/admin/claims/${accepted.id}`,
        title: "Alex Beispiel",
        reference: accepted.bookkeepingReference ?? accepted.id.slice(0, 8),
        kind: "Claim",
      },
    ]);
    expect(await results(editor, accepted.id.slice(0, 8))).toEqual([]);
    expect((await results(editor, accepted.id)).map((result: { title: string }) => result.title)).toEqual([
      "Alex Beispiel",
    ]);
    // The frame finds the pages itself, in the sidebar.
    expect((await results(editor, "Forms")).map((result: { href: string }) => result.href)).not.toContain(
      "/admin/forms",
    );
    expect(await results(editor, "a")).toEqual([]);
  });

  it("finds templates for template admins", async () => {
    expect(await results(admin, template.name.slice(0, 6))).toEqual([
      { href: `/admin/templates/${template.id}`, title: template.name, reference: "", kind: "Template" },
    ]);
  });

  it("finds archived claims and forms and marks them", async () => {
    await getDb().update(claims).set({ archivedAt: accepted.submittedAt }).where(eq(claims.id, accepted.id));
    await getDb().update(forms).set({ status: "archived" }).where(eq(forms.id, accepted.formId));
    expect((await results(admin, "Alex")).map((result: { kind: string }) => result.kind)).toEqual([
      "Archived",
    ]);
    expect((await results(admin, "Workshop")).map((result: { kind: string }) => result.kind)).toEqual([
      "Archived",
    ]);
    const page = await request("GET", "/api/v1/admin/search/all?q=Alex", { user: admin });
    expect(page.body[0].items[0].detail).toBe(
      `Test Workshop · ${accepted.bookkeepingReference ?? accepted.id} · Archived`,
    );
  });

  it("lists every result on the search page, matching pages first", async () => {
    const page = await request("GET", "/api/v1/admin/search/all?q=Beispiel", { user: admin });
    expect(page.body).toEqual([
      {
        label: "Claims",
        items: [
          expect.objectContaining({
            name: "Alex Beispiel",
            url: `/admin/claims/${accepted.id}`,
            kind: "Claim",
          }),
        ],
      },
    ]);
    expect((await request("GET", "/api/v1/admin/search/all?q=zzz", { user: admin })).body).toEqual([]);
    const pages = await request("GET", "/api/v1/admin/search/all?q=privacy", { user: admin });
    expect(pages.body[0]).toEqual({
      label: "Pages",
      items: [{ name: "Privacy notice", detail: "Page", url: "/admin/privacy-notice", kind: "Page" }],
    });
    const editorPages = await request("GET", "/api/v1/admin/search/all?q=privacy", { user: editor });
    expect(editorPages.body).toEqual([]);
  });
});
