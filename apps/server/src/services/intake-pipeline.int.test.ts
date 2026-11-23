/**
 * A submitted claim on its way through the worker (the intake cases of
 * tests/test_feedback.py that reach the PDF and email): its mileage details
 * and reference reach the PDF and the Finance email, and the claim-status
 * command finds it.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../db/client";
import { claims, deliveries, deliveryAttempts, expenses } from "../db/schema";
import { callCommand, readOutbox } from "../test/back-office";
import { freshIntake, mileageRow, post, prepared } from "../test/intake";
import { claimSummary } from "./documents";
import { runOne } from "./jobs";

describe("a submitted claim", () => {
  beforeEach(async () => {
    await freshIntake();
  });

  it("brings its mileage details and reference to the PDF and the email", async () => {
    const current = await prepared();
    current.data.expenses.push(mileageRow());
    expect((await post(current)).status).toBe(202);
    const [claim] = await getDb().select().from(claims);
    const rows = await getDb().select().from(expenses).where(eq(expenses.claimId, claim!.id));
    const summary = JSON.stringify(claimSummary(claim!, rows));
    expect(summary).toContain("B-AB 123");
    expect(summary).toContain("21.10.2026");
    expect(summary).toContain(claim!.bookkeepingReference!);
    while (await runOne());
    const [delivery] = await getDb().select().from(deliveries).where(eq(deliveries.claimId, claim!.id));
    expect(delivery!.state).toBe("delivered");
    const [attempt] = await getDb()
      .select()
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.deliveryId, delivery!.id));
    const message = readOutbox(attempt!.id);
    expect(message.headers.subject).toContain(claim!.bookkeepingReference!);
    expect(message.filename).toBe(`reimbursement_${claim!.bookkeepingReference!.replaceAll("/", "_")}.pdf`);
    expect(message.attachment!.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("is found by the claim-status command by its reference", async () => {
    const current = await prepared();
    expect((await post(current)).status).toBe(202);
    const [claim] = await getDb().select().from(claims);
    const output = await callCommand("claim-status", [claim!.bookkeepingReference!]);
    expect(output).toContain(claim!.bookkeepingReference!);
  });
});
