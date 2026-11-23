import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * The database: the tables of the Django version (0.1 to 0.4) under their
 * own names, with their columns, constraints and indexes, plus this
 * version's sessions. The first migration (drizzle/0000_django_baseline.sql)
 * creates exactly Django's tables in a new database; src/db/django.ts takes
 * over a Django database in place. Django's own tables (sessions,
 * permissions, content types, admin log, its migration list) stay in a
 * taken-over database for the version before and are not described here.
 *
 * Like Django, the tables have no defaults in the database: the defaults are
 * the application's (`$defaultFn`). Foreign keys carry the rules on delete
 * Django applied itself (cascade, set null, and protect as restrict).
 *
 * Amounts (numeric) come back as strings such as "12.50"; dates (date) as
 * "YYYY-MM-DD"; times (timestamp with time zone) as Date.
 */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

const now = () => new Date();
const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

// -- Django's users and groups --------------------------------------------------

/**
 * People who sign in to the admin area, keyed by the provider's subject
 * (`username`). `password` is Django's: unusable ("!" and random) for
 * provider sign-ins; this version never reads it.
 */
export const users = pgTable(
  "auth_user",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    password: varchar("password", { length: 128 })
      .notNull()
      .$defaultFn(() => `!${randomBytes(30).toString("base64url").slice(0, 40)}`),
    lastLogin: timestamptz("last_login"),
    isSuperuser: boolean("is_superuser")
      .notNull()
      .$defaultFn(() => false),
    username: varchar("username", { length: 150 }).notNull(),
    firstName: varchar("first_name", { length: 150 })
      .notNull()
      .$defaultFn(() => ""),
    lastName: varchar("last_name", { length: 150 })
      .notNull()
      .$defaultFn(() => ""),
    email: varchar("email", { length: 254 })
      .notNull()
      .$defaultFn(() => ""),
    isStaff: boolean("is_staff")
      .notNull()
      .$defaultFn(() => false),
    isActive: boolean("is_active")
      .notNull()
      .$defaultFn(() => true),
    dateJoined: timestamptz("date_joined").notNull().$defaultFn(now),
  },
  (table) => [
    unique("auth_user_username_key").on(table.username),
    index("auth_user_username_6821ab7c_like").using("btree", table.username.op("varchar_pattern_ops")),
  ],
);

/** Django's groups: the two roles of the admin area live here by name (src/auth/roles.ts). */
export const groups = pgTable(
  "auth_group",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    name: varchar("name", { length: 150 }).notNull(),
  },
  (table) => [
    unique("auth_group_name_key").on(table.name),
    index("auth_group_name_a6ea08ec_like").using("btree", table.name.op("varchar_pattern_ops")),
  ],
);

export const userGroups = pgTable(
  "auth_user_groups",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    userId: integer("user_id").notNull(),
    groupId: integer("group_id").notNull(),
  },
  (table) => [
    unique("auth_user_groups_user_id_group_id_94350c0c_uniq").on(table.userId, table.groupId),
    index("auth_user_groups_group_id_97559544").using("btree", table.groupId),
    index("auth_user_groups_user_id_6a12ed8b").using("btree", table.userId),
    foreignKey({
      name: "auth_user_groups_group_id_97559544_fk_auth_group_id",
      columns: [table.groupId],
      foreignColumns: [groups.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "auth_user_groups_user_id_6a12ed8b_fk_auth_user_id",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
  ],
);

// -- Settings, privacy notice, templates and forms ---------------------------------

/** The General and Appearance settings: one row (id 1) for the whole app (services/app-settings.ts). */
export const appSettings = pgTable("portal_appsettings", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
  language: varchar("language", { length: 2 }).notNull(),
  timezone: varchar("timezone", { length: 64 }).notNull(),
  dateFormat: varchar("date_format", { length: 8 }).notNull(),
  favicon: bytea("favicon").notNull(),
  faviconType: varchar("favicon_type", { length: 40 }).notNull(),
  /** Names the favicon in its link, so browsers fetch a new one at once. */
  faviconDigest: varchar("favicon_digest", { length: 16 }).notNull(),
  updatedAt: timestamptz("updated_at").notNull().$defaultFn(now).$onUpdateFn(now),
  accentColor: varchar("accent_color", { length: 7 }).notNull(),
  numberFormat: varchar("number_format", { length: 8 }).notNull(),
});

/**
 * Admin > Email: the provider that sends the app's email, its credentials and the
 * participant confirmation; one row (id 1) for the whole app (EmailSettings of the Django
 * version, its migration 0020; services/email-connection.ts). Secrets are stored sealed
 * (src/encryption.ts) and never shown again. The migration creates the table only where
 * 0.4 had not (drizzle/0002_email_settings.sql).
 */
export const emailSettings = pgTable(
  "portal_emailsettings",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    /** "", "mailersend" or "smtp". */
    provider: varchar("provider", { length: 12 }).notNull(),
    fromAddress: varchar("from_address", { length: 254 }).notNull(),
    replyToAddress: varchar("reply_to_address", { length: 254 }).notNull(),
    mailersendTokenSealed: text("mailersend_token_sealed").notNull(),
    webhookSecretSealed: text("webhook_secret_sealed").notNull(),
    smtpHost: varchar("smtp_host", { length: 253 }).notNull(),
    smtpPort: integer("smtp_port").notNull(),
    /** "starttls", "tls" or "none". */
    smtpSecurity: varchar("smtp_security", { length: 8 }).notNull(),
    smtpUsername: varchar("smtp_username", { length: 254 }).notNull(),
    smtpPasswordSealed: text("smtp_password_sealed").notNull(),
    confirmationEnabled: boolean("confirmation_enabled").notNull(),
    /** Admins' own subject and text per language: {"de": {"subject": …, "body": …}}; missing: the standard text. */
    confirmationTexts: jsonb("confirmation_texts").$type<ConfirmationTexts>().notNull(),
    /** When the last signed MailerSend webhook arrived. */
    webhookReceivedAt: timestamptz("webhook_received_at"),
    updatedAt: timestamptz("updated_at").notNull().$defaultFn(now).$onUpdateFn(now),
  },
  (table) => [check("portal_emailsettings_smtp_port_check", sql`${table.smtpPort} >= 0`)],
);

