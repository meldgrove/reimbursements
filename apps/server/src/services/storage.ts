/**
 * Private file storage: artifact key layout, durable writes, integrity and orphan sweeps.
 *
 * Callers name an artifact kind and its owner; only this module knows where it
 * lives. Keys and paths are those of 0.4, so files it wrote stay readable.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { config } from "../config";
import { writeAll } from "../documents/write-all";

export const HEARTBEAT_KEY = "worker-heartbeat";

/** A storage failure with a code: `file_too_large` when a write passes its limit, `invalid_key`. */
export class StorageError extends Error {
  constructor(readonly code: "file_too_large" | "invalid_key") {
    super(code);
    this.name = "StorageError";
  }
}

export function storageRoot(): string {
  return config().PRIVATE_STORAGE_ROOT;
}

export function uploadSourceKey(uploadId: string, extension: string): string {
  return `uploads/${uploadId}/source${extension}`;
}

/**
 * Every execution gets an immutable key. A stale lease cannot replace or delete
 * the output published by another validation execution.
 */
export function normalizedUploadKey(uploadId: string, suffix: string): string {
  return `uploads/${uploadId}/${randomUUID()}${suffix}`;
}

/** The lease-specific immutable key prevents an old renderer replacing a newer PDF. */
export function claimPdfKey(claimId: string, leaseToken: string): string {
  return `pdf/${claimId}/${leaseToken}.pdf`;
}

export function outboxKey(attemptId: string): string {
  return `outbox/${attemptId}.eml`;
}

export function newWorkspaceKey(): string {
  return `work/job-${randomUUID()}`;
}

export function workspaceRoot(): string {
  return path.join(storageRoot(), "work");
}

