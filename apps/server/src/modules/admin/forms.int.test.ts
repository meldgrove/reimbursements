import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { overrideConfigForTests } from "../../config";
import { getDb } from "../../db/client";
import { formOwners, forms, privacyNotices, type Form, type FormTemplate, type User } from "../../db/schema";
import { FORM_EDITOR, TEMPLATE_ADMIN } from "../../auth/roles";
import { isOpen, withTemplate } from "../../models";
import { saveSettings } from "../../services/app-settings";
import { createClaim, createForm, template as testTemplate } from "../../test/fixtures";
import { TEST_DATABASE_URL } from "../../test/env";
import { createUser, request, resetDatabase, signInWithTestHeader } from "../../test/helpers";

/**
 * The forms of the admin area: the form cases of tests/test_admin.py, and
 * test_admin_shows_and_reads_dates_in_the_app_date_format of
 * tests/test_general_settings.py.
 */
let restore: () => void;
let admin: User;
let editor: User;
let template: FormTemplate;

beforeAll(() => {
  restore = signInWithTestHeader();
});
afterAll(() => restore());

beforeEach(async () => {
  await resetDatabase();
  admin = await createUser("admin", [TEMPLATE_ADMIN]);
  editor = await createUser("editor", [FORM_EDITOR]);
  template = await testTemplate();
});

const reload = async (form: Form) => (await getDb().select().from(forms).where(eq(forms.id, form.id)))[0]!;
const formCount = async () => (await getDb().select().from(forms)).length;
const own = (form: Form, user: User) =>
  getDb().insert(formOwners).values({ formId: form.id, userId: user.id });

/** The editor's settings of `form` with changes (Django's form_settings of test_admin). */
function formSettings(form: Form, changes: Record<string, unknown> = {}) {
  return {
    name: form.name,
    slug: form.slug,
    values: { kst: form.fieldValues.kst ?? "", ktr: form.fieldValues.ktr ?? "" },
    recipient: form.recipient,
    supportEmail: form.supportEmail,
    ...changes,
  };
}

