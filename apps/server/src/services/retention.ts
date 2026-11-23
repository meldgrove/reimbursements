/**
 * Retention: when a claim's PDF and content are deleted, and deleting them
 * (portal/services/retention.py of the Django version).
 *
 * A claim is resolved once Finance has its PDF. The PDF then goes after
 * PDF_RETENTION_DAYS, everything else CONTENT_RETENTION_DAYS after
 * submission, never before the PDF. An unresolved claim keeps everything
 * until an operator resolves, archives or deletes it. Archiving needs no
 * resolution: an archived claim that is not resolved goes on its resolution
 * date, CONTENT_RETENTION_DAYS after submission.
 */
import { and, count, eq, isNotNull, isNull, lt, lte, ne, or, type SQL } from "drizzle-orm";
import { config } from "../config";
import {
  claims,
  confirmations,
  deliveries,
  deliveryAttempts,
  draftAdmissions,
  drafts,
  uploads,
  workspaceReservations,
  type Claim,
} from "../db/schema";
import { atomic, q } from "../db/tx";
import { logger } from "../logger";
import { deleteExpiredSessions } from "../auth/session";
import { recoverAbandonedWorkspaces } from "./capacity";
import { CLAIM_STATES } from "./claim-status";
import * as outbound from "./outbound";
import * as queue from "./queue";
import { removeKeys, sweepOrphans, type ArtifactOwners } from "./storage";
import { DELIVERED, FAILED, UNKNOWN } from "./transport";
import { expireDraft, expireUnattached, removeFiles } from "./uploads";

const DAY_MS = 24 * 3600 * 1000;
const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS);

/** When an unresolved claim becomes overdue for an operator. */
export function resolutionDue(submittedAt: Date): Date {
  return addDays(submittedAt, config().CONTENT_RETENTION_DAYS);
}

/** Claims whose content is due for deletion at `now`; see `contentDue`. */
export function contentDueBy(now: Date): SQL {
  return or(
    lte(claims.retentionDue, now),
    and(isNotNull(claims.archivedAt), isNull(claims.retentionDue), lte(claims.resolutionDue, now)),
  )!;
}

/** When the claim's remaining content is deleted, or null while it awaits resolution. */
export function contentDue(claim: Pick<Claim, "retentionDue" | "archivedAt" | "resolutionDue">): Date | null {
  if (claim.retentionDue === null && claim.archivedAt !== null) return claim.resolutionDue;
  return claim.retentionDue;
}

/**
 * Sets the deletion dates of a claim the caller locked from its Finance
 * delivery's state. A delivered claim is resolved. A failed or unclear
 * delivery holds everything until an operator resolves or archives it. Any
 * other state changes nothing.
 */
export async function followDelivery(
  claim: Pick<Claim, "id" | "submittedAt">,
  state: string,
  deliveredAt: Date | null,
) {
  let pdfDue: Date | null;
  let retentionDue: Date | null;
  if (state === DELIVERED) {
    pdfDue = addDays(deliveredAt ?? new Date(), config().PDF_RETENTION_DAYS);
    const content = addDays(claim.submittedAt, config().CONTENT_RETENTION_DAYS);
    retentionDue = content.getTime() >= pdfDue.getTime() ? content : pdfDue;
  } else if (state === FAILED || state === UNKNOWN) {
    pdfDue = retentionDue = null;
  } else {
    return;
  }
  await q().update(claims).set({ pdfDue, retentionDue }).where(eq(claims.id, claim.id));
}

/** A job or execution workspace still uses the claim; purge later. */
export class ClaimBusy extends Error {
  constructor() {
    super("claim_busy");
    this.name = "ClaimBusy";
  }
}

async function inUse(claimId: string): Promise<boolean> {
  if (await queue.claimHasRunningJob(claimId)) return true;
  const [reserved] = await q()
    .select({ id: workspaceReservations.id })
    .from(workspaceReservations)
    .leftJoin(uploads, eq(uploads.id, workspaceReservations.uploadId))
    .where(or(eq(workspaceReservations.claimId, claimId), eq(uploads.claimId, claimId)))
    .limit(1);
  return Boolean(reserved);
}

