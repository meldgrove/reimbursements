// The worker's path from an accepted claim to Finance and the participant:
// test_pipeline_sends_finance_pdf_and_participant_confirmation of
// tests/test_documents.py, the confirmation tests of tests/test_improvements.py,
// test_accepted_jobs_are_not_overtaken_by_replenished_validation of
// tests/test_resource_limits.py, the PDF and email part of
// test_mileage_details_and_reference_reach_pdf_and_email of tests/test_feedback.py
// and test_operator_retry_and_delivery_evidence_do_not_deadlock of
// tests/test_concurrency.py.
import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { and, count, eq, ne, sql } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "@reimbursements/shared/i18n";
import { config } from "../config";
import { TEST_EMAIL } from "../test/helpers";
import { PAYMENT_TIMING } from "../constants";
import { getDb } from "../db/client";
import {
  claims,
  confirmations,
  deliveries,
  deliveryAttempts,
  deliveryEvents,
  expenses,
  jobs,
  operations as operationRows,
  uploads,
  type Job,
} from "../db/schema";
import { atomic, q } from "../db/tx";
import { pdfText } from "../documents/test-files";
import {
  accepted,
  claimRow,
  freshState,
  localSettings,
  parseEml,
  readOutbox,
  readyDelivery,
} from "../test/back-office";
import { mockProvider, timedOut } from "../test/mailersend";
import { CLAIM_STATES } from "./claim-status";
import * as confirmations_ from "./confirmations";
import { claimReference } from "./documents";
import * as evidence from "./evidence";
import { acquireJob, Lease, reclaimStaleJobs, runOne } from "./jobs";
import * as mailersend from "./mailersend";
import * as operations from "./operations";
import { purgeClaim } from "./retention";
import { outboxKey, pathFor } from "./storage";

beforeEach(freshState);
afterEach(() => vi.restoreAllMocks());

async function runAll() {
  while (await runOne()) {
    /* every job that is due */
  }
}

describe("the pipeline", () => {
  it("sends Finance the PDF and the participant a confirmation", async () => {
    const { claim } = await accepted();
    await runAll();
    const ready = await claimRow(claim.id);
    expect(ready.state, ready.errorCode).toBe(CLAIM_STATES.READY);
    const [delivery] = await getDb().select().from(deliveries).where(eq(deliveries.claimId, claim.id));
    expect(delivery!.state).toBe("delivered");
    expect(ready.retentionDue).not.toBeNull();
    expect(ready.pdfSize).toBeLessThanOrEqual(config().MAX_FINAL_PDF_BYTES);
    const outbox = pathFor("outbox");
    const files = readdirSync(outbox).filter((name) => name.endsWith(".eml"));
    expect(files).toHaveLength(2);
    const messages = files.map((name) => parseEml(readFileSync(`${outbox}/${name}`, "utf8")));
    const finance = messages.find((message) => message.headers.to === ready.snapshot.recipient)!;
    expect(finance.attachment).not.toBeNull();
    expect((await PDFDocument.load(finance.attachment!)).getPageCount()).toBe(2);
    expect(await getDb().select().from(jobs).where(eq(jobs.state, "pending"))).toHaveLength(0);
  }, 120_000);

  it("carries mileage details and the reference to the PDF and the email", async () => {
    const { claim } = await accepted();
    await getDb().insert(expenses).values({
      id: randomUUID(),
      claimId: claim.id,
      position: 1,
      kind: "mileage",
      purpose: "Anreise mit dem Auto",
      travelDate: "2026-10-21",
      routeFrom: "Berlin",
      routeTo: "Potsdam",
      distanceKm: 40,
      roundTrip: true,
      returnDate: "2026-10-22",
      vehicleRegistration: "B-AB 123",
      mileageRate: "0.30",
      amount: "24.00",
    });
    await runAll();
    const ready = await claimRow(claim.id);
    const text = (await pdfText(readFileSync(pathFor(ready.pdfKey)))).map((page) => page.text).join("");
    expect(text).toContain(claimReference(ready));
    expect(text).toContain("B-AB 123");
    expect(text).toContain("21.10.2026");
    const [delivery] = await getDb().select().from(deliveries).where(eq(deliveries.claimId, claim.id));
    expect(delivery!.state).toBe("delivered");
    const [attempt] = await getDb()
      .select()
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.deliveryId, delivery!.id));
    const mail = readOutbox(attempt!.id);
    expect(mail.headers.subject).toContain(claimReference(ready));
    expect(mail.filename).toBe(`reimbursement_${claimReference(ready).replaceAll("/", "_")}.pdf`);
  }, 120_000);

  it("does not let replenished validations overtake accepted jobs", async () => {
    const { claim } = await accepted();
    await getDb().delete(jobs);
    const due = new Date(Date.now() - 1000);
    const [render] = await getDb()
      .insert(jobs)
      .values({ key: "accepted-render", kind: "render", claimId: claim.id, runAfter: due })
      .returning();
    const [delivery] = await getDb()
      .insert(deliveries)
      .values({ claimId: claim.id, recipient: "finance@example.invalid" })
      .returning();
    const [send] = await getDb()
      .insert(jobs)
      .values({ key: "accepted-send", kind: "send", deliveryId: delivery!.id, runAfter: due })
      .returning();
    const [upload] = await getDb().select().from(uploads).where(eq(uploads.claimId, claim.id)).limit(1);
    for (const expected of [render!, send!]) {
      await getDb()
        .insert(jobs)
        .values(
          Array.from({ length: 10 }, () => ({ key: randomUUID(), kind: "validate", uploadId: upload!.id })),
        );
      const current = await acquireJob();
      expect(current!.id).toBe(expected.id);
      await atomic(() => new Lease(current!).finish());
    }
  });
});