describe("creating forms", () => {
  it("creates a form from a template, publishing once the internal values are complete", async () => {
    const page = await request("GET", `/api/v1/admin/forms/new?template=${template.id}`, { user: admin });
    expect(page.status).toBe(200);
    expect(page.body.template.fields.map((field: { label: string }) => field.label)).toContain(
      "Kostenstelle (KST)",
    );
    expect(page.body.recipients).toEqual(["finance@example.invalid"]);
    // One approved inbox: preselected. The contact is the creator.
    expect(page.body.settings.recipient).toBe("finance@example.invalid");
    expect(page.body.settings.supportEmail).toBe("admin@example.invalid");
    const data = {
      name: "Werkstatt Herbst",
      slug: "werkstatt-herbst",
      values: { kst: "", ktr: "4711" },
      recipient: "finance@example.invalid",
      supportEmail: "team@example.invalid",
      purposeOptions: "Teilnahme\nMitwirkung",
      action: "publish",
    };
    const refused = await request("POST", `/api/v1/admin/forms?template=${template.id}`, {
      user: admin,
      body: data,
    });
    expect(refused.status).toBe(422);
    expect(await formCount()).toBe(0);
    const response = await request("POST", `/api/v1/admin/forms?template=${template.id}`, {
      user: admin,
      body: { ...data, values: { kst: "1234", ktr: "4711" } },
    });
    expect(response.status).toBe(201);
    const [form] = await getDb().select().from(forms);
    expect(form!.templateId).toBe(template.id);
    expect(form!.fieldValues).toEqual({ kst: "1234", ktr: "4711" });
    const ownerRows = await getDb().select().from(formOwners).where(eq(formOwners.formId, form!.id));
    expect(ownerRows.map((row) => row.userId)).toEqual([admin.id]);
  });

  it("refuses inboxes that are not approved", async () => {
    const response = await request("POST", `/api/v1/admin/forms?template=${template.id}`, {
      user: admin,
      body: {
        name: "Werkstatt",
        slug: "werkstatt",
        values: { kst: "1234" },
        recipient: "attacker@example.invalid",
        supportEmail: "team@example.invalid",
      },
    });
    expect(response.status).toBe(422);
    expect(response.body.error.fields.recipient).toContain("not one of the available choices");
    expect(await formCount()).toBe(0);
  });

  it("saves new forms as incomplete drafts", async () => {
    const page = await request("GET", `/api/v1/admin/forms/new?template=${template.id}`, { user: admin });
    expect(page.body.form).toBeNull();
    expect(page.body.settings).not.toHaveProperty("status");
    expect(page.body.settings).not.toHaveProperty("owners");
    const response = await request("POST", `/api/v1/admin/forms?template=${template.id}`, {
      user: admin,
      body: { instructions: "Erste Notiz" },
    });
    expect(response.status).toBe(201);
    const [form] = await getDb().select().from(forms);
    expect(form!.status).toBe("draft");
    expect(form!.instructions).toBe("Erste Notiz");
    expect(form!.name).toBe("New form");
    expect(form!.slug).toBeTruthy();
    expect(form!.fieldValues).toEqual({ kst: "", ktr: "" });
    expect(response.body).toMatchObject({
      id: form!.id,
      canDelete: true,
      link: `/f/${form!.slug}/`,
      status: "draft",
    });
  });

  it("updates the draft a first save made when the save is retried", async () => {
    const data = { creationKey: randomUUID(), name: "New form" };
    const first = await request("POST", `/api/v1/admin/forms?template=${template.id}`, {
      user: admin,
      body: data,
    });
    expect(first.status).toBe(201);
    const second = await request("POST", `/api/v1/admin/forms?template=${template.id}`, {
      user: admin,
      body: { ...data, instructions: "Nach Verbindungsfehler erneut gespeichert" },
    });
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.slug).toBe(first.body.slug);
    expect(await formCount()).toBe(1);
    const [form] = await getDb().select().from(forms);
    expect(form!.instructions).toBe("Nach Verbindungsfehler erneut gespeichert");
  });

  it("refuses an invalid creation key", async () => {
    const response = await request("POST", `/api/v1/admin/forms?template=${template.id}`, {
      user: admin,
      body: { creationKey: "not-a-key" },
    });
    expect(response.status).toBe(400);
    expect(await formCount()).toBe(0);
  });

  it("starts from a template that exists", async () => {
    expect((await request("GET", "/api/v1/admin/forms/new?template=999", { user: admin })).status).toBe(404);
    expect(
      (await request("POST", "/api/v1/admin/forms?template=999", { user: admin, body: {} })).status,
    ).toBe(404);
  });

  it("lists the templates to start from", async () => {
    const response = await request("GET", "/api/v1/admin/forms/templates", { user: editor });
    expect(response.status).toBe(200);
    expect(response.body.map((row: { name: string }) => row.name)).toEqual([
      "Externe Erstattung",
      "Test-Vorlage",
    ]);
  });
});

