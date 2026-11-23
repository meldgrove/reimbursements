// tests/test_operations.py of the Django version: reconciliation, the
// claim-status and verify-storage commands, and the health checks. Its
// production-settings tests are in config.test.ts, its redacted HTTP 500 log
// test in error-reporting.int.test.ts.
import { utimesSync, writeFileSync, unlinkSync } from "node:fs";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../db/client";
import { claims, deliveries, deliveryAttempts, deliveryEvents, jobs, uploads } from "../db/schema";
import { accepted, callCommand, claimRow, freshState, localSettings } from "../test/back-office";
import { request } from "../test/helpers";
import { json, mockProvider } from "../test/mailersend";
import { createForm } from "../test/fixtures";
import { digest } from "./drafts";
import { reconcileUnmatched } from "./evidence";
import { runOne } from "./jobs";
import { HEARTBEAT_KEY, pathFor } from "./storage";

beforeEach(freshState);
afterEach(() => vi.restoreAllMocks());

async function deliveryOf(claimId: string) {
  await getDb().delete(jobs);
  const [delivery] = await getDb()
    .insert(deliveries)
    .values({ claimId, recipient: "finance@example.invalid" })
    .returning();
  return delivery!;
}

describe("reconciliation", () => {
  it("rotates past stuck records", async () => {
    const { claim } = await accepted();
    const delivery = await deliveryOf(claim.id);
    await getDb()
      .insert(deliveryAttempts)
      .values(
        Array.from({ length: 101 }, (_, index) => ({
          deliveryId: delivery.id,
          state: "provider_accepted",
          messageId: `message-${index}`,
        })),
      );
    const seen: string[] = [];
    mockProvider((request) => {
      const messageId = new URL(request.url).pathname.split("/").at(-1)!;
      seen.push(messageId);
      return json(200, {
        data: {
          emails: [{ status: messageId === "message-100" ? "delivered" : "queued", to: delivery.recipient }],
        },
      });
    });
    for (let round = 0; round < 3; round += 1)
      await callCommand("reconcile-deliveries", ["--batch-size", "50"]);
    expect(seen).toContain("message-100");
    const [last] = await getDb()
      .select()
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.messageId, "message-100"));
    expect(last!.state).toBe("delivered");
    expect(await getDb().select().from(jobs)).toHaveLength(0);
  });

  it("shows a failed lookup and does not pin the batch to it", async () => {
    const { claim } = await accepted();
    const delivery = await deliveryOf(claim.id);
    const [first] = await getDb()
      .insert(deliveryAttempts)
      .values({ deliveryId: delivery.id, state: "paused", messageId: "first" })
      .returning();
    const [second] = await getDb()
      .insert(deliveryAttempts)
      .values({ deliveryId: delivery.id, state: "paused", messageId: "second" })
      .returning();
    mockProvider(() => new Response(null, { status: 404 }));
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    const { COMMANDS } = await import("../commands");
    await expect(COMMANDS.get("reconcile-deliveries")!.run(["--batch-size", "1"])).rejects.toThrow(
      /Provider lookup failed/,
    );
    vi.restoreAllMocks();
    mockProvider(() => new Response(null, { status: 404 }));
    expect(JSON.parse(chunks.join("")).failed).toBe(1);
    const reread = async (id: string) =>
      (await getDb().select().from(deliveryAttempts).where(eq(deliveryAttempts.id, id)))[0]!;
    expect((await reread(first!.id)).lastCheckedAt).not.toBeNull();
    expect((await reread(second!.id)).lastCheckedAt).toBeNull();
    await expect(callCommand("reconcile-deliveries", ["--batch-size", "1"])).rejects.toThrow();
    expect((await reread(second!.id)).lastCheckedAt).not.toBeNull();
  });

  it("batches of unmatched events do not starve later matches", async () => {
    const { claim } = await accepted();
    const delivery = await deliveryOf(claim.id);
    await getDb()
      .insert(deliveryAttempts)
      .values({ deliveryId: delivery.id, state: "provider_accepted", messageId: "known" });
    await getDb()
      .insert(deliveryEvents)
      .values(
        Array.from({ length: 100 }, (_, index) => ({
          providerId: `unknown-${index}`,
          messageId: `unknown-${index}`,
          kind: "activity.delivered",
          recipientHash: digest(delivery.recipient),
          providerTimestamp: new Date(),
        })),
      );
    await getDb()
      .insert(deliveryEvents)
      .values({
        providerId: "known-event",
        messageId: "known",
        kind: "activity.delivered",
        recipientHash: digest(delivery.recipient),
        providerTimestamp: new Date(),
      });
    await reconcileUnmatched();
    await reconcileUnmatched();
    const [known] = await getDb()
      .select()
      .from(deliveryEvents)
      .where(eq(deliveryEvents.providerId, "known-event"));
    expect(known!.applied).toBe(true);
  });
});

