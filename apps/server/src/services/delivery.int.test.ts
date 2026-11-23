// tests/test_delivery.py of the Django version. Its test of the participant's
// three outcomes on the Received page is in the participant API's tests; the
// rule itself is tested in claim-status.int.test.ts.
import { createHmac } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { and, asc, count, eq, ne } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../db/client";
import {
  claims,
  deliveries as deliveriesTable,
  deliveryAttempts,
  deliveryEvents,
  jobs,
  operations,
  type Delivery,
} from "../db/schema";
import {
  claimRow,
  callCommand,
  accepted,
  deliveryRow,
  freshState,
  localSettings,
  readyDelivery,
} from "../test/back-office";
import { request } from "../test/helpers";
import { json, mockProvider, refused, timedOut } from "../test/mailersend";
import { CLAIM_STATES } from "./claim-status";
import * as deliveries from "./delivery";
import { claimReference } from "./documents";
import * as evidence from "./evidence";
import { reclaimStaleJobs, runOne } from "./jobs";
import * as mailersend from "./mailersend";
import * as operations_ from "./operations";
import * as outbound from "./outbound";
import { pathFor } from "./storage";

beforeEach(freshState);
afterEach(() => vi.restoreAllMocks());

/** A verified webhook, as the route hands it on. */
async function ingestEvent(data: Record<string, unknown>) {
  const provided = mailersend.webhookEvidence(data);
  if (provided) await evidence.record(provided);
}

async function attempt(delivery: Delivery, values: Partial<typeof deliveryAttempts.$inferInsert> = {}) {
  const [row] = await getDb()
    .insert(deliveryAttempts)
    .values({ deliveryId: delivery.id, ...values })
    .returning();
  return row!;
}

async function attemptRow(id: string) {
  const [row] = await getDb().select().from(deliveryAttempts).where(eq(deliveryAttempts.id, id));
  return row!;
}

async function sendJob(delivery: Delivery) {
  await getDb().insert(jobs).values({ key: "send-test", kind: "send", deliveryId: delivery.id });
}

function eventPayload(
  delivery: Delivery,
  options: { kind?: string; providerId?: string; messageId?: string; tags?: string[] } = {},
) {
  return {
    type: `activity.${options.kind ?? "delivered"}`,
    created_at: new Date().toISOString(),
    data: {
      id: options.providerId ?? "event-1",
      message_id: options.messageId ?? "message-1",
      recipient: delivery.recipient,
      tags: options.tags ?? [],
    },
  };
}

async function countOf(table: typeof deliveryEvents | typeof jobs | typeof deliveryAttempts) {
  const [row] = await getDb().select({ value: count() }).from(table);
  return Number(row!.value);
}

