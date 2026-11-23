// tests/test_retention_periods.py and tests/test_claim_deletion.py of the
// Django version. The tests of Django migration 0008 have no counterpart:
// this version takes over databases of 0.3 and later, which ran it.
import { chmodSync, existsSync } from "node:fs";
import path from "node:path";
import { and, eq, gt, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config";
import { getDb } from "../db/client";
import {
  claims,
  deliveries,
  deliveryAttempts,
  drafts,
  expenses,
  forms,
  jobs,
  operations as operationRows,
  privacyNotices,
  uploads,
  type Claim,
  type Delivery,
} from "../db/schema";
import { accepted, claimRow, deliveryRow, freshState, readyDelivery } from "../test/back-office";
import { createForm } from "../test/fixtures";
import { CLAIM_STATES } from "./claim-status";
import * as deliveriesService from "./delivery";
import { runOne } from "./jobs";
import * as operations from "./operations";
import * as retention from "./retention";
import { cleanup } from "./retention";
import { pathFor } from "./storage";

beforeEach(freshState);
afterEach(() => vi.restoreAllMocks());

const DAY = 24 * 3600 * 1000;
const days = (date: Date, count: number) => new Date(date.getTime() + count * DAY);
const past = () => new Date(Date.now() - 1000);

async function delivered(delivery: Delivery): Promise<Claim> {
  await getDb()
    .insert(deliveryAttempts)
    .values({ deliveryId: delivery.id, state: "delivered", messageId: "message-1" });
  await deliveriesService.refresh(delivery);
  return claimRow(delivery.claimId);
}

async function exists(claimId: string): Promise<boolean> {
  return (await getDb().select({ id: claims.id }).from(claims).where(eq(claims.id, claimId))).length > 0;
}

describe("retention periods", () => {
  it("delivery schedules the PDF's and the content's deletion", async () => {
    const { delivery } = await readyDelivery();
    const claim = await delivered(delivery);
    const current = await deliveryRow(delivery.id);
    expect(claim.pdfDue).toEqual(days(current.deliveredAt!, config().PDF_RETENTION_DAYS));
    expect(claim.retentionDue).toEqual(days(claim.submittedAt, config().CONTENT_RETENTION_DAYS));
  });

  it.each([
    ["delivered", true],
    ["failed", false],
    ["send_unknown", false],
    ["provider_accepted", null],
  ])("retention follows the Finance delivery (%s)", async (state, dated) => {
    const { claim } = await accepted();
    const earlier = new Date();
    await getDb()
      .update(claims)
      .set({ pdfDue: earlier, retentionDue: earlier })
      .where(eq(claims.id, claim.id));
    const deliveredAt = days(claim.submittedAt, 100);
    await retention.followDelivery(claim, state, deliveredAt);
    const current = await claimRow(claim.id);
    if (dated === null) {
      // Not resolved either way: the stored dates stay as they were.
      expect([current.pdfDue, current.retentionDue]).toEqual([earlier, earlier]);
    } else if (dated) {
      expect(current.pdfDue).toEqual(days(deliveredAt, config().PDF_RETENTION_DAYS));
      // Content stays at least as long as the PDF.
      expect(current.retentionDue).toEqual(current.pdfDue);
    } else {
      expect([current.pdfDue, current.retentionDue]).toEqual([null, null]);
    }
  });

  it("deletes the PDF first and the content after ninety days", async () => {
    const { delivery } = await readyDelivery();
    const claim = await delivered(delivery);
    const pdf = pathFor(claim.pdfKey);
    await getDb().update(claims).set({ pdfDue: past() }).where(eq(claims.id, claim.id));
    expect((await cleanup()).pdfs_due).toBe(1);
    expect((await cleanup({ execute: true })).failures).toBe(0);
    const current = await claimRow(claim.id);
    expect(existsSync(pdf)).toBe(false);
    expect(current.pdfKey).toBe("");
    expect(current.pdfRemovedAt).not.toBeNull();
    expect(current.state).toBe(CLAIM_STATES.READY);
    expect(current.iban).toBeTruthy();
    expect(await getDb().select().from(uploads).where(eq(uploads.claimId, claim.id))).toHaveLength(2);
    await getDb().update(claims).set({ retentionDue: past() }).where(eq(claims.id, claim.id));
    await cleanup({ execute: true });
    expect(await exists(claim.id)).toBe(false);
  });

  it("a failed delivery keeps the PDF for resolution", async () => {
    const { delivery } = await readyDelivery();
    await getDb().insert(deliveryAttempts).values({ deliveryId: delivery.id, state: "failed" });
    await deliveriesService.refresh(delivery);
    const claim = await claimRow(delivery.claimId);
    expect([claim.pdfDue, claim.retentionDue]).toEqual([null, null]);
    await cleanup({ execute: true });
    expect((await claimRow(claim.id)).pdfKey).toBeTruthy();
  });

  it("an archived claim needs no resolution and goes on its resolution date", async () => {
    const { delivery } = await readyDelivery();
    await getDb().insert(deliveryAttempts).values({ deliveryId: delivery.id, state: "failed" });
    await deliveriesService.refresh(delivery);
    const due = past();
    await getDb().update(claims).set({ resolutionDue: due }).where(eq(claims.id, delivery.claimId));
    expect((await cleanup()).unresolved_near_expiry).toBe(1);
    await cleanup({ execute: true });
    expect(await exists(delivery.claimId)).toBe(true);

    await operations.archive([delivery.claimId], { actor: "admin" });
    const claim = await claimRow(delivery.claimId);
    expect(retention.contentDue(claim)).toEqual(due);
    expect(claim.retentionDue).toBeNull();
    const result = await cleanup();
    expect([result.claims_due, result.unresolved_near_expiry]).toEqual([1, 0]);
    await cleanup({ execute: true });
    expect(await exists(claim.id)).toBe(false);
    expect(existsSync(pathFor("pdf/test.pdf"))).toBe(false);
  });

  it("an archived claim waits for its resolution or retention date", async () => {
    const { delivery } = await readyDelivery();
    await getDb().update(claims).set({ archivedAt: new Date() }).where(eq(claims.id, delivery.claimId));
    let claim = await claimRow(delivery.claimId);
    expect(retention.contentDue(claim)).toEqual(claim.resolutionDue);
    expect(claim.resolutionDue.getTime()).toBeGreaterThan(Date.now());
    await cleanup({ execute: true });
    expect(await exists(claim.id)).toBe(true);
    // Once resolved, the retention date decides, as for any claim.
    claim = await delivered(delivery);
    expect(retention.contentDue(claim)).toEqual(claim.retentionDue);
    await getDb().update(claims).set({ resolutionDue: past() }).where(eq(claims.id, claim.id));
    await cleanup({ execute: true });
    expect(await exists(claim.id)).toBe(true);
    await getDb().update(claims).set({ retentionDue: past() }).where(eq(claims.id, claim.id));
    await cleanup({ execute: true });
    expect(await exists(claim.id)).toBe(false);
  });

  it("never purges archived forms", async () => {
    const form = await createForm({ status: "archived" });
    await cleanup({ execute: true });
    const [kept] = await getDb()
      .select()
      .from(forms)
      .where(and(eq(forms.id, form.id), eq(forms.status, "archived")));
    expect(kept).toBeDefined();
  });

  it("the initial privacy notice states the retention periods", async () => {
    expect([config().PDF_RETENTION_DAYS, config().CONTENT_RETENTION_DAYS]).toEqual([7, 90]);
    const [notice] = await getDb().select().from(privacyNotices).where(eq(privacyNotices.version, 1));
    expect(notice!.text).toContain(
      `${config().PDF_RETENTION_DAYS} Tage nach der Zustellung an die Buchhaltung`,
    );
    expect(notice!.text).toContain(`${config().CONTENT_RETENTION_DAYS} Tage nach dem Einreichen`);
  });
});

async function storedFiles(claimId: string): Promise<string[]> {
  return (await getDb().select().from(uploads).where(eq(uploads.claimId, claimId))).map((upload) =>
    pathFor(upload.sourceKey),
  );
}

describe("claim deletion", () => {
  it("removes the claim for good and is audited", async () => {
    const { claim } = await accepted();
    const files = await storedFiles(claim.id);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((file) => existsSync(file))).toBe(true);
    expect(await getDb().select().from(jobs).where(eq(jobs.state, "pending"))).not.toHaveLength(0);

    expect(
      await operations.deleteClaim(claim.id, { actor: "admin@example.invalid", reason: " Testeinreichung " }),
    ).toBe(true);

    expect(await getDb().select().from(claims)).toHaveLength(0);
    expect(files.some((file) => existsSync(file))).toBe(false);
    expect(await getDb().select().from(expenses)).toHaveLength(0);
    expect(await getDb().select().from(uploads)).toHaveLength(0);
    expect(await getDb().select().from(jobs)).toHaveLength(0);
    const [draft, ...others] = await getDb().select().from(drafts);
    expect(others).toHaveLength(0);
    expect([draft!.claimId, draft!.sessionHash, draft!.tokenHash]).toEqual([null, "", ""]);
    expect(
      await getDb()
        .select()
        .from(drafts)
        .where(and(isNull(drafts.claimId), gt(drafts.expiresAt, new Date()))),
    ).toHaveLength(0);
    const [operation] = await getDb().select().from(operationRows);
    expect([operation!.claimId, operation!.action]).toEqual([null, "delete"]);
    expect([operation!.actor, operation!.reason]).toEqual(["admin@example.invalid", "Testeinreichung"]);
    await cleanup({ execute: true });
    expect(await getDb().select().from(drafts)).toHaveLength(0);
    expect(await getDb().select().from(operationRows)).toHaveLength(1);
  });

  it("requires a reason", async () => {
    const { claim } = await accepted();
    await expect(operations.deleteClaim(claim.id, { actor: "admin", reason: "  " })).rejects.toMatchObject({
      code: "reason_missing",
    });
    const current = await claimRow(claim.id);
    expect(current.state).toBe(CLAIM_STATES.RECEIVED);
    expect(current.iban).toBeTruthy();
    expect(await getDb().select().from(operationRows)).toHaveLength(0);
  });

  it("waits for running work", async () => {
    const { claim } = await accepted();
    await getDb().update(jobs).set({ state: "running" }).where(eq(jobs.kind, "render"));
    await expect(operations.deleteClaim(claim.id, { actor: "admin", reason: "Test" })).rejects.toMatchObject({
      code: "busy",
    });
    expect((await claimRow(claim.id)).state).toBe(CLAIM_STATES.RECEIVED);
    expect(await getDb().select().from(uploads).where(eq(uploads.claimId, claim.id))).not.toHaveLength(0);
    expect(
      await getDb()
        .select()
        .from(jobs)
        .where(and(eq(jobs.kind, "render"), eq(jobs.state, "running"))),
    ).toHaveLength(1);
    expect(await getDb().select().from(operationRows)).toHaveLength(0);
  });

  it("cannot delete a deleted claim again", async () => {
    const { claim } = await accepted();
    await operations.deleteClaim(claim.id, { actor: "admin", reason: "Test" });
    await expect(operations.deleteClaim(claim.id, { actor: "admin", reason: "Again" })).rejects.toMatchObject(
      {
        code: "already_deleted",
      },
    );
    expect(await getDb().select().from(operationRows)).toHaveLength(1);
  });

  it("the cleanup finishes an interrupted deletion", async () => {
    const { claim } = await accepted();
    const [upload] = await getDb().select().from(uploads).where(eq(uploads.claimId, claim.id)).limit(1);
    const directory = path.dirname(pathFor(upload!.sourceKey));
    chmodSync(directory, 0o500);
    try {
      expect(await operations.deleteClaim(claim.id, { actor: "admin", reason: "Test" })).toBe(false);
    } finally {
      chmodSync(directory, 0o700);
    }
    expect((await claimRow(claim.id)).state).toBe(CLAIM_STATES.PURGING);
    const [operation] = await getDb().select().from(operationRows);
    expect(operation!.action).toBe("delete");
    await cleanup({ execute: true });
    expect(await getDb().select().from(claims)).toHaveLength(0);
    const [kept] = await getDb().select().from(operationRows);
    expect(kept!.action).toBe("delete");
  });

  it("never sends a deleted claim", async () => {
    const { delivery } = await readyDelivery();
    await getDb().insert(jobs).values({ key: "send-test", kind: "send", deliveryId: delivery.id });
    await operations.deleteClaim(delivery.claimId, { actor: "admin", reason: "Test" });
    expect(existsSync(pathFor("pdf/test.pdf"))).toBe(false);
    expect(await getDb().select().from(jobs)).toHaveLength(0);
    expect(await getDb().select().from(deliveries)).toHaveLength(0);
    expect(await runOne()).toBe(false);
    expect(await getDb().select().from(deliveryAttempts)).toHaveLength(0);
  });

  it.each([
    [[], false],
    [["failed"], false],
    [["failed", "send_unknown"], true],
    [["provider_accepted"], true],
    [["delivered"], true],
  ])("Finance may hold a copy unless every send failed (%o)", async (states, reached) => {
    const { delivery } = await readyDelivery();
    for (const state of states)
      await getDb().insert(deliveryAttempts).values({ deliveryId: delivery.id, state });
    expect(await deliveriesService.mayHaveReachedFinance({ id: delivery.claimId })).toBe(reached);
  });

  it("a claim without a delivery has not reached Finance", async () => {
    const { claim } = await accepted();
    expect(await deliveriesService.mayHaveReachedFinance(claim)).toBe(false);
  });
});