describe("editing forms", () => {
  it("shows editors only their forms", async () => {
    const form = await createForm();
    await createClaim(form);
    const other = await createForm({ slug: "other", name: "Andere Werkstatt", status: "draft" });
    await own(other, editor);
    const list = await request("GET", "/api/v1/admin/forms", { user: editor });
    expect(list.body.rows.map((row: { name: string }) => row.name)).toEqual(["Andere Werkstatt"]);
    expect((await request("GET", `/api/v1/admin/forms/${form.id}`, { user: editor })).status).toBe(404);
    expect((await request("GET", `/api/v1/admin/forms/${other.id}`, { user: editor })).status).toBe(200);
  });

  it("lets only template admins choose the start page", async () => {
    const form = await createForm();
    const current = await createForm({ slug: "allgemein", name: "Allgemein", primary: true });
    await own(form, editor);
    const data = formSettings(form, { primary: true });
    expect(
      (await request("PUT", `/api/v1/admin/forms/${form.id}`, { user: editor, body: data })).status,
    ).toBe(200);
    expect((await reload(form)).primary).toBe(false);
    expect((await request("PUT", `/api/v1/admin/forms/${form.id}`, { user: admin, body: data })).status).toBe(
      200,
    );
    expect((await reload(form)).primary).toBe(true);
    expect((await reload(current)).primary).toBe(false);
  });

  it("keeps a draft a draft and updates the existing form", async () => {
    const form = await createForm({ status: "draft" });
    const response = await request("PUT", `/api/v1/admin/forms/${form.id}`, {
      user: admin,
      body: formSettings(form, { name: "Neuer Name", values: { kst: "" } }),
    });
    expect(response.status).toBe(200);
    const saved = await reload(form);
    expect(saved.name).toBe("Neuer Name");
    expect(saved.fieldValues.kst).toBe("");
    expect(saved.status).toBe("draft");
    expect(await formCount()).toBe(1);
    expect(response.body.status).toBe("draft");
  });

  it("validates before publishing, and unpublishing closes the form", async () => {
    const form = await createForm({ status: "draft" });
    const url = `/api/v1/admin/forms/${form.id}`;
    const invalid = await request("PUT", url, {
      user: admin,
      body: formSettings(form, { action: "publish", values: { kst: "" }, supportEmail: "" }),
    });
    expect(invalid.status).toBe(422);
    expect(Object.keys(invalid.body.error.fields).sort()).toEqual(["supportEmail", "values.kst"]);
    expect((await reload(form)).status).toBe("draft");
    const published = await request("PUT", url, {
      user: admin,
      body: formSettings(form, { action: "publish" }),
    });
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ status: "published", canDelete: false });
    expect(isOpen(await withTemplate(await reload(form)))).toBe(true);
    const unpublished = await request("PUT", url, {
      user: admin,
      body: formSettings(form, { action: "unpublish" }),
    });
    expect(unpublished.body).toMatchObject({ status: "draft", canDelete: true });
    expect(isOpen(await withTemplate(await reload(form)))).toBe(false);
  });

  it("keeps a published form published and refuses invalid settings", async () => {
    const form = await createForm();
    const url = `/api/v1/admin/forms/${form.id}`;
    const response = await request("PUT", url, {
      user: admin,
      body: formSettings(form, { name: "Aktualisiert" }),
    });
    expect(response.body.status).toBe("published");
    expect(isOpen(await withTemplate(await reload(form)))).toBe(true);
    const refused = await request("PUT", url, {
      user: admin,
      body: formSettings(form, { name: "Nicht speichern", values: { kst: "" } }),
    });
    expect(refused.status).toBe(422);
    const saved = await reload(form);
    expect(saved.name).toBe("Aktualisiert");
    expect(saved.fieldValues.kst).toBe("TEST-KST");
    expect(saved.status).toBe("published");
  });

  it("keeps the opening schedule when publishing", async () => {
    const form = await createForm();
    const response = await request("PUT", `/api/v1/admin/forms/${form.id}`, {
      user: admin,
      body: formSettings(form, { action: "publish", opensAt: { date: "01.01.2099", time: "12:00" } }),
    });
    expect(response.status).toBe(200);
    const saved = await reload(form);
    expect(saved.status).toBe("published");
    expect(isOpen(await withTemplate(saved))).toBe(false);
  });

  it("needs ownership for saving and publication", async () => {
    const form = await createForm();
    const url = `/api/v1/admin/forms/${form.id}`;
    const body = formSettings(form, { action: "unpublish" });
    expect((await request("PUT", url, { user: editor, body })).status).toBe(404);
    expect((await reload(form)).status).toBe("published");
    await own(form, editor);
    const response = await request("PUT", url, { user: editor, body });
    expect(response.status).toBe(200);
    expect(response.body.canDelete).toBe(false);
    expect((await reload(form)).status).toBe("draft");
  });

  it("changes the status only through publication actions", async () => {
    const form = await createForm();
    const url = `/api/v1/admin/forms/${form.id}`;
    expect(
      (await request("PUT", url, { user: admin, body: formSettings(form, { status: "draft" }) })).status,
    ).toBe(200);
    expect((await reload(form)).status).toBe("published");
    const refused = await request("PUT", url, {
      user: admin,
      body: formSettings(form, { action: "delete" }),
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toBe("Invalid status change.");
  });

  it("reads and shows dates in the app date format", async () => {
    const form = await createForm({ closesAt: new Date("2099-12-31T22:30:00Z") });
    await saveSettings({ dateFormat: "m/d/Y" });
    const list = await request("GET", "/api/v1/admin/forms", { user: admin });
    expect(list.body.rows[0].closesAt).toBe("12/31/2099, 23:30");
    const page = await request("GET", `/api/v1/admin/forms/${form.id}`, { user: admin });
    expect(page.body.settings.closesAt).toEqual({ date: "12/31/2099", time: "23:30" });
    expect(page.body.datePattern).toBe("MM/DD/YYYY");
    const response = await request("PUT", `/api/v1/admin/forms/${form.id}`, {
      user: admin,
      body: formSettings(form, { tripStart: "10/20/2099", tripEnd: "10/21/2099" }),
    });
    expect(response.status).toBe(200);
    expect((await reload(form)).tripStart).toBe("2099-10-20");
    const invalid = await request("PUT", `/api/v1/admin/forms/${form.id}`, {
      user: admin,
      body: formSettings(form, { tripStart: "20.10.2099", closesAt: { date: "12/31/2099", time: "" } }),
    });
    expect(invalid.body.error.fields).toEqual({
      tripStart: "Enter a valid date.",
      closesAt: "Enter a valid time.",
    });
  });

  it("enters opening times in the app timezone", async () => {
    const form = await createForm();
    await saveSettings({ timezone: "America/New_York" });
    await request("PUT", `/api/v1/admin/forms/${form.id}`, {
      user: admin,
      body: formSettings(form, { closesAt: { date: "31.12.2099", time: "17:30" } }),
    });
    expect((await reload(form)).closesAt?.toISOString()).toBe("2099-12-31T22:30:00.000Z");
  });

  it("warns that a published form stays closed while its values do not fit the template", async () => {
    const form = await createForm({ fieldValues: { kst: "", ktr: "" } });
    const page = await request("GET", `/api/v1/admin/forms/${form.id}`, { user: admin });
    expect(page.body.invalidValues).toEqual(["Kostenstelle (KST)"]);
  });
});

