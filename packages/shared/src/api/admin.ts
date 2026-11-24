/**
 * The admin area's API (/api/v1/admin/...): claims, forms, templates, the
 * privacy notice, the General, Email and Appearance settings and the search. The
 * admin area is always English; dates and amounts arrive already formatted
 * in the app's date and number format.
 */
import { z } from "zod";

/** A badge: its text and tone (a Badge variant of @meldgrove/ui, e.g. success). */
export type Badge = { label: string; tone: string };

/** One page of a list (Django's change list: 100 rows a page). */
export type Paged<T> = { rows: T[]; count: number; page: number; pages: number };

/** A filter's options: value and label; the empty value is the default ("All"). */
export type FilterOption = { value: string; label: string };

// -- Forms ------------------------------------------------------------------------

export type FormStatus = "draft" | "published" | "archived";
export const FORM_STATUS_LABELS: Readonly<Record<FormStatus, string>> = {
  draft: "Draft",
  published: "Published",
  archived: "Archived",
};
export const FORM_STATUS_TONES: Readonly<Record<FormStatus, string>> = {
  draft: "secondary",
  published: "success",
  archived: "outline",
};

/** A publication change of the form editor; "" keeps the status. */
export type PublicationAction = "" | "publish" | "unpublish" | "archive" | "unarchive";
export const PUBLICATION_ACTIONS: readonly PublicationAction[] = [
  "",
  "publish",
  "unpublish",
  "archive",
  "unarchive",
];

export type FormRow = {
  id: number;
  name: string;
  slug: string;
  template: string;
  status: FormStatus;
  primary: boolean;
  /** The internal values fit the template. */
  valuesComplete: boolean;
  /** The form takes claims now. */
  openNow: boolean;
  /** Why an open form takes no claims ("Receiving inbox not approved"), or "". */
  unavailable: string;
  /** The closing time in the app's date format and timezone, or "". */
  closesAt: string;
  /** The form's address, e.g. https://reimbursements.example.invalid/f/workshop/. */
  link: string;
};

export type FormList = Paged<FormRow> & {
  templates: FilterOption[];
  /** Template admins delete forms (drafts and archived forms without claims). */
  canDelete: boolean;
};

/** A time entered in the app timezone: the date in the app date format and the time (HH:MM). */
export type DateTimeInput = { date: string; time: string };

/** What the form editor sends: every setting of a form (missing ones count as empty). */
export type FormSettings = {
  name: string;
  slug: string;
  primary: boolean;
  opensAt: DateTimeInput;
  closesAt: DateTimeInput;
  title: string;
  description: string;
  instructions: string;
  purposeOptions: string;
  /** Dates in the app date format. */
  tripStart: string;
  tripEnd: string;
  recipient: string;
  supportEmail: string;
  /** The internal values by template field key. */
  values: Record<string, string>;
};

export type FormSaveInput = Partial<FormSettings> & {
  /** Sent with every first save of a new form, so a retried one finds the form it made. */
  creationKey?: string;
  action?: PublicationAction;
};

/** A template field as the form editor shows it. */
export type ValueField = {
  key: string;
  label: string;
  kind: "text" | "choice";
  options: string[];
  required: boolean;
};

/** The form editor's state of a saved form. */
export type FormState = {
  id: number;
  name: string;
  slug: string;
  status: FormStatus;
  primary: boolean;
  /** The participants' page, /f/<slug>/. */
  link: string;
  canDelete: boolean;
};

export type FormEditor = {
  /** Null for a new form. */
  form: FormState | null;
  settings: FormSettings;
  template: { id: number; name: string; travel: "off" | "optional" | "required"; fields: ValueField[] };
  /** The approved Finance inboxes (APPROVED_DELIVERY_RECIPIENTS). */
  recipients: string[];
  /** Only template admins choose the start page. */
  canChoosePrimary: boolean;
  /** The standard texts participants see while title or description are empty (app language). */
  standardTitle: string;
  standardDescription: string;
  /** E.g. DD.MM.YYYY, and the timezone opening times are entered in. */
  datePattern: string;
  timezone: string;
  /** Labels of internal values that do not fit the template (the form stays closed). */
  invalidValues: string[];
};

/** The answer of a save: the form as it is now. */
export type FormSaved = FormState;

export type TemplateChoice = { id: number; name: string; description: string };

// -- Templates ----------------------------------------------------------------------

export type Travel = "off" | "optional" | "required";
export const TRAVEL_LABELS: Readonly<Record<Travel, string>> = {
  off: "No travel details",
  optional: "Optional (participants choose)",
  required: "Required",
};

