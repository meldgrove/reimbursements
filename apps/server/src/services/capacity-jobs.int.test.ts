// The job and lease parts of tests/test_capacity_recovery.py and
// tests/test_resource_limits.py of the Django version (their workspace and
// admission parts are in documents.int.test.ts and the upload tests).
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config";
import { getDb } from "../db/client";
import { q } from "../db/tx";
import { drafts, jobs, uploads, workspaceReservations } from "../db/schema";
import { blankPdf } from "../documents/test-files";
import { withTemplate } from "../models";
import {
  accepted,
  claimRow,
  fakeDisk,
  freshState,
  localSettings,
  storageDirectory,
  TestParticipant,
} from "../test/back-office";
import { createForm } from "../test/fixtures";
import { temporaryWorkspace, workspaceFiles } from "./capacity";
import { CLAIM_STATES } from "./claim-status";
import { openDraft } from "./drafts";
import { VALIDATE } from "./job-kinds";
import { acquireJob, Lease, reclaimStaleJobs, runOne } from "./jobs";
import { cleanup, orphanCleanup } from "./retention";
import { DisabledScanner } from "./scanner";
import { pathFor } from "./storage";
import * as uploadService from "./uploads";

beforeEach(freshState);
afterEach(() => vi.restoreAllMocks());

function separateFilesystems() {
  localSettings({ MIN_FREE_STORAGE_BYTES: 1_000_000_000 });
  const settings = config();
  fakeDisk(
    settings.MIN_FREE_STORAGE_BYTES + settings.UPLOAD_TEMP_HEADROOM_BYTES + 2 * settings.MAX_FINAL_PDF_BYTES,
    {
      workspaceFree: 700_000_000,
    },
  );
}

async function uploadFile(content: Uint8Array, name = "receipt.png") {
  const form = await createForm();
  const participant = new TestParticipant();
  const { draft, token } = await openDraft(participant, await withTemplate(form));
  const incoming = path.join(storageDirectory(), `incoming-${randomUUID()}`);
  writeFileSync(incoming, content);
  const upload = await uploadService.accept(participant, form.slug, {
    file: { name, size: content.length, path: incoming },
    kind: "receipt",
    expenseId: randomUUID(),
    draftId: draft.id,
    token,
  });
  return { upload, draftId: draft.id };
}

async function uploadRow(id: string) {
  const [row] = await getDb().select().from(uploads).where(eq(uploads.id, id));
  return row!;
}

