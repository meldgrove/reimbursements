/**
 * Form publication: drafts save with gaps, publishing needs complete settings
 * (portal/services/publication.py of the Django version).
 *
 * A form starts as a draft of a template. Every save validates the settings
 * for the status the form has afterwards. A draft accepts gaps and gets a
 * default name and slug; a published form needs its name, slug, an approved
 * recipient, a contact and internal values that fit its template. Publishing
 * keeps the opening schedule, so a published form opens when its schedule
 * says so. Archiving closes a form, gives up the start page and leaves the
 * form out of the forms list; unarchiving returns it as a draft. The first
 * save of a new form is idempotent per creation key, so a retried autosave
 * never creates a second form. Only template admins delete forms, and only
 * drafts or archived forms without participant drafts or claims.
 */
import { randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import { formatDate, parseDate, zonedInstants, zonedParts } from "@reimbursements/shared/dates";
import { isEmail } from "@reimbursements/shared/email";
import type {
  DateTimeInput,
  FormSettings,
  FormStatus,
  PublicationAction,
} from "@reimbursements/shared/api/admin";
import { config } from "../config";
import { claims, drafts, formOwners, forms, type Form, type User } from "../db/schema";
import { atomic, q } from "../db/tx";
import { applied } from "../i18n";
import { isTemplateAdmin, managedForms } from "../auth/roles";
import { FieldValueError, fieldOptions, validateFieldValue, type FormWithTemplate } from "../models";

/** The status a publication action leads to; no action keeps the current one. */
export const ACTIONS: Readonly<Record<PublicationAction, FormStatus | null>> = {
  "": null,
  publish: "published",
  unpublish: "draft",
  archive: "archived",
  unarchive: "draft",
};

/** Settings a draft may leave empty. Internal values may stay empty too. */
export const DRAFT_OPTIONAL: ReadonlySet<string> = new Set(["name", "slug", "recipient", "supportEmail"]);

/** A publication request that cannot be carried out. The message is for the admin area. */
export class Refused extends Error {
  override name = "Refused";
}

/** The status `form` (null for a new form) has after an action of ACTIONS. */
export function statusAfter(form: Pick<Form, "status"> | null, action: string): FormStatus {
  if (!Object.hasOwn(ACTIONS, action)) throw new Refused("Invalid status change.");
  return ACTIONS[action as PublicationAction] ?? (form?.status as FormStatus | undefined) ?? "draft";
}

const SLUG = /^[-a-zA-Z0-9_]+$/;

/** Django's slugify: ASCII letters, digits, hyphens and underscores, lower case. */
export function slugify(value: string): string {
  const ascii = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{ASCII}]/gu, "");
  return ascii
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/[-\s]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

