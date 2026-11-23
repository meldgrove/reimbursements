import { and } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../db/client";
import { claims, formOwners, forms, type Claim, type Form } from "../db/schema";
import { createClaim, createForm } from "../test/fixtures";
import { createUser, resetDatabase } from "../test/helpers";
import { eq } from "drizzle-orm";
import { FORM_EDITOR, managedForms, manages, sees, TEMPLATE_ADMIN, visibleClaims } from "./roles";

/** Port of tests/test_roles.py. */
let accepted: Claim;
let form: Form;
let otherForm: Form;

const own = (formId: number, userId: number) => getDb().insert(formOwners).values({ formId, userId });
const managedIds = async (user: Parameters<typeof managedForms>[0], extra = eq(forms.id, forms.id)) =>
  (
    await getDb()
      .select({ id: forms.id })
      .from(forms)
      .where(and(await managedForms(user), extra))
  ).map((row) => row.id);
const visibleIds = async (user: Parameters<typeof visibleClaims>[0], extra = eq(claims.id, claims.id)) =>
  (
    await getDb()
      .select({ id: claims.id })
      .from(claims)
      .where(and(await visibleClaims(user), extra))
  ).map((row) => row.id);

beforeEach(async () => {
  await resetDatabase();
  form = await createForm();
  accepted = await createClaim(form);
  otherForm = await createForm({ slug: "andere", name: "Andere" });
});

describe("roles", () => {
  it("lets template admins manage every form and see every claim", async () => {
    const admin = await createUser("admin", [TEMPLATE_ADMIN]);
    expect(new Set(await managedIds(admin))).toEqual(new Set([form.id, otherForm.id]));
    expect(await visibleIds(admin)).toEqual([accepted.id]);
    expect(await manages(admin, otherForm)).toBe(true);
    expect(await sees(admin, accepted)).toBe(true);
  });

  it("lets editors manage their own forms and see only their claims", async () => {
    const editor = await createUser("editor", [FORM_EDITOR]);
    await own(otherForm.id, editor.id);
    expect(await managedIds(editor)).toEqual([otherForm.id]);
    expect(await visibleIds(editor)).toEqual([]);
    expect(await manages(editor, form)).toBe(false);
    expect(await sees(editor, accepted)).toBe(false);
    await own(form.id, editor.id);
    expect(await manages(editor, form)).toBe(true);
    expect(await sees(editor, accepted)).toBe(true);
  });

  it("lets people without a role manage nothing", async () => {
    const nobody = await createUser("nobody");
    await own(form.id, nobody.id);
    expect(await managedIds(nobody)).toEqual([]);
    expect(await visibleIds(nobody)).toEqual([]);
    expect(await manages(nobody, form)).toBe(false);
  });

  it("narrows a given query", async () => {
    const editor = await createUser("editor", [FORM_EDITOR]);
    await own(form.id, editor.id);
    await own(otherForm.id, editor.id);
    expect(await managedIds(editor, eq(forms.slug, "andere"))).toEqual([otherForm.id]);
    expect(await visibleIds(editor, eq(claims.fullName, "nobody"))).toEqual([]);
  });

  it("makes a Django superuser a template admin, and a turned-off user nothing", async () => {
    const root = await createUser("root", [], { isSuperuser: true });
    expect(await manages(root, otherForm)).toBe(true);
    const gone = await createUser("gone", [TEMPLATE_ADMIN], { isActive: false });
    expect(await managedIds(gone)).toEqual([]);
  });
});
