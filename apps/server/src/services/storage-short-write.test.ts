// A write that returns early must not leave a shorter file than reported
// (writeSync may write fewer bytes than asked).
import type * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { overrideConfigForTests } from "../config";
import { pathFor, saveUpload } from "./storage";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  // At most 7 bytes per call, as a disk under pressure may.
  const writeSync = (fd: number, data: Uint8Array, offset = 0, length?: number) =>
    actual.writeSync(fd, data, offset, Math.min(length ?? data.byteLength - offset, 7));
  return { ...actual, default: { ...actual, writeSync }, writeSync };
});

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "storage-short-"));
  overrideConfigForTests({ PRIVATE_STORAGE_ROOT: root });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

it("writes every byte even when the system writes fewer than asked", async () => {
  const content = Buffer.from("receipt bytes ".repeat(100));
  const result = await saveUpload(
    [content.subarray(0, 600), content.subarray(600)],
    "uploads/u/source.pdf",
    10_000,
  );
  expect(result.size).toBe(content.byteLength);
  expect(readFileSync(pathFor("uploads/u/source.pdf"))).toEqual(content);
});
