/**
 * Evidence: what the provider says about a sent email, applied to that
 * email's record (portal/services/evidence.py of the Django version).
 *
 * Every outbound email has one record: a Finance delivery attempt or a
 * participant confirmation. The MailerSend adapter turns webhooks and lookups
 * into `Evidence`. This module stores each piece once, finds the email it is
 * about by provider message ID or by the record ID the email was tagged with,
 * and moves the record's state. Evidence that arrives before its email's
 * record is retried, and dropped after `UNMATCHED_LIFETIME`. Evidence never
 * causes a send.
 */
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import { confirmations, deliveryAttempts, deliveryEvents, type DeliveryEvent } from "../db/schema";
import { atomic, q } from "../db/tx";
import * as confirmationsService from "./confirmations";
import * as deliveryService from "./delivery";
import * as mailersend from "./mailersend";
import type { Evidence } from "./mailersend";
import { ACCEPTED, DELIVERED, FAILED, FINAL, PAUSED, UNKNOWN } from "./transport";

/** Emails the provider can tell us more about. */
const RECONCILABLE = [ACCEPTED, PAUSED, UNKNOWN];
const UNMATCHED_LIFETIME_MS = 30 * 24 * 3600 * 1000;

type EmailRecord = {
  id: string;
  state: string;
  errorCode: string;
  messageId: string | null;
  lastCheckedAt: Date | null;
  updatedAt: Date;
};
type EmailTable = typeof deliveryAttempts | typeof confirmations;

/**
 * Where one kind of email keeps its records. `settle(recordId, apply)` locks
 * the record in a transaction and calls `apply(record, recipient)` with the
 * address the email went to, unless the claim is being deleted. `apply`
 * returns whether it changed the record.
 */
type Sender = {
  table: EmailTable;
  settle: (id: string, apply: (record: EmailRecord, recipient: string) => Promise<boolean>) => Promise<void>;
};

const SENDERS: Sender[] = [
  { table: deliveryAttempts, settle: deliveryService.settle },
  { table: confirmations, settle: confirmationsService.settle },
];

export function recipientHash(address: string): string {
  return createHash("sha256").update(address.toLowerCase()).digest("hex");
}

/** Stores what the provider says about an email; it applies once the email is known. */
export async function record(evidence: Evidence) {
  await atomic(async () => {
    await q()
      .insert(deliveryEvents)
      .values({
        providerId: evidence.providerId,
        kind: evidence.kind,
        providerTimestamp: evidence.timestamp,
        messageId: evidence.messageId,
        recipientHash: recipientHash(evidence.recipient),
        attemptTag: evidence.attemptId,
      })
      .onConflictDoNothing({ target: deliveryEvents.providerId });
    const [event] = await q()
      .select()
      .from(deliveryEvents)
      .where(eq(deliveryEvents.providerId, evidence.providerId));
    await apply(event!);
  });
}

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** The sender and record ID of the email `event` is about, or null. */
async function find(event: DeliveryEvent): Promise<[Sender, string] | null> {
  if (event.messageId) {
    for (const sender of SENDERS) {
      const [found] = await q()
        .select({ id: sender.table.id })
        .from(sender.table)
        .where(eq(sender.table.messageId, event.messageId))
        .limit(1);
      if (found) return [sender, found.id];
    }
  }
  const tag = event.attemptTag.replace(/^\{|\}$/g, "");
  if (!UUID.test(tag)) return null;
  const hex = tag.replace(/-/g, "").toLowerCase();
  const tagged = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  for (const sender of SENDERS) {
    const [found] = await q()
      .select({ id: sender.table.id })
      .from(sender.table)
      .where(eq(sender.table.id, tagged))
      .limit(1);
    if (found) return [sender, tagged];
  }
  return null;
}

async function apply(event: DeliveryEvent) {
  if (event.applied) return;
  const found = await find(event);
  if (!found) return;
  const [sender, recordId] = found;
  await sender.settle(recordId, (email, recipient) => settleEmail(sender.table, email, recipient, event));
}

