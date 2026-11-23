/**
 * Disk reservation shared by web processes and document workers.
 *
 * Invariant: free private storage covers the configured floor, spool headroom for
 * in-flight requests, every pending upload's reserved output and every workspace
 * reservation. A reservation moves through admit (upload intake), transfer (into
 * an execution workspace), release (outcome recorded) and recover (after a crash).
 *
 * Lock order is Draft, then network budget, then capacity. `admitUpload` takes
 * them in that order itself. No worker takes a Draft lock while holding a Job lock,
 * including the release and recovery paths.
 */
import { closeSync, existsSync, mkdirSync, openSync, rmSync, statSync, statfsSync } from "node:fs";
import path from "node:path";
import { and, eq, lt, ne, sql, sum } from "drizzle-orm";
import { config } from "../config";
import { MAX_NORMALIZED_FILE_BYTES } from "../constants";
import { capacityLocks, drafts, uploads, workspaceReservations } from "../db/schema";
import { atomic, inTransaction, q } from "../db/tx";
import { sandboxAddon } from "../documents/sandbox";
import { logger } from "../logger";
import { chargeUpload } from "./network-budget";
import { validationBacklog } from "./queue";
import { newWorkspaceKey, pathFor, storageRoot, workspaceRoot } from "./storage";

export class CapacityError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CapacityError";
  }
}

/** The disk measurement seam. Tests replace its methods with a fixed-size fake. */
export const disk = {
  free(target: string): number {
    const stats = statfsSync(target);
    return Number(stats.bavail) * Number(stats.bsize);
  },
  /** Whether `target` is (or will be created) on the filesystem of `root`. */
  shared(target: string, root: string): boolean {
    return !existsSync(target) || statSync(target).dev === statSync(root).dev;
  },
};

/** File operations the tests make fail. */
export const workspaceFiles = {
  removeTree(directory: string) {
    rmSync(directory, { recursive: true, force: true });
  },
};

export function storageAvailable(): boolean {
  return disk.free(storageRoot()) >= config().MIN_FREE_STORAGE_BYTES;
}

async function total(query: Promise<Array<{ value: string | number | null }>>): Promise<number> {
  const [row] = await query;
  return Number(row?.value ?? 0);
}

async function lock() {
  if (!inTransaction()) throw new Error("Capacity admission requires a transaction");
  await q().insert(capacityLocks).values({ id: 1 }).onConflictDoNothing();
  await q().select({ id: capacityLocks.id }).from(capacityLocks).where(eq(capacityLocks.id, 1)).for("update");
}

function workspaceSharesStorage(): boolean {
  return disk.shared(workspaceRoot(), storageRoot());
}

/** Caller holds a transaction; the lock lasts through publication. */
async function check(additional: number) {
  await lock();
  let reserved =
    (await total(
      q()
        .select({ value: sum(uploads.reservedBytes) })
        .from(uploads),
    )) +
    (await total(
      q()
        .select({ value: sum(workspaceReservations.outputBytes) })
        .from(workspaceReservations),
    ));
  if (workspaceSharesStorage()) {
    reserved += await total(
      q()
        .select({ value: sum(workspaceReservations.size) })
        .from(workspaceReservations),
    );
  }
  const settings = config();
  const free = disk.free(storageRoot());
  if (free < settings.MIN_FREE_STORAGE_BYTES + settings.UPLOAD_TEMP_HEADROOM_BYTES + reserved + additional) {
    throw new CapacityError("storage_capacity");
  }
}

/**
 * Charges an upload to its draft and client network, and reserves its normalized output.
 * Runs in the upload's transaction. Returns the bytes to record as the new upload's
 * `reservedBytes`.
 */