describe("the forms list", () => {
  it("shows the publication status", async () => {
    await createForm();
    const list = await request("GET", "/api/v1/admin/forms", { user: admin });
    expect(list.body.rows[0]).toMatchObject({ status: "published", openNow: true, valuesComplete: true });
    expect(list.body.rows[0].link).toBe("http://localhost:8000/f/test/");
  });

  it.each([
    ["recipient", "Receiving inbox not approved"],
    ["privacy_notice", "No privacy notice"],
  ])("says why an open form accepts no claims (%s)", async (unavailable, reason) => {
    const form = await createForm();
    const row = async () => (await request("GET", "/api/v1/admin/forms", { user: admin })).body.rows[0];
    expect(await row()).toMatchObject({ openNow: true, unavailable: "" });
    let restoreConfig = () => {};
    if (unavailable === "recipient")
      restoreConfig = overrideConfigForTests({ APPROVED_DELIVERY_RECIPIENTS: ["other@example.invalid"] });
    else await getDb().delete(privacyNotices);
    try {
      expect(isOpen(await withTemplate(form))).toBe(true);
      expect(await row()).toMatchObject({ openNow: false, unavailable: reason });
      await getDb().update(forms).set({ status: "draft" }).where(eq(forms.id, form.id));
      expect(await row()).toMatchObject({ openNow: false, unavailable: "" });
    } finally {
      restoreConfig();
    }
  });

  it("filters by status, start page and template, and searches name and short name", async () => {
    await createForm();
    const draft = await createForm({ slug: "entwurf", name: "Entwurf", status: "draft", primary: true });
    await createForm({ slug: "alt", name: "Alt", status: "archived" });
    const names = async (query: string) =>
      (await request("GET", `/api/v1/admin/forms${query}`, { user: admin })).body.rows.map(
        (row: { name: string }) => row.name,
      );
    expect((await names("")).sort()).toEqual(["Entwurf", "Test Workshop"]);
    expect(await names("?status=archived")).toEqual(["Alt"]);
    expect(await names("?status=draft")).toEqual(["Entwurf"]);
    expect(await names("?primary=1")).toEqual(["Entwurf"]);
    expect(await names(`?template=${draft.templateId}&q=entw`)).toEqual(["Entwurf"]);
    expect(await names("?q=test")).toEqual(["Test Workshop"]);
  });
});

