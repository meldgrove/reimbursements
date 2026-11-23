// tests/test_claim_status.py of the Django version.
import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../db/client";
import { claims, deliveries, type Claim, type Form } from "../db/schema";
import { accepted, callCommand, freshState } from "../test/back-office";
import { createForm } from "../test/fixtures";
import * as claimStatus from "./claim-status";
import { CLAIM_STATES } from "./claim-status";

beforeEach(freshState);

// Claim state, delivery state (null: no delivery yet), shown status, participant outcome.
const CASES: Array<[string, string | null, string, string]> = [
  [CLAIM_STATES.RECEIVED, null, "received", "processing"],
  [CLAIM_STATES.RENDERING, null, "rendering", "processing"],
  [CLAIM_STATES.READY, null, "ready", "processing"],
  [CLAIM_STATES.FAILED, null, "processing_failed", "problem"],
  [CLAIM_STATES.READY, "pending", "pending", "processing"],
  [CLAIM_STATES.READY, "sending", "sending", "processing"],
  [CLAIM_STATES.READY, "provider_accepted", "provider_accepted", "processing"],
  [CLAIM_STATES.READY, "paused", "paused", "processing"],
  [CLAIM_STATES.READY, "send_unknown", "send_unknown", "processing"],
  [CLAIM_STATES.READY, "failed", "failed", "problem"],
  [CLAIM_STATES.READY, "delivered", "delivered", "delivered"],
  [CLAIM_STATES.PURGING, null, "purging", "processing"],
  [CLAIM_STATES.PURGING, "delivered", "purging", "processing"],
];

/** A claim with only what the model requires (Claim.objects.create(form, snapshot={}, state)). */
async function claimIn(form: Form, claimState: string, deliveryState: string | null): Promise<Claim> {
  const [claim] = await getDb()
    .insert(claims)
    .values({
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
      state: claimState,
    })
    .returning();
  if (deliveryState) {
    await getDb()
      .insert(deliveries)
      .values({ claimId: claim!.id, recipient: "finance@example.invalid", state: deliveryState });
  }
  return claim!;
}

async function loaded(id: string): Promise<Claim> {
  const [claim] = await getDb().select().from(claims).where(eq(claims.id, id));
  return claim!;
}

describe("claim status", () => {
  it.each(CASES)(
    "one rule decides what operators and participants see (%s, %s)",
    async (claimState, deliveryState, code, outcome) => {
      const form = await createForm();
      const claim = await claimIn(form, claimState, deliveryState);
      const [annotated] = await claimStatus.annotate();
      const status = await claimStatus.of(annotated!);
      expect([status.code, status.outcome, status.final]).toEqual([code, outcome, outcome !== "processing"]);
      expect(status.label).toBe(claimStatus.LABELS[code]);
      expect(await claimStatus.of(await loaded(claim.id))).toEqual(status);
      expect(status.deleted).toBe(claimState === CLAIM_STATES.PURGING);
    },
  );

  it("filtering by a status lists exactly the claims showing it", async () => {
    const form = await createForm();
    const shown = new Map<string, string>();
    for (const [claimState, deliveryState, code] of CASES) {
      shown.set((await claimIn(form, claimState, deliveryState)).id, code);
    }
    for (const [code] of claimStatus.CHOICES) {
      const listed = new Set((await claimStatus.annotate(claimStatus.listed(code))).map((claim) => claim.id));
      expect(listed, code).toEqual(
        new Set([...shown].filter(([, status]) => status === code).map(([id]) => id)),
      );
    }
    const choices = new Set(claimStatus.CHOICES.map(([code]) => code));
    for (const status of shown.values()) expect(choices.has(status)).toBe(true);
  });

  it("the claims list shows each claim under exactly one status option", async () => {
    const form = await createForm();
    const shown = new Map<string, string>();
    for (const [claimState, deliveryState, code] of CASES) {
      shown.set((await claimIn(form, claimState, deliveryState)).id, code);
    }
    const archived = new Set<string>();
    for (const [claimState, deliveryState] of CASES)
      archived.add((await claimIn(form, claimState, deliveryState)).id);
    await getDb()
      .update(claims)
      .set({ archivedAt: new Date() })
      .where(inArray(claims.id, [...archived]));
    const ids = async (option?: string) =>
      new Set((await claimStatus.annotate(claimStatus.listed(option))).map((claim) => claim.id));
    expect(await ids()).toEqual(new Set(shown.keys()));
    for (const [code] of claimStatus.FILTER_CHOICES) {
      if (code === claimStatus.ARCHIVED) {
        expect(await ids(code)).toEqual(archived);
      } else {
        expect(await ids(code), code).toEqual(
          new Set([...shown].filter(([, status]) => status === code).map(([id]) => id)),
        );
      }
    }
    // An unknown option filters nothing but still leaves the archived claims out.
    expect(await ids("unknown")).toEqual(new Set(shown.keys()));
  });

  it("archiving keeps the status participants see", async () => {
    const form = await createForm();
    const claim = await claimIn(form, CLAIM_STATES.READY, "delivered");
    const before = await claimStatus.of(claim);
    await getDb().update(claims).set({ archivedAt: new Date() }).where(eq(claims.id, claim.id));
    const [annotated] = await claimStatus.annotate();
    const after = await claimStatus.of(annotated!);
    expect([after.code, after.outcome, after.archived]).toEqual([before.code, "delivered", true]);
  });

  it("takes the error from the claim before its delivery", async () => {
    const form = await createForm();
    const claim = await claimIn(form, CLAIM_STATES.FAILED, null);
    await getDb().update(claims).set({ errorCode: "document_process_failed" }).where(eq(claims.id, claim.id));
    expect((await claimStatus.of(await loaded(claim.id))).errorCode).toBe("document_process_failed");
    await getDb()
      .update(claims)
      .set({ state: CLAIM_STATES.READY, errorCode: "" })
      .where(eq(claims.id, claim.id));
    await getDb().insert(deliveries).values({
      claimId: claim.id,
      recipient: "finance@example.invalid",
      state: "failed",
      errorCode: "hard_bounce",
    });
    expect((await claimStatus.of(await loaded(claim.id))).errorCode).toBe("hard_bounce");
  });

  it("unresolved claims are overdue until delivered or deleted", async () => {
    const { claim } = await accepted();
    const later = new Date(claim.resolutionDue.getTime() + 1000);
    const dayBefore = new Date(claim.resolutionDue.getTime() - 24 * 3600 * 1000);
    expect((await claimStatus.of(claim, { now: dayBefore })).overdue).toBe(false);
    expect((await claimStatus.of(claim, { now: later })).overdue).toBe(true);
    expect((await claimStatus.of({ ...claim, retentionDue: later }, { now: later })).overdue).toBe(false);
    expect((await claimStatus.of({ ...claim, state: CLAIM_STATES.PURGING }, { now: later })).overdue).toBe(
      false,
    );
    // Archived claims need no resolution; retention deletes them on that date.
    expect((await claimStatus.of({ ...claim, archivedAt: later }, { now: later })).overdue).toBe(false);
  });

  it("the claim-status command filters by the shown status", async () => {
    const form = await createForm();
    for (const [claimState, deliveryState] of CASES) await claimIn(form, claimState, deliveryState);
    const output = await callCommand("claim-status", ["--status", "purging"]);
    const rows = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .slice(0, -1);
    expect(rows.map((row) => row.status)).toEqual(["purging", "purging"]);
    expect(rows.map((row) => row.archived)).toEqual([false, false]);
  });
});
