// tests/test_uploads_and_retention.py of the Django version: validation jobs,
// purging and the health checks. Its HTTP-only cases (the shared editable
// draft rule, status and removal needing the draft token, a recipient that is
// no longer approved, a concurrent removal, the Received page of a purged
// claim) are in the participant API's tests.
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../db/client";
import {
  claims,
  confirmations,
  deliveries,
  deliveryAttempts,
  deliveryEvents,
  expenses,
  jobs,
  uploads,
  type Upload,
} from "../db/schema";
import { cameraJpegBytes, imageBytes } from "../documents/test-files";
import { withTemplate } from "../models";
import {
  accepted,
  claimRow,
  freshState,
  localSettings,
  storageDirectory,
  TestParticipant,
  unusedPort,
} from "../test/back-office";
import { createForm } from "../test/fixtures";
import { request } from "../test/helpers";

import { openDraft } from "./drafts";
import { runOne } from "./jobs";
import { cleanup, purgeClaim } from "./retention";
import { pathFor } from "./storage";
import * as uploadService from "./uploads";

beforeEach(freshState);
afterEach(() => vi.restoreAllMocks());

/** An upload to an open draft of the form "test", as the upload request makes it. */
async function upload(content: Uint8Array, options: { name?: string; kind?: "receipt" | "signature" } = {}) {
  const form = await createForm();
  const participant = new TestParticipant();
  const { draft, token } = await openDraft(participant, await withTemplate(form));
  const incoming = path.join(storageDirectory(), `incoming-${randomUUID()}`);
  writeFileSync(incoming, content);
  const kind = options.kind ?? "receipt";
  return uploadService.accept(participant, form.slug, {
    file: { name: options.name ?? "receipt.png", size: content.length, path: incoming },
    kind,
    expenseId: kind === "receipt" ? randomUUID() : "",
    draftId: draft.id,
    token,
  });
}

async function uploadRow(id: string): Promise<Upload> {
  const [row] = await getDb().select().from(uploads).where(eq(uploads.id, id));
  return row!;
}

describe("validation", () => {
  it("validates a real upload asynchronously", async () => {
    const created = await upload(await imageBytes());
    expect(created.state).toBe("pending");
    expect(await runOne()).toBe(true);
    const current = await uploadRow(created.id);
    expect(current.state, current.errorCode).toBe("ready");
    expect(current.normalizedKey.endsWith(".jpg")).toBe(true);
    expect(uploadService.status(current).pages).toBe(1);
  });

  it.each(["receipt", "signature"] as const)(
    "normalizes a camera JPEG with an auxiliary picture (%s)",
    async (kind) => {
      const content = await cameraJpegBytes();
      const created = await upload(content, { name: "camera.jpg", kind });
      expect(await runOne()).toBe(true);
      const current = await uploadRow(created.id);
      expect(current.state, current.errorCode).toBe("ready");
      expect(current.pages).toBe(1);
      const clean = sharp(pathFor(current.normalizedKey));
      const metadata = await clean.metadata();
      expect(metadata.format).toBe(kind === "receipt" ? "jpeg" : "png");
      expect(metadata.pages ?? 1).toBe(1);
      expect([metadata.width, metadata.height]).toEqual([180, 320]);
      expect(metadata.exif).toBeUndefined();
      expect(metadata.xmp).toBeUndefined();
      expect(metadata.icc).toBeUndefined();
      const { data, info } = await clean.raw().toBuffer({ resolveWithObject: true });
      const offset = (160 * info.width + 90) * info.channels;
      // The primary green picture, never the auxiliary red picture.
      expect(data[offset + 1]!).toBeGreaterThan(data[offset]! + 50);
    },
  );

  it("keeps the file pending when the scanner fails", async () => {
    const created = await upload(await imageBytes());
    localSettings({ UPLOAD_SCANNER: "clamav", CLAMAV_HOST: "127.0.0.1", CLAMAV_PORT: await unusedPort() });
    await runOne();
    const current = await uploadRow(created.id);
    expect([current.state, current.errorCode]).toEqual(["pending", "scanner_unavailable"]);
    const [job] = await getDb().select().from(jobs).where(eq(jobs.uploadId, created.id));
    expect(job!.state).toBe("pending");
  });

  it("enforces the single file limit on the original", async () => {
    await expect(upload(Buffer.alloc(10_000_001, "x"), { name: "large.png" })).rejects.toMatchObject({
      status: 413,
    });
    expect(await getDb().select().from(uploads)).toHaveLength(0);
  });

  it("never makes a spoofed image ready", async () => {
    const created = await upload(Buffer.from("not an image"));
    await runOne();
    expect((await uploadRow(created.id)).state).toBe("failed");
  });
});

