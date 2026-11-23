/**
 * Rules of the form and template rows that several modules share (the
 * methods of Form, TemplateField and PrivacyNotice in portal/models.py of
 * the Django version): a template field's options and validation, a form's
 * internal values, whether it is open, and the current privacy notice.
 */
import { asc, desc, eq } from "drizzle-orm";
import { FORM_DESCRIPTION, FORM_TITLE } from "@reimbursements/shared/constants";
import {
  formTemplates,
  forms,
  privacyNotices,
  templateFields,
  type Form,
  type FormTemplate,
  type PrivacyNotice,
  type TemplateField,
} from "./db/schema";
import { q } from "./db/tx";
import { t } from "./i18n";
import { logger } from "./logger";
import { pythonFullmatch } from "./python-regex";

/** A form with its template and the template's fields in order. */
export type FormWithTemplate = Form & { template: FormTemplate; fields: TemplateField[] };

/** The options of a choice field: one per non-empty line. */
export function fieldOptions(field: Pick<TemplateField, "choices">): string[] {
  return field.choices
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * A template field's pattern, written for Python's re (the Django version),
 * as a JavaScript RegExp with the same meaning that must match the whole
 * value (re.fullmatch); null when it has no translation (python-regex.ts).
 */
export function fieldPattern(pattern: string): RegExp | null {
  return pythonFullmatch(pattern);
}

const untranslatable = new Set<string>();

/** Why a template field's value is invalid (a message of the admin area). */
export class FieldValueError extends Error {
  override name = "FieldValueError";
}

/**
 * The cleaned value of a template field, or FieldValueError with a message
 * for the admin area (TemplateField.validate).
 */
export function validateFieldValue(
  field: Pick<TemplateField, "kind" | "choices" | "pattern" | "required">,
  value: unknown,
): string {
  const cleaned = (typeof value === "string" ? value : "").trim();
  if (!cleaned) {
    if (field.required) throw new FieldValueError("This field is required.");
    return "";
  }
  if (cleaned.length > 200) throw new FieldValueError("At most 200 characters.");
  if (field.kind === "choice" && !fieldOptions(field).includes(cleaned))
    throw new FieldValueError("Choose one of the options.");
  if (field.pattern) {
    const pattern = fieldPattern(field.pattern);
    if (!pattern && !untranslatable.has(field.pattern)) {
      // A pattern saved by the Django version that JavaScript cannot match: its
      // forms stay closed, naming the field, until the template is changed.
      untranslatable.add(field.pattern);
      logger.warn({ pattern: field.pattern }, "a template field's pattern has no JavaScript translation");
    }
    if (!pattern || !pattern.test(cleaned))
      throw new FieldValueError("The value does not match the template's format.");
  }
  return cleaned;
}

/**
 * Labels of internal values that no longer satisfy the current template.
 * A template change can add a required field or tighten a pattern; the form
 * then stays closed until its owners update the values.
 */
export function internalValueErrors(form: Pick<FormWithTemplate, "fieldValues" | "fields">): string[] {
  const errors: string[] = [];
  for (const field of form.fields) {
    try {
      validateFieldValue(field, form.fieldValues[field.key] ?? "");
    } catch {
      errors.push(field.label);
    }
  }
  return errors;
}

/** Whether the form is open now: published, within its opening times, its values valid. */
export function isOpen(
  form: Pick<FormWithTemplate, "status" | "opensAt" | "closesAt" | "fieldValues" | "fields">,
  now: Date = new Date(),
): boolean {
  return (
    form.status === "published" &&
    (!form.opensAt || now.getTime() >= form.opensAt.getTime()) &&
    (!form.closesAt || now.getTime() <= form.closesAt.getTime()) &&
    internalValueErrors(form).length === 0
  );
}

/** (label, value) pairs in template order, for the PDF; empty values are left out. */
export function internalValues(
  form: Pick<FormWithTemplate, "fieldValues" | "fields">,
): Array<[string, string]> {
  return form.fields
    .filter((field) => form.fieldValues[field.key])
    .map((field) => [field.label, form.fieldValues[field.key] ?? ""] as [string, string]);
}

/** The heading above the form: its title, or the standard one in the active language. */
export function displayTitle(form: Pick<Form, "title">): string {
  return form.title || t(FORM_TITLE);
}

/** The text below the title: its description, or the standard one in the active language. */
export function displayDescription(form: Pick<Form, "description">): string {
  return form.description || t(FORM_DESCRIPTION);
}

/** The template's fields in order (position, then id). */
export function templateFieldsOf(templateId: number): Promise<TemplateField[]> {
  return q()
    .select()
    .from(templateFields)
    .where(eq(templateFields.templateId, templateId))
    .orderBy(asc(templateFields.position), asc(templateFields.id));
}

/**
 * A form with its template and fields, by slug or id; null when there is
 * none. `forUpdate` locks the form row only (not the template).
 */
export async function loadForm(
  where: { slug: string } | { id: number },
  options: { forUpdate?: boolean } = {},
): Promise<FormWithTemplate | null> {
  const condition = "slug" in where ? eq(forms.slug, where.slug) : eq(forms.id, where.id);
  const query = q().select().from(forms).where(condition);
  const [form] = options.forUpdate ? await query.for("update") : await query;
  if (!form) return null;
  return withTemplate(form);
}

/** Adds the template and its fields to a form row. */
export async function withTemplate(form: Form): Promise<FormWithTemplate> {
  const [template] = await q().select().from(formTemplates).where(eq(formTemplates.id, form.templateId));
  return { ...form, template: template!, fields: await templateFieldsOf(form.templateId) };
}

/** The current privacy notice (the highest version), or null without one. */
export async function currentPrivacyNotice(): Promise<PrivacyNotice | null> {
  const [notice] = await q().select().from(privacyNotices).orderBy(desc(privacyNotices.version)).limit(1);
  return notice ?? null;
}
