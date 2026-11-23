/**
 * Delivery of a claim's authoritative PDF to its approved Finance inbox
 * (portal/services/delivery.py of the Django version).
 *
 * A Delivery's state is derived from its attempts. Attempts change only
 * through send results recorded here and provider evidence, which the
 * Evidence module applies through `settle`. A send whose outcome is unknown
 * is never repeated automatically. Finance may hold a copy unless every send
 * definitely failed; an operator resend then has to acknowledge the duplicate
 * risk. Failures before transmission are definite, because nothing reached
 * the provider.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, asc, eq, ne, sql, type SQL } from "drizzle-orm";
import { config } from "../config";
import {
  claims,
  deliveries,
  deliveryAttempts,
  type Claim,
  type Delivery,
  type DeliveryAttempt,
} from "../db/schema";
import { q } from "../db/tx";
import { t } from "../i18n";
import { forClaim } from "./app-settings";
import { CLAIM_STATES } from "./claim-status";
import { claimReference } from "./documents";
import * as outbound from "./outbound";
import { Undeliverable } from "./outbound";
import * as queue from "./queue";
import { followDelivery } from "./retention";
import { pathFor } from "./storage";
import {
  ACCEPTED,
  DELIVERED,
  FAILED,
  FINAL,
  PAUSED,
  PENDING,
  SENDING,
  UNKNOWN,
  type Message,
  type SendResult,
} from "./transport";

/** The provider holds or delivered the message: never send again automatically. */
const NO_AUTOMATIC_SEND: ReadonlySet<string> = new Set([DELIVERED, ACCEPTED, PAUSED, UNKNOWN]);

export type LockedDelivery = Delivery & { claim: Claim };

/** Queues delivery of a claim whose PDF is ready. Idempotent. */
export async function schedule(claim: Pick<Claim, "id" | "snapshot">): Promise<Delivery> {
  await q()
    .insert(deliveries)
    .values({ claimId: claim.id, recipient: snapshotText(claim.snapshot, "recipient") })
    .onConflictDoNothing({ target: deliveries.claimId });
  const [delivery] = await q().select().from(deliveries).where(eq(deliveries.claimId, claim.id));
  await queue.enqueue("send", delivery!);
  return delivery!;
}

/** In a transaction, locks Claim before Delivery, then any delivery attempts. */
async function lockDelivery(where: SQL): Promise<LockedDelivery> {
  const [found] = await q().select({ claimId: deliveries.claimId }).from(deliveries).where(where);
  if (!found) throw new Error("Delivery does not exist");
  const [claim] = await q().select().from(claims).where(eq(claims.id, found.claimId)).for("update");
  const [delivery] = await q().select().from(deliveries).where(where).for("update");
  if (!claim || !delivery) throw new Error("Delivery does not exist");
  return { ...delivery, claim };
}

async function attemptsOf(deliveryId: number): Promise<DeliveryAttempt[]> {
  return q()
    .select()
    .from(deliveryAttempts)
    .where(eq(deliveryAttempts.deliveryId, deliveryId))
    .orderBy(asc(deliveryAttempts.createdAt), asc(deliveryAttempts.id));
}

/** Derives the delivery's state from its attempts, and reports it to retention. */
export async function refresh(delivery: Pick<Delivery, "id" | "claimId" | "deliveredAt">) {
  const attempts = await attemptsOf(delivery.id);
  if (!attempts.length) return;
  const successful = attempts.filter((attempt) => attempt.state === DELIVERED);
  const current = successful.at(-1) ?? attempts.at(-1)!;
  const [claim] = await q().select().from(claims).where(eq(claims.id, delivery.claimId)).for("update");
  let deliveredAt = delivery.deliveredAt;
  if (current.state === DELIVERED) deliveredAt = deliveredAt ?? new Date();
  await followDelivery(claim!, current.state, deliveredAt);
  await q()
    .update(deliveries)
    .set({
      state: current.state,
      messageId: current.messageId ?? "",
      errorCode: current.errorCode,
      deliveredAt,
    })
    .where(eq(deliveries.id, delivery.id));
  // Callers keep using their row: give it the new values too.
  Object.assign(delivery, { deliveredAt });
}

/** In a transaction: a new attempt, or null when no automatic send may happen. */
export async function startAttempt(deliveryId: number): Promise<DeliveryAttempt | null> {
  const delivery = await lockDelivery(eq(deliveries.id, deliveryId));
  if (delivery.claim.state !== CLAIM_STATES.READY) return null;
  if (NO_AUTOMATIC_SEND.has(delivery.state)) {
    // After an earlier delivery the state stays delivered, also while an operator's
    // resend waits to be retried because the provider refused it before acceptance.
    const latest = (await attemptsOf(delivery.id)).at(-1);
    if (!latest || latest.state !== PENDING) return null;
  }
  const [attempt] = await q()
    .insert(deliveryAttempts)
    .values({ deliveryId: delivery.id, state: SENDING })
    .returning();
  await refresh(delivery);
  return attempt!;
}

