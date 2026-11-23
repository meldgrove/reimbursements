import { Hono } from "hono";
import { and, asc, count, eq, ilike, inArray, ne, notInArray, or, type SQL } from "drizzle-orm";
import { DECLARATION, DECLARATION_VERSION } from "@reimbursements/shared/constants";
import { translate } from "@reimbursements/shared/i18n";
import type {
  TemplateDetail,
  TemplateFieldInput,
  TemplateInput,
  TemplateRow,
  Travel,
} from "@reimbursements/shared/api/admin";
import { formTemplates, forms, templateFields, type FormTemplate } from "../../db/schema";
import { atomic, q } from "../../db/tx";
import type { AppEnv } from "../../http/env";
import { forbidden, notFound, validationError } from "../../http/errors";
import { idParam, requireEditor, requireTemplateAdmin } from "../../http/middleware";
import { formatAmount, formatDateTime } from "../../i18n";
import { isTemplateAdmin } from "../../auth/roles";
import { fieldOptions, fieldPattern } from "../../models";
import { loadSettings } from "../../services/app-settings";
import { body, contains } from "./common";

/**
 * Templates in the admin area (FormTemplateAdmin and TemplateFieldInline of
 * portal/admin.py): template admins add and change templates and their
 * fields, the internal values each form of the template sets; form editors
 * may look. A template with forms cannot be deleted.
 */
const router = new Hono<AppEnv>();

const TRAVEL: ReadonlySet<string> = new Set(["off", "optional", "required"]);
const SLUG = /^[-a-zA-Z0-9_]+$/;

/** The standard declaration in the app language, for new templates. */
export async function defaultDeclaration(): Promise<string> {
  return translate((await loadSettings()).language, DECLARATION);
}

async function formCounts(ids: number[]): Promise<Map<number, number>> {
  if (ids.length === 0) return new Map();
  const rows = await q()
    .select({ id: forms.templateId, total: count() })
    .from(forms)
    .where(inArray(forms.templateId, ids))
    .groupBy(forms.templateId);
  return new Map(rows.map((row) => [row.id, row.total]));
}

router.get("/admin/templates", async (c) => {
  await requireEditor(c);
  const term = (c.req.query("q") ?? "").trim().slice(0, 200);
  const conditions: SQL[] = [];
  for (const word of term ? term.split(/\s+/) : [])
    conditions.push(
      or(ilike(formTemplates.name, contains(word)), ilike(formTemplates.description, contains(word)))!,
    );
  const rows = await q()
    .select()
    .from(formTemplates)
    .where(and(...conditions))
    .orderBy(asc(formTemplates.name));
  const counts = await formCounts(rows.map((row) => row.id));
  return c.json(
    rows.map((row): TemplateRow => ({
      id: row.id,
      name: row.name,
      travel: row.travel as Travel,
      mileageEnabled: row.mileageEnabled,
      forms: counts.get(row.id) ?? 0,
      updatedAt: formatDateTime(row.updatedAt),
    })),
  );
});

async function detail(template: FormTemplate | null, canChange: boolean): Promise<TemplateDetail> {
  if (!template) {
    return {
      id: null,
      template: {
        name: "",
        description: "",
        intro: "",
        travel: "optional",
        mileageEnabled: false,
        mileageRate: formatAmount("0.30"),
        declaration: await defaultDeclaration(),
        declarationVersion: DECLARATION_VERSION,
        fields: [],
      },
      forms: 0,
      canChange,
      canDelete: false,
    };
  }
  const fields = await q()
    .select()
    .from(templateFields)
    .where(eq(templateFields.templateId, template.id))
    .orderBy(asc(templateFields.position), asc(templateFields.id));
  const forms = (await formCounts([template.id])).get(template.id) ?? 0;
  return {
    id: template.id,
    template: {
      name: template.name,
      description: template.description,
      intro: template.intro,
      travel: template.travel as Travel,
      mileageEnabled: template.mileageEnabled,
      mileageRate: formatAmount(template.mileageRate),
      declaration: template.declaration,
      declarationVersion: template.declarationVersion,
      fields: fields.map((field) => ({
        id: field.id,
        position: field.position,
        label: field.label,
        key: field.key,
        kind: field.kind === "choice" ? "choice" : "text",
        choices: field.choices,
        pattern: field.pattern,
        required: field.required,
      })),
    },
    forms,
    canChange,
    canDelete: canChange && forms === 0,
  };
}

