/**
 * Protected operational checks with no provider calls or participant content
 * (portal/services/readiness.py and the readyz view of the Django version),
 * for /-/readyz (modules/health.ts).
 */
import { readFileSync, statSync, statfsSync } from "node:fs";
import path from "node:path";
import { and, asc, eq, lte, or } from "drizzle-orm";
import { config } from "../config";
import { jobs } from "../db/schema";
import { q } from "../db/tx";
import { storageAvailable } from "./capacity";
import { sandboxReady } from "./documents";
import { PENDING, RUNNING } from "./queue";
import { scannerReady } from "./scanner";
import { checkWritable, heartbeatAge, storageRoot, workspaceRoot } from "./storage";

export type Readiness = {
  /** Whether every check passed. */
  ready: boolean;
  /** Each check by name, true when it passed (shown to holders of the health token). */
  checks: Record<string, boolean>;
  /** Age of the oldest job that waits or runs, in seconds; 0 without one. */
  oldestJobAgeSeconds: number;
};

/** A mount point of /proc/self/mountinfo, with its octal escapes (\040) decoded. */
function unescapeMount(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, code: string) => String.fromCharCode(Number.parseInt(code, 8)));
}

function within(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** The mount points of this process, as (mount point, filesystem type). */
export const mounts = {
  read(): Array<[string, string]> {
    return readFileSync("/proc/self/mountinfo", "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [fields, filesystem] = line.split(" - ", 2) as [string, string];
        return [unescapeMount(fields.split(" ")[4]!), filesystem.split(" ")[0]!] as [string, string];
      });
  },
};

/**
 * The document workspace is a private tmpfs of at most 750 MB of its own
 * (compose.yaml), so a parser can never fill the volume.
 */
export function boundedWorkspace(): boolean {
  try {
    const root = path.resolve(workspaceRoot());
    const stats = statSync(root);
    if (!stats.isDirectory()) return false;
    const matching = mounts
      .read()
      .filter(([mount]) => within(root, mount))
      .map(
        ([mount, filesystem]) =>
          [path.resolve(mount).split(path.sep).filter(Boolean).length, filesystem] as const,
      )
      .sort((a, b) => a[0] - b[0]);
    const innermost = matching.at(-1);
    const filesystem = statfsSync(root);
    return (
      innermost?.[1] === "tmpfs" &&
      stats.dev !== statSync(storageRoot()).dev &&
      (stats.mode & 0o077) === 0 &&
      stats.uid === process.getuid?.() &&
      filesystem.blocks * filesystem.bsize <= 750_000_000
    );
  } catch {
    return false;
  }
}

/** Seconds the oldest due or running job has waited; a retry waits from the end of its backoff. */
export async function queueAgeSeconds(): Promise<number> {
  const now = new Date();
  const [oldest] = await q()
    .select({ runAfter: jobs.runAfter })
    .from(jobs)
    .where(or(and(eq(jobs.state, PENDING), lte(jobs.runAfter, now)), eq(jobs.state, RUNNING)))
    .orderBy(asc(jobs.runAfter))
    .limit(1);
  return oldest ? Math.max(0, Math.floor((now.getTime() - oldest.runAfter.getTime()) / 1000)) : 0;
}

/** The checks of the document sandbox, the scanner, the workspace, the worker and the queue. */
export async function dependencies(): Promise<{ checks: Record<string, boolean>; age: number }> {
  const settings = config();
  const checks: Record<string, boolean> = {
    sandbox: await sandboxReady(),
    scanner: await scannerReady(),
  };
  if (!settings.isDevelopment) checks.workspace = boundedWorkspace();
  if (settings.REQUIRE_WORKER_HEARTBEAT) {
    const age = heartbeatAge();
    checks.worker = age !== null && age >= 0 && age < settings.JOB_LEASE_SECONDS + 60;
  }
  const age = await queueAgeSeconds();
  checks.queue = age <= settings.MAX_JOB_AGE_SECONDS;
  return { checks, age };
}

/**
 * Readiness of this installation. Throws when the storage is full or not
 * writable: /-/readyz then answers unavailable without details, as before.
 */
export async function readiness(): Promise<Readiness> {
  if (!storageAvailable()) throw new Error("storage_unavailable");
  checkWritable();
  const { checks, age } = await dependencies();
  return { ready: Object.values(checks).every(Boolean), checks, oldestJobAgeSeconds: age };
}
