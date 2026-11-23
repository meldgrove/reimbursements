import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { eq, isNotNull, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../db/client";
import {
  claims,
  deliveries,
  deliveryAttempts,
  drafts,
  formOwners,
  jobs,
  operations,
  uploads,
  type Claim,
  type Delivery,
  type Form,
  type User,
} from "../../db/schema";
import { FORM_EDITOR, TEMPLATE_ADMIN } from "../../auth/roles";
import * as claimStatus from "../../services/claim-status";
import { cleanup } from "../../services/retention";
import { pathFor } from "../../services/storage";
import { saveSettings } from "../../services/app-settings";
import { createClaim, createForm } from "../../test/fixtures";
import { createUser, request, resetDatabase, signInWithTestHeader } from "../../test/helpers";

/**
 * The claims of the admin area: the claim cases of tests/test_admin.py, the
 * admin parts of tests/test_claim_deletion.py, and the list's amounts of
 * tests/test_general_settings.py.
 */
let restore: () => void;
let admin: User;
let editor: User;
let form: Form;
let accepted: Claim;

const DAY = 24 * 3600 * 1000;

beforeAll(() => {
  restore = signInWithTestHeader();
});
afterAll(() => restore());

beforeEach(async () => {
  await resetDatabase();
  admin = await createUser("admin", [TEMPLATE_ADMIN]);
  editor = await createUser("editor", [FORM_EDITOR]);
  form = await createForm();
  accepted = await createClaim(form, { resolutionDue: new Date(Date.now() + 90 * DAY) });
  // As after a submission: the PDF is queued.
  await getDb()
    .insert(jobs)
    .values({ key: `render-${accepted.id}`, kind: "render", claimId: accepted.id });
});

/** Another claim of `form` (Django's second_claim). */
const secondClaim = (values: Partial<typeof claims.$inferInsert> = {}) =>
  createClaim(form, {
    fullName: "Sam Zweitens",
    email: "second@example.invalid",
    resolutionDue: new Date(Date.now() + 90 * DAY),
    ...values,
  });

/** The claim with a ready synthetic PDF and no queued jobs, and its delivery (Django's `delivery`). */
async function delivered(): Promise<Delivery> {
  await getDb().delete(jobs);
  const content = Buffer.from("%PDF-1.4 synthetic provider unit fixture");
  const file = pathFor("pdf/test.pdf");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  await getDb()
    .update(claims)
    .set({
      state: "ready",
      pdfKey: "pdf/test.pdf",
      pdfHash: createHash("sha256").update(content).digest("hex"),
      pdfSize: content.length,
    })
    .where(eq(claims.id, accepted.id));
  const [row] = await getDb()
    .insert(deliveries)
    .values({ claimId: accepted.id, recipient: "finance@example.invalid" })
    .returning();
  return row!;
}

const reload = async (claim: Claim) =>
  (await getDb().select().from(claims).where(eq(claims.id, claim.id)))[0];
const listed = async (user: User, query = "") =>
  (await request("GET", `/api/v1/admin/claims${query}`, { user })).body.rows.map(
    (row: { id: string }) => row.id,
  );

describe("seeing claims", () => {
  it("shows editors the claims of their forms only, without bank details", async () => {
    const other = await createForm({ slug: "other", name: "Andere Werkstatt", status: "draft" });
    await getDb().insert(formOwners).values({ formId: other.id, userId: editor.id });
    expect(await listed(editor)).toEqual([]);
    expect((await request("GET", `/api/v1/admin/claims/${accepted.id}`, { user: editor })).status).toBe(404);
    await getDb().insert(formOwners).values({ formId: form.id, userId: editor.id });
    const list = await request("GET", "/api/v1/admin/claims", { user: editor });
    expect(list.body.rows).toHaveLength(1);
    expect(list.body.rows[0]).toMatchObject({
      fullName: "Alex Beispiel",
      email: "participant@example.invalid",
    });
    expect(list.text).not.toContain("DE89");
    const detail = await request("GET", `/api/v1/admin/claims/${accepted.id}`, { user: editor });
    expect(detail.body).toMatchObject({ fullName: "Alex Beispiel", canOperate: false });
    expect(detail.text).not.toContain("DE89");
    expect((await request("GET", `/api/v1/admin/claims/${accepted.id}/retry`, { user: editor })).status).toBe(
      403,
    );
  });

  it("finds a claim by its full reference, not by a part of it", async () => {
    expect(await listed(admin, `?q=${accepted.id}`)).toEqual([accepted.id]);
    expect(await listed(admin, `?q=${accepted.id.slice(0, 8)}`)).toEqual([]);
    expect(await listed(admin, "?q=alex beispiel")).toEqual([accepted.id]);
  });

  it("shows amounts with a decimal comma until the US number format is chosen", async () => {
    await saveSettings({ language: "en" });
    const total = async () =>
      (await request("GET", "/api/v1/admin/claims", { user: admin })).body.rows[0].total;
    expect(await total()).toBe("12,50");
    await saveSettings({ language: "de", numberFormat: "us" });
    expect(await total()).toBe("12.50");
  });

  it("lists by the Status column what its filter shows", async () => {
    const states: [string, string | null][] = [
      ["rendering", null],
      ["ready", null],
      ["processing_failed", null],
      ["ready", "pending"],
      ["ready", "delivered"],
      ["ready", "failed"],
      ["ready", "send_unknown"],
      ["purging", null],
      ["purging", "delivered"],
    ];
    for (const [state, deliveryState] of states) {
      const claim = await secondClaim({ state });
      if (deliveryState)
        await getDb()
          .insert(deliveries)
          .values({ claimId: claim.id, recipient: "finance@example.invalid", state: deliveryState });
    }
    const all = await claimStatus.annotate();
    const columns = new Map<string, string>();
    for (const claim of all) columns.set(claim.id, (await claimStatus.of(claim)).code);
    const choices = claimStatus.CHOICES.map(([code]) => code);
    for (const code of columns.values()) expect(choices).toContain(code);
    const list = await request("GET", "/api/v1/admin/claims", { user: admin });
    expect(list.body.statuses.map((option: { label: string }) => option.label)).toContain("Archived");
    for (const state of choices) {
      const shown = new Set(await listed(admin, `?status=${state}`));
      const expected = new Set([...columns].filter(([, code]) => code === state).map(([id]) => id));
      expect(shown, state).toEqual(expected);
    }
  });

  it("narrows by the date of submission in the app timezone", async () => {
    await getDb()
      .update(claims)
      .set({ submittedAt: new Date("2026-03-31T22:30:00Z") })
      .where(eq(claims.id, accepted.id));
    const other = await secondClaim({ submittedAt: new Date("2025-06-01T10:00:00Z") });
    const list = await request("GET", "/api/v1/admin/claims", { user: admin });
    expect(list.body.dates.options.map((option: { value: string }) => option.value)).toEqual([
      "2025",
      "2026",
    ]);
    // 22:30 UTC on 31 March is already April in Berlin.
    const months = await request("GET", "/api/v1/admin/claims?year=2026", { user: admin });
    expect(months.body.dates.options).toEqual([{ value: "4", label: "April" }]);
    expect(await listed(admin, "?year=2026&month=4&day=1")).toEqual([accepted.id]);
    expect(await listed(admin, "?year=2025")).toEqual([other.id]);
  });

  it("filters by the forms of the claims one sees", async () => {
    const otherForm = await createForm({ slug: "other", name: "Andere Werkstatt" });
    const other = await createClaim(otherForm, { resolutionDue: new Date(Date.now() + 90 * DAY) });
    await createForm({ slug: "empty", name: "Ohne Anträge" });
    const list = await request("GET", "/api/v1/admin/claims", { user: admin });
    expect(list.body.forms.map((option: { label: string }) => option.label)).toEqual([
      "Andere Werkstatt",
      "Test Workshop",
    ]);
    expect(await listed(admin, `?form=${otherForm.id}`)).toEqual([other.id]);
  });
});

describe("processing claims again", () => {
  it("retries a failed PDF with an audited reason", async () => {
    await getDb()
      .update(claims)
      .set({ state: "processing_failed", errorCode: "timeout" })
      .where(eq(claims.id, accepted.id));
    await getDb().delete(jobs);
    const url = `/api/v1/admin/claims/${accepted.id}/retry`;
    const page = await request("GET", url, { user: admin });
    expect(page.body.plan).toEqual({ action: "render", duplicateRisk: false });
    expect((await request("POST", url, { user: admin, body: { reason: "" } })).status).toBe(422);
    const response = await request("POST", url, { user: admin, body: { reason: "Sandbox repariert" } });
    expect(response.status).toBe(200);
    expect(response.body.message).toBe("Processing has started again.");
    expect((await reload(accepted))!.state).toBe("received");
    const [operation] = await getDb().select().from(operations);
    expect([operation!.actor, operation!.reason]).toEqual(["admin@example.invalid", "Sandbox repariert"]);
  });

  it("asks for the acknowledgment of a duplicate before sending again", async () => {
    const delivery = await delivered();
    await getDb().insert(deliveryAttempts).values({ deliveryId: delivery.id, state: "delivered" });
    const url = `/api/v1/admin/claims/${accepted.id}/retry`;
    const page = await request("GET", url, { user: admin });
    expect(page.body.plan).toEqual({ action: "resend", duplicateRisk: true });
    const refused = await request("POST", url, {
      user: admin,
      body: { reason: "Das Postfach hat nichts erhalten" },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain("duplicate delivery");
    const response = await request("POST", url, {
      user: admin,
      body: { reason: "Das Postfach hat nichts erhalten", acknowledgeDuplicateRisk: true },
    });
    expect(response.status).toBe(200);
    const [row] = await getDb().select().from(deliveries).where(eq(deliveries.id, delivery.id));
    expect(row!.state).toBe("pending");
  });

  it("says what a retry would do before it runs", async () => {
    const delivery = await delivered();
    const url = `/api/v1/admin/claims/${accepted.id}/retry`;
    const page = await request("GET", url, { user: admin });
    expect(page.body).toMatchObject({ plan: { action: "resend", duplicateRisk: false }, refused: "" });
    await getDb()
      .insert(jobs)
      .values({ key: "send-running", kind: "send", deliveryId: delivery.id, state: "running" });
    const busy = await request("GET", url, { user: admin });
    expect(busy.body.plan).toBeNull();
    expect(busy.body.refused).toContain("already being processed");
  });
});

describe("deleting claims", () => {
  it("deletes a claim after confirmation, for good", async () => {
    const detail = await request("GET", `/api/v1/admin/claims/${accepted.id}`, { user: admin });
    expect(detail.body.canOperate).toBe(true);
    const preview = await request("GET", `/api/v1/admin/claims/deletion?ids=${accepted.id}`, { user: admin });
    expect(preview.status).toBe(200);
    expect(preview.body.rows).toHaveLength(1);
    expect(preview.body.rows[0]).toMatchObject({ fullName: "Alex Beispiel", sent: false });
    const url = "/api/v1/admin/claims/delete";
    expect(
      (await request("POST", url, { user: admin, body: { ids: [accepted.id], reason: "" } })).status,
    ).toBe(422);
    const kept = (await reload(accepted))!;
    expect(kept.state).toBe("received");
    expect(kept.iban).toBeTruthy();
    const response = await request("POST", url, {
      user: admin,
      body: { ids: [accepted.id], reason: "Testeinreichung" },
    });
    expect(response.status).toBe(200);
    expect(response.body.messages).toEqual([{ tone: "success", text: "The claim was deleted." }]);
    expect(await reload(accepted)).toBeUndefined();
    const [operation] = await getDb().select().from(operations);
    expect([operation!.claimId, operation!.action, operation!.actor, operation!.reason]).toEqual([
      null,
      "delete",
      "admin@example.invalid",
      "Testeinreichung",
    ]);
    expect(await listed(admin)).toEqual([]);
    expect((await request("GET", `/api/v1/admin/claims/${accepted.id}`, { user: admin })).status).toBe(404);
    expect(
      (await request("GET", `/api/v1/admin/claims/deletion?ids=${accepted.id}`, { user: admin })).status,
    ).toBe(404);
  });

  it("warns when Finance may already hold the PDF", async () => {
    const delivery = await delivered();
    await getDb().insert(deliveryAttempts).values({ deliveryId: delivery.id, state: "delivered" });
    const preview = await request("GET", `/api/v1/admin/claims/deletion?ids=${accepted.id}`, { user: admin });
    expect(preview.body.rows[0].sent).toBe(true);
  });

  it("refuses while the claim is processed", async () => {
    await getDb().update(jobs).set({ state: "running" }).where(eq(jobs.kind, "render"));
    const response = await request("POST", "/api/v1/admin/claims/delete", {
      user: admin,
      body: { ids: [accepted.id], reason: "Testeinreichung" },
    });
    expect(response.status).toBe(409);
    expect(response.body.messages[0].text).toContain("being processed or sent");
    expect((await reload(accepted))!.state).toBe("received");
    expect(await getDb().select().from(operations)).toEqual([]);
  });

  it("says that cleanup finishes an interrupted deletion", async () => {
    const [draft] = await getDb()
      .insert(drafts)
      .values({
        formId: form.id,
        sessionHash: "",
        tokenHash: "",
        revision: "0000000000000000",
        claimId: accepted.id,
      })
      .returning();
    const id = randomUUID();
    const key = `uploads/${id}/source.png`;
    fs.mkdirSync(path.dirname(pathFor(key)), { recursive: true });
    fs.writeFileSync(pathFor(key), "synthetic");
    await getDb()
      .insert(uploads)
      .values({
        id,
        draftId: draft!.id,
        claimId: accepted.id,
        originalName: "receipt.png",
        sourceKey: key,
        size: 9,
        checksum: "0".repeat(64),
        state: "ready",
      });
    const directory = path.dirname(pathFor(key));
    fs.chmodSync(directory, 0o500);
    let response;
    try {
      response = await request("POST", "/api/v1/admin/claims/delete", {
        user: admin,
        body: { ids: [accepted.id], reason: "Testeinreichung" },
      });
    } finally {
      fs.chmodSync(directory, 0o700);
    }
    expect(response.body.messages[0].text).toContain("finishes automatically within a few minutes");
    expect((await reload(accepted))!.state).toBe("purging");
    const [operation] = await getDb().select().from(operations);
    expect(operation!.action).toBe("delete");
  });

  it("confirms, then deletes the selected claims in bulk", async () => {
    const other = await secondClaim();
    const ids = [accepted.id, other.id];
    const preview = await request("GET", `/api/v1/admin/claims/deletion?ids=${ids.join(",")}`, {
      user: admin,
    });
    expect(preview.body.rows.map((row: { fullName: string }) => row.fullName).sort()).toEqual([
      "Alex Beispiel",
      "Sam Zweitens",
    ]);
    const url = "/api/v1/admin/claims/delete";
    expect((await request("POST", url, { user: admin, body: { ids, reason: "" } })).status).toBe(422);
    expect(await getDb().select().from(claims)).toHaveLength(2);
    const response = await request("POST", url, { user: admin, body: { ids, reason: "Tests" } });
    expect(response.body.messages).toEqual([{ tone: "success", text: "2 claims were deleted." }]);
    expect(await getDb().select().from(claims)).toEqual([]);
    expect(await getDb().select().from(operations).where(eq(operations.reason, "Tests"))).toHaveLength(2);
  });

  it("refuses more than 100 claims at once", async () => {
    const ids = [accepted.id];
    for (let index = 0; index < 100; index += 1) ids.push((await secondClaim()).id);
    const response = await request("POST", "/api/v1/admin/claims/delete", {
      user: admin,
      body: { ids, reason: "x" },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe("Please select at most 100 claims at once.");
  });

  it("lets editors delete nothing", async () => {
    await getDb().insert(formOwners).values({ formId: form.id, userId: editor.id });
    const detail = await request("GET", `/api/v1/admin/claims/${accepted.id}`, { user: editor });
    expect(detail.body.canOperate).toBe(false);
    const list = await request("GET", "/api/v1/admin/claims", { user: editor });
    expect(list.body.canOperate).toBe(false);
    expect(
      (await request("GET", `/api/v1/admin/claims/deletion?ids=${accepted.id}`, { user: editor })).status,
    ).toBe(403);
    const response = await request("POST", "/api/v1/admin/claims/delete", {
      user: editor,
      body: { ids: [accepted.id], reason: "Test" },
    });
    expect(response.status).toBe(403);
    expect((await reload(accepted))!.state).toBe("received");
    expect(await getDb().select().from(operations)).toEqual([]);
  });
});

describe("archiving claims", () => {
  it("leaves an archived claim out of the list until it is unarchived", async () => {
    const response = await request("POST", `/api/v1/admin/claims/${accepted.id}/archive`, {
      user: admin,
      body: {},
    });
    expect(response.body).toEqual({
      confirm: false,
      changed: 1,
      message: "The claim was archived. The claims list shows it under Status: Archived.",
    });
    const archived = (await reload(accepted))!;
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.state).toBe("received");
    const [operation] = await getDb().select().from(operations);
    expect([operation!.claimId, operation!.action, operation!.actor]).toEqual([
      accepted.id,
      "archive",
      "admin@example.invalid",
    ]);
    expect(await listed(admin)).toEqual([]);
    expect(await listed(admin, "?status=received")).toEqual([]);
    expect(await listed(admin, "?status=archived")).toEqual([accepted.id]);
    const row = (await request("GET", "/api/v1/admin/claims?status=archived", { user: admin })).body.rows[0];
    expect(row).toMatchObject({ archived: true, status: { label: "Received" } });
    const detail = await request("GET", `/api/v1/admin/claims/${accepted.id}`, { user: admin });
    const due = archived.resolutionDue;
    const date = (value: number) => String(value).padStart(2, "0");
    const berlin = new Date(due.toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
    expect(detail.body.contentDue).toContain(
      `${date(berlin.getDate())}.${date(berlin.getMonth() + 1)}.${berlin.getFullYear()}`,
    );
    expect(detail.text).not.toContain("+00:00");
    expect(detail.body.archived).toBe(true);

    const unarchived = await request("POST", `/api/v1/admin/claims/${accepted.id}/unarchive`, {
      user: admin,
      body: {},
    });
    expect(unarchived.body.message).toBe("The claim was unarchived.");
    expect((await reload(accepted))!.archivedAt).toBeNull();
    expect(await getDb().select().from(operations).where(eq(operations.action, "unarchive"))).toHaveLength(1);
    expect(await listed(admin)).toEqual([accepted.id]);
  });

  it("archives and unarchives in bulk", async () => {
    const other = await secondClaim();
    const archived = await request("POST", "/api/v1/admin/claims/archive", {
      user: admin,
      body: { ids: [accepted.id, other.id] },
    });
    expect(archived.body).toMatchObject({ confirm: false, message: "2 claims were archived." });
    expect(await getDb().select().from(claims).where(isNotNull(claims.archivedAt))).toHaveLength(2);
    expect(await listed(admin)).toEqual([]);
    const unarchived = await request("POST", "/api/v1/admin/claims/unarchive", {
      user: admin,
      body: { ids: [other.id] },
    });
    expect(unarchived.body.message).toBe("1 claim was unarchived.");
    const visible = await getDb().select().from(claims).where(isNull(claims.archivedAt));
    expect(visible.map((claim) => claim.id)).toEqual([other.id]);
    // An archived claim can still be deleted for good.
    const deleted = await request("POST", "/api/v1/admin/claims/delete", {
      user: admin,
      body: { ids: [accepted.id], reason: "Testeinreichung" },
    });
    expect(deleted.status).toBe(200);
    expect(await reload(accepted)).toBeUndefined();
  });

  it("asks first before archiving an overdue claim, as it is then deleted", async () => {
    const overdue = await secondClaim();
    await getDb()
      .update(claims)
      .set({ resolutionDue: new Date(overdue.submittedAt.getTime() - 1000) })
      .where(eq(claims.id, overdue.id));
    const url = `/api/v1/admin/claims/${overdue.id}/archive`;
    const asked = await request("POST", url, { user: admin, body: {} });
    expect(asked.body).toMatchObject({ confirm: true, selected: 1, retentionDays: 90 });
    expect(asked.body.overdue.map((row: { fullName: string }) => row.fullName)).toEqual(["Sam Zweitens"]);
    expect((await reload(overdue))!.archivedAt).toBeNull();
    expect(await getDb().select().from(operations)).toEqual([]);
    const confirmed = await request("POST", url, { user: admin, body: { confirm: true } });
    expect(confirmed.body.confirm).toBe(false);
    expect((await reload(overdue))!.archivedAt).not.toBeNull();
    await cleanup({ execute: true });
    expect(await reload(overdue)).toBeUndefined();

    // In bulk, only the overdue claims are listed for confirmation.
    const other = await secondClaim();
    await getDb().update(claims).set({ resolutionDue: other.submittedAt }).where(eq(claims.id, other.id));
    const ids = [accepted.id, other.id];
    const bulk = await request("POST", "/api/v1/admin/claims/archive", { user: admin, body: { ids } });
    expect(bulk.body).toMatchObject({ confirm: true, selected: 2 });
    expect(bulk.body.overdue.map((row: { fullName: string }) => row.fullName)).toEqual(["Sam Zweitens"]);
    expect(await getDb().select().from(claims).where(isNotNull(claims.archivedAt))).toEqual([]);
    const done = await request("POST", "/api/v1/admin/claims/archive", {
      user: admin,
      body: { ids, confirm: true },
    });
    expect(done.body.message).toBe("2 claims were archived.");
    expect(await getDb().select().from(claims).where(isNotNull(claims.archivedAt))).toHaveLength(2);
  });

  it("shows editors archived claims, but they cannot archive", async () => {
    await getDb().insert(formOwners).values({ formId: form.id, userId: editor.id });
    expect(
      (await request("POST", `/api/v1/admin/claims/${accepted.id}/archive`, { user: editor, body: {} }))
        .status,
    ).toBe(403);
    expect(
      (await request("POST", "/api/v1/admin/claims/archive", { user: editor, body: { ids: [accepted.id] } }))
        .status,
    ).toBe(403);
    expect((await reload(accepted))!.archivedAt).toBeNull();
    await getDb().update(claims).set({ archivedAt: accepted.submittedAt }).where(eq(claims.id, accepted.id));
    expect(await listed(editor, "?status=archived")).toEqual([accepted.id]);
  });

  it("says a claim being deleted is gone", async () => {
    await getDb().update(claims).set({ state: "purging" }).where(eq(claims.id, accepted.id));
    const detail = await request("GET", `/api/v1/admin/claims/${accepted.id}`, { user: admin });
    expect(detail.body.canOperate).toBe(false);
    const response = await request("POST", `/api/v1/admin/claims/${accepted.id}/archive`, {
      user: admin,
      body: {},
    });
    expect(response.body.message).toBe("This claim has already been deleted.");
  });
});
