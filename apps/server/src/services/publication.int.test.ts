import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../db/client";
import { claims, drafts, formOwners, forms, type Form, type FormTemplate } from "../db/schema";
import { FORM_EDITOR, TEMPLATE_ADMIN } from "../auth/roles";
import { createClaim, createForm, template as testTemplate } from "../test/fixtures";
import { createUser, resetDatabase } from "../test/helpers";
import { isOpen, templateFieldsOf, withTemplate } from "../models";
import * as publication from "./publication";

/** Port of tests/test_publication.py. */
const COMPLETE = {
  name: "Werkstatt",
  slug: "werkstatt",
  values: { kst: "4711" },
  recipient: "finance@example.invalid",
  supportEmail: "team@example.invalid",
};

let template: FormTemplate;

beforeEach(async () => {
  await resetDatabase();
  template = await testTemplate();
});

async function settings(
  data: Parameters<typeof publication.validateSettings>[2],
  options: { form?: Form | null; action?: string; templateId?: number } = {},
) {
  const status = publication.statusAfter(options.form ?? null, options.action ?? "");
  const fields = await templateFieldsOf(options.templateId ?? template.id);
  return publication.validateSettings({ fields }, status, data, {
    existing: options.form ?? null,
    canChoosePrimary: true,
  });
}

async function saved(
  data: Parameters<typeof publication.validateSettings>[2],
  person: Awaited<ReturnType<typeof createUser>>,
  options: { form?: Form | null; action?: string; creationKey?: string } = {},
) {
  const result = await settings(data, { ...options, templateId: options.form?.templateId });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return publication.save(result.settings, person, {
    existing: options.form ?? null,
    templateId: options.form?.templateId ?? template.id,
    creationKey: options.creationKey,
  });
}

const owners = async (form: Form) =>
  (await getDb().select().from(formOwners).where(eq(formOwners.formId, form.id))).map((row) => row.userId);

