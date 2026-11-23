/**
 * Audited operator actions on claims, shared by the admin area and the CLI
 * commands (portal/services/operations.py of the Django version).
 */
import { and, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { claims, operations, type Claim } from "../db/schema";
import { atomic, q } from "../db/tx";
import { logger } from "../logger";
import { CLAIM_STATES, forReference } from "./claim-status";
import * as delivery from "./delivery";
import { requeueRender } from "./job-kinds";
import * as queue from "./queue";
import * as retention from "./retention";

/** The action is not possible now. `code` names the reason; the message is for operators. */
export class ActionRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ActionRefused";
  }
}

export const RENDER = "render";
export const RESEND = "resend";

/**
 * What processing a claim again does now. `action` is RENDER, building a PDF
 * that was never produced, or RESEND, sending the PDF to Finance again. A
 * resend with `duplicateRisk` needs the operator's acknowledgment, because
 * Finance may already hold the PDF.
 */
export type Retry = { action: typeof RENDER | typeof RESEND; duplicateRisk: boolean };

/** What a retry of `claim` would do now. Throws ActionRefused when it cannot run. */
export async function planRetry(claim: Pick<Claim, "id" | "state" | "pdfKey">): Promise<Retry> {
  if (await queue.claimHasActiveJob(claim.id)) {
    throw new ActionRefused("active_job", "This claim is already being processed.");
  }
  if (claim.state === CLAIM_STATES.READY) {
    if (!claim.pdfKey) {
      throw new ActionRefused("pdf_removed", "The PDF has already been deleted and cannot be sent again.");
    }
    return { action: RESEND, duplicateRisk: await delivery.mayHaveReachedFinance(claim) };
  }
  if (claim.state === CLAIM_STATES.FAILED && !claim.pdfKey) return { action: RENDER, duplicateRisk: false };
  throw new ActionRefused("not_retryable", "This claim cannot be processed again in its current state.");
}

/** Carries out `planRetry`. A resend that may duplicate needs acknowledgment. Returns the claim. */
export async function retry(
  reference: string,
  options: { actor: string; reason: string; acknowledgeDuplicateRisk?: boolean },
): Promise<Claim> {
  return atomic(async () => {
    const [claim] = await q().select().from(claims).where(forReference(reference)).for("update");
    if (!claim) throw new ClaimNotFound(reference);
    if (!options.reason.trim()) throw new ActionRefused("reason_missing", "Please give a reason.");
    const plan = await planRetry(claim);
    if (plan.duplicateRisk && !options.acknowledgeDuplicateRisk) {
      throw new ActionRefused(
        "duplicate_risk",
        "The email may already have arrived. Check the delivery first, then acknowledge the risk of a duplicate delivery.",
      );
    }
    if (plan.action === RESEND) await delivery.resend(claim);
    else await requeueRender(claim);
    await q()
      .insert(operations)
      .values({
        claimId: claim.id,
        action: "retry",
        actor: options.actor,
        reason: options.reason.trim().slice(0, 500),
      });
    const [current] = await q().select().from(claims).where(eq(claims.id, claim.id));
    return current!;
  });
}

/** No claim has this reference (Django's Claim.DoesNotExist). */
export class ClaimNotFound extends Error {
  constructor(readonly reference: string) {
    super(`No claim has the reference ${reference}.`);
    this.name = "ClaimNotFound";
  }
}

/**
 * Deletes a claim now instead of at its retention date (Django's `delete`).
 *
 * Pending processing and sending stop, and the claim's record is deleted with
 * its content. The audited operation remains without a link to the claim. A
 * copy Finance already received stays with Finance. Returns true once the
 * claim is gone, or false when the purge began but could not finish now: the
 * claim stays purging and the worker's cleanup finishes it.
 */
export async function deleteClaim(
  reference: string,
  options: { actor: string; reason: string },
): Promise<boolean> {
  const claim = await atomic(async () => {
    const [found] = await q().select().from(claims).where(forReference(reference)).for("update");
    if (!options.reason.trim()) throw new ActionRefused("reason_missing", "Please give a reason.");
    if (!found || found.state === CLAIM_STATES.PURGING) {
      throw new ActionRefused("already_deleted", "This claim has already been deleted.");
    }
    try {
      await retention.beginPurge(found);
    } catch (error) {
      if (error instanceof retention.ClaimBusy) {
        throw new ActionRefused(
          "busy",
          "The claim is being processed or sent right now. Try again in a few minutes.",
        );
      }
      throw error;
    }
    await q()
      .insert(operations)
      .values({
        claimId: found.id,
        action: "delete",
        actor: options.actor,
        reason: options.reason.trim().slice(0, 500),
      });
    return found;
  });
  // Evidence outside the database, so a restored backup can be purged again.
  logger.info({ reference: claim.id }, "claim_deleted");
  try {
    await retention.purgeClaim(claim.id);
  } catch (error) {
    const fileError = error instanceof Error && "syscall" in error;
    if (!(error instanceof retention.ClaimBusy) && !fileError) throw error;
    logger.error({ reference: claim.id }, "purge_failed");
    return false;
  }
  return true;
}

/**
 * Hides claims from the claims list. Returns how many were archived.
 *
 * Processing and sending go on. An archived claim needs no resolution:
 * retention deletes it like a resolved one, or on its resolution date if it
 * was never resolved. Claims that are archived already or being deleted are
 * left as they are.
 */
export function archive(claimIds: string[], options: { actor: string }): Promise<number> {
  return setArchived(claimIds, new Date(), "archive", options.actor);
}

/** Returns archived claims to the claims list. Returns how many were unarchived. */
export function unarchive(claimIds: string[], options: { actor: string }): Promise<number> {
  return setArchived(claimIds, null, "unarchive", options.actor);
}

function setArchived(claimIds: string[], archivedAt: Date | null, action: string, actor: string) {
  return atomic(async () => {
    if (!claimIds.length) return 0;
    const locked = await q()
      .select({ id: claims.id })
      .from(claims)
      .where(
        and(
          inArray(claims.id, claimIds),
          archivedAt ? isNull(claims.archivedAt) : isNotNull(claims.archivedAt),
          ne(claims.state, CLAIM_STATES.PURGING),
        ),
      )
      .for("update");
    const ids = locked.map((row) => row.id);
    if (!ids.length) return 0;
    await q().update(claims).set({ archivedAt }).where(inArray(claims.id, ids));
    await q()
      .insert(operations)
      .values(ids.map((claimId) => ({ claimId, action, actor, reason: "" })));
    return ids.length;
  });
}
