// tests/test_jobs.py of the Django version.
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../db/client";
import { jobs, uploads, type Job } from "../db/schema";
import {
  accepted,
  claimRow,
  fakeDisk,
  freshState,
  localSettings,
  queuedUpload,
  unusedPort,
} from "../test/back-office";
import { CLAIM_STATES } from "./claim-status";
import { BACKOFF, reclaimStaleJobs, runOne } from "./jobs";

beforeEach(freshState);
afterEach(() => vi.restoreAllMocks());

async function jobRow(id: number): Promise<Job> {
  const [job] = await getDb().select().from(jobs).where(eq(jobs.id, id));
  return job!;
}

async function uploadRow(id: string) {
  const [upload] = await getDb().select().from(uploads).where(eq(uploads.id, id));
  return upload!;
}

async function unreachableScanner() {
  localSettings({ UPLOAD_SCANNER: "clamav", CLAMAV_HOST: "127.0.0.1", CLAMAV_PORT: await unusedPort() });
}

/** Lets the job wait for workspace capacity `times` times, then frees the workspace. */
async function waitForCapacity(job: Job, times: number) {
  fakeDisk(10 ** 12, { workspaceFree: 0 });
  for (let index = 0; index < times; index += 1) {
    expect(await runOne()).toBe(true);
    const current = await jobRow(job.id);
    expect([current.state, current.errorCode]).toEqual(["pending", "storage_capacity"]);
    await getDb().update(jobs).set({ runAfter: new Date() }).where(eq(jobs.id, job.id));
  }
  vi.restoreAllMocks();
  fakeDisk(10 ** 12, { workspaceFree: 10 ** 12 });
}

describe("jobs", () => {
  it("retries a scanner outage with backoff, then fails and releases the upload", async () => {
    const { upload, job } = await queuedUpload();
    await unreachableScanner();
    for (const [index, delay] of BACKOFF.entries()) {
      const before = Date.now();
      expect(await runOne()).toBe(true);
      const current = await jobRow(job.id);
      const pending = await uploadRow(upload.id);
      expect([current.state, current.attempts]).toEqual(["pending", index + 1]);
      const waited = (current.runAfter.getTime() - before) / 1000;
      expect(waited).toBeGreaterThanOrEqual(delay);
      expect(waited).toBeLessThanOrEqual(delay + 16);
      expect(pending.state).toBe("pending");
      expect(pending.reservedBytes).toBeGreaterThan(0);
      await getDb().update(jobs).set({ runAfter: new Date() }).where(eq(jobs.id, job.id));
    }
    expect(await runOne()).toBe(true);
    const current = await jobRow(job.id);
    const failed = await uploadRow(upload.id);
    expect([current.state, current.errorCode]).toEqual(["failed", "scanner_unavailable"]);
    expect([failed.state, failed.reservedBytes]).toEqual(["failed", 0]);
  });

  it.each([
    [4, "pending", CLAIM_STATES.RECEIVED],
    [5, "failed", CLAIM_STATES.FAILED],
  ])(
    "an interrupted render keeps its place until attempts run out (%i attempts)",
    async (attempts, jobState, claimState) => {
      const { claim } = await accepted();
      const [job] = await getDb().select().from(jobs).where(eq(jobs.kind, "render"));
      await getDb()
        .update(jobs)
        .set({ state: "running", attempts, leaseUntil: new Date(Date.now() - 1000) })
        .where(eq(jobs.id, job!.id));
      await reclaimStaleJobs();
      const current = await jobRow(job!.id);
      const reloaded = await claimRow(claim.id);
      expect([current.state, current.errorCode, current.runAfter]).toEqual([
        jobState,
        "worker_interrupted",
        job!.runAfter,
      ]);
      expect(reloaded.state).toBe(claimState);
      if (claimState === CLAIM_STATES.FAILED) expect(reloaded.errorCode).toBe("worker_interrupted");
    },
  );

  it("capacity waits leave scanner retries intact", async () => {
    const { upload, job } = await queuedUpload();
    await waitForCapacity(job, BACKOFF.length + 2);
    await unreachableScanner();
    expect(await runOne()).toBe(true);
    const current = await jobRow(job.id);
    expect([current.state, current.errorCode, current.attempts]).toEqual([
      "pending",
      "scanner_unavailable",
      1,
    ]);
    expect((await uploadRow(upload.id)).state).toBe("pending");
  });

  it("capacity waits leave an interrupted validation resumable", async () => {
    const { upload, job } = await queuedUpload();
    await waitForCapacity(job, BACKOFF.length + 2);
    await getDb()
      .update(jobs)
      .set({ state: "running", attempts: sql`${jobs.attempts} + 1`, leaseUntil: new Date(Date.now() - 1000) })
      .where(eq(jobs.id, job.id));
    await reclaimStaleJobs();
    const current = await jobRow(job.id);
    expect([current.state, current.errorCode]).toEqual(["pending", "worker_interrupted"]);
    expect((await uploadRow(upload.id)).state).toBe("pending");
  });
});