router.get("/admin/templates/new", async (c) => {
  await requireTemplateAdmin(c);
  return c.json(await detail(null, true));
});

router.get("/admin/templates/:id", async (c) => {
  const user = await requireEditor(c);
  const [template] = await q()
    .select()
    .from(formTemplates)
    .where(eq(formTemplates.id, idParam(c)));
  if (!template) throw notFound("No template has this ID.");
  return c.json(await detail(template, await isTemplateAdmin(user)));
});

const text = (value: unknown) => (typeof value === "string" ? value : "");
function tooLong(value: string, max: number): string | null {
  const length = [...value].length;
  return length > max ? `Ensure this value has at most ${max} characters (it has ${length}).` : null;
}

/**
 * The mileage rate in EUR (Django's DecimalField of 4 digits, 2 decimal
 * places, at least 0.01), typed with a point or the app's comma.
 */
function mileageRate(value: unknown): { rate: string } | { error: string } {
  const raw = text(value).trim();
  if (!raw) return { error: "This field is required." };
  const normalized = raw.replace(",", ".");
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(normalized)) return { error: "Enter a number." };
  const [whole = "", decimals = ""] = normalized.replace(/^[+-]/, "").split(".");
  const digits = whole.replace(/^0+/, "") + decimals;
  if (decimals.length > 2) return { error: "Ensure that there are no more than 2 decimal places." };
  if (digits.length > 4) return { error: "Ensure that there are no more than 4 digits in total." };
  if (whole.replace(/^0+/, "").length > 2)
    return { error: "Ensure that there are no more than 2 digits before the decimal point." };
  const cents = Math.round(Number(normalized) * 100);
  if (cents < 1) return { error: "Ensure this value is greater than or equal to 0.01." };
  return { rate: (cents / 100).toFixed(2) };
}

type ValidTemplate = {
  values: Omit<typeof formTemplates.$inferInsert, "id" | "updatedAt">;
  fields: (Omit<typeof templateFields.$inferInsert, "templateId"> & { id?: number })[];
};

/** Validates a template and its fields as Django's admin form and inline formset did. */
async function validate(input: Partial<TemplateInput>, existing: FormTemplate | null) {
  const errors: Record<string, string> = {};
  const name = text(input.name).trim();
  const declaration = text(input.declaration).trim();
  const declarationVersion = text(input.declarationVersion).trim();
  const travel = text(input.travel);
  if (!name) errors.name = "This field is required.";
  else if (tooLong(name, 200)) errors.name = tooLong(name, 200)!;
  else {
    const [taken] = await q()
      .select({ id: formTemplates.id })
      .from(formTemplates)
      .where(
        existing
          ? and(eq(formTemplates.name, name), ne(formTemplates.id, existing.id))
          : eq(formTemplates.name, name),
      );
    if (taken) errors.name = "Template with this Name already exists.";
  }
  if (!TRAVEL.has(travel))
    errors.travel = `Select a valid choice. ${travel} is not one of the available choices.`;
  const rate = mileageRate(input.mileageRate);
  if ("error" in rate) errors.mileageRate = rate.error;
  if (!declaration) errors.declaration = "This field is required.";
  if (!declarationVersion) errors.declarationVersion = "This field is required.";
  else if (tooLong(declarationVersion, 80)) errors.declarationVersion = tooLong(declarationVersion, 80)!;

  const fields: ValidTemplate["fields"] = [];
  const keys = new Map<string, number>();
  const given: TemplateFieldInput[] = Array.isArray(input.fields) ? input.fields : [];
  given.forEach((field, index) => {
    const at = (name: string) => `fields.${index}.${name}`;
    const label = text(field.label).trim();
    const key = text(field.key).trim();
    const kind = text(field.kind) || "text";
    const choices = text(field.choices);
    const pattern = text(field.pattern).trim();
    const position = Number(field.position);
    if (!label) errors[at("label")] = "This field is required.";
    else if (tooLong(label, 80)) errors[at("label")] = tooLong(label, 80)!;
    if (!key) errors[at("key")] = "This field is required.";
    else if (tooLong(key, 40)) errors[at("key")] = tooLong(key, 40)!;
    else if (!SLUG.test(key))
      errors[at("key")] = "Enter a valid “slug” consisting of letters, numbers, underscores or hyphens.";
    else if (keys.has(key))
      errors[at("key")] = "Please correct the duplicate data for key, which must be unique.";
    else keys.set(key, index);
    if (kind !== "text" && kind !== "choice")
      errors[at("kind")] = `Select a valid choice. ${kind} is not one of the available choices.`;
    if (!Number.isInteger(position) || position < 0 || position > 32767)
      errors[at("position")] = "Ensure this value is greater than or equal to 0.";
    if (tooLong(pattern, 200)) errors[at("pattern")] = tooLong(pattern, 200)!;
    else if (pattern && !fieldPattern(pattern)) errors[at("pattern")] = "Invalid regular expression.";
    if (kind === "choice" && fieldOptions({ choices }).length === 0)
      errors[at("choices")] = "Enter at least one option.";
    fields.push({
      id: typeof field.id === "number" ? field.id : undefined,
      position: Number.isInteger(position) ? position : 0,
      label,
      key,
      kind,
      choices,
      pattern,
      required: field.required !== false,
    });
  });
  if (Object.keys(errors).length > 0) throw validationError(errors, "Please correct the errors below.");
  const values: ValidTemplate["values"] = {
    name,
    description: text(input.description).trim(),
    intro: text(input.intro).trim(),
    travel,
    mileageEnabled: input.mileageEnabled === true,
    mileageRate: (rate as { rate: string }).rate,
    declaration,
    declarationVersion,
  };
  return { values, fields } satisfies ValidTemplate;
}

