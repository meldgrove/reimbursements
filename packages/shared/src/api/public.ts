/**
 * The participant API (/api/v1/public/…): the form page, uploads, live
 * validation, submission and the received page. Texts in answers are in the
 * app language already.
 */

/** Errors of fields, as the Django version reported them: per field a list of messages. */
export type FieldErrors = Record<string, Array<{ message: string; code: string }>>;

/** An error answer: `{ error: { code, message, fields? } }`. */
export type PublicError = { error: { code: string; message: string; fields?: FieldErrors } };

/** GET /api/v1/public/start: where the start page sends participants. */
export type StartAnswer = { redirect: string | null };

/** GET /api/v1/public/privacy: the current privacy notice. */
export type PrivacyAnswer = {
  notice: { text: string; version: number; createdAt: string; date: string } | null;
};

export type Travel = "off" | "optional" | "required";

/** Limits, messages and formats the form page applies (intake.client_config). */
export type ClientConfig = {
  limits: {
    receipt_bytes: number;
    submission_bytes: number;
    signature_bytes: number;
    expenses: number;
    files_per_expense: number;
    pdf_pages: number;
    claim_pages: number;
  };
  amount_pattern: string;
  max_distance_km: number;
  /** Participant messages by code, with the current limits. */
  messages: Record<string, string>;
  /** The page's own texts by key. */
  text: Record<string, string>;
  locale: string;
  decimal_separator: string;
  thousands_separator: string;
};

/** GET /api/v1/public/forms/<slug> while the form takes claims (or for a preview by an owner). */
export type FormPage = {
  state: "open" | "preview";
  form: {
    slug: string;
    name: string;
    title: string;
    description: string;
    /** "Submit by …" with the closing time, or "". */
    deadline: string;
    /** The template's notes and the form's notes for participants. */
    intro: string;
    instructions: string;
    supportEmail: string;
    tripStart: string;
    tripEnd: string;
  };
  terms: {
    declaration: string;
    privacyText: string;
    travel: Travel;
    /** EUR per km ("0.30"), or null without mileage. */
    mileageRate: string | null;
    purposeOptions: string[];
    fixedPurpose: string | null;
  };
  /** The participant's draft; null in a preview. */
  draft: { id: string; token: string } | null;
  config: ClientConfig & {
    /** The app date format as a pattern, e.g. DD.MM.YYYY. */
    date_format: string;
    amount_placeholder: string;
    field_lengths: Record<string, number>;
  };
  /** (code, name) pairs in the app language. */
  countries: Array<[string, string]>;
  /** The test environment banner. */
  development: boolean;
  /** Whether participants receive a confirmation of receipt (Admin > Email): the email field's hint. */
  confirmation: boolean;
};

/** GET /api/v1/public/forms/<slug> when the form takes no claims (HTTP 403, 404, 409, 429 or 503). */
export type ClosedFormPage = {
  state: "closed";
  /** The form's name, for published forms only. */
  name: string | null;
  /** Why, when the form is open but cannot take this participant now. */
  message: string | null;
  supportEmail: string | null;
};

/** POST /api/v1/public/forms/<slug>/uploads (HTTP 202). */
export type UploadAccepted = { id: string; state: string; name: string; size: number };

/** GET /api/v1/public/forms/<slug>/uploads/<id> with the X-Draft-Token header. */
export type UploadStatus = {
  id: string;
  state: "pending" | "ready" | "failed" | string;
  pages: number;
  message: string;
};

/** POST /api/v1/public/forms/<slug>/validate: the errors of the entries so far. */
export type ValidateAnswer = { fields: FieldErrors };

/** POST /api/v1/public/forms/<slug>/submit (HTTP 202). */
export type SubmitAnswer = { reference: string; claimId: string };

/** GET /api/v1/public/received/<claim id>: the participant's view of their claim. */
export type ReceivedAnswer = {
  reference: string;
  /** processing, problem or delivered. */
  state: "processing" | "problem" | "delivered" | string;
  final: boolean;
  form: { name: string; supportEmail: string };
};