describe("Finance delivery", () => {
  it.each([
    [
      () => new Response(null, { status: 202, headers: { "x-message-id": "message-123" } }),
      "provider_accepted",
      "",
    ],
    [
      () =>
        new Response(null, {
          status: 202,
          headers: { "x-message-id": "message-123", "x-send-paused": "true" },
        }),
      "paused",
      "",
    ],
    [() => json(202, { warnings: [{ type: "ALL_SUPPRESSED" }] }), "failed", "recipient_suppressed"],
    [
      () => new Response(null, { status: 429, headers: { "retry-after": "120" } }),
      "pending",
      "provider_throttled",
    ],
    [() => json(422, { errors: { sender: "invalid" } }), "failed", "provider_rejected"],
    [() => new Response(null, { status: 500 }), "send_unknown", "provider_outcome_unknown"],
  ])("maps the provider's answer %# to an outcome", async (response, state, code) => {
    const { delivery } = await readyDelivery();
    localSettings({ MAIL_DELIVERY_MODE: "mailersend" });
    mockProvider(() => response());
    const result = await outbound.send(deliveries.compose, await attempt(delivery));
    expect([result.state, result.errorCode]).toEqual([state, code]);
  });

  it("does not resend automatically after a timeout following transmission", async () => {
    const { delivery } = await readyDelivery();
    localSettings({ MAIL_DELIVERY_MODE: "mailersend" });
    const calls: Request[] = [];
    mockProvider(async (request) => {
      calls.push(request);
      const payload = (await request.json()) as Record<string, unknown>;
      expect(payload.to).toEqual([{ email: "finance@example.invalid" }]);
      expect((payload.from as { email: string }).email).toBe("no-reply@example.invalid");
      expect(payload.reply_to).toEqual({ email: "finance@example.invalid" });
      expect(payload.settings).toEqual({ track_opens: false, track_clicks: false, track_content: false });
      throw timedOut();
    });
    await sendJob(delivery);
    expect(await runOne()).toBe(true);
    expect(await runOne()).toBe(false);
    expect((await deliveryRow(delivery.id)).state).toBe("send_unknown");
    expect(calls).toHaveLength(1);
  });

  it("duplicate and late events do not regress a delivery", async () => {
    const { delivery } = await readyDelivery();
    await attempt(delivery, { state: "provider_accepted", messageId: "message-1" });
    const event = eventPayload(delivery);
    await ingestEvent(event);
    await ingestEvent(event);
    await ingestEvent(eventPayload(delivery, { kind: "sent", providerId: "event-2" }));
    expect((await deliveryRow(delivery.id)).state).toBe("delivered");
    expect(await countOf(deliveryEvents)).toBe(2);
    await ingestEvent(eventPayload(delivery, { kind: "hard_bounced", providerId: "event-3" }));
    expect((await deliveryRow(delivery.id)).state).toBe("failed");
    expect((await claimRow(delivery.claimId)).retentionDue).toBeNull();
  });

  it("an event before the send response correlates by the attempt tag", async () => {
    const { delivery } = await readyDelivery();
    const sent = await attempt(delivery);
    await ingestEvent(eventPayload(delivery, { tags: [`attempt-${sent.id}`] }));
    expect((await attemptRow(sent.id)).messageId).toBe("message-1");
    expect((await deliveryRow(delivery.id)).state).toBe("delivered");
  });

  it("an unknown message or a wrong recipient does not change the claim", async () => {
    const { delivery } = await readyDelivery();
    await attempt(delivery, { state: "provider_accepted", messageId: "message-1" });
    await ingestEvent(eventPayload(delivery, { messageId: "other" }));
    const payload = eventPayload(delivery, { providerId: "event-2" });
    payload.data.recipient = "other@example.invalid";
    await ingestEvent(payload);
    expect((await deliveryRow(delivery.id)).state).toBe("pending");
    const [unapplied] = await getDb()
      .select({ value: count() })
      .from(deliveryEvents)
      .where(eq(deliveryEvents.applied, false));
    expect(Number(unapplied!.value)).toBe(2);
  });

  it("checks webhook signatures and answers the setup ping", async () => {
    const { delivery } = await readyDelivery();
    localSettings({ MAILERSEND_WEBHOOK_SIGNING_SECRET: "synthetic-test-secret" });
    await attempt(delivery, { state: "provider_accepted", messageId: "message-1" });
    const data = JSON.stringify(eventPayload(delivery));
    const post = (body: string, signature?: string) =>
      request("POST", "/webhooks/mailersend/", {
        body,
        headers: { "content-type": "application/json", ...(signature ? { signature } : {}) },
      });
    expect((await post(data)).status).toBe(401);
    const signature = createHmac("sha256", "synthetic-test-secret").update(data).digest("hex");
    expect((await post(data, signature)).status).toBe(200);
    const ping = JSON.stringify({ type: "webhook.test" });
    const pingSignature = createHmac("sha256", mailersend.WEBHOOK_TEST_SECRET).update(ping).digest("hex");
    expect((await post(ping, pingSignature)).status).toBe(200);
    expect(await countOf(deliveryEvents)).toBe(1);
  });

  it("a stale send lease becomes unknown", async () => {
    const { delivery } = await readyDelivery();
    await attempt(delivery);
    await getDb()
      .insert(jobs)
      .values({
        key: "stale-send",
        kind: "send",
        deliveryId: delivery.id,
        state: "running",
        leaseUntil: new Date(Date.now() - 1000),
      });
    await reclaimStaleJobs();
    expect((await deliveryRow(delivery.id)).state).toBe("send_unknown");
    const [job] = await getDb().select().from(jobs);
    expect(job!.state).toBe("failed");
    expect(await runOne()).toBe(false);
  });

  it("the staging recipient guard blocks even a configured address", async () => {
    const { delivery } = await readyDelivery();
    localSettings({ TEST_RECIPIENT_ALLOWLIST: ["test-only@example.invalid"] });
    const result = await outbound.send(deliveries.compose, await attempt(delivery));
    expect(result.errorCode).toBe("test_recipient_blocked");
  });

  describe.each(["provider_accepted", "paused", "send_unknown"])(
    "reconciling a rejected message (%s)",
    (initial) => {
      it.each([
        [{}, "provider_rejected"],
        [{ suppression_reason: "blocklisted" }, "provider_suppressed"],
        [{ suppression_reason: "hard_bounced" }, "provider_hard_bounced"],
        [{ activity: [{ type: "suppressed" }] }, "provider_suppressed"],
      ])("marks it failed without resending (%o)", async (details, code) => {
        const { delivery, claim } = await readyDelivery();
        const sent = await attempt(delivery, { messageId: "rejected-message", state: initial });
        const calls: Request[] = [];
        mockProvider((request) => {
          calls.push(request);
          expect(request.method).toBe("GET");
          expect(new URL(request.url).pathname).toBe("/v1/messages/rejected-message");
          return json(200, {
            data: {
              emails: [{ id: "rejected-email", to: delivery.recipient, status: "rejected", ...details }],
            },
          });
        });
        await callCommand("reconcile-deliveries");
        await callCommand("reconcile-deliveries");
        const reloaded = await attemptRow(sent.id);
        const current = await deliveryRow(delivery.id);
        expect([reloaded.state, reloaded.errorCode]).toEqual(["failed", code]);
        expect([current.state, current.errorCode]).toEqual(["failed", code]);
        expect((await claimRow(claim.id)).retentionDue).toBeNull();
        expect(existsSync(pathFor(claim.pdfKey))).toBe(true);
        expect(calls).toHaveLength(1);
        const [event] = await getDb().select().from(deliveryEvents);
        expect(event!.applied).toBe(true);
        expect(await countOf(deliveryAttempts)).toBe(1);
        expect(await countOf(jobs)).toBe(0);
      });
    },
  );

  it("a rejected snapshot cannot fail another recipient", async () => {
    const { delivery } = await readyDelivery();
    const sent = await attempt(delivery, { messageId: "rejected-message", state: "provider_accepted" });
    mockProvider(() =>
      json(200, { data: { emails: [{ status: "rejected", to: "other@example.invalid" }] } }),
    );
    await callCommand("reconcile-deliveries");
    expect((await attemptRow(sent.id)).state).toBe("provider_accepted");
    const [event] = await getDb().select().from(deliveryEvents);
    expect(event!.applied).toBe(false);
  });

  it("a failure before transmission is definite and can be retried", async () => {
    const { delivery, claim } = await readyDelivery();
    localSettings({ MAIL_DELIVERY_MODE: "mailersend" });
    const calls: Request[] = [];
    mockProvider((request) => {
      calls.push(request);
      return new Response(null, { status: 202 });
    });
    unlinkSync(pathFor(claim.pdfKey));
    await sendJob(delivery);
    expect(await runOne()).toBe(true);
    const [sent] = await getDb()
      .select()
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.deliveryId, delivery.id));
    expect([sent!.state, sent!.errorCode]).toEqual(["failed", "attachment_unavailable"]);
    expect((await deliveryRow(delivery.id)).state).toBe("failed");
    expect(calls).toHaveLength(0);
    await callCommand("retry-claim", [claimReference(claim), "--reason", "restored PDF"]);
    expect((await deliveryRow(delivery.id)).state).toBe("pending");
    const [pending] = await getDb()
      .select({ value: count() })
      .from(jobs)
      .where(and(eq(jobs.kind, "send"), eq(jobs.state, "pending")));
    expect(Number(pending!.value)).toBe(1);
  });

  it.each([
    ["send_unknown", "provider_accepted"],
    ["paused", "paused"],
  ])("a queued snapshot resolves only an unknown outcome (%s)", async (initial, expected) => {
    const { delivery } = await readyDelivery();
    const sent = await attempt(delivery, { messageId: "queued-message", state: initial });
    mockProvider(() => json(200, { data: { emails: [{ status: "queued", to: delivery.recipient }] } }));
    await callCommand("reconcile-deliveries");
    expect((await attemptRow(sent.id)).state).toBe(expected);
    const [event] = await getDb().select().from(deliveryEvents);
    expect(event!.applied).toBe(true);
  });

  it.each(["send_unknown", "provider_accepted", "delivered"])(
    "an operator resend requires acknowledging the duplicate risk (%s)",
    async (state) => {
      const { delivery, claim } = await readyDelivery();
      await attempt(delivery, { state, messageId: "message-1" });
      await deliveries.refresh(delivery);
      const reference = claimReference(claim);
      await expect(callCommand("retry-claim", [reference, "--reason", "check"])).rejects.toThrow(
        /acknowledge-duplicate-risk/,
      );
      expect(await countOf(jobs)).toBe(0);
      await callCommand("retry-claim", [
        reference,
        "--reason",
        "provider confirmed no delivery",
        "--actor",
        "operator",
        "--acknowledge-duplicate-risk",
      ]);
      expect((await deliveryRow(delivery.id)).state).toBe("pending");
      const [operation] = await getDb().select().from(operations);
      expect(operation!.actor).toBe("operator");
      await expect(callCommand("retry-claim", [reference, "--reason", "again"])).rejects.toThrow(
        /active job/,
      );
    },
  );

  it("a failed render is queued again without duplicate risk", async () => {
    const { claim } = await accepted();
    await getDb().delete(jobs);
    await getDb()
      .update(claims)
      .set({ state: CLAIM_STATES.FAILED, errorCode: "document_timeout" })
      .where(eq(claims.id, claim.id));
    await callCommand("retry-claim", [claimReference(claim), "--reason", "timeout"]);
    const reloaded = await claimRow(claim.id);
    expect([reloaded.state, reloaded.errorCode]).toEqual([CLAIM_STATES.RECEIVED, ""]);
    const [job] = await getDb().select().from(jobs);
    expect(job!.kind).toBe("render");
  });

  it.each([
    [[], false],
    [["failed"], false],
    [["send_unknown", "failed"], true],
    [["provider_accepted"], true],
    [["delivered"], true],
  ])("a resend needs acknowledgment while Finance may hold a copy (%o)", async (states, risk) => {
    const { delivery, claim: ready } = await readyDelivery();
    for (const state of states) await attempt(delivery, { state });
    await deliveries.refresh(delivery);
    const claim = await claimRow(ready.id);
    expect(await deliveries.mayHaveReachedFinance(claim)).toBe(risk);
    expect(await operations_.planRetry(claim)).toEqual({ action: operations_.RESEND, duplicateRisk: risk });
    if (risk) {
      await expect(
        operations_.retry(claim.id, { actor: "operator", reason: "Checked" }),
      ).rejects.toMatchObject({
        code: "duplicate_risk",
      });
    }
    await operations_.retry(claim.id, {
      actor: "operator",
      reason: "Checked",
      acknowledgeDuplicateRisk: true,
    });
    expect((await deliveryRow(delivery.id)).state).toBe("pending");
    const [pending] = await getDb()
      .select({ value: count() })
      .from(jobs)
      .where(and(eq(jobs.kind, "send"), eq(jobs.state, "pending")));
    expect(Number(pending!.value)).toBe(1);
  });

  it.each([
    [CLAIM_STATES.FAILED, false, { action: operations_.RENDER, duplicateRisk: false }],
    [CLAIM_STATES.FAILED, true, "active_job"],
    [CLAIM_STATES.READY, false, "pdf_removed"],
    [CLAIM_STATES.RECEIVED, false, "not_retryable"],
    [CLAIM_STATES.PURGING, false, "not_retryable"],
  ])("what a retry would do (%s, active job %s)", async (state, activeJob, plan) => {
    const { claim: created } = await accepted();
    await getDb().delete(jobs).where(ne(jobs.kind, "render"));
    await getDb()
      .update(jobs)
      .set({ state: activeJob ? "pending" : "done" });
    await getDb().update(claims).set({ state, pdfKey: "" }).where(eq(claims.id, created.id));
    const claim = await claimRow(created.id);
    if (typeof plan === "object") {
      expect(await operations_.planRetry(claim)).toEqual(plan);
    } else {
      await expect(operations_.planRetry(claim)).rejects.toMatchObject({ code: plan });
    }
  });

  it("MailerSend reads back the attempt tag it sends", async () => {
    const { delivery } = await readyDelivery();
    localSettings({ MAIL_DELIVERY_MODE: "mailersend" });
    const sent: Array<{ tags: string[] }> = [];
    mockProvider(async (request) => {
      sent.push((await request.json()) as { tags: string[] });
      return new Response(null, { status: 202, headers: { "x-message-id": "message-9" } });
    });
    const record = await attempt(delivery);
    await outbound.send(deliveries.compose, record);
    const provided = mailersend.webhookEvidence({
      type: "activity.delivered",
      created_at: "2026-11-11T10:00:00Z",
      data: { id: "event-9", recipient: delivery.recipient, tags: sent[0]!.tags },
    });
    expect([provided!.attemptId, provided!.messageId]).toEqual([record.id, ""]);
    await evidence.record(provided!);
    expect((await attemptRow(record.id)).state).toBe("delivered");
  });

  it("retries a resend of a delivered claim after a refused connection", async () => {
    const { delivery } = await readyDelivery();
    localSettings({ MAIL_DELIVERY_MODE: "mailersend" });
    await attempt(delivery, { state: "delivered", messageId: "first" });
    await getDb()
      .update(deliveriesTable)
      .set({ state: "delivered" })
      .where(eq(deliveriesTable.id, delivery.id));
    const calls: Request[] = [];
    mockProvider((request) => {
      calls.push(request);
      if (calls.length === 1) throw refused();
      return new Response(null, { status: 202, headers: { "x-message-id": "second" } });
    });
    await operations_.retry(delivery.claimId, {
      actor: "operator",
      reason: "Lost",
      acknowledgeDuplicateRisk: true,
    });
    expect(await runOne()).toBe(true);
    let [job] = await getDb().select().from(jobs);
    expect(job!.state).toBe("pending");
    await getDb().update(jobs).set({ runAfter: new Date() });
    expect(await runOne()).toBe(true);
    expect(calls).toHaveLength(2);
    [job] = await getDb().select().from(jobs);
    expect(job!.state).toBe("done");
    const states = await getDb()
      .select({ state: deliveryAttempts.state })
      .from(deliveryAttempts)
      .orderBy(asc(deliveryAttempts.createdAt));
    expect(states.map((row) => row.state)).toEqual(["delivered", "pending", "provider_accepted"]);
  });
});
