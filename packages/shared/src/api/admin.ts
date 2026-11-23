/**
 * The admin area's API (/api/v1/admin/...): claims, forms, templates, the
 * privacy notice, the General and Appearance settings and the search. The
 * admin area is always English; dates and amounts arrive already formatted
 * in the app's date and number format.
 */

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

export type GeneralSettingsForm = {
  language: "de" | "en";
  timezone: string;
  dateFormat: string;
  numberFormat: string;
};

export type GeneralSettingsPage = {
  settings: GeneralSettingsForm;
  choices: {
    languages: FilterOption[];
    timezones: FilterOption[];
    dateFormats: FilterOption[];
    numberFormats: FilterOption[];
  };
  /** The running version, or "Built from source". */
  version: string;
};

export type AppearancePage = {
  accentColor: string;
  /** The colors in use, light and dark (the standard ones without an accent). */
  inUse: { custom: boolean; light: string; dark: string };
  favicon: { custom: boolean; url: string; type: string };
  /** A warning after saving, e.g. that links in a light color are hard to read. */
  warning?: string;
};

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