export async function admitUpload(network: string, draftId: string, size: number): Promise<number> {
  const settings = config();
  const [draft] = await q().select().from(drafts).where(eq(drafts.id, draftId)).for("update");
  if (!draft) throw new Error(`Draft ${draftId} does not exist`);
  if (
    draft.uploadCount >= settings.MAX_UPLOADS_PER_DRAFT ||
    draft.uploadBytes + size > settings.MAX_UPLOAD_BYTES_PER_DRAFT
  ) {
    throw new CapacityError("draft_work_limit");
  }
  // The caller's transaction refunds this charge if a later check fails.
  if (!(await chargeUpload(network, size))) throw new CapacityError("network_work_limit");
  const reservation = MAX_NORMALIZED_FILE_BYTES;
  await check(size + reservation);
  const derived =
    (await total(
      q()
        .select({
          value: sql<string>`coalesce(sum(${uploads.normalizedSize}), 0) + coalesce(sum(${uploads.reservedBytes}), 0)`,
        })
        .from(uploads)
        .where(eq(uploads.draftId, draftId)),
    )) +
    (await total(
      q()
        .select({ value: sum(workspaceReservations.size) })
        .from(workspaceReservations)
        .innerJoin(uploads, eq(workspaceReservations.uploadId, uploads.id))
        .where(eq(uploads.draftId, draftId)),
    ));
  if (derived + reservation > settings.MAX_DRAFT_DERIVED_BYTES)
    throw new CapacityError("draft_storage_limit");
  if ((await validationBacklog()) >= settings.MAX_PENDING_VALIDATIONS)
    throw new CapacityError("validation_backlog");
  await q()
    .update(drafts)
    .set({ uploadCount: draft.uploadCount + 1, uploadBytes: draft.uploadBytes + size })
    .where(eq(drafts.id, draftId));
  return reservation;
}

/** The upload's outcome is recorded; it no longer owes normalized output. */
export async function releaseUpload(uploadId: string) {
  await q().update(uploads).set({ reservedBytes: 0 }).where(eq(uploads.id, uploadId));
}

function lockFile(directory: string): string {
  // Outside the parser's writable subtree, so it cannot unlink/replace the lock.
  return path.join(path.dirname(directory), ".locks", path.basename(directory));
}

const LOCK_POLL_MS = 25;

/**
 * Holds the workspace's lock while `use` runs: shared by an execution and its
 * child (which inherits the descriptor), exclusive only for crash recovery.
 * `use` gets the lock's file descriptor. An exclusive lock that another holder
 * prevents throws WorkspaceBusy; a shared one waits.
 */