/** Applies `event` to the locked record of an email sent to `recipient`. */
async function settleEmail(
  table: EmailTable,
  email: EmailRecord,
  recipient: string,
  event: DeliveryEvent,
): Promise<boolean> {
  if (recipientHash(recipient) !== event.recipientHash) return false;
  if (email.messageId && event.messageId && email.messageId !== event.messageId) return false;
  const changes: Partial<EmailRecord> = { updatedAt: new Date() };
  if (!email.messageId && event.messageId) changes.messageId = event.messageId;
  const [outcomeState, errorCode, resolvesUnknownOnly] = mailersend.outcome(event.kind);
  let state: string | null = outcomeState;
  if (resolvesUnknownOnly && email.state !== UNKNOWN) state = null;
  // Terminal success/failure cannot regress on a late sent/deferred callback.
  if (state && (FINAL.has(state) || !FINAL.has(email.state))) {
    if (!(email.state === FAILED && state === DELIVERED)) {
      changes.state = state;
      changes.errorCode = errorCode;
    }
  }
  await q().update(table).set(changes).where(eq(table.id, email.id));
  Object.assign(email, changes);
  await q().update(deliveryEvents).set({ applied: true }).where(eq(deliveryEvents.id, event.id));
  event.applied = true;
  return true;
}

/** Retries evidence that arrived before its email's record; drops what stays unmatched. */
export async function reconcileUnmatched() {
  await atomic(async () => {
    const now = new Date();
    await q()
      .delete(deliveryEvents)
      .where(
        and(
          eq(deliveryEvents.applied, false),
          lt(deliveryEvents.receivedAt, new Date(now.getTime() - UNMATCHED_LIFETIME_MS)),
        ),
      );
    const events = await q()
      .select()
      .from(deliveryEvents)
      .where(eq(deliveryEvents.applied, false))
      .orderBy(
        sql`${deliveryEvents.lastCheckedAt} asc nulls first`,
        asc(deliveryEvents.receivedAt),
        asc(deliveryEvents.id),
      )
      .limit(100);
    for (const event of events) {
      await q().update(deliveryEvents).set({ lastCheckedAt: now }).where(eq(deliveryEvents.id, event.id));
      event.lastCheckedAt = now;
      await apply(event);
    }
  });
}

/** Unsettled emails with a message ID: never checked first, then the least recent. */
async function unsettled(table: EmailTable, limit: number): Promise<EmailRecord[]> {
  return q()
    .select({
      id: table.id,
      state: table.state,
      errorCode: table.errorCode,
      messageId: table.messageId,
      lastCheckedAt: table.lastCheckedAt,
      updatedAt: table.updatedAt,
    })
    .from(table)
    .where(and(isNotNull(table.messageId), ne(table.messageId, ""), inArray(table.state, RECONCILABLE)))
    .orderBy(sql`${table.lastCheckedAt} asc nulls first`, asc(table.updatedAt), asc(table.id))
    .limit(limit);
}

/** Never-checked emails first, by when they last changed; then by when they were last checked. */
function due(email: EmailRecord): [number, number] {
  return [email.lastCheckedAt ? 1 : 0, (email.lastCheckedAt ?? email.updatedAt).getTime()];
}

export type ReconcileCounts = { checked: number; deferred: number; failed: number };

/**
 * Asks the provider about unsettled emails of every sender. Never resends.
 * Returns counts of checked emails, deferred answers and failed lookups.
 */
export async function reconcile(batchSize: number): Promise<ReconcileCounts> {
  await reconcileUnmatched();
  const candidates: Array<[Sender, EmailRecord]> = [];
  for (const sender of SENDERS) {
    for (const email of await unsettled(sender.table, batchSize)) candidates.push([sender, email]);
  }
  candidates.sort(([, a], [, b]) => {
    const [x, y] = [due(a), due(b)];
    return x[0] - y[0] || x[1] - y[1];
  });
  const counts: ReconcileCounts = { checked: 0, deferred: 0, failed: 0 };
  for (const [sender, email] of candidates.slice(0, batchSize)) {
    // A bulk update in Django: the record's updated_at stays.
    await q()
      .update(sender.table)
      .set({ lastCheckedAt: new Date(), updatedAt: sql`${sender.table.updatedAt}` })
      .where(eq(sender.table.id, email.id));
    counts.checked += 1;
    let evidence: Evidence | null;
    try {
      evidence = await mailersend.lookup(email.id, email.messageId!);
    } catch (error) {
      if (!(error instanceof mailersend.LookupFailed)) throw error;
      counts.failed += 1;
      continue;
    }
    if (evidence === null) {
      counts.deferred += 1;
      continue;
    }
    await record(evidence);
  }
  return counts;
}
