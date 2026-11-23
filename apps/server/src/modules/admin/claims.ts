import { Hono, type Context } from "hono";
import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import type {
  ArchiveAnswer,
  ClaimDetail,
  ClaimList,
  ClaimRow,
  ClaimSummary,
  DeleteAnswer,
  DeletePreview,
  FilterOption,
  RetryPage,
} from "@reimbursements/shared/api/admin";
import { config } from "../../config";
import {
  claims,
  deliveries,
  forms,
  operations as operationRows,
  type Claim,
  type User,
} from "../../db/schema";
import { q } from "../../db/tx";
import type { AppEnv } from "../../http/env";
import { AppError, forbidden, notFound, validationError } from "../../http/errors";
import { requireEditor, requireTemplateAdmin, uuidParam } from "../../http/middleware";
import { applied, formatAmount, formatDateTime, formatInstantDate } from "../../i18n";
import { isTemplateAdmin, visibleClaims } from "../../auth/roles";
import * as claimStatus from "../../services/claim-status";
import * as delivery from "../../services/delivery";
import * as operations from "../../services/operations";
import * as retention from "../../services/retention";
import { actor, archivingMessage, body, contains, idsOf, pageOf, pagesOf, PAGE_SIZE } from "./common";

/**
 * Claims in the admin area (ClaimAdmin of portal/admin.py): the list with its
 * Status filter, search and dates, the claim, and the operator actions of
 * template admins: process again, archive, unarchive and delete. Form
 * editors see the claims of their forms; the list never shows bank details.
 */
const router = new Hono<AppEnv>();

/** A bulk deletion purges in the request; larger cleanups run in several steps. */
export const MAX_BULK_DELETE = 100;