export type TemplateRow = {
  id: number;
  name: string;
  travel: Travel;
  mileageEnabled: boolean;
  forms: number;
  updatedAt: string;
};

export type TemplateFieldInput = {
  /** The saved field's id; absent for a new one. */
  id?: number;
  position: number;
  label: string;
  key: string;
  kind: "text" | "choice";
  choices: string;
  pattern: string;
  required: boolean;
};

export type TemplateInput = {
  name: string;
  description: string;
  intro: string;
  travel: Travel;
  mileageEnabled: boolean;
  /** EUR per kilometre, in the app number format or with a point. */
  mileageRate: string;
  declaration: string;
  declarationVersion: string;
  fields: TemplateFieldInput[];
};

export type TemplateDetail = {
  /** Null for a new template. */
  id: number | null;
  template: TemplateInput;
  forms: number;
  /** Template admins change templates; form editors only look. */
  canChange: boolean;
  canDelete: boolean;
};

// -- Privacy notice -------------------------------------------------------------------

export type PrivacyNoticeRow = {
  id: number;
  version: number;
  createdAt: string;
  createdBy: string;
  current: boolean;
};

// -- Settings -------------------------------------------------------------------------

/**
 * PUT /api/v1/admin/settings/general, also `cli settings apply general`. `operator` and
 * `legalUrl` left out keep their saved values.
 */
export type GeneralSettingsForm = {
  language: "de" | "en";
  timezone: string;
  dateFormat: string;
  numberFormat: string;
  /** Who runs the app, shown in the footer of public pages; "" for none. */
  operator?: string;
  /** The address of the operator's legal page (imprint), http or https; "" for none. */
  legalUrl?: string;
};

export type GeneralSettingsPage = {
  settings: Required<GeneralSettingsForm>;
  /**
   * Variables of earlier versions' environment that are still set although the app no
   * longer reads them (PORTAL_OPERATOR, PORTAL_LEGAL_URL), with what to do; "" for none.
   */
  environmentNote: string;
  choices: {
    languages: FilterOption[];
    timezones: FilterOption[];
    dateFormats: FilterOption[];
    numberFormats: FilterOption[];
  };
  /** The running version, or "Built from source". */
  version: string;
};

/**
 * POST /api/v1/admin/settings/appearance as JSON, also `cli settings apply appearance`.
 * The page sends the same fields as a multipart form, with a new favicon as `favicon`.
 */
export type AppearanceForm = {
  /** A hex code such as #0f766e; "" for the standard colors. */
  accentColor: string;
  /** true: back to the standard favicon. */
  removeFavicon?: boolean;
};

export type AppearancePage = {
  accentColor: string;
  /** The colors in use, light and dark (the standard ones without an accent). */
  inUse: { custom: boolean; light: string; dark: string };
  favicon: { custom: boolean; url: string; type: string };
  /** A warning after saving, e.g. that links in a light color are hard to read. */
  warning?: string;
};

// -- Email (Admin > Email) ---------------------------------------------------------

export type EmailProvider = "" | "mailersend" | "smtp";
export type SmtpSecurity = "starttls" | "tls" | "none";
export type EmailSecretName = "mailersendToken" | "webhookSecret" | "smtpPassword";

const formText = z.string().default("");

/**
 * PUT /api/v1/admin/settings/email, also `cli settings apply email`. A secret field left empty keeps the saved secret, a
 * new value replaces it, `delete…` removes it. A confirmation subject or text left empty,
 * or equal to the standard one, follows the standard text. Field errors (422) are keyed
 * by these names, the confirmation's as `confirmation.<code>.subject` and `….body`.
 */
export const emailSettingsFormSchema = z.object({
  provider: formText,
  fromAddress: formText,
  replyToAddress: formText,
  smtpHost: formText,
  smtpPort: z.union([z.string(), z.number()]).default(""),
  smtpSecurity: formText,
  smtpUsername: formText,
  confirmationEnabled: z.boolean(),
  /** Per language code (de, en). */
  confirmation: z.record(z.string(), z.object({ subject: formText, body: formText })).default({}),
  mailersendToken: formText,
  webhookSecret: formText,
  smtpPassword: formText,
  deleteMailersendToken: z.boolean().default(false),
  deleteWebhookSecret: z.boolean().default(false),
  deleteSmtpPassword: z.boolean().default(false),
});
export type EmailSettingsForm = z.input<typeof emailSettingsFormSchema>;

/** A secret's field: never its value. */
export type EmailSecretState = {
  /** A value is saved, readable or not. */
  saved: boolean;
  /** Saved, but the app's secret no longer opens it: it counts as missing until entered again. */
  unreadable: boolean;
  /** Deleting is offered: a value is saved. */
  deletable: boolean;
  /** The field's placeholder, e.g. "Saved · type a new one to replace it"; "" when nothing is saved. */
  placeholder: string;
};