describe("purging", () => {
  it("deletes the claim with all its records and files", async () => {
    const { claim } = await accepted();
    while (await runOne()) {
      /* the PDF, Finance and the confirmation */
    }
    const ready = await claimRow(claim.id);
    const [delivery] = await getDb().select().from(deliveries).where(eq(deliveries.claimId, claim.id));
    const [attempt] = await getDb()
      .select()
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.deliveryId, delivery!.id));
    expect(attempt).toBeDefined();
    await getDb()
      .insert(deliveryEvents)
      .values({
        providerId: "synthetic",
        attemptTag: attempt!.id,
        kind: "delivered",
        recipientHash: "0".repeat(64),
        providerTimestamp: new Date(),
      });
    const files = [
      pathFor(ready.pdfKey),
      ...(await getDb().select().from(uploads).where(eq(uploads.claimId, claim.id))).map((row) =>
        pathFor(row.sourceKey),
      ),
    ];
    await purgeClaim(claim.id);
    expect(files.every((file) => !existsSync(file))).toBe(true);
    for (const table of [claims, deliveries, expenses, uploads, confirmations, deliveryEvents, jobs]) {
      expect(await getDb().select().from(table)).toHaveLength(0);
    }
    // A claim that is already gone needs nothing more.
    await purgeClaim(claim.id);
  }, 120_000);

  it("resumes an interrupted purge from its manifest", async () => {
    const { claim } = await accepted();
    const [first] = await getDb().select().from(uploads).where(eq(uploads.claimId, claim.id)).limit(1);
    const directory = path.dirname(pathFor(first!.sourceKey));
    chmodSync(directory, 0o500);
    try {
      await expect(purgeClaim(claim.id)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      chmodSync(directory, 0o700);
    }
    expect((await claimRow(claim.id)).state).toBe("purging");
    expect(await getDb().select().from(uploads).where(eq(uploads.claimId, claim.id))).toHaveLength(2);
    await cleanup({ execute: true });
    expect(await getDb().select().from(claims)).toHaveLength(0);
    expect(await getDb().select().from(uploads)).toHaveLength(0);
  });

  it("alerts about an unresolved claim instead of deleting it", async () => {
    const { claim } = await accepted();
    await getDb()
      .update(claims)
      .set({ resolutionDue: new Date(Date.now() - 24 * 3600 * 1000) })
      .where(eq(claims.id, claim.id));
    const result = await cleanup({ execute: true });
    expect(result.unresolved_near_expiry).toBe(1);
    expect((await claimRow(claim.id)).state).toBe("received");
    expect(await getDb().select().from(uploads).where(eq(uploads.claimId, claim.id))).not.toHaveLength(0);
  });

  it("expires an unused upload after the claim's acceptance", async () => {
    const { claim, draftId } = await accepted();
    const key = `uploads/${randomUUID()}/source.png`;
    const file = pathFor(key);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, await imageBytes());
    const [extra] = await getDb()
      .insert(uploads)
      .values({
        draftId,
        kind: "receipt",
        originalName: "unused.png",
        sourceKey: key,
        size: statSync(file).size,
        checksum: "synthetic",
        createdAt: new Date(Date.now() - 25 * 3600 * 1000),
      })
      .returning();
    await cleanup({ execute: true });
    expect(await getDb().select().from(uploads).where(eq(uploads.id, extra!.id))).toHaveLength(0);
    expect(existsSync(file)).toBe(false);
    expect(await getDb().select().from(uploads).where(eq(uploads.claimId, claim.id))).toHaveLength(2);
  });

  it("deletes content once due, without any setting", async () => {
    const { claim } = await accepted();
    await getDb()
      .update(claims)
      .set({ retentionDue: new Date(Date.now() - 1000) })
      .where(eq(claims.id, claim.id));
    await cleanup({ execute: true });
    expect(await getDb().select().from(claims)).toHaveLength(0);
  });
});

describe("health checks", () => {
  it("liveness does not need the database; readiness does", async () => {
    const { getPool } = await import("../db/client");
    const pool = getPool();
    vi.spyOn(pool, "query").mockImplementation((() => {
      throw new Error("synthetic database outage");
    }) as never);
    expect((await request("GET", "/-/healthz")).status).toBe(200);
    expect((await request("GET", "/-/readyz")).status).toBe(503);
  });

  it("liveness reports the release version", async () => {
    localSettings({ APP_VERSION: "1.2.3" });
    expect((await request("GET", "/-/healthz")).body.version).toBe("1.2.3");
    localSettings({ APP_VERSION: "" });
    expect((await request("GET", "/-/healthz")).body.version).toBeNull();
  });

  it("public health checks require the deployment's token", async () => {
    localSettings({ isDevelopment: false, HEALTHCHECK_TOKEN: "synthetic-health-token" });
    expect((await request("GET", "/-/healthz")).status).toBe(404);
    expect(
      (await request("GET", "/-/healthz", { headers: { "x-health-token": "synthetic-health-token" } }))
        .status,
    ).toBe(200);
  });
});