/** Admins' own confirmation texts per language code. */
export type ConfirmationTexts = Partial<Record<string, { subject?: string; body?: string }>>;

/** The app's one privacy notice. Every change is a new version; claims keep theirs. */
export const privacyNotices = pgTable(
  "portal_privacynotice",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    version: integer("version").notNull(),
    text: text("text").notNull(),
    createdAt: timestamptz("created_at").notNull().$defaultFn(now),
    createdBy: varchar("created_by", { length: 254 })
      .notNull()
      .$defaultFn(() => ""),
  },
  (table) => [
    unique("portal_privacynotice_version_key").on(table.version),
    check("portal_privacynotice_version_check", sql`${table.version} >= 0`),
  ],
);

/** A type of reimbursement form. Its fields hold each form's internal values. */
export const formTemplates = pgTable(
  "portal_formtemplate",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description")
      .notNull()
      .$defaultFn(() => ""),
    intro: text("intro")
      .notNull()
      .$defaultFn(() => ""),
    declaration: text("declaration").notNull(),
    declarationVersion: varchar("declaration_version", { length: 80 }).notNull(),
    /** off, optional or required. */
    travel: varchar("travel", { length: 12 })
      .notNull()
      .$defaultFn(() => "optional"),
    mileageEnabled: boolean("mileage_enabled")
      .notNull()
      .$defaultFn(() => false),
    mileageRate: numeric("mileage_rate", { precision: 4, scale: 2 })
      .notNull()
      .$defaultFn(() => "0.30"),
    updatedAt: timestamptz("updated_at").notNull().$defaultFn(now).$onUpdateFn(now),
  },
  (table) => [
    unique("portal_formtemplate_name_key").on(table.name),
    index("portal_formtemplate_name_151c361a_like").using("btree", table.name.op("varchar_pattern_ops")),
  ],
);

/** An internal value each form of the template sets, e.g. KST, KTR or an ID; printed in the PDF. */
export const templateFields = pgTable(
  "portal_templatefield",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    key: varchar("key", { length: 40 }).notNull(),
    label: varchar("label", { length: 80 }).notNull(),
    /** text or choice. */
    kind: varchar("kind", { length: 10 })
      .notNull()
      .$defaultFn(() => "text"),
    /** Only for choices: one option per line. */
    choices: text("choices")
      .notNull()
      .$defaultFn(() => ""),
    pattern: varchar("pattern", { length: 200 })
      .notNull()
      .$defaultFn(() => ""),
    required: boolean("required")
      .notNull()
      .$defaultFn(() => true),
    position: smallint("position")
      .notNull()
      .$defaultFn(() => 0),
    templateId: bigint("template_id", { mode: "number" }).notNull(),
  },
  (table) => [
    unique("template_field_key_unique").on(table.templateId, table.key),
    index("portal_templatefield_key_bd511803").using("btree", table.key),
    index("portal_templatefield_key_bd511803_like").using("btree", table.key.op("varchar_pattern_ops")),
    index("portal_templatefield_template_id_90b76303").using("btree", table.templateId),
    check("portal_templatefield_position_check", sql`${table.position} >= 0`),
    foreignKey({
      name: "portal_templatefield_template_id_90b76303_fk_portal_fo",
      columns: [table.templateId],
      foreignColumns: [formTemplates.id],
    }).onDelete("cascade"),
  ],
);

/**
 * A reimbursement form, drafted and published by its owners. Status draft,
 * published or archived; an archived form is closed and left out of the
 * forms list, and keeps its claims.
 */
