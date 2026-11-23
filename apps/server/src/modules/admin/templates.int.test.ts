import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../db/client";
import {
  formTemplates,
  forms,
  privacyNotices,
  templateFields,
  type FormTemplate,
  type User,
} from "../../db/schema";
import { FORM_EDITOR, TEMPLATE_ADMIN } from "../../auth/roles";
import { internalValues, isOpen, loadForm, validateFieldValue } from "../../models";
import { saveSettings } from "../../services/app-settings";
import { createForm, template as testTemplate } from "../../test/fixtures";
import { createUser, request, resetDatabase, signInWithTestHeader } from "../../test/helpers";

/**
 * Templates and the privacy notice of the admin area: the template and
 * privacy notice cases of tests/test_admin.py and tests/test_forms.py, and
 * test_new_templates_get_the_declaration_in_the_app_language of
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

const newTemplate = (changes: Record<string, unknown> = {}) => ({
  name: "Reisekosten",
  description: "Für Reisen\nzweite Zeile",
  intro: "",
  travel: "required",
  mileageEnabled: true,
  mileageRate: "0,35",
  declaration: "Ich bestätige.",
  declarationVersion: "travel-v1",
  fields: [
    {
      position: 0,
      label: "Kostenstelle",
      key: "kst",
      kind: "text",
      choices: "",
      pattern: "\\d{4}",
      required: true,
    },
    { position: 1, label: "Art", key: "art", kind: "choice", choices: "A\nB", pattern: "", required: false },
  ],
  ...changes,
});

describe("templates", () => {
  it("lets editors look, but not change, add or delete", async () => {
    expect(
      (await request("GET", `/api/v1/admin/templates/${template.id}`, { user: editor })).body.canChange,
    ).toBe(false);
    const changed = await request("PUT", `/api/v1/admin/templates/${template.id}`, {
      user: editor,
      body: newTemplate({ name: "X" }),
    });
    expect(changed.status).toBe(403);
    expect((await request("GET", "/api/v1/admin/templates/new", { user: editor })).status).toBe(403);
    expect(
      (await request("POST", "/api/v1/admin/templates", { user: editor, body: newTemplate() })).status,
    ).toBe(403);
    expect((await request("DELETE", `/api/v1/admin/templates/${template.id}`, { user: editor })).status).toBe(
      403,
    );
    const [row] = await getDb().select().from(formTemplates).where(eq(formTemplates.id, template.id));
    expect(row!.name).toBe("Test-Vorlage");
  });

  it("adds a template with its fields", async () => {
    const response = await request("POST", "/api/v1/admin/templates", { user: admin, body: newTemplate() });
    expect(response.status).toBe(201);
    const [created] = await getDb().select().from(formTemplates).where(eq(formTemplates.name, "Reisekosten"));
    expect(created).toMatchObject({ travel: "required", mileageEnabled: true, mileageRate: "0.35" });
    const fields = await getDb()
      .select()
      .from(templateFields)
      .where(eq(templateFields.templateId, created!.id));
    expect(fields.map((field) => [field.key, field.kind, field.required])).toEqual([
      ["kst", "text", true],
      ["art", "choice", false],
    ]);
    expect(response.body.template.mileageRate).toBe("0,35");
  });

  it("changes, reorders and removes fields", async () => {
    const page = await request("GET", `/api/v1/admin/templates/${template.id}`, { user: admin });
    const [kst, ktr] = page.body.template.fields;
    const response = await request("PUT", `/api/v1/admin/templates/${template.id}`, {
      user: admin,
      body: {
        ...page.body.template,
        fields: [
          { ...ktr, key: "kst", position: 0 },
          { ...kst, key: "ktr", position: 1, label: "Kostenstelle neu" },
          { position: 2, label: "ID", key: "id", kind: "text", choices: "", pattern: "", required: false },
        ],
      },
    });
    expect(response.status).toBe(200);
    const fields = await getDb()
      .select()
      .from(templateFields)
      .where(eq(templateFields.templateId, template.id))
      .orderBy(templateFields.position);
    expect(fields.map((field) => [field.id, field.key, field.label])).toEqual([
      [ktr.id, "kst", "Kostenträger (KTR)"],
      [kst.id, "ktr", "Kostenstelle neu"],
      [expect.any(Number), "id", "ID"],
    ]);
    const removed = await request("PUT", `/api/v1/admin/templates/${template.id}`, {
      user: admin,
      body: { ...response.body.template, fields: [] },
    });
    expect(removed.status).toBe(200);
    expect(
      await getDb().select().from(templateFields).where(eq(templateFields.templateId, template.id)),
    ).toEqual([]);
  });

  it("validates the template and its fields", async () => {
    const response = await request("POST", "/api/v1/admin/templates", {
      user: admin,
      body: newTemplate({
        name: "Test-Vorlage",
        mileageRate: "0,001",
        declarationVersion: "",
        fields: [
          { position: 0, label: "Bad", key: "bad", kind: "text", choices: "", pattern: "(", required: true },
          {
            position: 1,
            label: "Art",
            key: "art",
            kind: "choice",
            choices: "\n",
            pattern: "",
            required: true,
          },
          { position: 2, label: "Art", key: "art", kind: "text", choices: "", pattern: "", required: true },
          { position: 3, label: "", key: "no key", kind: "text", choices: "", pattern: "", required: true },
        ],
      }),
    });
    expect(response.status).toBe(422);
    expect(response.body.error.fields).toEqual({
      name: "Template with this Name already exists.",
      mileageRate: "Ensure that there are no more than 2 decimal places.",
      declarationVersion: "This field is required.",
      "fields.0.pattern": "Invalid regular expression.",
      "fields.1.choices": "Enter at least one option.",
      "fields.2.key": "Please correct the duplicate data for key, which must be unique.",
      "fields.3.label": "This field is required.",
      "fields.3.key": "Enter a valid “slug” consisting of letters, numbers, underscores or hyphens.",
    });
    expect(await getDb().select().from(formTemplates)).toHaveLength(2);
  });

  it("deletes only templates without forms", async () => {
    await createForm();
    expect((await request("DELETE", `/api/v1/admin/templates/${template.id}`, { user: admin })).status).toBe(
      403,
    );
    const page = await request("GET", `/api/v1/admin/templates/${template.id}`, { user: admin });
    expect(page.body).toMatchObject({ forms: 1, canDelete: false });
    await getDb().delete(forms);
    expect((await request("DELETE", `/api/v1/admin/templates/${template.id}`, { user: admin })).status).toBe(
      200,
    );
    expect(await getDb().select().from(formTemplates).where(eq(formTemplates.id, template.id))).toEqual([]);
  });

  it("lists templates with their forms, and searches name and description", async () => {
    await createForm();
    const list = await request("GET", "/api/v1/admin/templates", { user: admin });
    expect(list.body.map((row: { name: string; forms: number }) => [row.name, row.forms])).toEqual([
      ["Externe Erstattung", 0],
      ["Test-Vorlage", 1],
    ]);
    const found = await request("GET", "/api/v1/admin/templates?q=externe", { user: admin });
    expect(found.body.map((row: { name: string }) => row.name)).toEqual(["Externe Erstattung"]);
  });

  it("gives new templates the declaration in the app language", async () => {
    const german = await request("GET", "/api/v1/admin/templates/new", { user: admin });
    expect(german.body.template.declaration.startsWith("Hiermit bestätige")).toBe(true);
    await saveSettings({ language: "en" });
    const english = await request("GET", "/api/v1/admin/templates/new", { user: admin });
    expect(english.body.template.declaration.startsWith("I confirm")).toBe(true);
    expect(english.body.template).toMatchObject({
      declarationVersion: "reimbursement-v1",
      travel: "optional",
    });
  });

  it("validates internal values with the template's fields", () => {
    const field = { kind: "text", choices: "", pattern: "\\d{4}", required: true };
    expect(validateFieldValue(field, " 1234 ")).toBe("1234");
    expect(() => validateFieldValue(field, "12345")).toThrow();
    expect(() => validateFieldValue(field, "")).toThrow();
    const choice = { kind: "choice", choices: "A\nB", pattern: "", required: true };
    expect(validateFieldValue(choice, "B")).toBe("B");
    expect(() => validateFieldValue(choice, "C")).toThrow();
  });

  it("closes a form when its template gains a required value", async () => {
    const form = await createForm();
    const page = await request("GET", `/api/v1/admin/templates/${template.id}`, { user: admin });
    await request("PUT", `/api/v1/admin/templates/${template.id}`, {
      user: admin,
      body: {
        ...page.body.template,
        fields: [
          ...page.body.template.fields,
          { position: 2, label: "ID", key: "id", kind: "text", choices: "", pattern: "", required: true },
        ],
      },
    });
    let loaded = (await loadForm({ id: form.id }))!;
    expect(isOpen(loaded)).toBe(false);
    const list = await request("GET", "/api/v1/admin/forms", { user: admin });
    expect(list.body.rows[0]).toMatchObject({ valuesComplete: false, openNow: false });
    await getDb()
      .update(forms)
      .set({ fieldValues: { ...form.fieldValues, id: "WS-1" } })
      .where(eq(forms.id, form.id));
    loaded = (await loadForm({ id: form.id }))!;
    expect(isOpen(loaded)).toBe(true);
    expect(internalValues(loaded)).toContainEqual(["ID", "WS-1"]);
  });
});

describe("the privacy notice", () => {
  it("is saved as a new version, never changed", async () => {
    const [first] = await getDb().select().from(privacyNotices);
    const page = await request("GET", "/api/v1/admin/privacy-notices/new", { user: admin });
    expect(page.body.text.split("\n")[0].slice(0, 20)).toBe(first!.text.split("\n")[0]!.slice(0, 20));
    const response = await request("POST", "/api/v1/admin/privacy-notices", {
      user: admin,
      body: { text: "Neue Fassung.\n" },
    });
    expect(response.status).toBe(201);
    expect(response.body.version).toBe(first!.version + 1);
    const list = await request("GET", "/api/v1/admin/privacy-notices", { user: admin });
    expect(
      list.body.map((row: { version: number; current: boolean; createdBy: string }) => [
        row.version,
        row.current,
      ]),
    ).toEqual([
      [2, true],
      [1, false],
    ]);
    expect(list.body[0].createdBy).toBe("admin@example.invalid");
    const [current] = await getDb().select().from(privacyNotices).orderBy(privacyNotices.version).offset(1);
    expect(current!.text).toBe("Neue Fassung.");
    // There is no way to change a version.
    expect(
      (
        await request("PUT", `/api/v1/admin/privacy-notices/${current!.id}`, {
          user: admin,
          body: { text: "Edit" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await request("POST", "/api/v1/admin/privacy-notices", { user: admin, body: { text: " " } })).status,
    ).toBe(422);
  });

  it("is for template admins only", async () => {
    expect((await request("GET", "/api/v1/admin/privacy-notices", { user: editor })).status).toBe(403);
    expect(
      (await request("POST", "/api/v1/admin/privacy-notices", { user: editor, body: { text: "x" } })).status,
    ).toBe(403);
  });
});