export const OPERATION_LABELS: Readonly<Record<string, string>> = {
  retry: "Processed again",
  delete: "Deleted",
  archive: "Archived",
  unarchive: "Unarchived",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Annotated = Claim & {
  status: string;
  delivery: typeof deliveries.$inferSelect | null;
  formName: string;
};

/** Claims with their status, delivery and form name, matching `where`. */
function annotatedQuery(where: SQL | undefined) {
  return q()
    .select({ claim: claims, delivery: deliveries, status: claimStatus.STATUS, formName: forms.name })
    .from(claims)
    .innerJoin(forms, eq(forms.id, claims.formId))
    .leftJoin(deliveries, eq(deliveries.claimId, claims.id))
    .where(where);
}

function annotated(row: {
  claim: Claim;
  delivery: typeof deliveries.$inferSelect | null;
  status: string;
  formName: string;
}): Annotated {
  return { ...row.claim, delivery: row.delivery, status: row.status, formName: row.formName };
}

const shortReference = (claim: Claim) => claim.bookkeepingReference ?? claim.id.slice(0, 8);
const fullReference = (claim: Claim) => claim.bookkeepingReference ?? claim.id;

async function badge(claim: Annotated) {
  const status = await claimStatus.of(claim);
  return { status, badge: { code: status.code, label: status.label, tone: status.tone } };
}

async function summary(claim: Annotated): Promise<ClaimSummary> {
  const { badge: status } = await badge(claim);
  return {
    id: claim.id,
    reference: fullReference(claim),
    form: claim.formName,
    submittedOn: formatInstantDate(claim.submittedAt),
    fullName: claim.fullName,
    status,
    archived: claim.archivedAt !== null,
  };
}

/** The claims the person sees among `ids`, annotated. */
async function selectedClaims(user: User, ids: string[]): Promise<Annotated[]> {
  if (ids.length === 0) return [];
  const rows = await annotatedQuery(and(inArray(claims.id, ids), await visibleClaims(user))).orderBy(
    desc(claims.submittedAt),
    desc(claims.id),
  );
  return rows.map(annotated);
}

/** A claim the person sees (404 for any other, like an unknown one). */
async function visibleClaim(user: User, id: string): Promise<Annotated> {
  const [row] = await annotatedQuery(and(eq(claims.id, id), await visibleClaims(user)));
  if (!row) throw notFound("This claim does not exist or you may not see it.");
  return annotated(row);
}

/** Search like Django's ClaimAdmin: a full ID, or every word in the name, email or exact reference. */
function searchCondition(term: string): SQL | undefined {
  const value = term.trim();
  if (!value) return undefined;
  const hex = value.replace(/^urn:uuid:/i, "").replace(/[{}-]/g, "");
  if (/^[0-9a-f]{32}$/i.test(hex)) {
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    return eq(claims.id, id.toLowerCase());
  }
  return and(
    ...value
      .split(/\s+/)
      .map((word) =>
        or(
          ilike(claims.fullName, contains(word)),
          ilike(claims.email, contains(word)),
          eq(claims.bookkeepingReference, word),
        )!,
      ),
  );
}

/** A part of the submission time in the app timezone (Django's date hierarchy works in it). */
function part(name: "year" | "month" | "day"): SQL<number> {
  return sql<number>`extract(${sql.raw(name)} from ${claims.submittedAt} at time zone ${applied().timezone})::int`;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function dateQuery(c: Context<AppEnv>) {
  const number = (name: string, max: number) => {
    const value = c.req.query(name) ?? "";
    return /^[0-9]{1,4}$/.test(value) && Number(value) >= 1 && Number(value) <= max ? Number(value) : null;
  };
  const year = number("year", 9999);
  const month = year ? number("month", 12) : null;
  const day = month ? number("day", 31) : null;
  return { year, month, day };
}

router.get("/admin/claims", async (c) => {
  const user = await requireEditor(c);
  const option = c.req.query("status") ?? "";
  const form = c.req.query("form") ?? "";
  const term = (c.req.query("q") ?? "").slice(0, 200);
  const { year, month, day } = dateQuery(c);
  const visible = await visibleClaims(user);
  const base: SQL[] = [visible, claimStatus.listed(option || null)];
  if (/^[1-9][0-9]{0,15}$/.test(form)) base.push(eq(claims.formId, Number(form)));
  const search = searchCondition(term);
  if (search) base.push(search);
  const dated: SQL[] = [...base];
  if (year) dated.push(sql`${part("year")} = ${year}`);
  if (month) dated.push(sql`${part("month")} = ${month}`);
  if (day) dated.push(sql`${part("day")} = ${day}`);
  const where = and(...dated);
  const { page, offset } = pageOf(c);
  const [{ total } = { total: 0 }] = await q()
    .select({ total: count() })
    .from(claims)
    .leftJoin(deliveries, eq(deliveries.claimId, claims.id))
    .where(where);
  const rows = (
    await annotatedQuery(where)
      .orderBy(desc(claims.submittedAt), desc(claims.id))
      .limit(PAGE_SIZE)
      .offset(offset)
  ).map(annotated);
  const now = new Date();
  const result: ClaimRow[] = [];
  for (const claim of rows) {
    const status = await claimStatus.of(claim, { now });
    result.push({
      id: claim.id,
      reference: shortReference(claim),
      form: claim.formName,
      submittedAt: formatDateTime(claim.submittedAt),
      fullName: claim.fullName,
      email: claim.email,
      total: claim.total === null ? "" : formatAmount(claim.total),
      status: { code: status.code, label: status.label, tone: status.tone },
      archived: status.archived,
      overdue: status.overdue,
    });
  }
  // Only the forms of claims the person sees (Django's RelatedOnlyFieldListFilter).
  const formOptions = await q()
    .selectDistinct({ id: forms.id, name: forms.name })
    .from(forms)
    .innerJoin(claims, eq(claims.formId, forms.id))
    .where(visible)
    .orderBy(asc(forms.name), asc(forms.id));
  // The date hierarchy: the next level's values within the current one.
  const level = !year ? "year" : !month ? "month" : !day ? "day" : null;
  const options: FilterOption[] = [];
  if (level) {
    const values = await q()
      .selectDistinct({ value: part(level) })
      .from(claims)
      .leftJoin(deliveries, eq(deliveries.claimId, claims.id))
      .where(where);
    // Sorted here: the expression's timezone parameter differs between SELECT and ORDER BY.
    values.sort((a, b) => a.value - b.value);
    for (const { value } of values) {
      const label =
        level === "year"
          ? String(value)
          : level === "month"
            ? MONTHS[value - 1]!
            : `${MONTHS[month! - 1]} ${value}`;
      options.push({ value: String(value), label });
    }
  }
  const crumbs: FilterOption[] = [];
  if (year) crumbs.push({ value: "", label: "All dates" });
  if (month) crumbs.push({ value: String(year), label: String(year) });
  if (day) crumbs.push({ value: `${year}-${month}`, label: `${MONTHS[month! - 1]} ${year}` });
  const answer: ClaimList = {
    rows: result,
    count: total,
    page,
    pages: pagesOf(total),
    forms: formOptions.map((row) => ({ value: String(row.id), label: row.name })),
    statuses: claimStatus.FILTER_CHOICES.map(([value, label]) => ({ value, label })),
    dates: { crumbs, options },
    canOperate: await isTemplateAdmin(user),
  };
  return c.json(answer);
});

/** Deletion's confirmation: the selected claims that are not deleted yet, and whether Finance may hold them. */
router.get("/admin/claims/deletion", async (c) => {
  const user = await requireTemplateAdmin(c);
  const ids = idsOf((c.req.query("ids") ?? "").split(",").filter(Boolean), UUID, 1000);
  const selected = (await selectedClaims(user, ids)).filter(
    (claim) => claim.state !== claimStatus.CLAIM_STATES.PURGING,
  );
  if (selected.length === 0) throw notFound("The selected claims have already been deleted.");
  if (selected.length > MAX_BULK_DELETE)
    throw new AppError(400, "too_many", `Please select at most ${MAX_BULK_DELETE} claims at once.`);
  const rows: DeletePreview["rows"] = [];
  for (const claim of selected)
    rows.push({ ...(await summary(claim)), sent: await delivery.mayHaveReachedFinance(claim) });
  return c.json({ rows } satisfies DeletePreview);
});

/** Deletes the selected claims for good, each on its own, and says what happened. */
router.post("/admin/claims/delete", async (c) => {
  const user = await requireTemplateAdmin(c);
  const input = await body(c);
  const ids = idsOf(input.ids, UUID, 1000);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) throw validationError({ reason: "This field is required." });
  if ([...reason].length > 500)
    throw validationError({
      reason: `Ensure this value has at most 500 characters (it has ${[...reason].length}).`,
    });
  const selected = (await selectedClaims(user, ids)).filter(
    (claim) => claim.state !== claimStatus.CLAIM_STATES.PURGING,
  );
  if (selected.length === 0) throw notFound("The selected claims have already been deleted.");
  if (selected.length > MAX_BULK_DELETE)
    throw new AppError(400, "too_many", `Please select at most ${MAX_BULK_DELETE} claims at once.`);
  const answer: DeleteAnswer = { deleted: 0, resuming: 0, refused: [], messages: [] };
  for (const claim of selected) {
    try {
      if (await operations.deleteClaim(claim.id, { actor: actor(user), reason })) answer.deleted += 1;
      else answer.resuming += 1;
    } catch (error) {
      if (!(error instanceof operations.ActionRefused)) throw error;
      answer.refused.push({ reference: fullReference(claim), message: error.message });
    }
  }
  if (answer.deleted)
    answer.messages.push({
      tone: "success",
      text: answer.deleted === 1 ? "The claim was deleted." : `${answer.deleted} claims were deleted.`,
    });
  if (answer.resuming)
    answer.messages.push({
      tone: "warning",
      text: `Deletion has started and finishes automatically within a few minutes (${answer.resuming} ${answer.resuming === 1 ? "claim" : "claims"}).`,
    });
  for (const refused of answer.refused)
    answer.messages.push({
      tone: "error",
      text: selected.length === 1 ? refused.message : `${refused.reference}: ${refused.message}`,
    });
  return c.json(answer, answer.refused.length === selected.length ? 409 : 200);
});

/**
 * Archives claims, or asks first when that deletes some of them at once: an
 * overdue claim is past its retention period and kept only for its
 * resolution, so retention deletes it within minutes once archived.
 */
async function archiveClaims(user: User, selected: Annotated[], confirmed: boolean): Promise<ArchiveAnswer> {
  const now = new Date();
  const overdue: Annotated[] = [];
  for (const claim of selected) if ((await claimStatus.of(claim, { now })).overdue) overdue.push(claim);
  if (overdue.length > 0 && !confirmed) {
    const rows: ClaimSummary[] = [];
    for (const claim of overdue) rows.push(await summary(claim));
    return {
      confirm: true,
      overdue: rows,
      selected: selected.length,
      retentionDays: config().CONTENT_RETENTION_DAYS,
    };
  }
  const changed = await operations.archive(
    selected.map((claim) => claim.id),
    { actor: actor(user) },
  );
  return { confirm: false, changed, message: archivingMessage(changed, "claim", true) };
}

router.post("/admin/claims/archive", async (c) => {
  const user = await requireTemplateAdmin(c);
  const input = await body(c);
  const selected = await selectedClaims(user, idsOf(input.ids, UUID));
  return c.json(await archiveClaims(user, selected, input.confirm === true));
});

router.post("/admin/claims/unarchive", async (c) => {
  const user = await requireTemplateAdmin(c);
  const selected = await selectedClaims(user, idsOf((await body(c)).ids, UUID));
  const changed = await operations.unarchive(
    selected.map((claim) => claim.id),
    { actor: actor(user) },
  );
  return c.json({ changed, message: archivingMessage(changed, "claim", false) });
});

router.get("/admin/claims/:id", async (c) => {
  const user = await requireEditor(c);
  const claim = await visibleClaim(user, uuidParam(c));
  const { status, badge: shown } = await badge(claim);
  const logged = await q()
    .select()
    .from(operationRows)
    .where(eq(operationRows.claimId, claim.id))
    .orderBy(desc(operationRows.createdAt), desc(operationRows.id));
  const due = retention.contentDue(claim);
  const answer: ClaimDetail = {
    id: claim.id,
    reference: fullReference(claim),
    form: claim.formName,
    submittedAt: formatDateTime(claim.submittedAt),
    fullName: claim.fullName,
    email: claim.email,
    total: claim.total === null ? "" : formatAmount(claim.total),
    status: shown,
    archived: status.archived,
    error: status.errorCode,
    archivedAt: claim.archivedAt ? formatDateTime(claim.archivedAt) : "",
    pdfRemovedAt: claim.pdfRemovedAt ? formatDateTime(claim.pdfRemovedAt) : "",
    contentDue: due ? formatDateTime(due) : "",
    overdue: status.overdue,
    operations: logged.map((row) => ({
      id: row.id,
      when: formatDateTime(row.createdAt),
      action: OPERATION_LABELS[row.action] ?? row.action,
      actor: row.actor,
      reason: row.reason,
    })),
    // A deleted claim has nothing left to process, archive or delete.
    canOperate: (await isTemplateAdmin(user)) && !status.deleted,
  };
  return c.json(answer);
});

async function operableClaim(c: Context<AppEnv>): Promise<{ user: User; claim: Annotated }> {
  const user = await requireEditor(c);
  if (!(await isTemplateAdmin(user))) throw forbidden("Only template admins may do this.");
  return { user, claim: await visibleClaim(user, uuidParam(c)) };
}

/** What processing the claim again would do, before it runs. */
router.get("/admin/claims/:id/retry", async (c) => {
  const { claim } = await operableClaim(c);
  let plan: RetryPage["plan"] = null;
  let refused = "";
  try {
    plan = await operations.planRetry(claim);
  } catch (error) {
    if (!(error instanceof operations.ActionRefused)) throw error;
    refused = error.message;
  }
  return c.json({ claim: await summary(claim), plan, refused } satisfies RetryPage);
});

router.post("/admin/claims/:id/retry", async (c) => {
  const { user, claim } = await operableClaim(c);
  const input = await body(c);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) throw validationError({ reason: "This field is required." });
  if ([...reason].length > 500)
    throw validationError({
      reason: `Ensure this value has at most 500 characters (it has ${[...reason].length}).`,
    });
  try {
    await operations.retry(claim.id, {
      actor: actor(user),
      reason,
      acknowledgeDuplicateRisk: input.acknowledgeDuplicateRisk === true,
    });
  } catch (error) {
    if (!(error instanceof operations.ActionRefused)) throw error;
    throw new AppError(409, error.code, error.message);
  }
  return c.json({ ok: true, message: "Processing has started again." });
});

router.post("/admin/claims/:id/archive", async (c) => {
  const { user, claim } = await operableClaim(c);
  if ((await claimStatus.of(claim)).deleted)
    return c.json({
      confirm: false,
      changed: 0,
      message: "This claim has already been deleted.",
    } satisfies ArchiveAnswer);
  const input = await body(c).catch(() => ({}) as Record<string, unknown>);
  const answer = await archiveClaims(user, [claim], input.confirm === true);
  if (!answer.confirm && answer.changed)
    answer.message = "The claim was archived. The claims list shows it under Status: Archived.";
  return c.json(answer);
});

router.post("/admin/claims/:id/unarchive", async (c) => {
  const { user, claim } = await operableClaim(c);
  if ((await claimStatus.of(claim)).deleted)
    return c.json({ changed: 0, message: "This claim has already been deleted." });
  const changed = await operations.unarchive([claim.id], { actor: actor(user) });
  return c.json({ changed, message: changed ? "The claim was unarchived." : "The claim is not archived." });
});

export default router;