/** The claim's emails to Finance: they carry its PDF. */
async function financeEmails(claimId: string) {
  return q()
    .select({ id: deliveryAttempts.id, messageId: deliveryAttempts.messageId })
    .from(deliveryAttempts)
    .innerJoin(deliveries, eq(deliveries.id, deliveryAttempts.deliveryId))
    .where(eq(deliveries.claimId, claimId));
}

async function emails(claimId: string) {
  const confirmationRows = await q()
    .select({ id: confirmations.id, messageId: confirmations.messageId })
    .from(confirmations)
    .where(eq(confirmations.claimId, claimId));
  return [...(await financeEmails(claimId)), ...confirmationRows];
}

/**
 * Marks a claim the caller has locked as purging and cancels its jobs.
 *
 * Throws ClaimBusy while a job or execution workspace still uses it. Once
 * marked, the worker's cleanup finishes the purge even if the caller is
 * interrupted.
 */
export async function beginPurge(claim: Pick<Claim, "id">) {
  if (await inUse(claim.id)) throw new ClaimBusy();
  await q().update(claims).set({ state: CLAIM_STATES.PURGING }).where(eq(claims.id, claim.id));
  await queue.cancelClaimJobs(claim.id);
}

function lockClaim(claimId: string) {
  return q().select().from(claims).where(eq(claims.id, claimId)).for("update");
}

/**
 * Deletes a claim with its files and every record that belongs to it.
 *
 * Nothing of the claim remains in the database. Only operator actions stay in
 * the log, without a link to the claim.
 *
 * `dueBy` (the cleanup) deletes the claim only if its content is still due
 * then, checked under the lock: an operator may have unarchived it, or
 * evidence moved its date, since the cleanup listed it. A purge already begun
 * always finishes; an operator's deletion passes no date.
 */
export async function purgeClaim(claimId: string, options: { dueBy?: Date } = {}) {
  const claim = await atomic(async () => {
    const [locked] = await lockClaim(claimId);
    if (!locked) return null;
    if (options.dueBy && locked.state !== CLAIM_STATES.PURGING) {
      const due = contentDue(locked);
      if (!due || due.getTime() > options.dueBy.getTime()) return null;
    }
    await beginPurge(locked);
    return locked;
  });
  if (!claim) return;
  // Leave the manifest intact until every deletion succeeds, so a crash resumes safely.
  const files = await q().select().from(uploads).where(eq(uploads.claimId, claim.id));
  for (const upload of files) await removeFiles(upload);
  removeKeys(claim.pdfKey);
  await atomic(async () => {
    const [locked] = await lockClaim(claimId);
    if (!locked) return;
    if (await inUse(locked.id)) throw new ClaimBusy();
    // Evidence names emails, not the claim; the claim's other records cascade.
    await outbound.forget(...(await emails(locked.id)));
    // Released and expired, the accepted draft goes with the next cleanup, together
    // with any uploads it kept; it no longer counts as an active draft.
    await q()
      .update(drafts)
      .set({ sessionHash: "", tokenHash: "", payloadHash: "", expiresAt: new Date() })
      .where(eq(drafts.claimId, locked.id));
    await q().delete(claims).where(eq(claims.id, locked.id));
  });
}

/**
 * Deletes a delivered claim's PDF and local email copies; the content stays.
 * `dueBy` (the cleanup): only if the PDF is still due then, checked under the lock.
 */
export async function removePdf(claimId: string, options: { dueBy?: Date } = {}) {
  await atomic(async () => {
    // The row lock keeps operator retries out until the PDF is gone.
    const [claim] = await lockClaim(claimId);
    if (!claim || !claim.pdfKey || claim.state === CLAIM_STATES.PURGING) return;
    if (options.dueBy && !(claim.pdfDue && claim.pdfDue.getTime() <= options.dueBy.getTime())) return;
    if (await queue.claimHasActiveJob(claim.id)) throw new ClaimBusy();
    removeKeys(claim.pdfKey);
    outbound.removeCopies(...(await financeEmails(claim.id)).map((email) => email.id));
    await q().update(claims).set({ pdfKey: "", pdfRemovedAt: new Date() }).where(eq(claims.id, claim.id));
  });
}