describe("deleting forms", () => {
  it("deletes drafts", async () => {
    const form = await createForm({ status: "draft" });
    const page = await request("GET", `/api/v1/admin/forms/${form.id}`, { user: admin });
    expect(page.body.form.canDelete).toBe(true);
    expect((await request("DELETE", `/api/v1/admin/forms/${form.id}`, { user: admin })).status).toBe(200);
    expect(await formCount()).toBe(0);
  });

  it("never deletes published forms", async () => {
    const form = await createForm();
    const page = await request("GET", `/api/v1/admin/forms/${form.id}`, { user: admin });
    expect(page.body.form.canDelete).toBe(false);
    expect((await request("DELETE", `/api/v1/admin/forms/${form.id}`, { user: admin })).status).toBe(403);
    expect(await formCount()).toBe(1);
  });

  it("refuses the deletion when the form was published since the page opened", async () => {
    const form = await createForm({ status: "draft" });
    const page = await request("GET", `/api/v1/admin/forms/${form.id}`, { user: admin });
    expect(page.body.form.canDelete).toBe(true);
    await getDb().update(forms).set({ status: "published" }).where(eq(forms.id, form.id));
    expect((await request("DELETE", `/api/v1/admin/forms/${form.id}`, { user: admin })).status).toBe(403);
    expect(await formCount()).toBe(1);
  });

  it("keeps drafts with submitted claims", async () => {
    const form = await createForm({ status: "draft" });
    await createClaim(form);
    const page = await request("GET", `/api/v1/admin/forms/${form.id}`, { user: admin });
    expect(page.body.form.canDelete).toBe(false);
    expect((await request("DELETE", `/api/v1/admin/forms/${form.id}`, { user: admin })).status).toBe(403);
    expect(await formCount()).toBe(1);
  });

  it("deletes nothing in bulk when a published form is selected", async () => {
    const form = await createForm();
    const draft = await createForm({ slug: "entwurf", name: "Entwurf", status: "draft" });
    const response = await request("POST", "/api/v1/admin/forms/delete", {
      user: admin,
      body: { ids: [form.id, draft.id] },
    });
    expect(response.status).toBe(403);
    expect(await formCount()).toBe(2);
    expect(
      (await request("POST", "/api/v1/admin/forms/delete", { user: editor, body: { ids: [draft.id] } }))
        .status,
    ).toBe(403);
    const deleted = await request("POST", "/api/v1/admin/forms/delete", {
      user: admin,
      body: { ids: [draft.id] },
    });
    expect(deleted.body.message).toBe("1 form was deleted.");
    expect(await formCount()).toBe(1);
  });

  it("deletes archived forms without claims", async () => {
    const form = await createForm({ status: "archived" });
    const page = await request("GET", `/api/v1/admin/forms/${form.id}`, { user: admin });
    expect(page.body.form.canDelete).toBe(true);
    expect((await request("DELETE", `/api/v1/admin/forms/${form.id}`, { user: admin })).status).toBe(200);
    expect(await formCount()).toBe(0);
  });

  it("lets form editors delete nothing", async () => {
    const form = await createForm({ status: "draft" });
    await own(form, editor);
    expect((await request("DELETE", `/api/v1/admin/forms/${form.id}`, { user: editor })).status).toBe(403);
    expect(await formCount()).toBe(1);
  });
});

