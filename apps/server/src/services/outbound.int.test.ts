// tests/test_outbound.py of the Django version: Finance deliveries and
// participant confirmations follow one send-at-most-once protocol, and the
// provider's evidence settles either.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../db/client";
import { claims, confirmations, deliveryAttempts, deliveryEvents, jobs, type Delivery } from "../db/schema";
import { callCommand, freshState, localSettings, readyDelivery } from "../test/back-office";
import { json, mockProvider } from "../test/mailersend";
import * as evidence from "./evidence";
import { BACKOFF, runOne } from "./jobs";
import * as mailersend from "./mailersend";
import * as outbound from "./outbound";
import * as queue from "./queue";
import { purgeClaim } from "./retention";
import { outboxKey, pathFor } from "./storage";
import { ACCEPTED, PENDING, sendResult, type Message, type SendResult, type Transport } from "./transport";

type Result = SendResult | Error | ((message: Message) => Promise<SendResult>);

/** An in-memory transport adapter. */
class Recorder implements Transport {
  readonly sent: Message[] = [];
  results: Result[] = [];

  async send(message: Message): Promise<SendResult> {
    this.sent.push(message);
    const result = this.results.shift() ?? sendResult(ACCEPTED, { messageId: "message-1" });
    if (result instanceof Error) throw result;
    return typeof result === "function" ? result(message) : result;
  }
}

let transport: Recorder;

beforeEach(async () => {
  await freshState();
  transport = new Recorder();
  outbound.transportOverride.current = transport;
});

afterEach(() => {
  outbound.transportOverride.current = null;
  vi.restoreAllMocks();
});

type Email = {
  record: () => Promise<{ state: string; errorCode: string; messageId: string | null }>;
  recipient: string;
};

async function finance(delivery: Delivery): Promise<Email> {
  await getDb().delete(jobs);
  await queue.enqueue("send", delivery);
  return {
    record: async () => {
      const rows = await getDb()
        .select()
        .from(deliveryAttempts)
        .where(eq(deliveryAttempts.deliveryId, delivery.id))
        .orderBy(asc(deliveryAttempts.createdAt));
      return rows.at(-1)!;
    },
    recipient: delivery.recipient,
  };
}

async function confirmation(delivery: Delivery): Promise<Email> {
  await getDb().delete(jobs);
  await getDb()
    .update(confirmations)
    .set({ state: PENDING })
    .where(eq(confirmations.claimId, delivery.claimId));
  await queue.enqueue("confirm", { id: delivery.claimId });
  const [claim] = await getDb().select().from(claims).where(eq(claims.id, delivery.claimId));
  return {
    record: async () => {
      const [row] = await getDb()
        .select()
        .from(confirmations)
        .where(eq(confirmations.claimId, delivery.claimId));
      return row!;
    },
    recipient: claim!.email,
  };
}

const SENDERS = [
  ["finance", finance],
  ["confirmation", confirmation],
] as const;

async function runUntilIdle() {
  for (;;) {
    const [pending] = await getDb()
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.state, queue.PENDING))
      .limit(1);
    if (!pending) return;
    await getDb().update(jobs).set({ runAfter: new Date() });
    await runOne();
  }
}

/** Verified MailerSend webhook evidence. */
function webhook(recipient: string, kind: string, providerId: string, data: Record<string, unknown> = {}) {
  return mailersend.webhookEvidence({
    type: `activity.${kind}`,
    created_at: new Date().toISOString(),
    data: { id: providerId, recipient, ...data },
  })!;
}