async function store(templateId: number, fields: ValidTemplate["fields"]) {
  const kept = fields.filter((field) => field.id !== undefined).map((field) => field.id!);
  await q()
    .delete(templateFields)
    .where(
      kept.length
        ? and(eq(templateFields.templateId, templateId), notInArray(templateFields.id, kept))
        : eq(templateFields.templateId, templateId),
    );
  // Keys stay unique per template while fields swap them: free the kept fields' keys first.
  for (const field of fields.filter((item) => item.id !== undefined))
    await q()
      .update(templateFields)
      .set({ key: `__${field.id}` })
      .where(and(eq(templateFields.id, field.id!), eq(templateFields.templateId, templateId)));
  for (const { id, ...field } of fields) {
    if (id !== undefined) {
      const [updated] = await q()
        .update(templateFields)
        .set(field)
        .where(and(eq(templateFields.id, id), eq(templateFields.templateId, templateId)))
        .returning({ id: templateFields.id });
      if (updated) continue;
    }
    await q()
      .insert(templateFields)
      .values({ ...field, templateId });
  }
}

router.post("/admin/templates", async (c) => {
  await requireTemplateAdmin(c);
  const { values, fields } = await validate((await body(c)) as Partial<TemplateInput>, null);
  const created = await atomic(async () => {
    const [template] = await q().insert(formTemplates).values(values).returning();
    await store(template!.id, fields);
    return template!;
  });
  return c.json(await detail(created, true), 201);
});

router.put("/admin/templates/:id", async (c) => {
  const user = await requireEditor(c);
  const id = idParam(c);
  if (!(await isTemplateAdmin(user))) throw forbidden("Only template admins may change templates.");
  const [existing] = await q().select().from(formTemplates).where(eq(formTemplates.id, id));
  if (!existing) throw notFound("No template has this ID.");
  const { values, fields } = await validate((await body(c)) as Partial<TemplateInput>, existing);
  const saved = await atomic(async () => {
    const [template] = await q()
      .update(formTemplates)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(formTemplates.id, id))
      .returning();
    await store(id, fields);
    return template!;
  });
  return c.json(await detail(saved, true));
});

router.delete("/admin/templates/:id", async (c) => {
  const user = await requireEditor(c);
  const id = idParam(c);
  if (!(await isTemplateAdmin(user))) throw forbidden("Only template admins may delete templates.");
  await atomic(async () => {
    const [template] = await q().select().from(formTemplates).where(eq(formTemplates.id, id)).for("update");
    if (!template) throw notFound("No template has this ID.");
    if ((await formCounts([id])).get(id)) throw forbidden("A template with forms cannot be deleted.");
    await q().delete(formTemplates).where(eq(formTemplates.id, id));
  });
  return c.json({ ok: true });
});

export default router;