/** Only the confirmation's job is due (receipt sending runs independently of PDF processing). */
async function confirmationJob(claimId: string): Promise<Job> {
  await getDb().update(jobs).set({ state: "done" }).where(ne(jobs.kind, "confirm"));
  const [job] = await getDb()
    .select()
    .from(jobs)
    .where(and(eq(jobs.kind, "confirm"), eq(jobs.claimId, claimId)));
  return job!;
}

async function confirmationOf(claimId: string) {
  const [row] = await getDb().select().from(confirmations).where(eq(confirmations.claimId, claimId));
  return row!;
}

describe("the participant's confirmation", () => {
  it("is sent once, with the reference and no sensitive attachments", async () => {
    const { claim } = await accepted();
    await confirmationJob(claim.id);
    expect(await runOne()).toBe(true);
    expect(await runOne()).toBe(false);
    const confirmation = await confirmationOf(claim.id);
    expect(confirmation.state).toBe("delivered");
    const message = readOutbox(confirmation.id);
    expect(message.headers.to).toBe(claim.email);
    expect(message.headers["reply-to"]).toBe(claim.snapshot.support_email);
    const reference = claimReference(claim);
    expect(message.headers.subject).toContain(reference);
    expect(message.text).toContain(reference);
    expect(message.text).toContain(String(claim.snapshot.name));
    expect(message.text).toContain(translate("de", PAYMENT_TIMING));
    expect(message.attachment).toBeNull();
    expect(message.text).not.toContain(claim.iban);
    await confirmations_.schedule(claim);
    expect(await runOne()).toBe(false);
    const current = await claimRow(claim.id);
    expect(current.state).toBe(CLAIM_STATES.RECEIVED);
    expect(await getDb().select().from(deliveries)).toHaveLength(0);
    const [confirms] = await getDb().select({ value: count() }).from(jobs).where(eq(jobs.kind, "confirm"));
    expect(Number(confirms!.value)).toBe(1);
  });

  it("goes through MailerSend with the restrictions of Finance email", async () => {
    const { claim } = await accepted();
    localSettings({ MAIL_DELIVERY_MODE: "mailersend" });
    await confirmationJob(claim.id);
    const calls: Array<Record<string, unknown>> = [];
    mockProvider(async (request) => {
      const payload = (await request.json()) as Record<string, unknown>;
      calls.push(payload);
      expect(payload.to).toEqual([{ email: claim.email }]);
      expect((payload.from as { email: string }).email).toBe(TEST_EMAIL.fromAddress);
      expect((payload.reply_to as { email: string }).email).toBe(claim.snapshot.support_email);
      expect(String(payload.text)).toContain(claimReference(claim));
      expect(payload).not.toHaveProperty("attachments");
      expect(Object.values(payload.settings as Record<string, boolean>).some(Boolean)).toBe(false);
      return new Response(null, { status: 202, headers: { "x-message-id": "receipt-1" } });
    });
    expect(await runOne()).toBe(true);
    expect(await runOne()).toBe(false);
    const confirmation = await confirmationOf(claim.id);
    expect([confirmation.state, confirmation.messageId]).toEqual(["provider_accepted", "receipt-1"]);
    expect(calls).toHaveLength(1);
  });

  it("retries throttling without duplicate emails", async () => {
    const { claim } = await accepted();
    localSettings({ MAIL_DELIVERY_MODE: "mailersend" });
    const job = await confirmationJob(claim.id);
    mockProvider(() => new Response(null, { status: 429, headers: { "retry-after": "120" } }));
    expect(await runOne()).toBe(true);
    const [waiting] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));
    expect(waiting!.state).toBe("pending");
    expect((await confirmationOf(claim.id)).state).toBe("pending");
    expect(waiting!.runAfter.getTime()).toBeGreaterThanOrEqual(Date.now() + 119_000);
    await getDb().update(jobs).set({ runAfter: new Date() }).where(eq(jobs.id, job.id));
    vi.restoreAllMocks();
    mockProvider(() => new Response(null, { status: 202, headers: { "x-message-id": "receipt-2" } }));
    expect(await runOne()).toBe(true);
    expect(await runOne()).toBe(false);
    expect((await confirmationOf(claim.id)).state).toBe("provider_accepted");
  });

  it("is not sent again when its outcome is unknown", async () => {
    const { claim } = await accepted();
    localSettings({ MAIL_DELIVERY_MODE: "mailersend" });
    await confirmationJob(claim.id);
    mockProvider(() => {
      throw timedOut();
    });
    expect(await runOne()).toBe(true);
    expect(await runOne()).toBe(false);
    expect((await confirmationOf(claim.id)).state).toBe("send_unknown");
  });

  it("is not sent again after an interruption", async () => {
    const { claim } = await accepted();
    const job = await confirmationJob(claim.id);
    await getDb()
      .update(jobs)
      .set({ state: "running", leaseUntil: new Date(Date.now() - 1000) })
      .where(eq(jobs.id, job.id));
    await getDb().update(confirmations).set({ state: "sending" }).where(eq(confirmations.claimId, claim.id));
    await reclaimStaleJobs();
    expect(await runOne()).toBe(false);
    expect((await confirmationOf(claim.id)).state).toBe("send_unknown");
  });

  it("respects the test recipient allowlist", async () => {
    const { claim } = await accepted();
    localSettings({ TEST_RECIPIENT_ALLOWLIST: ["finance@example.invalid"] });
    await confirmationJob(claim.id);
    expect(await runOne()).toBe(true);
    const confirmation = await confirmationOf(claim.id);
    expect(confirmation.errorCode).toBe("test_recipient_blocked");
    expect(existsSync(pathFor(outboxKey(confirmation.id)))).toBe(false);
  });

  it("goes with its local email when the content is purged", async () => {
    const { claim } = await accepted();
    await confirmationJob(claim.id);
    expect(await runOne()).toBe(true);
    const email = pathFor(outboxKey((await confirmationOf(claim.id)).id));
    expect(existsSync(email)).toBe(true);
    await purgeClaim(claim.id);
    expect(existsSync(email)).toBe(false);
    expect(await getDb().select().from(confirmations)).toHaveLength(0);
  });
});