function maxLength(value: string, max: number): string | null {
  const length = [...value].length;
  return length > max ? `Ensure this value has at most ${max} characters (it has ${length}).` : null;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");
/** Django's form fields strip surrounding whitespace, of text areas too. */
const stripped = (value: unknown) => text(value).trim();

/** The form's settings and values once they validated, ready to store. */
export type ValidSettings = Pick<
  Form,
  | "name"
  | "title"
  | "description"
  | "slug"
  | "primary"
  | "opensAt"
  | "closesAt"
  | "instructions"
  | "purposeOptions"
  | "tripStart"
  | "tripEnd"
  | "recipient"
  | "supportEmail"
  | "fieldValues"
  | "status"
>;

export type Validation =
  { ok: true; settings: ValidSettings } | { ok: false; errors: Record<string, string> };

/** A date of the app date format (or ISO) as YYYY-MM-DD, null when empty; undefined when invalid. */
function dateValue(value: unknown): string | null | undefined {
  const raw = stripped(value);
  if (!raw) return null;
  return parseDate(raw, applied().dateFormat) ?? undefined;
}

/**
 * A time entered in the app timezone (Django's SplitDateTimeField): both
 * parts or none. Returns the instant, null when empty, or an error message.
 * A time the clocks skip or repeat is refused, as Django refused it.
 * `kept`: the stored instant, which stays as it is while its date and time
 * are sent back unchanged (the editor shows no fractions of a second).
 */
function dateTimeValue(
  value: Partial<DateTimeInput> | null | undefined,
  kept: Date | null,
): Date | null | string {
  const date = stripped(value?.date);
  const time = stripped(value?.time);
  if (!date && !time) return null;
  if (kept) {
    const shown = moment(kept);
    if (date === shown.date && time === shown.time) return kept;
  }
  const day = date ? parseDate(date, applied().dateFormat) : null;
  if (!day) return "Enter a valid date.";
  if (!time || !/^\d{1,2}:\d{2}(?::\d{2})?$/.test(time)) return "Enter a valid time.";
  const { timezone } = applied();
  const instants = zonedInstants(day, time, timezone);
  if (!instants) return "Enter a valid time.";
  if (instants.length !== 1) {
    const [hour, minute, second = "00"] = time.split(":");
    const wall = `${day} ${hour!.padStart(2, "0")}:${minute}:${second}`;
    return `${wall} couldn’t be interpreted in time zone ${timezone}; it may be ambiguous or it may not exist.`;
  }
  return instants[0]!;
}

/** An instant as the editor shows it: a date in the app date format and a time in its timezone. */
function moment(value: Date | null): DateTimeInput {
  if (!value) return { date: "", time: "" };
  const { dateFormat, timezone } = applied();
  const parts = zonedParts(value, timezone);
  const two = (number: number) => String(number).padStart(2, "0");
  const day = `${String(parts.year).padStart(4, "0")}-${two(parts.month)}-${two(parts.day)}`;
  // Seconds only when there are some, so a save keeps them (Django's time field showed them).
  const time = `${two(parts.hour)}:${two(parts.minute)}${parts.second ? `:${two(parts.second)}` : ""}`;
  return { date: formatDate(day, dateFormat), time };
}

/**
 * Validates a form's settings for the status it will have once saved
 * (Django's SettingsForm of a template and status): missing settings count
 * as empty. A form editor cannot choose the start page: the current choice
 * stays (`canChoosePrimary` false).
 */
export async function validateSettings(
  template: Pick<FormWithTemplate, "fields">,
  status: FormStatus,
  input: Partial<FormSettings>,
  options: { existing?: Form | null; canChoosePrimary: boolean },
): Promise<Validation> {
  const existing = options.existing ?? null;
  const drafting = status !== "published";
  const errors: Record<string, string> = {};
  const required = (name: string) => !(drafting && DRAFT_OPTIONAL.has(name));

  let name = stripped(input.name);
  const title = stripped(input.title);
  const description = stripped(input.description);
  let slug = stripped(input.slug);
  const instructions = stripped(input.instructions);
  const purposeOptions = stripped(input.purposeOptions);
  const recipient = stripped(input.recipient);
  const supportEmail = stripped(input.supportEmail);

  if (!name && required("name")) errors.name = "This field is required.";
  else if (maxLength(name, 200)) errors.name = maxLength(name, 200)!;
  if (maxLength(title, 200)) errors.title = maxLength(title, 200)!;
  if (!slug && required("slug")) errors.slug = "This field is required.";
  else if (slug && maxLength(slug, 50)) errors.slug = maxLength(slug, 50)!;
  else if (slug && !SLUG.test(slug))
    errors.slug = "Enter a valid “slug” consisting of letters, numbers, underscores or hyphens.";

  const approved = config().APPROVED_DELIVERY_RECIPIENTS;
  if (!recipient) {
    if (required("recipient")) errors.recipient = "This field is required.";
  } else if (!approved.includes(recipient)) {
    errors.recipient = `Select a valid choice. ${recipient} is not one of the available choices.`;
  }
  if (!supportEmail) {
    if (required("supportEmail")) errors.supportEmail = "This field is required.";
  } else if (maxLength(supportEmail, 254) || !isEmail(supportEmail)) {
    errors.supportEmail = "Enter a valid email address.";
  }

  const tripStart = dateValue(input.tripStart);
  if (tripStart === undefined) errors.tripStart = "Enter a valid date.";
  const tripEnd = dateValue(input.tripEnd);
  if (tripEnd === undefined) errors.tripEnd = "Enter a valid date.";
  const opensAt = dateTimeValue(input.opensAt, existing?.opensAt ?? null);
  if (typeof opensAt === "string") errors.opensAt = opensAt;
  const closesAt = dateTimeValue(input.closesAt, existing?.closesAt ?? null);
  if (typeof closesAt === "string") errors.closesAt = closesAt;

  // Drafts get a name and a link of their own.
  if (drafting) {
    if (!errors.name && !name) name = "New form";
    if (!errors.slug && !slug) {
      const stem = slugify(name).slice(0, 30) || "form";
      slug = existing?.slug || `${stem}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    }
  }

  const values: Record<string, string> = {};
  const given = input.values ?? {};
  for (const field of template.fields) {
    const key = `values.${field.key}`;
    const raw = typeof given[field.key] === "string" ? given[field.key]! : "";
    if (raw.trim() && maxLength(raw.trim(), 200)) {
      errors[key] = maxLength(raw.trim(), 200)!;
      continue;
    }
    // The choice field of a value refuses anything but its options, in drafts too.
    if (field.kind === "choice" && raw.trim() && !fieldOptions(field).includes(raw.trim())) {
      errors[key] = `Select a valid choice. ${raw.trim()} is not one of the available choices.`;
      continue;
    }
    if (drafting && !raw.trim()) {
      values[field.key] = "";
      continue;
    }
    try {
      values[field.key] = validateFieldValue(field, raw);
    } catch (error) {
      if (!(error instanceof FieldValueError)) throw error;
      errors[key] = error.message;
    }
  }

  if (tripStart && tripEnd && tripStart > tripEnd && !errors.tripEnd)
    errors.tripEnd = "The trip cannot end before it starts.";
  if (opensAt instanceof Date && closesAt instanceof Date && opensAt >= closesAt && !errors.closesAt)
    errors.closesAt = "The closing time must be after the opening time.";

  if (!errors.slug && slug) {
    const [taken] = await q()
      .select({ id: forms.id })
      .from(forms)
      .where(existing ? and(eq(forms.slug, slug), ne(forms.id, existing.id)) : eq(forms.slug, slug));
    if (taken) errors.slug = "Form with this Short name for the link already exists.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    settings: {
      name,
      title,
      description,
      slug,
      // The start page changes only when the editor sends it: a save of other
      // settings keeps a handover made meanwhile.
      primary:
        options.canChoosePrimary && typeof input.primary === "boolean"
          ? input.primary
          : (existing?.primary ?? false),
      opensAt: opensAt as Date | null,
      closesAt: closesAt as Date | null,
      instructions,
      purposeOptions,
      tripStart: tripStart ?? null,
      tripEnd: tripEnd ?? null,
      recipient,
      supportEmail,
      fieldValues: values,
      status,
    },
  };
}

/** A form's settings as the editor shows them: dates in the app date format, times in its timezone. */
export function settingsOf(form: Form): FormSettings {
  const { dateFormat } = applied();
  return {
    name: form.name,
    slug: form.slug,
    primary: form.primary,
    opensAt: moment(form.opensAt),
    closesAt: moment(form.closesAt),
    title: form.title,
    description: form.description,
    instructions: form.instructions,
    purposeOptions: form.purposeOptions,
    tripStart: form.tripStart ? formatDate(form.tripStart, dateFormat) : "",
    tripEnd: form.tripEnd ? formatDate(form.tripEnd, dateFormat) : "",
    recipient: form.recipient,
    supportEmail: form.supportEmail,
    values: { ...form.fieldValues },
  };
}

/**
 * Stores a form whose settings validated; a new form records its creation key.
 * The start page is one form at most: marking another one hands it over.
 * The creator owns a new form. Form editors stay owners of every form they
 * save, so nobody locks themselves out of a form they are editing.
 */
export async function save(
  settings: ValidSettings,
  person: Pick<User, "id" | "isActive" | "isSuperuser">,
  options: { existing?: Form | null; templateId: number; creationKey?: string | null },
): Promise<Form> {
  return atomic(async () => {
    const values = { ...settings, primary: settings.status === "archived" ? false : settings.primary };
    if (values.primary) {
      const others = options.existing
        ? and(eq(forms.primary, true), ne(forms.id, options.existing.id))
        : eq(forms.primary, true);
      await q().update(forms).set({ primary: false }).where(others);
    }
    let form: Form;
    if (options.existing) {
      [form] = (await q()
        .update(forms)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(forms.id, options.existing.id))
        .returning()) as [Form];
    } else {
      [form] = (await q()
        .insert(forms)
        .values({ ...values, templateId: options.templateId, creationKey: options.creationKey ?? null })
        .returning()) as [Form];
    }
    if (!options.existing || !(await isTemplateAdmin(person))) {
      await q().insert(formOwners).values({ formId: form.id, userId: person.id }).onConflictDoNothing();
    }
    return form;
  });
}

/** The form an earlier first save with this creation key made, if this person manages it. */
export async function created(
  person: Pick<User, "id" | "isActive" | "isSuperuser">,
  creationKey: string,
): Promise<Form | null> {
  const [form] = await q()
    .select()
    .from(forms)
    .where(and(eq(forms.creationKey, creationKey), await managedForms(person)));
  return form ?? null;
}

/** Archives a form, or returns an archived form as a draft. Returns whether it changed. */
export async function setArchived(form: Pick<Form, "id" | "status">, archived: boolean): Promise<boolean> {
  if (archived === (form.status === "archived")) return false;
  await q()
    .update(forms)
    .set(
      archived
        ? { status: "archived", primary: false, updatedAt: new Date() }
        : { status: "draft", updatedAt: new Date() },
    )
    .where(eq(forms.id, form.id));
  return true;
}

/** Only template admins delete forms, and only drafts or archived forms without claims or drafts. */
export async function mayDelete(
  person: Pick<User, "id" | "isActive" | "isSuperuser">,
  form: Pick<Form, "id" | "status">,
): Promise<boolean> {
  if (!(await isTemplateAdmin(person)) || form.status === "published") return false;
  const [used] = await q()
    .select({ one: sql`1` })
    .from(forms)
    .where(
      and(
        eq(forms.id, form.id),
        sql`(exists (select 1 from ${claims} where ${claims.formId} = ${forms.id}) or exists (select 1 from ${drafts} where ${drafts.formId} = ${forms.id}))`,
      ),
    );
  return !used;
}
