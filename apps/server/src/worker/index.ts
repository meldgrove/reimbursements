import { logger } from "../logger";

/**
 * The worker (the Django version's `manage.py run_jobs`): validates uploads,
 * builds claim PDFs, sends email, reconciles evidence, cleans up, and writes
 * its heartbeat (PRIVATE_STORAGE_ROOT/worker-heartbeat, which the health
 * checks of every compose file read).
 *
 * TODO(BACK OFFICE): port portal/management/commands/run_jobs.py,
 * portal/jobs.py, portal/job_kinds.py and portal/services/queue.py here.
 */
export type Stop = () => Promise<void>;

export async function startWorker(): Promise<Stop> {
  logger.warn("the worker is not ported yet");
  return async () => undefined;
}