/** The Finance email of an attempt. Throws Undeliverable when it cannot be sent. */
export async function compose(attempt: Pick<DeliveryAttempt, "id" | "deliveryId">): Promise<Message> {
  const [row] = await q()
    .select({ delivery: deliveries, claim: claims })
    .from(deliveries)
    .innerJoin(claims, eq(claims.id, deliveries.claimId))
    .where(eq(deliveries.id, attempt.deliveryId));
  if (!row) throw new Undeliverable("message_unavailable");
  const { delivery, claim } = row;
  if (!outbound.recipientApproved(delivery.recipient)) throw new Undeliverable("unapproved_recipient");
  let content: Buffer;
  try {
    content = readFileSync(pathFor(claim.pdfKey));
  } catch {
    throw new Undeliverable("attachment_unavailable");
  }
  if (
    content.length > config().MAX_FINAL_PDF_BYTES ||
    createHash("sha256").update(content).digest("hex") !== claim.pdfHash
  ) {
    throw new Undeliverable("attachment_integrity");
  }
  const reference = claimReference(claim);
  // A claim without these fails to compose: nothing is sent (message_unavailable).
  const values = { reference, form: snapshotText(claim.snapshot, "name") };
  const { subject, text } = await forClaim(claim, async () => ({
    subject: t("Reimbursement claim {reference} | {form}", values),
    text: t(
      "Reimbursement claim {reference}\nForm: {form}\n\nThe complete reimbursement form and all receipts are in the attached PDF.\n",
      values,
    ),
  }));
  const settings = config();
  return {
    attemptId: attempt.id,
    sender: settings.MAIL_FROM_ADDRESS,
    replyTo: settings.MAIL_REPLY_TO_ADDRESS,
    recipient: delivery.recipient,
    subject,
    text,
    attachment: content,
    filename: `reimbursement_${reference.replaceAll("/", "_")}.pdf`,
  };
}

/** A value the claim's snapshot must hold, as text (Python's snapshot["key"] raised KeyError). */
export function snapshotText(snapshot: Record<string, unknown>, key: string): string {
  if (!(key in snapshot)) throw new Error(`The claim's snapshot has no ${key}`);
  const value = snapshot[key];
  return value === null || value === undefined ? "None" : String(value);
}

/** In a transaction: stores a send result unless provider evidence already settled it. */
export async function recordResult(attemptId: string, result: SendResult) {
  const [found] = await q().select().from(deliveryAttempts).where(eq(deliveryAttempts.id, attemptId));
  if (!found) throw new Error(`Delivery attempt ${attemptId} does not exist`);
  const delivery = await lockDelivery(eq(deliveries.id, found.deliveryId));
  const [attempt] = await q()
    .select()
    .from(deliveryAttempts)
    .where(eq(deliveryAttempts.id, attemptId))
    .for("update");
  const changes: Partial<DeliveryAttempt> = { updatedAt: new Date() };
  if (!FINAL.has(attempt!.state))
    Object.assign(changes, { state: result.state, errorCode: result.errorCode });
  if (result.messageId) changes.messageId = result.messageId;
  await q().update(deliveryAttempts).set(changes).where(eq(deliveryAttempts.id, attemptId));
  await refresh(delivery);
}

/** In a transaction: a send ended without a result, so its outcome is unknown. */
export async function markUnknown(deliveryId: number, errorCode: string) {
  const delivery = await lockDelivery(eq(deliveries.id, deliveryId));
  await q()
    .update(deliveryAttempts)
    // A bulk update in Django: the attempts' updated_at stays.
    .set({ state: UNKNOWN, errorCode, updatedAt: sql`${deliveryAttempts.updatedAt}` })
    .where(and(eq(deliveryAttempts.deliveryId, delivery.id), eq(deliveryAttempts.state, SENDING)));
  await refresh(delivery);
}

/**
 * In a transaction: lets provider evidence change an attempt, then refreshes
 * its delivery. `apply(attempt, recipient)` runs on the locked attempt unless
 * its claim is being deleted, and returns whether it changed the attempt.
 */
export async function settle(
  attemptId: string,
  apply: (attempt: DeliveryAttempt, recipient: string) => Promise<boolean>,
) {
  const [found] = await q()
    .select({ deliveryId: deliveryAttempts.deliveryId })
    .from(deliveryAttempts)
    .where(eq(deliveryAttempts.id, attemptId));
  if (!found) throw new Error(`Delivery attempt ${attemptId} does not exist`);
  const delivery = await lockDelivery(eq(deliveries.id, found.deliveryId));
  const [attempt] = await q()
    .select()
    .from(deliveryAttempts)
    .where(eq(deliveryAttempts.id, attemptId))
    .for("update");
  if (delivery.claim.state !== CLAIM_STATES.PURGING && (await apply(attempt!, delivery.recipient))) {
    await refresh(delivery);
  }
}

/** Some send of the claim's PDF did not definitely fail, so Finance may hold a copy. */
export async function mayHaveReachedFinance(claim: Pick<Claim, "id">): Promise<boolean> {
  const [row] = await q()
    .select({ id: deliveryAttempts.id })
    .from(deliveryAttempts)
    .innerJoin(deliveries, eq(deliveries.id, deliveryAttempts.deliveryId))
    .where(and(eq(deliveries.claimId, claim.id), ne(deliveryAttempts.state, FAILED)))
    .limit(1);
  return Boolean(row);
}

/** Operator retry: queues the claim's PDF for Finance again, whatever earlier sends did. */
export async function resend(claim: Pick<Claim, "id">) {
  const delivery = await lockDelivery(eq(deliveries.claimId, claim.id));
  await q().update(deliveries).set({ state: PENDING, errorCode: "" }).where(eq(deliveries.id, delivery.id));
  await queue.enqueue("send", delivery, { again: true });
}