/** `target` with symbolic links resolved as far as it exists (Python's Path.resolve()). */
function resolveExisting(target: string): string {
  const absolute = path.resolve(target);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return path.join(realpathSync(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** The file of `key`; throws StorageError("invalid_key") for keys outside the storage root. */
export function pathFor(key: string): string {
  const root = resolveExisting(storageRoot());
  // An absolute key replaces the root, as with Python paths, and is refused below.
  const target = resolveExisting(path.resolve(root, key));
  const relative = path.relative(root, target);
  if (!key || relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new StorageError("invalid_key");
  }
  return target;
}

export function syncDirectory(directory: string) {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Stores `chunks` under `key` durably and atomically: a temporary file next to
 * the target, fsync, rename, fsync of the directory. Throws
 * StorageError("file_too_large") once more than `limit` bytes arrive.
 */
export async function saveUpload(
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  key: string,
  limit: number,
): Promise<{ size: number; checksum: string }> {
  const target = pathFor(key);
  const directory = path.dirname(target);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `incoming-${randomUUID()}`);
  const fd = openSync(temporary, "wx", 0o600);
  let size = 0;
  const checksum = createHash("sha256");
  try {
    try {
      for await (const chunk of chunks) {
        size += chunk.byteLength;
        if (size > limit) throw new StorageError("file_too_large");
        writeAll(fd, chunk);
        checksum.update(chunk);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, target);
    syncDirectory(directory);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { size, checksum: checksum.digest("hex") };
}

/** Copies bounded sandbox output across filesystems, then publishes it atomically. */
export function publishFile(source: string, key: string, limit: number) {
  return saveUpload(createReadStream(source, { highWaterMark: 64 * 1024 }), key, limit);
}

/** Durably and atomically stores a small private artifact. */
export function writeBytes(key: string, content: Uint8Array) {
  return saveUpload([content], key, content.byteLength);
}

export function removeKeys(...keys: Array<string | null | undefined>) {
  for (const key of new Set(keys.filter((key): key is string => Boolean(key)))) {
    rmSync(pathFor(key), { force: true });
  }
}

/** Whether the stored artifact has the recorded size and, if given, SHA-256. */
export async function verify(
  key: string,
  expected: { size: number; checksum?: string | null },
): Promise<boolean> {
  const file = pathFor(key);
  let stats;
  try {
    stats = statSync(file);
  } catch {
    return false;
  }
  if (!stats.isFile() || stats.size !== expected.size) return false;
  if (expected.checksum === undefined || expected.checksum === null) return true;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex") === expected.checksum;
}

export function checkWritable() {
  const probe = pathFor(`checks/${randomUUID()}`);
  mkdirSync(path.dirname(probe), { recursive: true, mode: 0o700 });
  writeFileSync(probe, "ready");
  unlinkSync(probe);
}

export function writeHeartbeat() {
  const file = pathFor(HEARTBEAT_KEY);
  writeFileSync(file, new Date().toISOString());
  // The file's time is the heartbeat (the health check reads it), also on a fast second write.
  const now = new Date();
  utimesSync(file, now, now);
}

/** Seconds since the worker's last heartbeat, or null when it never wrote one. */
export function heartbeatAge(): number | null {
  try {
    return Date.now() / 1000 - statSync(pathFor(HEARTBEAT_KEY)).mtimeMs / 1000;
  } catch {
    return null;
  }
}

/** Who owns stored artifacts, for `sweepOrphans`. */
export type ArtifactOwners = {
  /** Keys the upload retains, or null if it no longer exists. */
  uploadKeys(uploadId: string): Promise<Set<string> | null>;
  /** Whether a workspace directory still has a reservation. */
  workspaceReserved(key: string): Promise<boolean>;
  /** Whether a claim still references the PDF. */
  pdfReferenced(key: string): Promise<boolean>;
};

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

function entries(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

function mtime(file: string): number | null {
  try {
    return lstatSync(file).mtimeMs / 1000;
  } catch {
    return null;
  }
}

function isDirectory(file: string): boolean {
  try {
    return lstatSync(file).isDirectory();
  } catch {
    return false;
  }
}

function isFile(file: string): boolean {
  try {
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
}

/** The canonical form of a UUID, as Python's uuid.UUID printed it. */
function canonicalUuid(value: string): string {
  const hex = value.replace(/-/g, "").toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Removes stored artifacts older than the cutoff that no database record owns. */
export async function sweepOrphans(olderThan: Date, owners: ArtifactOwners) {
  const cutoff = olderThan.getTime() / 1000;
  const root = storageRoot();
  const key = (file: string) => path.relative(root, file);

  const uploads = path.join(root, "uploads");
  for (const name of entries(uploads)) {
    const directory = path.join(uploads, name);
    const changed = mtime(directory);
    if (!isDirectory(directory) || changed === null || changed >= cutoff || !UUID.test(name)) continue;
    const retained = await owners.uploadKeys(canonicalUuid(name));
    if (retained === null) {
      rmSync(directory, { recursive: true, force: true });
      continue;
    }
    for (const fileName of entries(directory)) {
      const file = path.join(directory, fileName);
      const fileChanged = mtime(file);
      if (isFile(file) && fileChanged !== null && fileChanged < cutoff && !retained.has(key(file)))
        unlinkSync(file);
    }
  }
  const work = workspaceRoot();
  for (const name of entries(work)) {
    if (!name.startsWith("job-")) continue;
    const directory = path.join(work, name);
    const changed = mtime(directory);
    if (
      isDirectory(directory) &&
      changed !== null &&
      changed < cutoff &&
      !(await owners.workspaceReserved(key(directory)))
    ) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  const pdf = path.join(root, "pdf");
  for (const claim of entries(pdf)) {
    for (const name of entries(path.join(pdf, claim))) {
      if (!name.endsWith(".pdf")) continue;
      const file = path.join(pdf, claim, name);
      const changed = mtime(file);
      if (changed !== null && changed < cutoff && !(await owners.pdfReferenced(key(file)))) unlinkSync(file);
    }
  }
  const incoming = path.join(root, "incoming");
  for (const name of entries(incoming)) {
    const file = path.join(incoming, name);
    const changed = mtime(file);
    if (isFile(file) && changed !== null && changed < cutoff) unlinkSync(file);
  }
}