describe("capacity and jobs", () => {
  it("a render needs only the final output's capacity on persistent storage", async () => {
    const { claim } = await accepted();
    separateFilesystems();
    expect(await runOne()).toBe(true);
    expect((await claimRow(claim.id)).state).toBe(CLAIM_STATES.READY);
    const [render] = await getDb().select().from(jobs).where(eq(jobs.kind, "render"));
    expect(render!.state).toBe("done");
    expect(await getDb().select().from(workspaceReservations)).toHaveLength(0);
  }, 60_000);

  it("a restart recovers a missing tmpfs workspace before the next render", async () => {
    const { claim } = await accepted();
    separateFilesystems();
    const [reservation] = await getDb()
      .insert(workspaceReservations)
      .values({
        directory: `work/job-${randomUUID()}`,
        size: config().MAX_RENDER_WORKSPACE_BYTES,
        claimId: claim.id,
        createdAt: new Date(Date.now() - 421_000),
        outputBytes: config().MAX_FINAL_PDF_BYTES,
      })
      .returning();
    await orphanCleanup();
    expect(
      await getDb().select().from(workspaceReservations).where(eq(workspaceReservations.id, reservation!.id)),
    ).toHaveLength(0);
    expect(await runOne()).toBe(true);
    expect((await claimRow(claim.id)).state).toBe(CLAIM_STATES.READY);
  }, 60_000);

  it("measures and reserves normalized bytes before the conversion", async () => {
    // A checkerboard: tiny as PNG, large as JPEG.
    const pixels = Buffer.alloc(1000 * 1000 * 3);
    for (let y = 0; y < 1000; y += 1) {
      for (let x = 0; x < 1000; x += 1)
        pixels.fill((x + y) % 2 ? 255 : 0, (y * 1000 + x) * 3, (y * 1000 + x) * 3 + 3);
    }
    const content = await sharp(pixels, { raw: { width: 1000, height: 1000, channels: 3 } })
      .png()
      .toBuffer();
    const { upload } = await uploadFile(content);
    expect(upload.reservedBytes).toBe(10_000_000);
    expect(await runOne()).toBe(true);
    const current = await uploadRow(upload.id);
    expect(current.state, current.errorCode).toBe("ready");
    expect(current.normalizedSize).toBe(statSync(pathFor(current.normalizedKey)).size);
    expect(current.normalizedSize).toBeGreaterThan(current.size * 10);
    expect(current.reservedBytes).toBe(0);
    expect(await getDb().select().from(workspaceReservations)).toHaveLength(0);
  });

  it("keeps the reservation when the workspace's cleanup fails, until the cleanup job", async () => {
    const { upload } = await uploadFile(
      await sharp({ create: { width: 10, height: 10, channels: 3, background: "white" } })
        .png()
        .toBuffer(),
    );
    vi.spyOn(workspaceFiles, "removeTree").mockImplementation(() => {
      throw Object.assign(new Error("synthetic"), { code: "EIO", syscall: "rmdir" });
    });
    await expect(temporaryWorkspace({ upload }, async () => undefined)).rejects.toThrow("synthetic");
    vi.restoreAllMocks();
    expect(
      await getDb().select().from(workspaceReservations).where(eq(workspaceReservations.uploadId, upload.id)),
    ).toHaveLength(1);
    await getDb()
      .update(workspaceReservations)
      .set({ createdAt: new Date(Date.now() - 25 * 3600 * 1000) });
    await cleanup({ execute: true });
    expect(await getDb().select().from(workspaceReservations)).toHaveLength(0);
  });

  it("releases the pending capacity of expired or failed uploads", async () => {
    const { upload, draftId } = await uploadFile(
      await sharp({ create: { width: 10, height: 10, channels: 3, background: "white" } })
        .png()
        .toBuffer(),
    );
    await getDb()
      .update(jobs)
      .set({ state: "running", leaseUntil: new Date(Date.now() - 1000), attempts: 5 })
      .where(eq(jobs.uploadId, upload.id));
    await reclaimStaleJobs();
    expect((await uploadRow(upload.id)).reservedBytes).toBe(0);
    await getDb()
      .update(drafts)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(drafts.id, draftId));
    await cleanup({ execute: true });
    expect(await getDb().select().from(uploads)).toHaveLength(0);
  });

  /** The lease expires while the file is processed (the scanner runs first). */
  function expireLeaseDuringProcessing(jobId: number) {
    vi.spyOn(DisabledScanner.prototype, "scan").mockImplementation(async () => {
      await getDb().update(jobs).set({ leaseToken: randomUUID() }).where(eq(jobs.id, jobId));
    });
  }

  it("a stale PDF validator does not delete its source", async () => {
    const { upload } = await uploadFile(await blankPdf(), "source.pdf");
    const old = await acquireJob();
    expireLeaseDuringProcessing(old!.id);
    await VALIDATE.run(old!, new Lease(old!));
    expect(existsSync(pathFor(upload.sourceKey))).toBe(true);
    expect(await getDb().select().from(workspaceReservations)).toHaveLength(0);
  });

  it("a stale image validator removes its unrecorded output", async () => {
    const { upload } = await uploadFile(
      await sharp({ create: { width: 10, height: 10, channels: 3, background: "white" } })
        .png()
        .toBuffer(),
    );
    const old = await acquireJob();
    expireLeaseDuringProcessing(old!.id);
    await VALIDATE.run(old!, new Lease(old!));
    const current = await uploadRow(upload.id);
    expect(current.state).toBe("pending");
    expect(current.normalizedKey).toBe("");
    expect(existsSync(pathFor(current.sourceKey))).toBe(true);
    expect(
      readdirSync(path.dirname(pathFor(current.sourceKey))).filter((name) => name.endsWith(".jpg")),
    ).toEqual([]);
  });

  it("the validation's reservation lasts until its metadata is published", async () => {
    const { upload } = await uploadFile(
      await sharp({ create: { width: 10, height: 10, channels: 3, background: "white" } })
        .png()
        .toBuffer(),
    );
    const current = await acquireJob();
    const observed: boolean[] = [];
    const finish = Lease.prototype.finish;
    vi.spyOn(Lease.prototype, "finish").mockImplementation(async function (this: Lease, ...args) {
      // Inside the job's transaction, as the lease's own writes are.
      const [item] = await q().select().from(uploads).where(eq(uploads.id, upload.id));
      const reservations = await q()
        .select()
        .from(workspaceReservations)
        .where(eq(workspaceReservations.uploadId, upload.id));
      observed.push(reservations.length > 0);
      expect(item!.state).toBe("ready");
      expect(item!.normalizedSize).toBeGreaterThan(0);
      return finish.apply(this, args);
    });
    await VALIDATE.run(current!, new Lease(current!));
    expect(observed).toEqual([true]);
    expect(await getDb().select().from(workspaceReservations)).toHaveLength(0);
  });
});
