/**
 * The single worker's job runner: lease a job, dispatch it to its kind,
 * record the outcome (portal/jobs.py of the Django version).
 *
 * Job kinds (services/job-kinds.ts) own their target's transitions. The runner
 * owns leases, capacity waits and the one retry policy. Every lease counts as
 * an attempt, except one that ends waiting for capacity: only processing uses
 * up retries.
 */
import { randomInt, randomUUID } from "node:crypto";
import { and, asc, eq, gt, lt, lte, sql } from "drizzle-orm";
import { config } from "../config";
import { jobs, type Job } from "../db/schema";
import { atomic, q } from "../db/tx";
import { logger } from "../logger";
import { reportError } from "../error-reporting";
import { CapacityError } from "./capacity";
import { KINDS, type JobLease } from "./job-kinds";
import { CANCELLED, DONE, FAILED, PENDING, RUNNING } from "./queue";

export const BACKOFF = [60, 300, 900, 3600];
export const CAPACITY_WAIT_SECONDS = 60;

export function canRetry(job: Pick<Job, "attempts">): boolean {
  return job.attempts <= BACKOFF.length;
}

/** Seconds until the next attempt: the attempt's step of BACKOFF, at least `minimum`, plus up to 15. */
export function backoff(job: Pick<Job, "attempts">, minimum = 0): number {
  return Math.max(minimum, BACKOFF.at(Math.min(job.attempts, BACKOFF.length) - 1)!) + randomInt(0, 16);
}

const seconds = (value: number) => new Date(Date.now() + value * 1000);

/** A running job's exclusive claim. Writes after expiry are silently dropped. */
export class Lease implements JobLease {
  constructor(readonly job: Job) {}

  get token(): string | null {
    return this.job.leaseToken;
  }

  /** Inside a transaction: locks the job and confirms this lease still holds it. */
  async live(): Promise<boolean> {
    if (!this.token) return false;
    const [row] = await q()
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.id, this.job.id),
          eq(jobs.state, RUNNING),
          eq(jobs.leaseToken, this.token),
          gt(jobs.leaseUntil, new Date()),
        ),
      )
      .for("update");
    return Boolean(row);
  }

  async finish(state = DONE, errorCode = "", delay = 0, changes: Partial<Record<"attempts", unknown>> = {}) {
    if (!this.token) return;
    await q()
      .update(jobs)
      .set({
        state,
        errorCode,
        runAfter: seconds(delay),
        leaseToken: null,
        leaseUntil: null,
        ...(changes as object),
      })
      .where(and(eq(jobs.id, this.job.id), eq(jobs.state, RUNNING), eq(jobs.leaseToken, this.token)));
  }

  cancel() {
    return this.finish(CANCELLED);
  }

  /** Runs again shortly. Waiting is not an attempt, so this lease's attempt is returned. */
  waitForCapacity() {
    return this.finish(PENDING, "storage_capacity", CAPACITY_WAIT_SECONDS, {
      attempts: sql`${jobs.attempts} - 1`,
    });
  }

  /** Schedules another attempt with backoff. False once attempts are exhausted. */
  async retry(errorCode: string, options: { minimumDelay?: number } = {}): Promise<boolean> {
    if (!canRetry(this.job)) return false;
    await this.finish(PENDING, errorCode, backoff(this.job, options.minimumDelay ?? 0));
    return true;
  }
}

/** The next job that is due, leased to this worker; null when none is. */
export function acquireJob(): Promise<Job | null> {
  return atomic(async () => {
    // Later public intake cannot overtake already accepted work. run_after also
    // keeps backoff retries behind work that was ready before their retry time.
    const [job] = await q()
      .select()
      .from(jobs)
      .where(and(eq(jobs.state, PENDING), lte(jobs.runAfter, new Date())))
      .orderBy(asc(jobs.runAfter), asc(jobs.id))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!job) return null;
    const [leased] = await q()
      .update(jobs)
      .set({
        state: RUNNING,
        leaseToken: randomUUID(),
        leaseUntil: seconds(config().JOB_LEASE_SECONDS),
        attempts: job.attempts + 1,
      })
      .where(eq(jobs.id, job.id))
      .returning();
    return leased!;
  });
}

/** Expired leases mean a dead worker. Resumable kinds keep their place in the queue. */
export function reclaimStaleJobs(): Promise<void> {
  return atomic(async () => {
    const stale = await q()
      .select()
      .from(jobs)
      .where(and(eq(jobs.state, RUNNING), lt(jobs.leaseUntil, new Date())))
      .for("update");
    for (const job of stale) {
      const kind = KINDS[job.kind]!;
      let state: string;
      let errorCode: string;
      if (kind.resumable && canRetry(job)) {
        [state, errorCode] = [PENDING, "worker_interrupted"];
      } else {
        [state, errorCode] = [FAILED, await kind.interrupted(job)];
      }
      await q()
        .update(jobs)
        .set({ state, errorCode, leaseToken: null, leaseUntil: null })
        .where(eq(jobs.id, job.id));
    }
  });
}

/** Leases and runs one due job. False when none was due. */
export async function runOne(): Promise<boolean> {
  const job = await acquireJob();
  if (!job) return false;
  const kind = KINDS[job.kind]!;
  const lease = new Lease(job);
  try {
    await kind.run(job, lease);
  } catch (error) {
    if (error instanceof CapacityError) {
      await atomic(async () => {
        if (await lease.live()) await lease.waitForCapacity();
      });
      logger.warn({ job: job.id }, "document_capacity_wait");
      return true;
    }
    const failure = kind.failure(error);
    await atomic(async () => {
      if (!(await lease.live())) return;
      if (failure.retryable && (await lease.retry(failure.code))) {
        await kind.retrying(job, failure.code);
      } else {
        await kind.failed(job, failure.code);
        await lease.finish(FAILED, failure.code);
      }
    });
    if (failure.expected) {
      logger.warn({ job: job.id, code: failure.code }, "document_job_failed");
    } else {
      logger.error({ err: error, job: job.id, kind: job.kind }, "job_failed");
      reportError(error);
    }
  }
  return true;
}
