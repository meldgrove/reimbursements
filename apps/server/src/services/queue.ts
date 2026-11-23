/**
 * The persistent job queue: states, keys and active-job queries.
 *
 * Domain modules enqueue work here; the worker (jobs.ts) runs it.
 */
import { randomUUID } from "node:crypto";
import { and, count, eq, inArray, or } from "drizzle-orm";
import { deliveries, jobs } from "../db/schema";
import { q } from "../db/tx";

export const PENDING = "pending";
export const RUNNING = "running";
export const DONE = "done";
export const FAILED = "failed";
export const CANCELLED = "cancelled";
export const ACTIVE = [PENDING, RUNNING] as const;

export type JobKind = "validate" | "render" | "send" | "confirm";
/** The target column of each kind. */
export const TARGETS = {
  validate: "uploadId",
  render: "claimId",
  send: "deliveryId",
  confirm: "claimId",
} as const;

/**
 * Queues `kind` for its target. The first job per target is idempotent; `again`
 * adds a further job, for an operator retry.
 */
export async function enqueue(
  kind: JobKind,
  target: { id: string | number },
  options: { again?: boolean } = {},
): Promise<typeof jobs.$inferSelect> {
  const key = `${kind}:${target.id}` + (options.again ? `:${randomUUID()}` : "");
  const targetColumn = TARGETS[kind];
  await q()
    .insert(jobs)
    .values({ key, kind, [targetColumn]: target.id } as typeof jobs.$inferInsert)
    .onConflictDoNothing({ target: jobs.key });
  const [job] = await q().select().from(jobs).where(eq(jobs.key, key));
  return job!;
}

function forClaim(claimId: string) {
  return or(
    eq(jobs.claimId, claimId),
    inArray(
      jobs.deliveryId,
      q().select({ id: deliveries.id }).from(deliveries).where(eq(deliveries.claimId, claimId)),
    ),
  );
}

export async function claimHasActiveJob(claimId: string): Promise<boolean> {
  const [row] = await q()
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(forClaim(claimId), inArray(jobs.state, [...ACTIVE])))
    .limit(1);
  return Boolean(row);
}

export async function claimHasRunningJob(claimId: string): Promise<boolean> {
  const [row] = await q()
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(forClaim(claimId), eq(jobs.state, RUNNING)))
    .limit(1);
  return Boolean(row);
}

export async function cancelClaimJobs(claimId: string) {
  await q().update(jobs).set({ state: CANCELLED }).where(forClaim(claimId));
}

export async function validationBacklog(): Promise<number> {
  const [row] = await q()
    .select({ value: count() })
    .from(jobs)
    .where(and(eq(jobs.kind, "validate"), inArray(jobs.state, [...ACTIVE])));
  return Number(row?.value ?? 0);
}
