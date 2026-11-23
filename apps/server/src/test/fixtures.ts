import { desc, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import {
  claims,
  expenses,
  formTemplates,
  forms,
  privacyNotices,
  templateFields,
  type Claim,
  type Form,
  type FormTemplate,
  type PrivacyNotice,
} from "../db/schema";

/**
 * Fixtures of the Django version's tests/conftest.py. `template`,
 * `privacyNotice` and `form` as there; `createClaim` writes an accepted
 * claim directly (the Django tests' `accepted` went through the submission;
 * INTAKE adds `prepared` and `accepted` on top of its API).
 */

/** "Test-Vorlage" with the fields kst (required) and ktr. */
export async function template(): Promise<FormTemplate> {
  let [row] = await getDb().select().from(formTemplates).where(eq(formTemplates.name, "Test-Vorlage"));
  if (!row) {
    [row] = await getDb()
      .insert(formTemplates)
      .values({
        name: "Test-Vorlage",
        travel: "optional",
        mileageEnabled: true,
        declaration:
          "Hiermit bestätige ich, dass die angegebenen Auslagen tatsächlich entstanden sind, dem genannten Zweck dienen und bisher nicht erstattet wurden.",
        declarationVersion: "reimbursement-v1",
      })
      .returning();
    await getDb()
      .insert(templateFields)
      .values([
        { templateId: row!.id, key: "kst", label: "Kostenstelle (KST)", position: 0 },
        { templateId: row!.id, key: "ktr", label: "Kostenträger (KTR)", required: false, position: 1 },
      ]);
  }
  return row!;
}

/** The current privacy notice, or a synthetic one. */
export async function privacyNotice(): Promise<PrivacyNotice> {
  const [current] = await getDb()
    .select()
    .from(privacyNotices)
    .orderBy(desc(privacyNotices.version))
    .limit(1);
  if (current) return current;
  const [created] = await getDb()
    .insert(privacyNotices)
    .values({ version: 1, text: "Synthetic privacy notice for tests." })
    .returning();
  return created!;
}

/** The published form "test" of "Test-Vorlage", sending to finance@example.invalid. */
export async function createForm(values: Partial<typeof forms.$inferInsert> = {}): Promise<Form> {
  const base = await template();
  await privacyNotice();
  const [row] = await getDb()
    .insert(forms)
    .values({
      templateId: base.id,
      slug: "test",
      name: "Test Workshop",
      fieldValues: { kst: "TEST-KST", ktr: "TEST-KTR" },
      recipient: "finance@example.invalid",
      supportEmail: "finance@example.invalid",
      status: "published",
      ...values,
    })
    .returning();
  return row!;
}

/**
 * An accepted claim of `form` with one receipt expense of 12.50 EUR, written
 * directly (no uploads, PDF or jobs).
 */
export async function createClaim(
  form: Pick<Form, "id" | "name">,
  values: Partial<typeof claims.$inferInsert> = {},
): Promise<Claim> {
  const [row] = await getDb()
    .insert(claims)
    .values({
      formId: form.id,
      fullName: "Alex Beispiel",
      email: "participant@example.invalid",
      street: "Teststraße 1",
      postalCode: "12345",
      city: "Berlin",
      country: "DE",
      accountHolder: "Alex Beispiel",
      iban: "DE89370400440532013000",
      purpose: "Teilnahme am synthetischen Workshop",
      snapshot: { name: form.name, template: "Test-Vorlage", language: "de", revision: "0000000000000000" },
      total: "12.50",
      ...values,
    })
    .returning();
  await getDb().insert(expenses).values({
    claimId: row!.id,
    position: 1,
    merchant: "Belegverkauf",
    purpose: "Workshop-Anreise",
    receiptReference: "TEST-1",
    amount: "12.50",
  });
  return row!;
}
