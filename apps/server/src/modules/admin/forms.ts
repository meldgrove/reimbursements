import { Hono, type Context } from "hono";
import { and, asc, count, desc, eq, ilike, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { FORM_DESCRIPTION, FORM_TITLE } from "@reimbursements/shared/constants";
import { dateFormat } from "@reimbursements/shared/dates";
import { translate } from "@reimbursements/shared/i18n";
import type {
  FormEditor,
  FormList,
  FormRow,
  FormSaveInput,
  FormSaved,
  FormStatus,
  TemplateChoice,
  ValueField,
} from "@reimbursements/shared/api/admin";
import { config } from "../../config";
import {
  formTemplates,
  forms,
  templateFields,
  type Form,
  type TemplateField,
  type User,
} from "../../db/schema";
import { atomic, q } from "../../db/tx";
import type { AppEnv } from "../../http/env";
import { AppError, forbidden, notFound, validationError } from "../../http/errors";
import { idParam, requireEditor, requireTemplateAdmin } from "../../http/middleware";
import { applied, formatDateTime } from "../../i18n";
import { isTemplateAdmin, managedForms } from "../../auth/roles";
import { currentPrivacyNotice, fieldOptions, internalValueErrors, templateFieldsOf } from "../../models";
import { loadSettings } from "../../services/app-settings";
import * as publication from "../../services/publication";
import { NO_PRIVACY_NOTICE, refusal, UNAPPROVED_RECIPIENT } from "../../services/terms";
import { absolute, archivingMessage, body, contains, idsOf, pageOf, pagesOf, PAGE_SIZE } from "./common";

/**
 * Forms in the admin area (FormAdmin of portal/admin.py): the list with the
 * Open now column, choosing a template for a new form, the editor that saves
 * as one types (portal/static/portal/admin-form.js), publication, archiving
 * and deletion. Form editors manage their own forms, template admins every
 * form; only template admins choose the start page and delete.
 */
const router = new Hono<AppEnv>();

/** Why an open form takes no claims; the other columns show why a form is closed. */
const UNAVAILABLE: Record<string, string> = {
  [UNAPPROVED_RECIPIENT]: "Receiving inbox not approved",
  [NO_PRIVACY_NOTICE]: "No privacy notice",
};

const STATUSES: ReadonlySet<string> = new Set(["draft", "published", "archived"]);

async function fieldsByTemplate(templateIds: number[]): Promise<Map<number, TemplateField[]>> {
  const map = new Map<number, TemplateField[]>();
  if (templateIds.length === 0) return map;
  const rows = await q()
    .select()
    .from(templateFields)
    .where(inArray(templateFields.templateId, templateIds))
    .orderBy(asc(templateFields.position), asc(templateFields.id));
  for (const row of rows) map.set(row.templateId, [...(map.get(row.templateId) ?? []), row]);
  return map;
}

router.get("/admin/forms", async (c) => {
  const user = await requireEditor(c);
  const status = c.req.query("status") ?? "";
  const primary = c.req.query("primary") ?? "";
  const template = c.req.query("template") ?? "";
  const term = (c.req.query("q") ?? "").trim().slice(0, 200);
  const conditions: SQL[] = [await managedForms(user)];
  conditions.push(STATUSES.has(status) ? eq(forms.status, status) : ne(forms.status, "archived"));
  if (primary === "1" || primary === "0") conditions.push(eq(forms.primary, primary === "1"));
  if (/^[1-9][0-9]{0,15}$/.test(template)) conditions.push(eq(forms.templateId, Number(template)));
  if (term) {
    const words = term.split(/\s+/);
    for (const word of words)
      conditions.push(or(ilike(forms.name, contains(word)), ilike(forms.slug, contains(word)))!);
  }
  const where = and(...conditions);
  const { page, offset } = pageOf(c);
  const [{ total } = { total: 0 }] = await q().select({ total: count() }).from(forms).where(where);
  const rows = await q()
    .select({ form: forms, template: formTemplates })
    .from(forms)
    .innerJoin(formTemplates, eq(formTemplates.id, forms.templateId))
    .where(where)
    .orderBy(desc(forms.createdAt), desc(forms.id))
    .limit(PAGE_SIZE)
    .offset(offset);
  const fields = await fieldsByTemplate([...new Set(rows.map((row) => row.template.id))]);
  // The privacy notice decides every row's Open now: read once per page.
  const notice = await currentPrivacyNotice();
  const now = new Date();
  const result: FormRow[] = rows.map(({ form, template: formTemplate }) => {
    const full = { ...form, template: formTemplate, fields: fields.get(formTemplate.id) ?? [] };
    const refused = refusal(full, notice, now);
    return {
      id: form.id,
      name: form.name,
      slug: form.slug,
      template: formTemplate.name,
      status: form.status as FormStatus,
      primary: form.primary,
      valuesComplete: internalValueErrors(full).length === 0,
      openNow: !refused,
      unavailable: UNAVAILABLE[refused] ?? "",
      closesAt: form.closesAt ? formatDateTime(form.closesAt) : "",
      link: absolute(`/f/${form.slug}/`),
    };
  });
  const templates = await q()
    .select({ id: formTemplates.id, name: formTemplates.name })
    .from(formTemplates)
    .orderBy(asc(formTemplates.name));
  const answer: FormList = {
    rows: result,
    count: total,
    page,
    pages: pagesOf(total),
    templates: templates.map((row) => ({ value: String(row.id), label: row.name })),
    canDelete: await isTemplateAdmin(user),
  };
  return c.json(answer);
});

/** Templates a new form can start from (step 1 of a new form). */
router.get("/admin/forms/templates", async (c) => {
  await requireEditor(c);
  const rows = await q()
    .select({ id: formTemplates.id, name: formTemplates.name, description: formTemplates.description })
    .from(formTemplates)
    .orderBy(asc(formTemplates.name));
  return c.json(rows satisfies TemplateChoice[]);
});

async function templateOf(id: number) {
  const [template] = await q().select().from(formTemplates).where(eq(formTemplates.id, id));
  if (!template) throw notFound("No template has this ID.");
  const fields = await q()
    .select()
    .from(templateFields)
    .where(eq(templateFields.templateId, id))
    .orderBy(asc(templateFields.position), asc(templateFields.id));
  return { ...template, fields };
}

function templateQuery(c: Context<AppEnv>): number {
  const value = c.req.query("template") ?? "";
  if (!/^[1-9][0-9]{0,15}$/.test(value)) throw notFound("No template has this ID.");
  return Number(value);
}

/** A form the person manages (404 for any other, like an unknown one). */
async function managedForm(user: User, id: number, options: { forUpdate?: boolean } = {}) {
  const condition = and(eq(forms.id, id), await managedForms(user));
  const query = q().select().from(forms).where(condition);
  const [form] = options.forUpdate ? await query.for("update") : await query;
  if (!form) throw notFound("This form does not exist or you may not manage it.");
  return form;
}

async function state(user: User, form: Form): Promise<FormSaved> {
  return {
    id: form.id,
    name: form.name,
    slug: form.slug,
    status: form.status as FormStatus,
    primary: form.primary,
    link: `/f/${form.slug}/`,
    canDelete: await publication.mayDelete(user, form),
  };
}

async function editor(
  user: User,
  template: Awaited<ReturnType<typeof templateOf>>,
  form: Form | null,
): Promise<FormEditor> {
  const approved = config().APPROVED_DELIVERY_RECIPIENTS;
  const settings = form
    ? publication.settingsOf(form)
    : {
        ...publication.settingsOf({
          name: "",
          slug: "",
          primary: false,
          opensAt: null,
          closesAt: null,
          title: "",
          description: "",
          instructions: "",
          purposeOptions: "",
          tripStart: null,
          tripEnd: null,
          recipient: approved.length === 1 ? approved[0]! : "",
          supportEmail: user.email,
          fieldValues: {},
        } as unknown as Form),
      };
  for (const field of template.fields) settings.values[field.key] ??= "";
  // Empty texts show the standard ones, in the language participants see.
  const language = (await loadSettings()).language;
  const fields: ValueField[] = template.fields.map((field) => ({
    key: field.key,
    label: field.label,
    kind: field.kind === "choice" ? "choice" : "text",
    options: fieldOptions(field),
    required: field.required,
  }));
  return {
    form: form ? await state(user, form) : null,
    settings,
    template: {
      id: template.id,
      name: template.name,
      travel: template.travel as FormEditor["template"]["travel"],
      fields,
    },
    recipients: approved,
    canChoosePrimary: await isTemplateAdmin(user),
    standardTitle: translate(language, FORM_TITLE),
    standardDescription: translate(language, FORM_DESCRIPTION),
    datePattern: dateFormat(applied().dateFormat).pattern,
    timezone: applied().timezone,
    invalidValues:
      form && form.status === "published" ? internalValueErrors({ ...form, fields: template.fields }) : [],
  };
}

router.get("/admin/forms/new", async (c) => {
  const user = await requireEditor(c);
  return c.json(await editor(user, await templateOf(templateQuery(c)), null));
});

router.get("/admin/forms/:id", async (c) => {
  const user = await requireEditor(c);
  const form = await managedForm(user, idParam(c));
  return c.json(await editor(user, await templateOf(form.templateId), form));
});

/**
 * Saves a form's settings, with a publication change (`action`) or none.
 * Errors answer 422 with a message per setting (`values.<key>` for internal
 * values); the form keeps what it had. An existing form is read again under
 * a row lock, so the status and the start page follow what it has now: a
 * save that raced an archiving or a handover does not undo them.
 */
async function saveForm(
  user: User,
  input: FormSaveInput,
  target: { form: Form } | { templateId: number; creationKey: string | null },
): Promise<FormSaved> {
  return atomic(async () => {
    if ("form" in target && input.primary === true) {
      // Every writer locks forms in id order (bulk deletion too), so a handover never
      // holds its own form while it waits for the current start page.
      const current = await q().select({ id: forms.id }).from(forms).where(eq(forms.primary, true));
      const ids = [...new Set([target.form.id, ...current.map((row) => row.id)])];
      await q()
        .select({ id: forms.id })
        .from(forms)
        .where(inArray(forms.id, ids))
        .orderBy(asc(forms.id))
        .for("update");
    }
    const existing = "form" in target ? await managedForm(user, target.form.id, { forUpdate: true }) : null;
    let status: FormStatus;
    try {
      status = publication.statusAfter(existing, typeof input.action === "string" ? input.action : "");
    } catch (error) {
      if (error instanceof publication.Refused) throw new AppError(400, "refused", error.message);
      throw error;
    }
    const templateId = existing ? existing.templateId : (target as { templateId: number }).templateId;
    const template = { fields: await templateFieldsOf(templateId) };
    const validation = await publication.validateSettings(template, status, input, {
      existing,
      canChoosePrimary: await isTemplateAdmin(user),
    });
    if (!validation.ok) throw validationError(validation.errors, "Please correct the marked fields.");
    const form = await publication.save(validation.settings, user, {
      existing,
      templateId,
      creationKey: existing ? null : (target as { creationKey: string | null }).creationKey,
    });
    return state(user, form);
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The first save of a new form; a retry with the same creation key updates
 * the form it made. Saves with the same key wait for each other (an advisory
 * lock until the transaction ends), so a retry that overtakes its timed-out
 * first save finds that form instead of reporting its link as taken.
 */
router.post("/admin/forms", async (c) => {
  const user = await requireEditor(c);
  const input = (await body(c)) as FormSaveInput;
  const templateId = templateQuery(c);
  const key = input.creationKey;
  if (key !== undefined && (typeof key !== "string" || !UUID.test(key)))
    throw new AppError(400, "bad_request", "Invalid request. Please reload the page.");
  const creationKey = key ? key.toLowerCase() : null;
  return atomic(async () => {
    if (creationKey)
      await q().execute(sql`select pg_advisory_xact_lock(hashtext(${`form-creation:${creationKey}`}))`);
    const earlier = creationKey ? await publication.created(user, creationKey) : null;
    if (earlier) return c.json(await saveForm(user, input, { form: earlier }));
    await templateOf(templateId);
    return c.json(await saveForm(user, input, { templateId, creationKey }), 201);
  });
});

router.put("/admin/forms/:id", async (c) => {
  const user = await requireEditor(c);
  const id = idParam(c);
  const input = (await body(c)) as FormSaveInput;
  const form = await managedForm(user, id);
  return c.json(await saveForm(user, input, { form }));
});

/** Archives or unarchives the selected forms the person manages. */
router.post("/admin/forms/archive", async (c) => {
  const user = await requireEditor(c);
  const input = await body(c);
  const archived = input.archived !== false;
  const ids = idsOf(input.ids, /^[1-9][0-9]{0,15}$/).map(Number);
  const selected = await q()
    .select()
    .from(forms)
    .where(and(inArray(forms.id, ids), await managedForms(user)));
  let changed = 0;
  for (const form of selected) if (await publication.setArchived(form, archived)) changed += 1;
  return c.json({ changed, message: archivingMessage(changed, "form", archived) });
});

async function deleteForms(user: User, ids: number[]) {
  const selected = await q()
    .select()
    .from(forms)
    .where(and(inArray(forms.id, ids), await managedForms(user)))
    .orderBy(asc(forms.id))
    .for("update");
  for (const form of selected)
    if (!(await publication.mayDelete(user, form)))
      throw forbidden("Only drafts and archived forms without claims can be deleted.");
  if (selected.length > 0)
    await q()
      .delete(forms)
      .where(
        inArray(
          forms.id,
          selected.map((form) => form.id),
        ),
      );
  return selected.length;
}

/** Deletes a draft or an archived form without claims or participant drafts (template admins). */
router.delete("/admin/forms/:id", async (c) => {
  const user = await requireEditor(c);
  const form = await managedForm(user, idParam(c));
  if (!(await publication.mayDelete(user, form)))
    throw forbidden("Only drafts and archived forms without claims can be deleted.");
  await atomic(() => deleteForms(user, [form.id]));
  return c.json({ ok: true });
});

/** Deletes the selected forms, all or none (Django's delete_selected for template admins). */
router.post("/admin/forms/delete", async (c) => {
  const user = await requireTemplateAdmin(c);
  const ids = idsOf((await body(c)).ids, /^[1-9][0-9]{0,15}$/).map(Number);
  const deleted = await atomic(() => deleteForms(user, ids));
  return c.json({
    deleted,
    message: deleted === 1 ? "1 form was deleted." : `${deleted} forms were deleted.`,
  });
});

export default router;