/** GET /api/v1/admin/settings/email (also the answer of a save, with `message`). */
export type EmailSettingsPage = {
  settings: {
    provider: EmailProvider;
    fromAddress: string;
    replyToAddress: string;
    smtpHost: string;
    smtpPort: number;
    smtpSecurity: SmtpSecurity;
    smtpUsername: string;
    confirmationEnabled: boolean;
    /** The subject and text per language: the admins' own, or the standard ones. */
    confirmation: Record<string, { subject: string; body: string }>;
  };
  secrets: Record<EmailSecretName, EmailSecretState>;
  /**
   * Variables of earlier versions' environment that are still set although the app no
   * longer reads them (MAILERSEND_API_TOKEN …), with what to do; "" for none.
   */
  environmentNote: string;
  /** The Status block. */
  status: {
    state: "local" | "ready" | "not_set_up";
    /** "Local outbox", "Ready" or "Not set up". */
    label: string;
    text: string;
    /** MailerSend without a webhook signing secret; "" otherwise. */
    warning: string;
    /** Saved secrets that no longer open; "" otherwise. */
    unreadable: string;
  };
  /** The MailerSend section's webhook line. */
  webhook: { url: string; receivedAt: string | null; text: string };
  choices: { providers: FilterOption[]; securities: FilterOption[]; languages: FilterOption[] };
  /** What admins may write in braces in the confirmation. */
  placeholders: Array<{ name: string; description: string }>;
  /** The signed-in admin's address, the test email's first recipient. */
  testRecipient: string;
  /** After a save: "The email settings were saved." */
  message?: string;
};

/** POST /api/v1/admin/settings/email/test: one test email with the saved settings. */
export type EmailTestRequest = { to: string };
/** Whether the email reached the provider, and what to tell the admin. */
export type EmailTestAnswer = { reached: boolean; message: string };

// -- Claims ---------------------------------------------------------------------------

export type ClaimRow = {
  id: string;
  /** The bookkeeping reference, or the first 8 characters of the ID. */
  reference: string;
  form: string;
  submittedAt: string;
  fullName: string;
  email: string;
  total: string;
  status: Badge & { code: string };
  archived: boolean;
  overdue: boolean;
};

/** Django's date hierarchy: the current drill-down and the next level's choices. */
export type DateHierarchy = {
  /** Back up: "All dates", then the year, then the month. */
  crumbs: FilterOption[];
  options: FilterOption[];
};

export type ClaimList = Paged<ClaimRow> & {
  forms: FilterOption[];
  statuses: FilterOption[];
  dates: DateHierarchy;
  /** Template admins archive, unarchive and delete claims. */
  canOperate: boolean;
};

export type OperationRow = { id: number; when: string; action: string; actor: string; reason: string };

export type ClaimDetail = {
  id: string;
  reference: string;
  form: string;
  submittedAt: string;
  fullName: string;
  email: string;
  total: string;
  status: Badge & { code: string };
  archived: boolean;
  error: string;
  archivedAt: string;
  pdfRemovedAt: string;
  contentDue: string;
  overdue: boolean;
  operations: OperationRow[];
  /** Template admins process again, archive and delete claims that are not deleted. */
  canOperate: boolean;
};

/** A claim as the confirmations list it. */
export type ClaimSummary = {
  id: string;
  reference: string;
  form: string;
  submittedOn: string;
  fullName: string;
  status: Badge & { code: string };
  archived: boolean;
};

export type RetryPage = {
  claim: ClaimSummary;
  /** What a retry would do: render the PDF again or send it again; null when refused. */
  plan: { action: "render" | "resend"; duplicateRisk: boolean } | null;
  /** Why a retry is not possible now, or "". */
  refused: string;
};

export type DeletePreview = {
  rows: (ClaimSummary & { sent: boolean })[];
};

/** Archiving asks first when it deletes overdue claims at once. */
export type ArchiveAnswer =
  | { confirm: true; overdue: ClaimSummary[]; selected: number; retentionDays: number }
  | { confirm: false; changed: number; message: string };

export type DeleteAnswer = {
  deleted: number;
  /** Claims whose deletion started and finishes in the background. */
  resuming: number;
  refused: { reference: string; message: string }[];
  messages: { tone: "success" | "warning" | "error"; text: string }[];
};

// -- Search ---------------------------------------------------------------------------

export type SearchItem = { name: string; detail: string; url: string; kind: string; reference?: string };
export type SearchGroup = { label: string; items: SearchItem[] };
