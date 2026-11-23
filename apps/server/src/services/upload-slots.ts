/**
 * How many upload bodies are received at once. In the Django version each of
 * the TOTAL_WEB_WORKERS synchronous web workers spooled at most one upload,
 * and capacity keeps temporary storage free for exactly that many
 * (UPLOAD_TEMP_HEADROOM_BYTES). Node serves requests concurrently, so an
 * upload waits for a slot before its body is read, and holds it until its
 * spooled file is removed.
 *
 * Slots are file locks in the private storage, so they hold across every web
 * process that shares it; a process that dies releases its slots with its
 * descriptors.
 */
import { closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { config } from "../config";
import { sandboxAddon } from "../documents/sandbox";
import { storageRoot } from "./storage";

const POLL_MS = 50;

/** Development without the native add-on: the slots of this process only. */
let localSlots = 0;

type Slot = { release(): void };

/** The request ended (its client went away) while it waited for a slot. */
export class UploadAborted extends Error {
  override name = "UploadAborted";
}

function aborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new UploadAborted("upload_aborted");
}

function tryAcquire(): Slot | null {
  const count = config().TOTAL_WEB_WORKERS;
  const addon = sandboxAddon();
  if (!addon) {
    if (!config().isDevelopment) {
      throw new Error("Upload slots need the native add-on: run node native/sandbox/build.mjs");
    }
    if (localSlots >= count) return null;
    localSlots += 1;
    return { release: () => (localSlots -= 1) };
  }
  const directory = path.join(storageRoot(), "incoming", ".slots");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (let index = 0; index < count; index += 1) {
    const fd = openSync(path.join(directory, `slot-${index}`), "a+", 0o600);
    // flock locks belong to the open file: another descriptor, also of this process, waits.
    let locked = false;
    try {
      locked = addon.flock(fd, "exclusive");
    } finally {
      // Taken by another, or the call failed: the descriptor goes back either way.
      if (!locked) closeSync(fd);
    }
    if (locked) return { release: () => closeSync(fd) };
  }
  return null;
}

/** Runs `use` holding an upload slot; waits for one while all are taken (or until `signal` aborts). */
export async function withUploadSlot<T>(signal: AbortSignal | undefined, use: () => Promise<T>): Promise<T> {
  let slot = tryAcquire();
  while (!slot) {
    aborted(signal);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    aborted(signal);
    slot = tryAcquire();
  }
  try {
    return await use();
  } finally {
    slot.release();
  }
}
