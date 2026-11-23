// A lock call that fails (not contention: the add-on throws) must not leak
// the slot file's descriptor (review D10).
import type * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { overrideConfigForTests } from "../config";
import { withUploadSlot } from "./upload-slots";

const descriptors = vi.hoisted(() => ({ opened: [] as number[], closed: [] as number[] }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  const openSync = ((...args: Parameters<typeof actual.openSync>) => {
    const fd = actual.openSync(...args);
    descriptors.opened.push(fd);
    return fd;
  }) as typeof actual.openSync;
  const closeSync = (fd: number) => {
    descriptors.closed.push(fd);
    actual.closeSync(fd);
  };
  return { ...actual, default: { ...actual, openSync, closeSync }, openSync, closeSync };
});

vi.mock("../documents/sandbox", () => ({
  sandboxAddon: () => ({
    flock: () => {
      throw new Error("flock: Input/output error");
    },
  }),
}));

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "upload-slots-"));
  overrideConfigForTests({ PRIVATE_STORAGE_ROOT: root });
  descriptors.opened.length = 0;
  descriptors.closed.length = 0;
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

it("closes the slot file when the lock call fails", async () => {
  await expect(withUploadSlot(undefined, async () => "used")).rejects.toThrow(/Input\/output error/);
  expect(descriptors.opened).toHaveLength(1);
  expect(descriptors.closed).toEqual(descriptors.opened);
});