describe("publication", () => {
  it("saves a new draft with gaps, and its creator owns it", async () => {
    const editor = await createUser("editor", [FORM_EDITOR]);
    const form = await saved({ instructions: "Erste Notiz" }, editor);
    expect(form.status).toBe("draft");
    expect(form.name).toBe("New form");
    expect(form.slug.startsWith("new-form-")).toBe(true);
    expect(form.fieldValues).toEqual({ kst: "", ktr: "" });
    expect(await owners(form)).toEqual([editor.id]);
  });

  it("needs complete settings to publish", async () => {
    const incomplete = await settings({ name: "Werkstatt" }, { action: "publish" });
    expect(incomplete.ok).toBe(false);
    const errors = !incomplete.ok ? Object.keys(incomplete.errors) : [];
    expect(errors).toEqual(expect.arrayContaining(["slug", "values.kst", "recipient", "supportEmail"]));
    const admin = await createUser("admin", [TEMPLATE_ADMIN]);
    const form = await saved(COMPLETE, admin, { action: "publish" });
    expect(form.status).toBe("published");
    expect(isOpen(await withTemplate(form))).toBe(true);
  });

  it("checks internal values and the schedule when publishing", async () => {
    const invalid = await settings(
      {
        ...COMPLETE,
        values: { kst: "4711", ktr: "x".repeat(201) },
        opensAt: { date: "2099-01-02", time: "00:00" },
        closesAt: { date: "2099-01-01", time: "00:00" },
      },
      { action: "publish" },
    );
    expect(invalid.ok).toBe(false);
    expect(Object.keys(!invalid.ok ? invalid.errors : {})).toEqual(
      expect.arrayContaining(["values.ktr", "closesAt"]),
    );
  });

  it("returns a form to draft when unpublishing, and keeps its settings", async () => {
    const form = await createForm();
    const admin = await createUser("admin", [TEMPLATE_ADMIN]);
    const draft = await saved({ ...COMPLETE, slug: form.slug, values: { kst: "" }, recipient: "" }, admin, {
      form,
      action: "unpublish",
    });
    expect(draft.status).toBe("draft");
    expect(draft.fieldValues.kst).toBe("");
    expect(await owners(draft)).toEqual([]);
  });

  it("refuses unknown actions", async () => {
    const form = await createForm();
    expect(() => publication.statusAfter(form, "delete")).toThrow(publication.Refused);
    expect(publication.statusAfter(form, "")).toBe("published");
    expect(publication.statusAfter(null, "")).toBe("draft");
  });

  it("closes an archived form and gives up the start page", async () => {
    const form = await createForm({ primary: true });
    const admin = await createUser("admin", [TEMPLATE_ADMIN]);
    // An archived form keeps gaps like a draft.
    const archived = await saved(
      { ...COMPLETE, slug: form.slug, values: { kst: "" }, primary: true },
      admin,
      {
        form,
        action: "archive",
      },
    );
    expect(archived.status).toBe("archived");
    expect(archived.fieldValues.kst).toBe("");
    expect(archived.primary).toBe(false);
    expect(isOpen(await withTemplate(archived))).toBe(false);
    expect(publication.statusAfter(archived, "")).toBe("archived");
    expect(publication.statusAfter(archived, "unarchive")).toBe("draft");
  });

  it("sets archived forms back to drafts", async () => {
    const form = await createForm();
    expect(await publication.setArchived(form, true)).toBe(true);
    const [archived] = await getDb().select().from(forms).where(eq(forms.id, form.id));
    expect(archived!.status).toBe("archived");
    expect(await publication.setArchived(archived!, true)).toBe(false);
    expect(await publication.setArchived(archived!, false)).toBe(true);
    const [draft] = await getDb().select().from(forms).where(eq(forms.id, form.id));
    expect(draft!.status).toBe("draft");
    expect(await publication.setArchived(draft!, false)).toBe(false);
  });

  it("finds the form a retried first save made", async () => {
    const editor = await createUser("editor", [FORM_EDITOR]);
    const other = await createUser("other", [FORM_EDITOR]);
    const key = randomUUID();
    const form = await saved({ name: "Erst" }, editor, { creationKey: key });
    expect((await publication.created(editor, key))?.id).toBe(form.id);
    expect(await publication.created(other, key)).toBeNull();
    expect(await publication.created(editor, randomUUID())).toBeNull();
  });

  it("keeps editors owners of forms they save", async () => {
    const form = await createForm();
    const editor = await createUser("editor", [FORM_EDITOR]);
    const data = { ...COMPLETE, slug: form.slug };
    expect(await owners(await saved(data, editor, { form }))).toContain(editor.id);
    const admin = await createUser("admin", [TEMPLATE_ADMIN]);
    expect(await owners(await saved(data, admin, { form }))).not.toContain(admin.id);
  });

  it("lets only template admins delete, and only forms without claims or drafts", async () => {
    const admin = await createUser("admin", [TEMPLATE_ADMIN]);
    const editor = await createUser("editor", [FORM_EDITOR]);
    const form = await createForm();
    const claim = await createClaim(form);
    await getDb()
      .insert(drafts)
      .values({ formId: form.id, sessionHash: "x", tokenHash: "y", revision: "0000000000000000" });
    expect(await publication.mayDelete(admin, form)).toBe(false);
    form.status = "draft";
    expect(await publication.mayDelete(admin, form)).toBe(false);
    await getDb().delete(claims).where(eq(claims.id, claim.id));
    expect(await publication.mayDelete(admin, form)).toBe(false);
    await getDb().delete(drafts).where(eq(drafts.formId, form.id));
    expect(await publication.mayDelete(admin, form)).toBe(true);
    expect(await publication.mayDelete(editor, form)).toBe(false);
    form.status = "archived";
    expect(await publication.mayDelete(admin, form)).toBe(true);
  });

  it("hands the start page over to the form marked last", async () => {
    const admin = await createUser("admin", [TEMPLATE_ADMIN]);
    const current = await createForm({ slug: "allgemein", name: "Allgemein", primary: true });
    const form = await createForm();
    await saved({ ...COMPLETE, slug: form.slug, primary: true }, admin, { form });
    const rows = await getDb().select({ slug: forms.slug, primary: forms.primary }).from(forms);
    expect(Object.fromEntries(rows.map((row) => [row.slug, row.primary]))).toEqual({
      [current.slug]: false,
      [form.slug]: true,
    });
  });
});