describe("archiving forms", () => {
  it("closes an archived form and leaves it out of the list", async () => {
    const form = await createForm({ primary: true });
    const url = `/api/v1/admin/forms/${form.id}`;
    const response = await request("PUT", url, {
      user: admin,
      body: formSettings(form, { action: "archive", primary: true }),
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "archived", primary: false });
    const saved = await reload(form);
    expect(saved).toMatchObject({ status: "archived", primary: false });
    expect(isOpen(await withTemplate(saved))).toBe(false);
    const names = async (query = "") =>
      (await request("GET", `/api/v1/admin/forms${query}`, { user: admin })).body.rows.map(
        (row: { name: string }) => row.name,
      );
    expect(await names()).toEqual([]);
    expect(await names("?status=archived")).toEqual(["Test Workshop"]);
    // Unarchiving returns the form as a draft; publishing reopens it.
    const unarchived = await request("PUT", url, {
      user: admin,
      body: formSettings(form, { action: "unarchive" }),
    });
    expect(unarchived.body.status).toBe("draft");
    expect(await names()).toEqual(["Test Workshop"]);
  });

  it("archives and unarchives in bulk, only the forms one manages", async () => {
    const form = await createForm();
    const other = await createForm({ slug: "other", name: "Andere Werkstatt", status: "draft" });
    await own(other, editor);
    const archived = await request("POST", "/api/v1/admin/forms/archive", {
      user: editor,
      body: { ids: [form.id, other.id], archived: true },
    });
    expect(archived.body.message).toBe("1 form was archived.");
    const rows = await getDb().select({ slug: forms.slug, status: forms.status }).from(forms);
    expect(Object.fromEntries(rows.map((row) => [row.slug, row.status]))).toEqual({
      test: "published",
      other: "archived",
    });
    const again = await request("POST", "/api/v1/admin/forms/archive", {
      user: editor,
      body: { ids: [other.id], archived: true },
    });
    expect(again.body.message).toBe("The selected forms were already archived.");
    const unarchived = await request("POST", "/api/v1/admin/forms/archive", {
      user: editor,
      body: { ids: [other.id], archived: false },
    });
    expect(unarchived.body.message).toBe("1 form was unarchived.");
    expect((await reload(other)).status).toBe("draft");
  });
});

describe("access", () => {
  it("is for people with a role only", async () => {
    const nobody = await createUser("nobody");
    expect((await request("GET", "/api/v1/admin/forms", { user: nobody })).status).toBe(403);
    expect((await request("GET", "/api/v1/admin/forms")).status).toBe(401);
  });
});

/** Runs `statement` in a transaction of another connection and keeps it open until `commit`. */
async function holdTransaction(statement: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  await client.query("begin");
  await client.query(statement, params);
  return {
    async commit() {
      await client.query("commit");
      await client.end();
    },
  };
}

