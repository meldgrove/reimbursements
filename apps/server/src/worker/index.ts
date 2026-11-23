import { connectionLost, Outage } from "../database";
import { logger } from "../logger";
import { reportError } from "../error-reporting";
import { reconcileUnmatched } from "../services/evidence";
import { Interrupted, reclaimStaleJobs, runOne, type Lease } from "../services/jobs";
import { cleanup } from "../services/retention";
import { writeHeartbeat } from "../services/storage";

/**
 * The worker (the Django version's `manage.py run_jobs`): validates uploads,
 * builds claim PDFs, sends email, reconciles evidence, cleans up, and writes
 * its heartbeat (PRIVATE_STORAGE_ROOT/worker-heartbeat, which the health
 * checks of every compose file read).
 *
 * One job runs at a time. Every minute it first reclaims jobs whose worker
 * died, applies provider evidence that arrived before its email, and carries
 * out due deletions.
 *
 * A lost database connection (PostgreSQL restarts during updates) waits with
 * backoff instead of failing (database.ts); a job it interrupted is handed on
 * as soon as the database is back.
 */
export type Stop = () => Promise<void>;

const MAINTENANCE_MS = 60_000;
const IDLE_MS = 1_000;
/** After an unexpected error, the loop waits this long. */
const ERROR_PAUSE_MS = 5_000;

/** Reclaims stale jobs, applies early evidence and carries out due deletions. */
export async function maintenance() {
  await reclaimStaleJobs();
  await reconcileUnmatched();
  const result = await cleanup({ execute: true });
  if (result.failures || result.unresolved_near_expiry) {
    logger.warn({ result }, "maintenance_attention");
  }
}

/** The loop's options: `once` runs one pass, `drain` stops when no job is due (run_jobs' flags). */
export type WorkerOptions = { once?: boolean; drain?: boolean };

type Round = { lastMaintenance: number; shouldStop: () => boolean };

/** One round of the loop, and its pauses; tests replace them. */
export const loop = {
  /** Maintenance once a minute, the heartbeat, then the next due job. False when none ran. */
  async work(round: Round): Promise<boolean> {
    if (performance.now() - round.lastMaintenance > MAINTENANCE_MS) {
      await maintenance();
      round.lastMaintenance = performance.now();
      // A stop that arrived during maintenance starts no new job, such as an email.
      if (round.shouldStop()) return false;
    }
    writeHeartbeat();
    return runOne();
  },

  /** Waits `ms`, or less when a stop arrives. */
  async sleep(ms: number, shouldStop: () => boolean): Promise<void> {
    const end = performance.now() + ms;
    for (let left = ms; left > 0 && !shouldStop(); left = end - performance.now()) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(left, IDLE_MS)));
    }
  },
};

/** Runs the worker until `shouldStop` turns true (or `once`/`drain` end it). */
export async function runJobs(options: WorkerOptions = {}, shouldStop: () => boolean = () => false) {
  const round: Round = { lastMaintenance: Number.NEGATIVE_INFINITY, shouldStop };
  const outage = new Outage();
  let abandoned: Lease | null = null;
  while (!shouldStop()) {
    let processed: boolean;
    try {
      if (abandoned) {
        const lease = abandoned;
        abandoned = null;
        try {
          await lease.abandon();
        } catch (error) {
          // Tried again while the database is away; otherwise the expired
          // lease hands the job on (reclaimStaleJobs).
          if (connectionLost(error)) abandoned = lease;
          throw error;
        }
      }
      processed = await loop.work(round);
    } catch (error) {
      if (error instanceof Interrupted) {
        abandoned = error.lease;
        await loop.sleep(outage.lost(error.cause) * 1000, shouldStop);
        continue;
      }
      if (connectionLost(error)) {
        await loop.sleep(outage.lost(error) * 1000, shouldStop);
        continue;
      }
      if (options.once || options.drain) throw error;
      logger.error({ err: error }, "worker_loop_failed");
      reportError(error);
      await loop.sleep(ERROR_PAUSE_MS, shouldStop);
      continue;
    }
    outage.ended();
    if (shouldStop() || options.once || (options.drain && !processed)) return;
    if (!processed) await loop.sleep(IDLE_MS, shouldStop);
  }
}

export async function startWorker(): Promise<Stop> {
  let stopping = false;
  logger.info("worker started");
  const running = runJobs({}, () => stopping).catch((error: unknown) => {
    logger.fatal({ err: error }, "worker stopped");
    reportError(error);
    process.exitCode = 1;
  });
  return async () => {
    stopping = true;
    // The job running now finishes; an expired lease would hand it to the next worker.
    await running;
  };
}