export async function workspaceLock<T>(
  directory: string,
  options: { exclusive?: boolean },
  use: (fd: number) => Promise<T>,
): Promise<T> {
  const file = lockFile(directory);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = openSync(file, "a+", 0o600);
  try {
    const addon = sandboxAddon();
    if (!addon) {
      if (!config().isDevelopment) {
        throw new Error("Workspace locks need the native add-on: run node native/sandbox/build.mjs");
      }
      warnUnlocked();
    } else if (options.exclusive) {
      if (!addon.flock(fd, "exclusive")) throw new WorkspaceBusy();
    } else {
      while (!addon.flock(fd, "shared")) await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
    return await use(fd);
  } finally {
    // Closing the descriptor releases this process's lock.
    closeSync(fd);
  }
}

/** Another process (perhaps an orphaned parser) still holds the workspace. */
export class WorkspaceBusy extends Error {
  constructor() {
    super("workspace_busy");
    this.name = "WorkspaceBusy";
  }
}

let warned = false;
function warnUnlocked() {
  if (warned) return;
  warned = true;
  logger.warn("the native sandbox add-on is not built: workspaces are not locked (development only)");
}

type WorkspaceOwner = { upload?: { id: string }; claim?: { id: string } };

/**
 * Runs `use` with a private execution directory whose disk is reserved until it
 * is removed. An upload's pending output reservation transfers into the
 * workspace reservation. A failure to remove the directory keeps the
 * reservation; recovery releases it later.
 */
export async function temporaryWorkspace<T>(
  owner: WorkspaceOwner,
  use: (directory: string) => Promise<T>,
): Promise<T> {
  const settings = config();
  const root = workspaceRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const key = newWorkspaceKey();
  const directory = pathFor(key);
  const size = owner.upload ? MAX_NORMALIZED_FILE_BYTES : settings.MAX_RENDER_WORKSPACE_BYTES;
  const outputSize = owner.upload ? MAX_NORMALIZED_FILE_BYTES : settings.MAX_FINAL_PDF_BYTES;
  const persistentSize = outputSize + (workspaceSharesStorage() ? size : 0);
  return workspaceLock(directory, {}, async () => {
    let reservation: string | undefined;
    try {
      await atomic(async () => {
        await check(0);
        let current: { reservedBytes: number } | undefined;
        if (owner.upload) {
          [current] = await q()
            .select({ reservedBytes: uploads.reservedBytes })
            .from(uploads)
            .where(eq(uploads.id, owner.upload.id))
            .for("update");
          if (!current) throw new Error(`Upload ${owner.upload.id} does not exist`);
        }
        await check(Math.max(0, persistentSize - (current?.reservedBytes ?? 0)));
        const reserved = await total(
          q()
            .select({ value: sum(workspaceReservations.size) })
            .from(workspaceReservations),
        );
        if (disk.free(root) < reserved + size) throw new CapacityError("workspace_capacity");
        const [created] = await q()
          .insert(workspaceReservations)
          .values({
            directory: key,
            size,
            outputBytes: outputSize,
            uploadId: owner.upload?.id ?? null,
            claimId: owner.claim?.id ?? null,
          })
          .returning({ id: workspaceReservations.id });
        if (owner.upload) {
          await q().update(uploads).set({ reservedBytes: 0 }).where(eq(uploads.id, owner.upload.id));
        }
        mkdirSync(directory, { mode: 0o700 });
        reservation = created!.id;
      });
      return await use(directory);
    } finally {
      if (existsSync(directory)) workspaceFiles.removeTree(directory);
      if (reservation)
        await q().delete(workspaceReservations).where(eq(workspaceReservations.id, reservation));
      rmSync(lockFile(directory), { force: true });
    }
  });
}

/** Releases workspaces whose execution died, once no process holds their lock. */
export async function recoverAbandonedWorkspaces() {
  const cutoff = new Date(Date.now() - config().JOB_LEASE_SECONDS * 1000);
  const abandoned = await q()
    .select()
    .from(workspaceReservations)
    .where(lt(workspaceReservations.createdAt, cutoff));
  for (const reservation of abandoned) await removeAbandonedWorkspace(reservation);
}

type Reservation = typeof workspaceReservations.$inferSelect;

async function removeAbandonedWorkspace(reservation: Reservation): Promise<boolean> {
  const directory = pathFor(reservation.directory);
  mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  try {
    await workspaceLock(directory, { exclusive: true }, async () => {
      if (existsSync(directory)) workspaceFiles.removeTree(directory);
      await atomic(async () => {
        await lock();
        if (reservation.uploadId) {
          const [current] = await q()
            .select({ state: uploads.state, reservedBytes: uploads.reservedBytes })
            .from(uploads)
            .where(eq(uploads.id, reservation.uploadId))
            .for("update");
          const [other] = await q()
            .select({ id: workspaceReservations.id })
            .from(workspaceReservations)
            .where(
              and(
                eq(workspaceReservations.uploadId, reservation.uploadId),
                ne(workspaceReservations.id, reservation.id),
              ),
            )
            .limit(1);
          if (current && current.state === "pending" && !other) {
            // A crashed validator still owes its admitted output capacity.
            await q()
              .update(uploads)
              .set({ reservedBytes: Math.max(current.reservedBytes, reservation.outputBytes) })
              .where(eq(uploads.id, reservation.uploadId));
          }
        }
        await q().delete(workspaceReservations).where(eq(workspaceReservations.id, reservation.id));
      });
      rmSync(lockFile(directory), { force: true });
    });
    return true;
  } catch (error) {
    // An expired job lease does not prove that its parser has stopped.
    if (error instanceof WorkspaceBusy) return false;
    throw error;
  }
}

/** Whether a workspace directory (`work/job-…`) still has a reservation (retention's orphan sweep). */
export async function workspaceReserved(key: string): Promise<boolean> {
  const [row] = await q()
    .select({ id: workspaceReservations.id })
    .from(workspaceReservations)
    .where(eq(workspaceReservations.directory, key))
    .limit(1);
  return Boolean(row);
}
