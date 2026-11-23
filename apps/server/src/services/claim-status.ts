/**
 * The status a claim shows, to operators and to its participant
 * (portal/services/claim_status.py of the Django version).
 *
 * One rule decides it: the claim's processing state until a Finance delivery
 * exists, then the delivery's state, while a claim being deleted shows that
 * instead. The rule is a database expression (`STATUS`), so the admin list,
 * its Status filter, the claim-status command and the participant's Received
 * page all read the same value.
 *
 * Archiving is not a status: an archived claim keeps it, but the claims list
 * shows the claim only under the Status filter's own Archived option (`listed`).
 */
import { and, asc, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { claims, deliveries, type Claim, type Delivery } from "../db/schema";
import { q } from "../db/tx";
import { ACCEPTED, DELIVERED, FAILED, PAUSED, PENDING, SENDING, UNKNOWN } from "./transport";

/** The states of a claim's processing (Claim.State of the Django version). */
export const CLAIM_STATES = {
  RECEIVED: "received",
  RENDERING: "rendering",
  READY: "ready",
  FAILED: "processing_failed",
  /** Content removal has begun; the claim record itself is deleted last. */
  PURGING: "purging",
} as const;
export type ClaimState = (typeof CLAIM_STATES)[keyof typeof CLAIM_STATES];

/** Labels of the claim states, in the order a claim passes through them. */
export const CLAIM_STATE_LABELS: ReadonlyArray<readonly [ClaimState, string]> = [
  [CLAIM_STATES.RECEIVED, "Received"],
  [CLAIM_STATES.RENDERING, "Creating PDF"],
  [CLAIM_STATES.READY, "PDF created"],
  [CLAIM_STATES.FAILED, "PDF creation failed"],
  [CLAIM_STATES.PURGING, "Being deleted"],
];

export const DELIVERY_LABELS: Readonly<Record<string, string>> = {
  [PENDING]: "Waiting to send",
  [SENDING]: "Sending",
  [ACCEPTED]: "Accepted by the email service",
  [PAUSED]: "Sending delayed",
  [DELIVERED]: "Delivered",
  [FAILED]: "Sending failed",
  [UNKNOWN]: "Delivery unclear",
};

export const LABELS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(CLAIM_STATE_LABELS),
  ...DELIVERY_LABELS,
};

export const TONES: Readonly<Record<string, string>> = {
  [CLAIM_STATES.FAILED]: "destructive",
  [CLAIM_STATES.PURGING]: "outline",
  [PAUSED]: "warning",
  [UNKNOWN]: "warning",
  [FAILED]: "destructive",
  [DELIVERED]: "success",
};

/** A deleted claim is gone; one still being deleted is left to the worker's cleanup. */
export const DELETED: ReadonlySet<string> = new Set([CLAIM_STATES.PURGING]);

/** Every status in the order a claim passes through them, for filter options. */
export const CHOICES: ReadonlyArray<readonly [string, string]> = [
  ...CLAIM_STATE_LABELS.filter(([state]) => !DELETED.has(state)),
  ...Object.entries(DELIVERY_LABELS),
  ...CLAIM_STATE_LABELS.filter(([state]) => DELETED.has(state)),
];

/** The Status filter of the claims list: every status, then the archived claims. */
export const ARCHIVED = "archived";
export const FILTER_CHOICES: ReadonlyArray<readonly [string, string]> = [...CHOICES, [ARCHIVED, "Archived"]];

/** What a participant sees: three outcomes; the detailed states stay internal. */
export const PROCESSING = "processing";
export const PROBLEM = "problem";
const PROBLEMS: ReadonlySet<string> = new Set([CLAIM_STATES.FAILED, FAILED]);

/**
 * Each claim's status code (Django's `annotate`). Valid in a query of claims
 * left-joined with their delivery: `withDelivery()` builds one.
 */
export const STATUS: SQL<string> = sql<string>`(case when ${claims.state} = ${CLAIM_STATES.PURGING} or ${deliveries.id} is null then ${claims.state} else ${deliveries.state} end)`;

/** Claims matching `reference`: a UUID names a claim's ID, anything else its bookkeeping reference. */
export function forReference(reference: string): SQL {
  const value = String(reference).trim();
  const hex = value.replace(/^urn:uuid:/i, "").replace(/[{}-]/g, "");
  if (/^[0-9a-f]{32}$/i.test(hex)) {
    const canonical = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    return eq(claims.id, canonical.toLowerCase());
  }
  return eq(claims.bookkeepingReference, reference);
}

export type AnnotatedClaim = Claim & { status: string; delivery: Delivery | null };

/**
 * The claims matching `where` (all without it), each with its `status` and
 * delivery, ordered by submission (Django's `annotate` on a queryset).
 */
export async function annotate(where?: SQL): Promise<AnnotatedClaim[]> {
  const rows = await q()
    .select({ claim: claims, delivery: deliveries, status: STATUS })
    .from(claims)
    .leftJoin(deliveries, eq(deliveries.claimId, claims.id))
    .where(where)
    .orderBy(asc(claims.submittedAt), asc(claims.id));
  return rows.map((row) => ({ ...row.claim, status: row.status, delivery: row.delivery }));
}

/**
 * The condition of the claims list for a Status filter option, for a query
 * from `annotate` (claims left-joined with deliveries).
 *
 * Archived claims are listed only under ARCHIVED, whatever their status; any
 * other option, or none, lists the claims that are not archived.
 */
export function listed(option?: string | null): SQL {
  if (option === ARCHIVED) return isNotNull(claims.archivedAt);
  const visible = isNull(claims.archivedAt);
  return option && option in LABELS ? and(visible, sql`${STATUS} = ${option}`)! : visible;
}

/** A claim's status: what operators and its participant see. */
export class Status {
  constructor(
    readonly code: string,
    readonly errorCode: string,
    /** Unresolved past its resolution date: not delivered, archived or being deleted. */
    readonly overdue: boolean,
    readonly archived: boolean,
  ) {}

  get label(): string {
    return LABELS[this.code] ?? this.code;
  }

  get tone(): string {
    return TONES[this.code] ?? "secondary";
  }

  get deleted(): boolean {
    return DELETED.has(this.code);
  }

  /** The participant's view: processing, problem or delivered. */
  get outcome(): string {
    if (this.code === DELIVERED) return DELIVERED;
    return PROBLEMS.has(this.code) ? PROBLEM : PROCESSING;
  }

  /** The participant's view cannot change any more. */
  get final(): boolean {
    return this.outcome !== PROCESSING;
  }
}

/**
 * The status of a claim. A claim from `annotate` carries its status and
 * delivery; any other costs one query.
 */
export async function of(
  claim: Claim & { status?: string; delivery?: Delivery | null },
  options: { now?: Date } = {},
): Promise<Status> {
  let code = claim.status;
  let delivery = claim.delivery;
  if (code === undefined || delivery === undefined) {
    const [row] = await q()
      .select({ status: STATUS, delivery: deliveries })
      .from(claims)
      .leftJoin(deliveries, eq(deliveries.claimId, claims.id))
      .where(eq(claims.id, claim.id));
    if (!row) throw new Error(`Claim ${claim.id} does not exist`);
    code ??= row.status;
    delivery = row.delivery;
  }
  const purging = claim.state === CLAIM_STATES.PURGING;
  const archived = claim.archivedAt !== null;
  const now = options.now ?? new Date();
  return new Status(
    code,
    claim.errorCode || (delivery ? delivery.errorCode : ""),
    claim.resolutionDue.getTime() <= now.getTime() && !claim.retentionDue && !purging && !archived,
    archived,
  );
}