describe("commands", () => {
  it("claim-status streams beyond 100 claims", async () => {
    const form = await createForm();
    await getDb()
      .insert(claims)
      .values(
        Array.from({ length: 101 }, () => ({
          formId: form.id,
          fullName: "",
          email: "",
          street: "",
          postalCode: "",
          city: "",
          country: "",
          accountHolder: "",
          iban: "",
          purpose: "",
          snapshot: {},
        })),
      );
    const records = (await callCommand("claim-status"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.filter((row) => "reference" in row)).toHaveLength(101);
    expect(records.at(-1)).toHaveProperty("oldest_job_age_seconds");
  });

  it("verify-storage detects missing and corrupted files", async () => {
    const { claim } = await accepted();
    while (await runOne()) {
      /* run every job */
    }
    const ready = await claimRow(claim.id);
    expect(ready.state).toBe("ready");
    expect(JSON.parse(await callCommand("verify-storage")).failures).toBe(0);
    const [original] = await getDb()
      .select()
      .from(uploads)
      .where(eq(uploads.claimId, claim.id))
      .orderBy(asc(uploads.createdAt))
      .limit(1);
    writeFileSync(pathFor(original!.sourceKey), "corrupted synthetic receipt");
    await expect(callCommand("verify-storage")).rejects.toThrow(/storage verification failed/);
    unlinkSync(pathFor(ready.pdfKey));
    await expect(callCommand("verify-storage")).rejects.toThrow();
  }, 120_000);
});

describe("health checks", () => {
  it.each(["/-/healthz", "/-/readyz"])("%s rejects a non-ASCII token", async (path) => {
    localSettings({ isDevelopment: false, HEALTHCHECK_TOKEN: "test-probe-token" });
    const response = await request("GET", path, { headers: { "x-health-token": "invalid-ä" } });
    expect(response.status).toBe(404);
  });

  it("readiness detects a dead worker and an old queue", async () => {
    localSettings({ REQUIRE_WORKER_HEARTBEAT: true });
    expect((await request("GET", "/-/readyz")).status).toBe(503);
    const heartbeat = pathFor(HEARTBEAT_KEY);
    writeFileSync(heartbeat, "synthetic");
    expect((await request("GET", "/-/readyz")).status).toBe(200);
    utimesSync(heartbeat, 0, 0);
    const response = await request("GET", "/-/readyz");
    expect(response.status).toBe(503);
    expect(response.body.checks.worker).toBe(false);
  });

  it("readiness reports a queue whose oldest job waits too long", async () => {
    const { claim } = await accepted();
    await getDb()
      .update(jobs)
      .set({ runAfter: new Date(Date.now() - 3600 * 1000) })
      .where(eq(jobs.claimId, claim.id));
    const response = await request("GET", "/-/readyz");
    expect(response.status).toBe(503);
    expect(response.body.checks.queue).toBe(false);
    expect(response.body.oldest_job_age_seconds).toBeGreaterThanOrEqual(3600);
  });
});
