import { logger } from "../logger";
import { reportError } from "../error-reporting";
import { reconcileUnmatched } from "../services/evidence";
import { reclaimStaleJobs, runOne } from "../services/jobs";
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
 */
export type Stop = () => Promise<void>;

const MAINTENANCE_MS = 60_000;
const IDLE_MS = 1_000;
/** After an error (the database is away, say), the loop waits this long. */
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

/** Runs the worker until `shouldStop` turns true (or `once`/`drain` end it). */
export async function runJobs(options: WorkerOptions = {}, shouldStop: () => boolean = () => false) {
  let lastMaintenance = Number.NEGATIVE_INFINITY;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  while (!shouldStop()) {
    let processed: boolean;
    try {
      if (performance.now() - lastMaintenance > MAINTENANCE_MS) {
        await maintenance();
        lastMaintenance = performance.now();
        // A stop that arrived during maintenance starts no new job, such as an email.
        if (shouldStop()) return;
      }
      writeHeartbeat();
      processed = await runOne();
    } catch (error) {
      if (options.once || options.drain) throw error;
      logger.error({ err: error }, "worker_loop_failed");
      reportError(error);
      await sleep(ERROR_PAUSE_MS);
      continue;
    }
    if (options.once || (options.drain && !processed)) return;
    if (!processed) await sleep(IDLE_MS);
  }
}

export async function startWorker(): Promise<Stop> {
  let stopping = false;
  logger.info("worker started");
  const loop = runJobs({}, () => stopping).catch((error: unknown) => {
    logger.fatal({ err: error }, "worker stopped");
    reportError(error);
    process.exitCode = 1;
  });
  return async () => {
    stopping = true;
    // The job running now finishes; an expired lease would hand it to the next worker.
    await loop;
  };
}