/** Lets a request run until it waits for a lock the other connection holds. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

describe("saves that race", () => {
  it("keeps an archiving that commits while an autosave reads the form", async () => {
    const form = await createForm();
    await own(form, editor);
    const archiving = await holdTransaction(
      `update portal_form set status = 'archived', "primary" = false where id = $1`,
      [form.id],
    );
    const saving = request("PUT", `/api/v1/admin/forms/${form.id}`, {
      user: editor,
      body: formSettings(form, { instructions: "Neu", action: "" }),
    });
    await settle();
    await archiving.commit();
    const response = await saving;
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("archived");
    const after = await reload(form);
    expect(after.status).toBe("archived");
    expect(after.instructions).toBe("Neu");
  });

  it("keeps a start-page handover that commits while an editor's save reads the form", async () => {
    const form = await createForm({ primary: true });
    const other = await createForm({ slug: "other", name: "Other" });
    await own(form, editor);
    const handover = await holdTransaction(
      `update portal_form set "primary" = (id = $2) where id in ($1, $2)`,
      [form.id, other.id],
    );
    const saving = request("PUT", `/api/v1/admin/forms/${form.id}`, {
      user: editor,
      body: formSettings(form, { instructions: "Neu" }),
    });
    await settle();
    await handover.commit();
    expect((await saving).status).toBe(200);
    expect((await reload(form)).primary).toBe(false);
    expect((await reload(other)).primary).toBe(true);
  });

  it("hands the start page over without deadlocking a bulk deletion of both forms", async () => {
    const first = await createForm({ primary: true });
    const second = await createForm({ slug: "second", name: "Second" });
    const deletion = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await deletion.connect();
    try {
      await deletion.query("begin");
      // A bulk deletion locks its forms in id order: the first one now …
      await deletion.query("select id from portal_form where id = $1 for update", [first.id]);
      const saving = request("PUT", `/api/v1/admin/forms/${second.id}`, {
        user: admin,
        body: formSettings(second, { primary: true }),
      });
      await settle();
      // … then the second one, which the handover must not hold while it waits for the first.
      await deletion.query("select id from portal_form where id = $1 for update", [second.id]);
      await deletion.query("rollback");
      expect((await saving).status).toBe(200);
      expect((await reload(second)).primary).toBe(true);
      expect((await reload(first)).primary).toBe(false);
    } finally {
      await deletion.end();
    }
  });

  it("keeps the start page when a template admin's save does not send it", async () => {
    const form = await createForm({ primary: true });
    const response = await request("PUT", `/api/v1/admin/forms/${form.id}`, {
      user: admin,
      body: formSettings(form, { instructions: "Neu" }),
    });
    expect(response.status).toBe(200);
    expect((await reload(form)).primary).toBe(true);
  });

  it("finds the form of a first save that commits while its retry runs", async () => {
    const data = { creationKey: randomUUID(), name: "Werkstatt", slug: "werkstatt" };
    const answers = await Promise.all(
      Array.from({ length: 12 }, () =>
        request("POST", `/api/v1/admin/forms?template=${template.id}`, { user: admin, body: data }),
      ),
    );
    expect(answers.map((answer) => answer.status).sort()).toEqual([...Array(11).fill(200), 201]);
    expect(new Set(answers.map((answer) => answer.body.id)).size).toBe(1);
    expect(await formCount()).toBe(1);
  });
});

describe("opening times", () => {
  it("refuses a time the clocks skip or repeat, as Django did", async () => {
    const form = await createForm();
    for (const [date, wall] of [
      ["29.03.2026", "2026-03-29 02:30:00"],
      ["25.10.2026", "2026-10-25 02:30:00"],
    ] as const) {
      const response = await request("PUT", `/api/v1/admin/forms/${form.id}`, {
        user: admin,
        body: formSettings(form, { opensAt: { date, time: "02:30" } }),
      });
      expect(response.status).toBe(422);
      expect(response.body.error.fields.opensAt).toBe(
        `${wall} couldn’t be interpreted in time zone Europe/Berlin; it may be ambiguous or it may not exist.`,
      );
    }
    expect((await reload(form)).opensAt).toBeNull();
  });

  it("keeps the seconds of a stored opening time through a save of other settings", async () => {
    const opensAt = new Date("2026-06-01T07:28:15.123Z");
    const form = await createForm({ opensAt });
    const page = await request("GET", `/api/v1/admin/forms/${form.id}`, { user: admin });
    expect(page.body.settings.opensAt).toEqual({ date: "01.06.2026", time: "09:28:15" });
    const response = await request("PUT", `/api/v1/admin/forms/${form.id}`, {
      user: admin,
      body: { ...page.body.settings, instructions: "Neu" },
    });
    expect(response.status).toBe(200);
    expect((await reload(form)).opensAt?.toISOString()).toBe(opensAt.toISOString());
  });
});