export const forms = pgTable(
  "portal_form",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    slug: varchar("slug", { length: 50 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    /** The internal values by template field key. */
    fieldValues: jsonb("field_values")
      .$type<Record<string, string>>()
      .notNull()
      .$defaultFn(() => ({})),
    purposeOptions: text("purpose_options")
      .notNull()
      .$defaultFn(() => ""),
    instructions: text("instructions")
      .notNull()
      .$defaultFn(() => ""),
    recipient: varchar("recipient", { length: 254 }).notNull(),
    supportEmail: varchar("support_email", { length: 254 }).notNull(),
    tripStart: date("trip_start", { mode: "string" }),
    tripEnd: date("trip_end", { mode: "string" }),
    opensAt: timestamptz("opens_at"),
    closesAt: timestamptz("closes_at"),
    createdAt: timestamptz("created_at").notNull().$defaultFn(now),
    updatedAt: timestamptz("updated_at").notNull().$defaultFn(now).$onUpdateFn(now),
    templateId: bigint("template_id", { mode: "number" }).notNull(),
    /** The start page redirects to this form while it is open; one form at most. */
    primary: boolean("primary")
      .notNull()
      .$defaultFn(() => false),
    creationKey: uuid("creation_key"),
    status: varchar("status", { length: 12 })
      .notNull()
      .$defaultFn(() => "draft"),
    description: text("description")
      .notNull()
      .$defaultFn(() => ""),
    title: varchar("title", { length: 200 })
      .notNull()
      .$defaultFn(() => ""),
  },
  (table) => [
    unique("portal_form_creation_key_key").on(table.creationKey),
    unique("portal_form_slug_key").on(table.slug),
    uniqueIndex("form_primary_unique")
      .using("btree", table.primary)
      .where(sql`${table.primary}`),
    index("portal_form_slug_bd4bc797_like").using("btree", table.slug.op("varchar_pattern_ops")),
    index("portal_form_template_id_b08269a2").using("btree", table.templateId),
    foreignKey({
      name: "portal_form_template_id_b08269a2_fk_portal_formtemplate_id",
      columns: [table.templateId],
      foreignColumns: [formTemplates.id],
    }).onDelete("restrict"),
  ],
);

export const formOwners = pgTable(
  "portal_form_owners",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    formId: bigint("form_id", { mode: "number" }).notNull(),
    userId: integer("user_id").notNull(),
  },
  (table) => [
    unique("portal_form_owners_form_id_user_id_eb6780b4_uniq").on(table.formId, table.userId),
    index("portal_form_owners_form_id_de3fc7ed").using("btree", table.formId),
    index("portal_form_owners_user_id_c9532439").using("btree", table.userId),
    foreignKey({
      name: "portal_form_owners_form_id_de3fc7ed_fk_portal_form_id",
      columns: [table.formId],
      foreignColumns: [forms.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "portal_form_owners_user_id_c9532439_fk_auth_user_id",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
  ],
);

// -- Participants: admission budgets, drafts and uploads --------------------------

/** A shared creation budget, keyed by a secret digest of the client network. */
export const draftAdmissions = pgTable(
  "portal_draftadmission",
  {
    key: varchar("key", { length: 64 }).primaryKey(),
    windowStart: timestamptz("window_start").notNull().$defaultFn(now),
    count: integer("count")
      .notNull()
      .$defaultFn(() => 0),
    uploadCount: integer("upload_count")
      .notNull()
      .$defaultFn(() => 0),
    uploadBytes: bigint("upload_bytes", { mode: "number" })
      .notNull()
      .$defaultFn(() => 0),
    uploadWindowStart: timestamptz("upload_window_start").notNull().$defaultFn(now),
    uploadWindowCount: integer("upload_window_count")
      .notNull()
      .$defaultFn(() => 0),
  },
  (table) => [
    index("portal_draftadmission_key_bc2522a5_like").using("btree", table.key.op("varchar_pattern_ops")),
    index("portal_draftadmission_window_start_508d2b79").using("btree", table.windowStart),
    check("portal_draftadmission_count_check", sql`${table.count} >= 0`),
    check("portal_draftadmission_upload_bytes_check", sql`${table.uploadBytes} >= 0`),
    check("portal_draftadmission_upload_count_check", sql`${table.uploadCount} >= 0`),
    check("portal_draftadmission_upload_window_count_check", sql`${table.uploadWindowCount} >= 0`),
  ],
);

/** One participant's session-bound, token-authorized copy of a form (services/drafts.ts). */
export const drafts = pgTable(
  "portal_draft",
  {
    id: uuid("id").primaryKey().$defaultFn(randomUUID),
    sessionHash: varchar("session_hash", { length: 64 }).notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    createdAt: timestamptz("created_at").notNull().$defaultFn(now),
    /** 24 hours after creation unless set. */
    expiresAt: timestamptz("expires_at")
      .notNull()
      .$defaultFn(() => new Date(Date.now() + 24 * 3600 * 1000)),
    payloadHash: varchar("payload_hash", { length: 64 })
      .notNull()
      .$defaultFn(() => ""),
    uploadCount: integer("upload_count")
      .notNull()
      .$defaultFn(() => 0),
    uploadBytes: bigint("upload_bytes", { mode: "number" })
      .notNull()
      .$defaultFn(() => 0),
    claimId: uuid("claim_id"),
    formId: bigint("form_id", { mode: "number" }).notNull(),
    /** The digest of the form's terms when the draft was opened (services/terms.ts). */
    revision: varchar("revision", { length: 16 }).notNull(),
  },
  (table) => [
    unique("portal_draft_claim_id_key").on(table.claimId),
    index("portal_draft_expires_at_f171ba29").using("btree", table.expiresAt),
    index("portal_draft_form_id_b819ac1b").using("btree", table.formId),
    check("portal_draft_upload_bytes_check", sql`${table.uploadBytes} >= 0`),
    check("portal_draft_upload_count_check", sql`${table.uploadCount} >= 0`),
    foreignKey({
      name: "portal_draft_claim_id_d6af9412_fk_portal_claim_id",
      columns: [table.claimId],
      foreignColumns: [claims.id],
    }).onDelete("set null"),
    foreignKey({
      name: "portal_draft_form_id_b819ac1b_fk_portal_form_id",
      columns: [table.formId],
      foreignColumns: [forms.id],
    }).onDelete("restrict"),
  ],
);

// -- Claims ---------------------------------------------------------------------

/** A permanent, participant-free sequence of bookkeeping references (id 1). */
export const claimReferenceCounters = pgTable(
  "portal_claimreferencecounter",
  {
    id: smallint("id")
      .primaryKey()
      .$defaultFn(() => 1),
    value: bigint("value", { mode: "number" })
      .notNull()
      .$defaultFn(() => 0),
  },
  (table) => [
    check("portal_claimreferencecounter_id_check", sql`${table.id} >= 0`),
    check("portal_claimreferencecounter_value_check", sql`${table.value} >= 0`),
  ],
);

/**
 * An accepted submission with its expenses, bookkeeping reference, snapshot
 * and authoritative PDF. State: received, rendering, ready,
 * processing_failed, purging (services/claim-status.ts).
 */
export const claims = pgTable(
  "portal_claim",
  {
    id: uuid("id").primaryKey().$defaultFn(randomUUID),
    fullName: varchar("full_name", { length: 200 }).notNull(),
    email: varchar("email", { length: 254 }).notNull(),
    street: varchar("street", { length: 200 }).notNull(),
    postalCode: varchar("postal_code", { length: 12 }).notNull(),
    city: varchar("city", { length: 100 }).notNull(),
    country: varchar("country", { length: 2 }).notNull(),
    accountHolder: varchar("account_holder", { length: 200 }).notNull(),
    iban: varchar("iban", { length: 34 }).notNull(),
    bic: varchar("bic", { length: 11 })
      .notNull()
      .$defaultFn(() => ""),
    purpose: text("purpose").notNull(),
    purposeDetails: text("purpose_details")
      .notNull()
      .$defaultFn(() => ""),
    tripDestination: varchar("trip_destination", { length: 200 })
      .notNull()
      .$defaultFn(() => ""),
    tripStart: date("trip_start", { mode: "string" }),
    tripEnd: date("trip_end", { mode: "string" }),
    submittedAt: timestamptz("submitted_at").notNull().$defaultFn(now),
    /** The form configuration, terms and language used at submission. */
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    total: numeric("total", { precision: 12, scale: 2 }),
    state: varchar("state", { length: 24 })
      .notNull()
      .$defaultFn(() => "received"),
    pdfKey: varchar("pdf_key", { length: 200 })
      .notNull()
      .$defaultFn(() => ""),
    pdfHash: varchar("pdf_hash", { length: 64 })
      .notNull()
      .$defaultFn(() => ""),
    pdfSize: integer("pdf_size")
      .notNull()
      .$defaultFn(() => 0),
    pdfPageCount: integer("pdf_page_count")
      .notNull()
      .$defaultFn(() => 0),
    errorCode: varchar("error_code", { length: 80 })
      .notNull()
      .$defaultFn(() => ""),
    /** The PDF is removed first; all remaining content at retention_due. */
    pdfDue: timestamptz("pdf_due"),
    pdfRemovedAt: timestamptz("pdf_removed_at"),
    retentionDue: timestamptz("retention_due"),
    resolutionDue: timestamptz("resolution_due").notNull().$defaultFn(now),
    supersedesId: uuid("supersedes_id"),
    formId: bigint("form_id", { mode: "number" }).notNull(),
    bookkeepingReference: varchar("bookkeeping_reference", { length: 200 }),
    /** Archived claims leave the claims list and need no resolution (services/retention.ts). */
    archivedAt: timestamptz("archived_at"),
  },
  (table) => [
    unique("portal_claim_bookkeeping_reference_key").on(table.bookkeepingReference),
    index("portal_claim_archived_at_59843ecb").using("btree", table.archivedAt),
    index("portal_claim_bookkeeping_reference_f27a4966_like").using(
      "btree",
      table.bookkeepingReference.op("varchar_pattern_ops"),
    ),
    index("portal_claim_form_id_a8cd19f9").using("btree", table.formId),
    index("portal_claim_pdf_due_e8333a41").using("btree", table.pdfDue),
    index("portal_claim_retention_due_5a4d5d77").using("btree", table.retentionDue),
    index("portal_claim_state_102b7533").using("btree", table.state),
    index("portal_claim_state_102b7533_like").using("btree", table.state.op("varchar_pattern_ops")),
    index("portal_claim_supersedes_id_fbc751d8").using("btree", table.supersedesId),
    check("portal_claim_pdf_page_count_check", sql`${table.pdfPageCount} >= 0`),
    check("portal_claim_pdf_size_check", sql`${table.pdfSize} >= 0`),
    foreignKey({
      name: "portal_claim_form_id_a8cd19f9_fk_portal_form_id",
      columns: [table.formId],
      foreignColumns: [forms.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "portal_claim_supersedes_id_fbc751d8_fk_portal_claim_id",
      columns: [table.supersedesId],
      foreignColumns: [table.id],
    }).onDelete("set null"),
  ],
);

/** A receipt or mileage row of a claim. */
export const expenses = pgTable(
  "portal_expense",
  {
    id: uuid("id").primaryKey().$defaultFn(randomUUID),
    position: smallint("position").notNull(),
    /** receipt or mileage. */
    kind: varchar("kind", { length: 10 })
      .notNull()
      .$defaultFn(() => "receipt"),
    merchant: varchar("merchant", { length: 200 })
      .notNull()
      .$defaultFn(() => ""),
    purpose: varchar("purpose", { length: 3000 }).notNull(),
    receiptReference: varchar("receipt_reference", { length: 100 })
      .notNull()
      .$defaultFn(() => ""),
    travelDate: date("travel_date", { mode: "string" }),
    routeFrom: varchar("route_from", { length: 200 })
      .notNull()
      .$defaultFn(() => ""),
    routeTo: varchar("route_to", { length: 200 })
      .notNull()
      .$defaultFn(() => ""),
    distanceKm: integer("distance_km"),
    roundTrip: boolean("round_trip")
      .notNull()
      .$defaultFn(() => false),
    mileageRate: numeric("mileage_rate", { precision: 4, scale: 2 }),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    claimId: uuid("claim_id").notNull(),
    returnDate: date("return_date", { mode: "string" }),
    vehicleRegistration: varchar("vehicle_registration", { length: 20 })
      .notNull()
      .$defaultFn(() => ""),
  },
  (table) => [
    unique("expense_position_unique").on(table.claimId, table.position),
    index("portal_expense_claim_id_05f3f970").using("btree", table.claimId),
    check("expense_amount_positive", sql`${table.amount} > (0)::numeric`),
    check("portal_expense_distance_km_check", sql`${table.distanceKm} >= 0`),
    check("portal_expense_position_check", sql`${table.position} >= 0`),
    foreignKey({
      name: "portal_expense_claim_id_05f3f970_fk_portal_claim_id",
      columns: [table.claimId],
      foreignColumns: [claims.id],
    }).onDelete("cascade"),
  ],
);

/** A receipt or signature file of a draft, and later of its claim. State pending, ready or failed. */
export const uploads = pgTable(
  "portal_upload",
  {
    id: uuid("id").primaryKey().$defaultFn(randomUUID),
    expenseId: uuid("expense_id"),
    position: smallint("position")
      .notNull()
      .$defaultFn(() => 0),
    /** receipt or signature. */
    kind: varchar("kind", { length: 12 })
      .notNull()
      .$defaultFn(() => "receipt"),
    originalName: varchar("original_name", { length: 200 }).notNull(),
    sourceKey: varchar("source_key", { length: 200 }).notNull(),
    normalizedKey: varchar("normalized_key", { length: 200 })
      .notNull()
      .$defaultFn(() => ""),
    normalizedSize: integer("normalized_size")
      .notNull()
      .$defaultFn(() => 0),
    reservedBytes: integer("reserved_bytes")
      .notNull()
      .$defaultFn(() => 0),
    size: integer("size").notNull(),
    checksum: varchar("checksum", { length: 64 }).notNull(),
    mediaType: varchar("media_type", { length: 40 })
      .notNull()
      .$defaultFn(() => ""),
    pages: integer("pages")
      .notNull()
      .$defaultFn(() => 0),
    state: varchar("state", { length: 12 })
      .notNull()
      .$defaultFn(() => "pending"),
    errorCode: varchar("error_code", { length: 80 })
      .notNull()
      .$defaultFn(() => ""),
    createdAt: timestamptz("created_at").notNull().$defaultFn(now),
    claimId: uuid("claim_id"),
    draftId: uuid("draft_id").notNull(),
  },
  (table) => [
    index("portal_upload_claim_id_d9b688d4").using("btree", table.claimId),
    index("portal_upload_draft_id_062d69ed").using("btree", table.draftId),
    check("portal_upload_normalized_size_check", sql`${table.normalizedSize} >= 0`),
    check("portal_upload_pages_check", sql`${table.pages} >= 0`),
    check("portal_upload_position_check", sql`${table.position} >= 0`),
    check("portal_upload_reserved_bytes_check", sql`${table.reservedBytes} >= 0`),
    check("portal_upload_size_check", sql`${table.size} >= 0`),
    foreignKey({
      name: "portal_upload_claim_id_d9b688d4_fk_portal_claim_id",
      columns: [table.claimId],
      foreignColumns: [claims.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "portal_upload_draft_id_062d69ed_fk_portal_draft_id",
      columns: [table.draftId],
      foreignColumns: [drafts.id],
    }).onDelete("cascade"),
  ],
);

// -- Email: Finance deliveries, confirmations, evidence ----------------------------

/** Sending a claim's PDF to its approved Finance inbox, in one or more attempts. */
export const deliveries = pgTable(
  "portal_delivery",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    recipient: varchar("recipient", { length: 254 }).notNull(),
    state: varchar("state", { length: 24 })
      .notNull()
      .$defaultFn(() => "pending"),
    messageId: varchar("message_id", { length: 100 })
      .notNull()
      .$defaultFn(() => ""),
    deliveredAt: timestamptz("delivered_at"),
    errorCode: varchar("error_code", { length: 80 })
      .notNull()
      .$defaultFn(() => ""),
    updatedAt: timestamptz("updated_at").notNull().$defaultFn(now).$onUpdateFn(now),
    claimId: uuid("claim_id").notNull(),
  },
  (table) => [
    unique("portal_delivery_claim_id_key").on(table.claimId),
    index("portal_delivery_state_384fbd15").using("btree", table.state),
    index("portal_delivery_state_384fbd15_like").using("btree", table.state.op("varchar_pattern_ops")),
    foreignKey({
      name: "portal_delivery_claim_id_b1627f00_fk_portal_claim_id",
      columns: [table.claimId],
      foreignColumns: [claims.id],
    }).onDelete("cascade"),
  ],
);

/** The participant's receipt email, independent of PDF processing and Finance delivery. */
export const confirmations = pgTable(
  "portal_confirmation",
  {
    id: uuid("id").primaryKey().$defaultFn(randomUUID),
    state: varchar("state", { length: 24 })
      .notNull()
      .$defaultFn(() => "pending"),
    messageId: varchar("message_id", { length: 100 })
      .notNull()
      .$defaultFn(() => ""),
    errorCode: varchar("error_code", { length: 80 })
      .notNull()
      .$defaultFn(() => ""),
    updatedAt: timestamptz("updated_at").notNull().$defaultFn(now).$onUpdateFn(now),
    claimId: uuid("claim_id").notNull(),
    lastCheckedAt: timestamptz("last_checked_at"),
  },
  (table) => [
    unique("portal_confirmation_claim_id_key").on(table.claimId),
    index("portal_confirmation_last_checked_at_604a24c5").using("btree", table.lastCheckedAt),
    foreignKey({
      name: "portal_confirmation_claim_id_e1ec4834_fk_portal_claim_id",
      columns: [table.claimId],
      foreignColumns: [claims.id],
    }).onDelete("cascade"),
  ],
);

export const deliveryAttempts = pgTable(
  "portal_deliveryattempt",
  {
    id: uuid("id").primaryKey().$defaultFn(randomUUID),
    state: varchar("state", { length: 24 })
      .notNull()
      .$defaultFn(() => "sending"),
    messageId: varchar("message_id", { length: 100 }),
    errorCode: varchar("error_code", { length: 80 })
      .notNull()
      .$defaultFn(() => ""),
    createdAt: timestamptz("created_at").notNull().$defaultFn(now),
    updatedAt: timestamptz("updated_at").notNull().$defaultFn(now).$onUpdateFn(now),
    lastCheckedAt: timestamptz("last_checked_at"),
    deliveryId: bigint("delivery_id", { mode: "number" }).notNull(),
  },
  (table) => [
    unique("portal_deliveryattempt_message_id_key").on(table.messageId),
    index("portal_deliveryattempt_delivery_id_eb21ca56").using("btree", table.deliveryId),
    index("portal_deliveryattempt_last_checked_at_f5aba670").using("btree", table.lastCheckedAt),
    index("portal_deliveryattempt_message_id_af9a3e0f_like").using(
      "btree",
      table.messageId.op("varchar_pattern_ops"),
    ),
    foreignKey({
      name: "portal_deliveryattem_delivery_id_eb21ca56_fk_portal_de",
      columns: [table.deliveryId],
      foreignColumns: [deliveries.id],
    }).onDelete("cascade"),
  ],
);

/**
 * Evidence about one sent email: a Finance delivery attempt or a
 * confirmation. It names its email by provider message ID or by
 * `attempt_tag`, the ID of the email's record, never by claim.
 */
export const deliveryEvents = pgTable(
  "portal_deliveryevent",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    providerId: varchar("provider_id", { length: 100 }).notNull(),
    messageId: varchar("message_id", { length: 100 })
      .notNull()
      .$defaultFn(() => ""),
    kind: varchar("kind", { length: 80 }).notNull(),
    recipientHash: varchar("recipient_hash", { length: 64 }).notNull(),
    attemptTag: varchar("attempt_tag", { length: 80 })
      .notNull()
      .$defaultFn(() => ""),
    providerTimestamp: timestamptz("provider_timestamp").notNull(),
    receivedAt: timestamptz("received_at").notNull().$defaultFn(now),
    applied: boolean("applied")
      .notNull()
      .$defaultFn(() => false),
    lastCheckedAt: timestamptz("last_checked_at"),
  },
  (table) => [
    unique("portal_deliveryevent_provider_id_key").on(table.providerId),
    index("portal_deliveryevent_last_checked_at_e331cda0").using("btree", table.lastCheckedAt),
    index("portal_deliveryevent_message_id_6904c7e3").using("btree", table.messageId),
    index("portal_deliveryevent_message_id_6904c7e3_like").using(
      "btree",
      table.messageId.op("varchar_pattern_ops"),
    ),
    index("portal_deliveryevent_provider_id_16305df5_like").using(
      "btree",
      table.providerId.op("varchar_pattern_ops"),
    ),
  ],
);

// -- Jobs, operations, capacity --------------------------------------------------

/** A queued job of the worker: exactly one of upload, claim or delivery (services/queue.ts). */
export const jobs = pgTable(
  "portal_job",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    key: varchar("key", { length: 160 }).notNull(),
    kind: varchar("kind", { length: 20 }).notNull(),
    state: varchar("state", { length: 16 })
      .notNull()
      .$defaultFn(() => "pending"),
    attempts: integer("attempts")
      .notNull()
      .$defaultFn(() => 0),
    runAfter: timestamptz("run_after").notNull().$defaultFn(now),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamptz("lease_until"),
    errorCode: varchar("error_code", { length: 80 })
      .notNull()
      .$defaultFn(() => ""),
    createdAt: timestamptz("created_at").notNull().$defaultFn(now),
    claimId: uuid("claim_id"),
    deliveryId: bigint("delivery_id", { mode: "number" }),
    uploadId: uuid("upload_id"),
  },
  (table) => [
    unique("portal_job_key_key").on(table.key),
    index("portal_job_claim_id_6ef2461a").using("btree", table.claimId),
    index("portal_job_delivery_id_4de78ba6").using("btree", table.deliveryId),
    index("portal_job_key_d5a35c1e_like").using("btree", table.key.op("varchar_pattern_ops")),
    index("portal_job_run_after_6c9ca569").using("btree", table.runAfter),
    index("portal_job_state_af9d1159").using("btree", table.state),
    index("portal_job_state_af9d1159_like").using("btree", table.state.op("varchar_pattern_ops")),
    index("portal_job_upload_id_711b59f7").using("btree", table.uploadId),
    check(
      "job_exactly_one_target",
      sql`(((${table.claimId} IS NULL) AND (${table.deliveryId} IS NULL) AND (${table.uploadId} IS NOT NULL)) OR ((${table.claimId} IS NOT NULL) AND (${table.deliveryId} IS NULL) AND (${table.uploadId} IS NULL)) OR ((${table.claimId} IS NULL) AND (${table.deliveryId} IS NOT NULL) AND (${table.uploadId} IS NULL)))`,
    ),
    check("portal_job_attempts_check", sql`${table.attempts} >= 0`),
    foreignKey({
      name: "portal_job_claim_id_6ef2461a_fk_portal_claim_id",
      columns: [table.claimId],
      foreignColumns: [claims.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "portal_job_delivery_id_4de78ba6_fk_portal_delivery_id",
      columns: [table.deliveryId],
      foreignColumns: [deliveries.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "portal_job_upload_id_711b59f7_fk_portal_upload_id",
      columns: [table.uploadId],
      foreignColumns: [uploads.id],
    }).onDelete("cascade"),
  ],
);

/** An operator's action on a claim (retry, archive, delete …), with who and why. */
export const operations = pgTable(
  "portal_operation",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    action: varchar("action", { length: 40 }).notNull(),
    actor: varchar("actor", { length: 254 }).notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    createdAt: timestamptz("created_at").notNull().$defaultFn(now),
    claimId: uuid("claim_id"),
  },
  (table) => [
    index("portal_operation_claim_id_43c1af12").using("btree", table.claimId),
    foreignKey({
      name: "portal_operation_claim_id_43c1af12_fk_portal_claim_id",
      columns: [table.claimId],
      foreignColumns: [claims.id],
    }).onDelete("set null"),
  ],
);

/** One transaction lock (id 1) serializes admission against the shared filesystem. */
export const capacityLocks = pgTable(
  "portal_capacitylock",
  {
    id: smallint("id")
      .primaryKey()
      .$defaultFn(() => 1),
  },
  (table) => [check("portal_capacitylock_id_check", sql`${table.id} >= 0`)],
);

/** A reservation lives until its particular process workspace is removed. */
export const workspaceReservations = pgTable(
  "portal_workspacereservation",
  {
    id: uuid("id").primaryKey().$defaultFn(randomUUID),
    directory: varchar("directory", { length: 200 }).notNull(),
    size: integer("size").notNull(),
    outputBytes: integer("output_bytes")
      .notNull()
      .$defaultFn(() => 0),
    createdAt: timestamptz("created_at").notNull().$defaultFn(now),
    claimId: uuid("claim_id"),
    uploadId: uuid("upload_id"),
  },
  (table) => [
    unique("portal_workspacereservation_directory_key").on(table.directory),
    index("portal_workspacereservation_claim_id_03246bd9").using("btree", table.claimId),
    index("portal_workspacereservation_created_at_a0303a5c").using("btree", table.createdAt),
    index("portal_workspacereservation_directory_fc473a49_like").using(
      "btree",
      table.directory.op("varchar_pattern_ops"),
    ),
    index("portal_workspacereservation_upload_id_17fae713").using("btree", table.uploadId),
    check("portal_workspacereservation_output_bytes_check", sql`${table.outputBytes} >= 0`),
    check("portal_workspacereservation_size_check", sql`${table.size} >= 0`),
    foreignKey({
      name: "portal_workspacerese_claim_id_03246bd9_fk_portal_cl",
      columns: [table.claimId],
      foreignColumns: [claims.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "portal_workspacerese_upload_id_17fae713_fk_portal_up",
      columns: [table.uploadId],
      foreignColumns: [uploads.id],
    }).onDelete("restrict"),
  ],
);

// -- This version's sessions -------------------------------------------------------

/**
 * Browser sessions of this version (src/auth/session.ts): `admin` sessions of
 * people who signed in, with the provider's ID token for sign-out, and
 * `participant` sessions that bind drafts to a browser. The cookie holds a
 * random token; `id` is its SHA-256.
 */
export const sessions = pgTable(
  "portal_session",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    kind: varchar("kind", { length: 12 }).$type<"admin" | "participant">().notNull(),
    userId: integer("user_id"),
    idToken: text("id_token").notNull().default(""),
    /** Participant sessions: the remembered draft per form slug. */
    data: jsonb("data").$type<SessionData>().notNull().default({}),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    expiresAt: timestamptz("expires_at").notNull(),
  },
  (table) => [
    index("portal_session_expires_at_idx").using("btree", table.expiresAt),
    index("portal_session_user_id_idx").using("btree", table.userId),
    check("portal_session_kind_check", sql`${table.kind} in ('admin', 'participant')`),
    foreignKey({
      name: "portal_session_user_id_fk_auth_user_id",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
  ],
);

export type SessionData = { drafts?: Record<string, { id: string; token: string }> };

export type User = typeof users.$inferSelect;
export type Group = typeof groups.$inferSelect;
export type AppSettingsRow = typeof appSettings.$inferSelect;
export type EmailSettingsRow = typeof emailSettings.$inferSelect;
export type PrivacyNotice = typeof privacyNotices.$inferSelect;
export type FormTemplate = typeof formTemplates.$inferSelect;
export type TemplateField = typeof templateFields.$inferSelect;
export type Form = typeof forms.$inferSelect;
export type DraftAdmission = typeof draftAdmissions.$inferSelect;
export type Draft = typeof drafts.$inferSelect;
export type Claim = typeof claims.$inferSelect;
export type Expense = typeof expenses.$inferSelect;
export type Upload = typeof uploads.$inferSelect;
export type Delivery = typeof deliveries.$inferSelect;
export type Confirmation = typeof confirmations.$inferSelect;
export type DeliveryAttempt = typeof deliveryAttempts.$inferSelect;
export type DeliveryEvent = typeof deliveryEvents.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type Operation = typeof operations.$inferSelect;
export type WorkspaceReservation = typeof workspaceReservations.$inferSelect;
export type Session = typeof sessions.$inferSelect;