/** Runs `fn` outside the transaction of the code calling it (another connection). */
const detached = AsyncResource.bind(<T>(fn: () => Promise<T>) => fn());

describe("concurrency", () => {
  it.each(["webhook", "reconciliation"])(
    "an operator retry and delivery evidence do not deadlock (%s)",
    async (source) => {
      const { delivery } = await readyDelivery();
      await getDb().update(deliveries).set({ state: "send_unknown" }).where(eq(deliveries.id, delivery.id));
      await getDb()
        .insert(deliveryAttempts)
        .values({ deliveryId: delivery.id, state: "send_unknown", messageId: "concurrent-message" });
      const event = {
        type: "activity.delivered",
        created_at: new Date().toISOString(),
        data: { id: "concurrent-event", recipient: delivery.recipient, message_id: "concurrent-message" },
      };
      if (source === "reconciliation") {
        await getDb()
          .insert(deliveryEvents)
          .values({
            providerId: "concurrent-event",
            kind: event.type,
            providerTimestamp: new Date(),
            recipientHash: evidence.recipientHash(delivery.recipient),
            messageId: "concurrent-message",
          });
      }
      let applied: Promise<void> | undefined;
      await atomic(async () => {
        await q().select().from(claims).where(eq(claims.id, delivery.claimId)).for("update");
        applied = detached(() =>
          source === "webhook"
            ? evidence.record(mailersend.webhookEvidence(event)!)
            : evidence.reconcileUnmatched(),
        );
        // The evidence waits for the operator's claim lock.
        const deadline = Date.now() + 5000;
        for (;;) {
          const [row] = (
            await detached(() =>
              getDb().execute(
                sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
              ),
            )
          ).rows as Array<{ waiting: number }>;
          if (row!.waiting > 0) break;
          expect(Date.now(), "Evidence did not reach its claim lock.").toBeLessThan(deadline);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await operations.retry(delivery.claimId, {
          actor: "admin@example.invalid",
          reason: "Concurrent delivery check",
          acknowledgeDuplicateRisk: true,
        });
      });
      await applied;
      const [current] = await getDb().select().from(deliveries).where(eq(deliveries.id, delivery.id));
      expect(current!.state).toBe("delivered");
      expect((await claimRow(delivery.claimId)).retentionDue).not.toBeNull();
      const [stored] = await getDb()
        .select()
        .from(deliveryEvents)
        .where(eq(deliveryEvents.providerId, "concurrent-event"));
      expect(stored!.applied).toBe(true);
      const retries = await getDb()
        .select()
        .from(operationRows)
        .where(and(eq(operationRows.claimId, delivery.claimId), eq(operationRows.action, "retry")));
      expect(retries).toHaveLength(1);
    },
  );
});
