/** The Draft gate and opening drafts (tests/test_drafts.py). */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../db/client";
import { drafts as draftsTable, forms, privacyNotices, type Draft, type Form } from "../db/schema";
import { atomic } from "../db/tx";
import { IntakeError } from "../intake";
import { loadForm } from "../models";
import { createForm } from "../test/fixtures";
import { TestParticipant, freshIntake, intakeSettings, post, prepared } from "../test/intake";
import * as drafts from "./drafts";
import { READ, REMOVE, REVIEW, SUBMIT, UPLOAD, type Action } from "./drafts";
import * as terms from "./terms";

// Actions on unsubmitted drafts only, and actions that need an accepting form.
const EDITS: Array<[string, Action]> = [
  ["REVIEW", REVIEW],
  ["REMOVE", REMOVE],
  ["UPLOAD", UPLOAD],
  ["SUBMIT", SUBMIT],
];
const ACCEPTS: Array<[string, Action]> = [
  ["REVIEW", REVIEW],
  ["UPLOAD", UPLOAD],
  ["SUBMIT", SUBMIT],
];
const ALL: Array<[string, Action]> = [["READ", READ], ...EDITS];

type Opened = { participant: TestParticipant; draft: Draft; token: string };

async function full(form: Form) {
  return (await loadForm({ id: form.id }))!;
}

async function open(form: Form): Promise<Opened> {
  const participant = new TestParticipant();
  const { draft, token } = await drafts.openDraft(participant, await full(form));
  return { participant, draft, token };
}

function gate(
  opened: Opened,
  action: Action,
  changes: { participant?: TestParticipant; token?: string } = {},
) {
  return atomic(() =>
    drafts.gate(
      changes.participant ?? opened.participant,
      "test",
      opened.draft.id,
      changes.token ?? opened.token,
      action,
    ),
  );
}

async function refused(
  opened: Opened,
  action: Action,
  status: number,
  changes: { participant?: TestParticipant; token?: string } = {},
): Promise<IntakeError> {
  try {
    await gate(opened, action, changes);
  } catch (error) {
    if (!(error instanceof IntakeError)) throw error;
    expect(error.status).toBe(status);
    return error;
  }
  throw new Error("The gate let the action pass");
}

describe("drafts", () => {
  let form: Form;
  beforeEach(async () => {
    await freshIntake();
    form = await createForm();
  });

  it("opening starts a session only for an admitted draft", async () => {
    intakeSettings({ MAX_ACTIVE_DRAFTS: 0 });
    const participant = new TestParticipant();
    await expect(drafts.openDraft(participant, await full(form))).rejects.toBeInstanceOf(IntakeError);
    expect(participant.session).toBeNull();
    intakeSettings({ MAX_ACTIVE_DRAFTS: 10 });
    const { draft, token } = await drafts.openDraft(participant, await full(form));
    expect(draft.sessionHash).toBe(participant.session);
    expect(draft.revision).toBe((await terms.of(await full(form))).revision);
    expect(await participant.remembered("test")).toEqual({ id: draft.id, token });
  });

  it("opening again reuses the draft until its revision changes", async () => {
    const opened = await open(form);
    const again = await drafts.openDraft(opened.participant, await full(form));
    expect([again.draft.id, again.token]).toEqual([opened.draft.id, opened.token]);
    await getDb().insert(privacyNotices).values({ version: 2, text: "Neue Fassung." });
    const renewed = await drafts.openDraft(opened.participant, await full(form));
    expect(renewed.draft.id).not.toBe(opened.draft.id);
    expect(await getDb().$count(draftsTable)).toBe(2);
  });

  it("opening refuses a form that cannot accept claims", async () => {
    intakeSettings({ APPROVED_DELIVERY_RECIPIENTS: ["other@example.invalid"] });
    const error = await drafts
      .openDraft(new TestParticipant(), await full(form))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IntakeError);
    expect((error as IntakeError).status).toBe(503);
    expect(await getDb().$count(draftsTable)).toBe(0);
  });

  it.each(ALL)("every action needs the session and the token: %s", async (_name, action) => {
    const opened = await open(form);
    await refused(opened, action, 404, { participant: new TestParticipant(undefined, "other") });
    await refused(opened, action, 404, { token: "wrong" });
    const passed = await gate(opened, action);
    expect(passed.draft.id).toBe(opened.draft.id);
    expect(passed.form.id).toBe(form.id);
  });

  it.each(ALL)("an expired draft is gone for every action: %s", async (_name, action) => {
    const opened = await open(form);
    await getDb()
      .update(draftsTable)
      .set({ expiresAt: new Date() })
      .where(eq(draftsTable.id, opened.draft.id));
    await refused(opened, action, 410);
  });

  it.each(EDITS)("a submitted draft accepts no edits but can be read: %s", async (_name, action) => {
    const current = await prepared(form);
    expect((await post(current)).status).toBe(202);
    const [draft] = await getDb().select().from(draftsTable);
    await getDb()
      .update(draftsTable)
      .set({ expiresAt: new Date(Date.now() - 24 * 3600 * 1000), tokenHash: drafts.digest("unused") })
      .where(eq(draftsTable.id, draft!.id));
    const opened = {
      participant: new TestParticipant(undefined, draft!.sessionHash),
      draft: draft!,
      token: "unused",
    };
    const error = await refused(opened, action, 409);
    expect(error).toBeInstanceOf(drafts.AlreadySubmitted);
    expect((error as drafts.AlreadySubmitted).draft.id).toBe(draft!.id);
    expect((await gate(opened, READ)).draft.id).toBe(draft!.id);
  });

  it.each(ACCEPTS)("accepting actions need an open form: %s", async (_name, action) => {
    const opened = await open(form);
    await getDb().update(forms).set({ status: "draft" }).where(eq(forms.id, form.id));
    expect((await refused(opened, action, 409)).message).toContain("geschlossen");
    await gate(opened, REMOVE);
  });

  it.each(ACCEPTS)("accepting actions need an approved recipient: %s", async (_name, action) => {
    const opened = await open(form);
    intakeSettings({ APPROVED_DELIVERY_RECIPIENTS: ["other@example.invalid"] });
    await refused(opened, action, 503);
    await gate(opened, REMOVE);
  });

  it.each(ACCEPTS)("accepting actions need the draft's revision: %s", async (_name, action) => {
    const opened = await open(form);
    await getDb().update(forms).set({ purposeOptions: "Neu" }).where(eq(forms.id, form.id));
    expect((await refused(opened, action, 409)).message).toContain("aktualisiert");
    await gate(opened, REMOVE);
  });
});
