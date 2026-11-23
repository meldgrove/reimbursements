// Private file storage: keys, durable writes and their limits, integrity,
// the heartbeat and the orphan sweep (portal/services/storage.py).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { overrideConfigForTests } from "../config";
import {
  claimPdfKey,
  heartbeatAge,
  newWorkspaceKey,
  normalizedUploadKey,
  outboxKey,
  pathFor,
  publishFile,
  removeKeys,
  saveUpload,
  StorageError,
  sweepOrphans,
  uploadSourceKey,
  verify,
  writeBytes,
  writeHeartbeat,
} from "./storage";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "storage-"));
  overrideConfigForTests({ PRIVATE_STORAGE_ROOT: root });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("keys", () => {
  it("lays out artifacts as 0.4 did", () => {
    expect(uploadSourceKey("u1", ".pdf")).toBe("uploads/u1/source.pdf");
    expect(normalizedUploadKey("u1", ".jpg")).toMatch(/^uploads\/u1\/[0-9a-f-]{36}\.jpg$/);
    expect(normalizedUploadKey("u1", ".jpg")).not.toBe(normalizedUploadKey("u1", ".jpg"));
    expect(claimPdfKey("c1", "lease")).toBe("pdf/c1/lease.pdf");
    expect(outboxKey("a1")).toBe("outbox/a1.eml");
    expect(newWorkspaceKey()).toMatch(/^work\/job-[0-9a-f-]{36}$/);
  });

  it("refuses keys outside the storage", () => {
    expect(pathFor("uploads/x/source.png")).toBe(path.join(root, "uploads/x/source.png"));
    for (const key of ["", "../escape", "uploads/../../escape", "/etc/passwd", "."]) {
      expect(() => pathFor(key)).toThrow(StorageError);
    }
    mkdirSync(path.join(root, "uploads"));
    symlinkSync("/etc", path.join(root, "uploads", "link"));
    expect(() => pathFor("uploads/link/passwd")).toThrow(StorageError);
  });
});

describe("writes", () => {
  it("stores durably with size and SHA-256, and stops at the limit without leaving a file", async () => {
    const result = await saveUpload(
      [Buffer.from("hello "), Buffer.from("world")],
      "uploads/u1/source.png",
      100,
    );
    expect(result).toEqual({
      size: 11,
      checksum: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    });
    expect(readFileSync(pathFor("uploads/u1/source.png"), "utf8")).toBe("hello world");
    await expect(
      saveUpload([Buffer.alloc(60), Buffer.alloc(60)], "uploads/u2/source.png", 100),
    ).rejects.toSatisfy((error) => error instanceof StorageError && error.code === "file_too_large");
    expect(existsSync(pathFor("uploads/u2/source.png"))).toBe(false);
    expect(readdirSync(path.join(root, "uploads", "u2"))).toEqual([]);
  });

  it("publishes a file across folders and writes small artifacts", async () => {
    const source = path.join(root, "output.pdf");
    writeFileSync(source, "%PDF-synthetic");
    const published = await publishFile(source, "pdf/c1/lease.pdf", 1000);
    expect(published.size).toBe(14);
    expect(await verify("pdf/c1/lease.pdf", { size: 14, checksum: published.checksum })).toBe(true);
    expect(await verify("pdf/c1/lease.pdf", { size: 14, checksum: "0".repeat(64) })).toBe(false);
    expect(await verify("pdf/c1/lease.pdf", { size: 15 })).toBe(false);
    expect(await verify("pdf/c1/missing.pdf", { size: 14 })).toBe(false);
    await writeBytes("outbox/a1.eml", Buffer.from("From: x"));
    expect(readFileSync(pathFor("outbox/a1.eml"), "utf8")).toBe("From: x");
    removeKeys("outbox/a1.eml", "outbox/a1.eml", "", null, "outbox/never.eml");
    expect(existsSync(pathFor("outbox/a1.eml"))).toBe(false);
  });
});

describe("heartbeat", () => {
  it("has no age before the worker wrote one", () => {
    expect(heartbeatAge()).toBeNull();
    writeHeartbeat();
    expect(heartbeatAge()).toBeGreaterThanOrEqual(0);
    expect(heartbeatAge()).toBeLessThan(5);
  });
});

describe("the orphan sweep", () => {
  function old(file: string) {
    const then = new Date(Date.now() - 48 * 3600 * 1000);
    utimesSync(file, then, then);
  }

  it("removes only old artifacts that nothing owns", async () => {
    const kept = "11111111-1111-4111-8111-111111111111";
    const gone = "22222222-2222-4222-8222-222222222222";
    for (const key of [
      `uploads/${kept}/source.png`,
      `uploads/${kept}/stale.jpg`,
      `uploads/${gone}/source.png`,
    ]) {
      mkdirSync(path.dirname(pathFor(key)), { recursive: true });
      writeFileSync(pathFor(key), "x");
      old(pathFor(key));
    }
    mkdirSync(path.join(root, "work", "job-reserved"), { recursive: true });
    mkdirSync(path.join(root, "work", "job-orphan"), { recursive: true });
    mkdirSync(path.join(root, "pdf", "c1"), { recursive: true });
    writeFileSync(path.join(root, "pdf", "c1", "kept.pdf"), "x");
    writeFileSync(path.join(root, "pdf", "c1", "orphan.pdf"), "x");
    mkdirSync(path.join(root, "incoming"));
    writeFileSync(path.join(root, "incoming", "partial"), "x");
    writeFileSync(path.join(root, "incoming", "fresh"), "x");
    for (const entry of [
      `uploads/${kept}`,
      `uploads/${gone}`,
      "work/job-reserved",
      "work/job-orphan",
      "pdf/c1/kept.pdf",
      "pdf/c1/orphan.pdf",
      "incoming/partial",
    ]) {
      old(path.join(root, entry));
    }
    await sweepOrphans(new Date(Date.now() - 24 * 3600 * 1000), {
      uploadKeys: async (id) => (id === kept ? new Set([`uploads/${kept}/source.png`]) : null),
      workspaceReserved: async (key) => key === "work/job-reserved",
      pdfReferenced: async (key) => key === "pdf/c1/kept.pdf",
    });
    expect(existsSync(pathFor(`uploads/${kept}/source.png`))).toBe(true);
    expect(existsSync(pathFor(`uploads/${kept}/stale.jpg`))).toBe(false);
    expect(existsSync(path.join(root, "uploads", gone))).toBe(false);
    expect(existsSync(path.join(root, "work", "job-reserved"))).toBe(true);
    expect(existsSync(path.join(root, "work", "job-orphan"))).toBe(false);
    expect(existsSync(path.join(root, "pdf", "c1", "kept.pdf"))).toBe(true);
    expect(existsSync(path.join(root, "pdf", "c1", "orphan.pdf"))).toBe(false);
    expect(existsSync(path.join(root, "incoming", "partial"))).toBe(false);
    expect(existsSync(path.join(root, "incoming", "fresh"))).toBe(true);
  });
});