export type CleanupResult = {
  pdfs_due: number;
  claims_due: number;
  drafts_due: number;
  unresolved_near_expiry: number;
  failures: number;
};

/** Whether `error` is a filesystem error (Python's OSError). */
function isFileError(error: unknown): boolean {
  return (
    error instanceof Error && typeof (error as { code?: unknown }).code === "string" && "syscall" in error
  );
}

/** Due deletions: counted, and with `execute` carried out. */
export async function cleanup(options: { execute?: boolean } = {}): Promise<CleanupResult> {
  const now = new Date();
  const pdfs = (
    await q()
      .select({ id: claims.id })
      .from(claims)
      .where(and(lte(claims.pdfDue, now), ne(claims.pdfKey, ""), ne(claims.state, CLAIM_STATES.PURGING)))
  ).map((row) => row.id);
  const due = (
    await q()
      .select({ id: claims.id })
      .from(claims)
      .where(or(contentDueBy(now), eq(claims.state, CLAIM_STATES.PURGING)))
  ).map((row) => row.id);
  const draftIds = (
    await q()
      .select({ id: drafts.id })
      .from(drafts)
      .where(and(isNull(drafts.claimId), lt(drafts.expiresAt, now)))
  ).map((row) => row.id);
  const [unresolved] = await q()
    .select({ value: count() })
    .from(claims)
    .where(
      and(
        lte(claims.resolutionDue, addDays(now, 3)),
        isNull(claims.retentionDue),
        isNull(claims.archivedAt),
        ne(claims.state, CLAIM_STATES.PURGING),
      ),
    );
  const result: CleanupResult = {
    pdfs_due: pdfs.length,
    claims_due: due.length,
    drafts_due: draftIds.length,
    unresolved_near_expiry: Number(unresolved?.value ?? 0),
    failures: 0,
  };
  if (!options.execute) return result;
  // Session expiry denies access but does not remove stored tokens or metadata.
  await deleteExpiredSessions();
  await q()
    .delete(draftAdmissions)
    .where(lt(draftAdmissions.windowStart, addDays(now, -2)));
  for (const claimId of pdfs) {
    try {
      await removePdf(claimId, { dueBy: now });
    } catch (error) {
      if (!(error instanceof ClaimBusy) && !isFileError(error)) throw error;
      result.failures += 1;
      logger.error({ reference: claimId }, "pdf_removal_failed");
    }
  }
  for (const claimId of due) {
    try {
      await purgeClaim(claimId, { dueBy: now });
    } catch (error) {
      if (!(error instanceof ClaimBusy) && !isFileError(error)) throw error;
      result.failures += 1;
      logger.error({ reference: claimId }, "purge_failed");
    }
  }
  for (const draftId of draftIds) {
    try {
      await expireDraft(draftId);
    } catch (error) {
      if (!isFileError(error)) throw error;
      result.failures += 1;
    }
  }
  result.failures += await expireUnattached(now);
  await orphanCleanup();
  return result;
}

/** Database ownership of stored artifacts, for the storage orphan sweep. */
export const storedOwners: ArtifactOwners = {
  async uploadKeys(uploadId) {
    const [upload] = await q()
      .select({ sourceKey: uploads.sourceKey, normalizedKey: uploads.normalizedKey })
      .from(uploads)
      .where(eq(uploads.id, uploadId));
    return upload ? new Set([upload.sourceKey, upload.normalizedKey]) : null;
  },
  async workspaceReserved(key) {
    const [row] = await q()
      .select({ id: workspaceReservations.id })
      .from(workspaceReservations)
      .where(eq(workspaceReservations.directory, key))
      .limit(1);
    return Boolean(row);
  },
  async pdfReferenced(key) {
    const [row] = await q().select({ id: claims.id }).from(claims).where(eq(claims.pdfKey, key)).limit(1);
    return Boolean(row);
  },
};

export async function orphanCleanup() {
  await recoverAbandonedWorkspaces();
  await sweepOrphans(new Date(Date.now() - DAY_MS), storedOwners);
}
