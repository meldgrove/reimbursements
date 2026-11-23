/**
 * Protected operational checks with no provider calls or participant content
 * (portal/services/readiness.py of the Django version), for /-/readyz.
 *
 * TODO(BACK OFFICE): port readiness.py: the bounded workspace (tmpfs), the
 * writable storage, the scanner and the sandbox when they are required, the
 * worker heartbeat (REQUIRE_WORKER_HEARTBEAT) and the age of the oldest
 * pending job (MAX_JOB_AGE_SECONDS). The foundation only checks the database
 * (modules/health.ts does) and answers ready.
 */
export type Readiness = {
  /** Whether every check passed. */
  ready: boolean;
  /** Each check by name, true when it passed (shown to holders of the health token). */
  checks: Record<string, boolean>;
  /** Age of the oldest job that waits or runs, in seconds; 0 without one. */
  oldestJobAgeSeconds: number;
};

export async function readiness(): Promise<Readiness> {
  return { ready: true, checks: {}, oldestJobAgeSeconds: 0 };
}