describe.each(SENDERS)("%s emails", (_name, sender) => {
  it("records an accepted send once", async () => {
    const { delivery } = await readyDelivery();
    const { record } = await sender(delivery);
    await runUntilIdle();
    expect(transport.sent).toHaveLength(1);
    const current = await record();
    expect([current.state, current.messageId]).toEqual(["provider_accepted", "message-1"]);
  });

  it("retries a throttled send until attempts run out", async () => {
    const { delivery } = await readyDelivery();
    const { record } = await sender(delivery);
    transport.results = Array.from({ length: 10 }, () =>
      sendResult(PENDING, { errorCode: "provider_throttled" }),
    );
    await runUntilIdle();
    expect(transport.sent).toHaveLength(BACKOFF.length + 1);
    const current = await record();
    expect([current.state, current.errorCode]).toEqual(["failed", "retry_exhausted"]);
    const [job] = await getDb().select().from(jobs);
    expect(job!.errorCode).toBe("retry_exhausted");
  });

  it("never repeats a send that raised", async () => {
    const { delivery } = await readyDelivery();
    const { record } = await sender(delivery);
    transport.results = [new Error("synthetic timeout")];
    await runUntilIdle();
    expect(transport.sent).toHaveLength(1);
    const current = await record();
    expect([current.state, current.errorCode]).toEqual(["send_unknown", "unexpected_send_failure"]);
  });

  it("is blocked by the test allowlist", async () => {
    const { delivery } = await readyDelivery();
    localSettings({ TEST_RECIPIENT_ALLOWLIST: ["nobody@example.invalid"] });
    const { record } = await sender(delivery);
    await runUntilIdle();
    expect(transport.sent).toHaveLength(0);
    const current = await record();
    expect([current.state, current.errorCode]).toEqual(["failed", "test_recipient_blocked"]);
  });

  it("is settled by provider evidence", async () => {
    const { delivery } = await readyDelivery();
    const email = await sender(delivery);
    await runUntilIdle();
    await evidence.record(webhook(email.recipient, "delivered", "event-1", { message_id: "message-1" }));
    await evidence.record(webhook(email.recipient, "sent", "event-2", { message_id: "message-1" }));
    expect((await email.record()).state).toBe("delivered");
    const unapplied = await getDb().select().from(deliveryEvents).where(eq(deliveryEvents.applied, false));
    expect(unapplied).toHaveLength(0);
  });

  it("keeps evidence that arrives before the send result", async () => {
    const { delivery } = await readyDelivery();
    const email = await sender(delivery);
    transport.results = [
      async (message) => {
        await evidence.record(
          webhook(email.recipient, "delivered", "event-1", { tags: [`attempt-${message.attemptId}`] }),
        );
        return sendResult(ACCEPTED, { messageId: "message-1" });
      },
    ];
    await runUntilIdle();
    const current = await email.record();
    expect([current.state, current.messageId]).toEqual(["delivered", "message-1"]);
  });

  it("is not changed by evidence for another recipient", async () => {
    const { delivery } = await readyDelivery();
    const email = await sender(delivery);
    await runUntilIdle();
    await evidence.record(
      webhook("other@example.invalid", "hard_bounced", "event-1", { message_id: "message-1" }),
    );
    expect((await email.record()).state).toBe("provider_accepted");
  });

  it("fails definitely when its message cannot be composed", async () => {
    const { delivery } = await readyDelivery();
    const email = await sender(delivery);
    await getDb().update(claims).set({ snapshot: {} }).where(eq(claims.id, delivery.claimId));
    await runUntilIdle();
    expect(transport.sent).toHaveLength(0);
    const current = await email.record();
    expect([current.state, current.errorCode]).toEqual(["failed", "message_unavailable"]);
  });

  it("is looked up by the reconciliation", async () => {
    const { delivery } = await readyDelivery();
    const email = await sender(delivery);
    await runUntilIdle();
    const lookedUp: string[] = [];
    mockProvider((request) => {
      lookedUp.push(path.basename(new URL(request.url).pathname));
      return json(200, { data: { emails: [{ status: "delivered", to: email.recipient }] } });
    });
    await callCommand("reconcile-deliveries");
    expect(lookedUp).toEqual(["message-1"]);
    expect((await email.record()).state).toBe("delivered");
  });
});

describe("outbound email", () => {
  it("removes local copies with their messages", () => {
    for (const messageId of ["attempt-1", "confirmation-1"]) {
      const file = pathFor(outboxKey(messageId));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "synthetic");
    }
    outbound.removeCopies("attempt-1");
    expect(existsSync(pathFor(outboxKey("attempt-1")))).toBe(false);
    expect(existsSync(pathFor(outboxKey("confirmation-1")))).toBe(true);
  });

  it("forgets the evidence of a claim's emails when the claim is deleted", async () => {
    const { delivery, claim } = await readyDelivery();
    await finance(delivery);
    await runUntilIdle();
    await confirmation(delivery);
    transport.results = [sendResult(ACCEPTED, { messageId: "message-2" })];
    await runUntilIdle();
    await evidence.record(webhook(delivery.recipient, "delivered", "finance", { message_id: "message-1" }));
    await evidence.record(webhook(claim.email, "delivered", "confirmation", { message_id: "message-2" }));
    // Evidence that names the claim's email but never applied goes as well.
    await evidence.record(webhook("other@example.invalid", "sent", "unapplied", { message_id: "message-2" }));
    await evidence.record(webhook(claim.email, "delivered", "another-email", { message_id: "message-3" }));
    await purgeClaim(claim.id);
    const left = await getDb().select({ providerId: deliveryEvents.providerId }).from(deliveryEvents);
    expect(left.map((row) => row.providerId)).toEqual(["another-email"]);
  });

  it("drops unmatched evidence after thirty days", async () => {
    for (const [providerId, age] of [
      ["recent", 29],
      ["old", 31],
    ] as const) {
      await getDb()
        .insert(deliveryEvents)
        .values({
          providerId,
          messageId: providerId,
          kind: "activity.delivered",
          recipientHash: "0".repeat(64),
          providerTimestamp: new Date(),
          receivedAt: new Date(Date.now() - age * 24 * 3600 * 1000),
        });
    }
    await evidence.reconcileUnmatched();
    const left = await getDb().select({ providerId: deliveryEvents.providerId }).from(deliveryEvents);
    expect(left.map((row) => row.providerId)).toEqual(["recent"]);
  });
});
