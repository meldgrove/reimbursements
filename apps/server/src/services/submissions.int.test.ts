/**
 * Acceptance of a participant's claim (tests/test_submission.py, the
 * participant parts of tests/test_forms.py and tests/test_feedback.py).
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../db/client";
import {
  claimReferenceCounters,
  claims,
  drafts,
  expenses,
  formTemplates,
  forms,
  jobs,
  privacyNotices,
  templateFields,
  uploads,
} from "../db/schema";
import { loadForm } from "../models";
import { CookieJar, request } from "../test/helpers";
import {
  errorMessage,
  fieldErrors,
  freshIntake,
  mileageRow,
  openForm,
  post,
  prepared,
  type Prepared,
} from "../test/intake";
import { normalizeUuid } from "./claim-validation";
import { allocateReference } from "./references";
import * as terms from "./terms";

async function claimCount() {
  return getDb().$count(claims);
}

async function onlyClaim() {
  const rows = await getDb().select().from(claims);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** The participant reloads after a configuration change and works on the new revision. */
async function reopened(current: Prepared) {
  const form = (await loadForm({ id: current.form.id }))!;
  const revision = (await terms.of(form)).revision;
  await getDb().update(drafts).set({ revision }).where(eq(drafts.id, current.draft.id));
  current.data.revision = revision;
}

async function rejected(current: Prepared, field: string) {
  const response = await post(current);
  expect(response.status, response.text).toBe(400);
  expect(Object.keys(fieldErrors(response))).toContain(field);
  expect(await claimCount()).toBe(0);
}

describe("submission", () => {
  let current: Prepared;
  beforeEach(async () => {
    await freshIntake();
    current = await prepared();
  });

  it("acceptance snapshots the form and uses exact decimal totals", async () => {
    current.data.total = "999999";
    expect((await post(current)).status).toBe(202);
    const claim = await onlyClaim();
    expect(claim.total).toBe("12.50");
    expect(claim.iban).toBe("DE89370400440532013000");
    expect(claim.accountHolder).toBe("Alex Beispiel");
    expect([claim.street, claim.postalCode, claim.city, claim.country]).toEqual([
      "Teststraße 1",
      "12345",
      "Berlin",
      "DE",
    ]);
    expect(claim.snapshot.internal_values).toEqual([
      ["Kostenstelle (KST)", "TEST-KST"],
      ["Kostenträger (KTR)", "TEST-KTR"],
    ]);
    expect(claim.snapshot.privacy_version).not.toBeNull();
    expect(claim.snapshot.declaration_version).toBe("reimbursement-v1");
    const [row] = await getDb().select().from(expenses).where(eq(expenses.claimId, claim.id));
    expect(row!.merchant).toBe("Belegverkauf");
    expect(await getDb().$count(uploads, eq(uploads.claimId, claim.id))).toBe(2);
    expect(await getDb().$count(jobs, and(eq(jobs.kind, "render"), eq(jobs.claimId, claim.id)))).toBe(1);
  });

  it("a repeated post returns one claim even after the form closes", async () => {
    const first = await post(current);
    await getDb()
      .update(forms)
      .set({ status: "draft", purposeOptions: "Neue Vorgabe" })
      .where(eq(forms.id, current.form.id));
    const second = await post(current);
    expect(second.body).toEqual(first.body);
    expect(await claimCount()).toBe(1);
    const changed = structuredClone(current.data);
    changed.full_name = "Changed name";
    expect((await post(current, changed)).status).toBe(409);
    expect((await onlyClaim()).fullName).toBe("Alex Beispiel");
  });

  it.each([
    ["iban", "DE89370400440532013001"],
    ["full_name", " "],
    ["purpose", ""],
    ["declaration", false],
    ["privacy_acknowledged", false],
    ["trip_end", "2026-10-19"],
  ])("an invalid claim never creates records: %s", async (field, value) => {
    current.data[field] = value;
    expect((await post(current)).status).toBe(400);
    expect(await claimCount()).toBe(0);
  });

  it.each([12.5, "1.234", "1,234.56", "NaN", "-1", "0", "1e3"])(
    "ambiguous or inexact amounts are rejected: %s",
    async (amount) => {
      current.data.expenses[0].amount = amount;
      expect((await post(current)).status).toBe(400);
    },
  );

  it("cross-session files, receipt and form token are private", async () => {
    const other = new CookieJar();
    expect((await post({ ...current, jar: other })).status).toBe(404);
    const uploadId = current.data.expenses[0].uploads[0];
    const status = await request("GET", `/api/v1/public/forms/test/uploads/${uploadId}`, {
      jar: other,
      headers: { "x-draft-token": current.data.token },
    });
    expect(status.status).toBe(404);
    const response = await post(current);
    const receipt = `/api/v1/public/received/${response.body.claimId}`;
    expect((await request("GET", receipt, { jar: other })).status).toBe(404);
    expect((await request("GET", receipt, { jar: current.jar })).status).toBe(200);
  });

  it("a stale configuration requires review again", async () => {
    await getDb().update(forms).set({ purposeOptions: "Neue Vorgabe" }).where(eq(forms.id, current.form.id));
    expect((await post(current)).status).toBe(409);
    expect(await claimCount()).toBe(0);
  });

  it("a closed form rejects a new submission", async () => {
    await getDb()
      .update(forms)
      .set({ closesAt: new Date(Date.now() - 1000) })
      .where(eq(forms.id, current.form.id));
    expect((await post(current)).status).toBe(409);
  });

  it("a receipt cannot move to another expense by forging its UUID", async () => {
    current.data.expenses[0].id = crypto.randomUUID();
    expect((await post(current)).status).toBe(400);
    expect(await claimCount()).toBe(0);
    expect(await getDb().$count(jobs, eq(jobs.kind, "render"))).toBe(0);
  });

  it("pending, missing or oversized receipts block acceptance", async () => {
    await getDb().update(uploads).set({ state: "pending" }).where(eq(uploads.kind, "receipt"));
    expect((await post(current)).status).toBe(400);
    await getDb().update(uploads).set({ state: "ready", pages: 101 }).where(eq(uploads.kind, "receipt"));
    const response = await post(current);
    expect(response.status).toBe(413);
    expect(errorMessage(response)).toContain("Seiten");
  });

  it("there are no anonymous attachment or staff routes", async () => {
    for (const path of ["/staff/", "/accounts/login/", "/media/receipt.png", "/api/v1/public/claims"]) {
      expect((await request("GET", path)).status).toBe(404);
    }
  });

  it("a bad draft UUID is a client error", async () => {
    current.data.draft_id = "invalid";
    expect((await post(current)).status).toBe(404);
  });

  it("a cross-site request is refused", async () => {
    const response = await request("POST", "/api/v1/public/forms/test/submit", {
      jar: current.jar,
      body: current.data,
      headers: { origin: "https://elsewhere.example.invalid" },
    });
    expect(response.status).toBe(403);
    expect(await claimCount()).toBe(0);
  });

  it("a signature listed as a receipt is refused with its reason", async () => {
    current.data.expenses[0].uploads.push(current.data.signature);
    const response = await post(current);
    expect(response.status).toBe(400);
    expect(errorMessage(response)).toBe("Ein Beleg gehört nicht zu dieser Auslagenposition.");
    expect(await claimCount()).toBe(0);
  });

  it("an oversized request is refused with the intake message", async () => {
    const response = await request("POST", "/api/v1/public/forms/test/submit", {
      jar: current.jar,
      body: JSON.stringify({ padding: "x".repeat(200_000) }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(413);
    expect(errorMessage(response)).toBe("Die Datei oder Anfrage ist zu groß.");
  });
});

describe("participant fields", () => {
  let current: Prepared;
  beforeEach(async () => {
    await freshIntake();
    current = await prepared();
  });

  it.each([
    ["full_name", "Alex Beispiel 2"],
    ["account_holder", "<script>"],
    ["postal_code", "1234"],
    ["country", "XX"],
    ["street", ""],
    ["bic", "NOTABIC"],
  ])("participant fields are validated: %s", async (field, value) => {
    current.data[field] = value;
    await rejected(current, field);
  });

  it("names in any script and joint accounts are accepted", async () => {
    current.data.full_name = "Zoë O’Neil-Łukasiewicz";
    current.data.account_holder = "Zoë O’Neil & Jan Nowak";
    current.data.country = "GB";
    current.data.postal_code = "SW1A 1AA";
    expect((await post(current)).status).toBe(202);
    const claim = await onlyClaim();
    expect(claim.accountHolder).toBe("Zoë O’Neil & Jan Nowak");
    expect(claim.country).toBe("GB");
  });

  it("an IBAN outside SEPA requires a BIC", async () => {
    current.data.iban = "BR1800360305000010009795493C1";
    await rejected(current, "bic");
    current.data.bic = "BOFA US 3N";
    expect((await post(current)).status).toBe(202);
    expect((await onlyClaim()).bic).toBe("BOFAUS3N");
  });

  it("a foreign SEPA IBAN needs no BIC", async () => {
    current.data.iban = "CH93 0076 2011 6238 5295 7";
    expect((await post(current)).status).toBe(202);
  });

  it("the reference is optional and amounts are euros", async () => {
    const row = current.data.expenses[0];
    row.receipt_reference = "";
    row.currency = "USD";
    expect((await post(current)).status).toBe(202);
    const claim = await onlyClaim();
    const [expense] = await getDb().select().from(expenses).where(eq(expenses.claimId, claim.id));
    expect(expense!.receiptReference).toBe("");
    expect(claim.total).toBe("12.50");
  });

  it("purpose options restrict the choice and keep the details", async () => {
    await getDb()
      .update(forms)
      .set({ purposeOptions: "Teilnahme an der Werkstatt\nMitwirkung als Referent:in" })
      .where(eq(forms.id, current.form.id));
    await reopened(current);
    await rejected(current, "purpose");
    current.data.purpose = "Mitwirkung als Referent:in";
    current.data.purpose_details = "Workshop zu Engagement";
    expect((await post(current)).status).toBe(202);
    const claim = await onlyClaim();
    expect([claim.purpose, claim.purposeDetails]).toEqual([
      "Mitwirkung als Referent:in",
      "Workshop zu Engagement",
    ]);
  });

  it("optional travel details are dropped when it is not a trip", async () => {
    Object.assign(current.data, { is_trip: false, trip_destination: "Ignored", trip_end: "" });
    expect((await post(current)).status).toBe(202);
    const claim = await onlyClaim();
    expect(claim.tripDestination).toBe("");
    expect(claim.tripStart).toBeNull();
  });

  it.each(["trip_destination", "trip_start"])(
    "a trip needs its destination and dates: %s",
    async (missing) => {
      current.data[missing] = "";
      expect((await post(current)).status).toBe(400);
      expect(await claimCount()).toBe(0);
    },
  );

  it("required travel ignores the participant's choice", async () => {
    await getDb()
      .update(formTemplates)
      .set({ travel: "required" })
      .where(eq(formTemplates.id, current.form.templateId));
    await reopened(current);
    Object.assign(current.data, { is_trip: false, trip_destination: "" });
    await rejected(current, "trip_destination");
  });

  it("mileage is calculated on the server without receipts", async () => {
    current.data.expenses.push(mileageRow({ amount: "9999" }));
    expect((await post(current)).status).toBe(202);
    const claim = await onlyClaim();
    const [mileage] = await getDb()
      .select()
      .from(expenses)
      .where(and(eq(expenses.claimId, claim.id), eq(expenses.kind, "mileage")));
    expect([
      mileage!.distanceKm! * (mileage!.roundTrip ? 2 : 1),
      mileage!.mileageRate,
      mileage!.amount,
    ]).toEqual([578, "0.30", "173.40"]);
    expect(claim.total).toBe("185.90");
    expect(claim.snapshot.mileage_rate).toBe("0.30");
  });

  it("mileage uses its own travel details without duplicate claim fields", async () => {
    current.data.expenses.push(mileageRow());
    Object.assign(current.data, { is_trip: false, trip_destination: "", trip_start: "", trip_end: "" });
    expect((await post(current)).status).toBe(202);
    const claim = await onlyClaim();
    expect(claim.tripDestination).toBe("");
    expect(claim.tripStart).toBeNull();
    const [mileage] = await getDb()
      .select()
      .from(expenses)
      .where(and(eq(expenses.claimId, claim.id), eq(expenses.kind, "mileage")));
    expect(mileage!.returnDate).toBe("2026-10-21");
  });

  it.each([
    { distance_km: "0" },
    { distance_km: "12.5" },
    { travel_date: "" },
    { route_to: "" },
    { return_date: "" },
    { return_date: "2026-10-19" },
    { return_date: "2026-99-99" },
    { vehicle_registration: "" },
    { vehicle_registration: "X".repeat(21) },
    { vehicle_registration: "ß".repeat(20) },
  ])("invalid mileage rows are rejected: %o", async (changes) => {
    current.data.expenses.push(mileageRow(changes));
    expect((await post(current)).status).toBe(400);
    expect(await claimCount()).toBe(0);
  });

  it("mileage needs a template that allows it", async () => {
    await getDb()
      .update(formTemplates)
      .set({ mileageEnabled: false })
      .where(eq(formTemplates.id, current.form.templateId));
    await reopened(current);
    current.data.expenses.push(mileageRow());
    expect((await post(current)).status).toBe(400);
  });

  it("edits that change nothing a participant agreed to keep drafts open", async () => {
    await getDb()
      .update(forms)
      .set({
        instructions: "Neu",
        name: "Umbenannt",
        supportEmail: "neu@example.invalid",
        fieldValues: { kst: "4321", ktr: "TEST-KTR" },
      })
      .where(eq(forms.id, current.form.id));
    await getDb()
      .update(formTemplates)
      .set({ intro: "Neue Hinweise", description: "Intern" })
      .where(eq(formTemplates.id, current.form.templateId));
    await getDb()
      .insert(templateFields)
      .values({ templateId: current.form.templateId, key: "id", label: "ID", required: false });
    expect((await post(current)).status).toBe(202);
    expect((await onlyClaim()).snapshot.internal_values).toContainEqual(["Kostenstelle (KST)", "4321"]);
  });

  it.each([
    ["declaration", { declaration: "Neue Erklärung." }],
    ["declaration version", { declarationVersion: "2" }],
    ["travel", { travel: "required" }],
    ["mileage rate", { mileageRate: "0.35" }],
    ["mileage", { mileageEnabled: false }],
  ])("a change a participant agreed to makes open drafts reload: %s", async (_name, change) => {
    await getDb().update(formTemplates).set(change).where(eq(formTemplates.id, current.form.templateId));
    const response = await post(current);
    expect(response.status).toBe(409);
    expect(errorMessage(response)).toContain("aktualisiert");
    expect(await claimCount()).toBe(0);
  });

  it("a change of the purposes makes open drafts reload", async () => {
    await getDb().update(forms).set({ purposeOptions: "Teilnahme" }).where(eq(forms.id, current.form.id));
    expect((await post(current)).status).toBe(409);
  });

  it("a new privacy notice makes open drafts reload", async () => {
    await getDb().insert(privacyNotices).values({ version: 2, text: "Neue Fassung." });
    expect((await post(current)).status).toBe(409);
  });

  it("the form closes when its template gains a required value", async () => {
    await getDb()
      .insert(templateFields)
      .values({ templateId: current.form.templateId, key: "id", label: "ID", position: 5 });
    const { internalValueErrors, isOpen, internalValues } = await import("../models");
    let form = (await loadForm({ id: current.form.id }))!;
    expect(internalValueErrors(form)).toEqual(["ID"]);
    expect(isOpen(form)).toBe(false);
    expect((await post(current)).status).toBe(409);
    expect((await openForm(current.jar)).status).toBe(403);
    await getDb()
      .update(forms)
      .set({ fieldValues: { kst: "TEST-KST", ktr: "TEST-KTR", id: "WS-1" } })
      .where(eq(forms.id, current.form.id));
    form = (await loadForm({ id: current.form.id }))!;
    expect(isOpen(form)).toBe(true);
    expect(internalValues(form)).toContainEqual(["ID", "WS-1"]);
  });
});

describe("purposes and references", () => {
  let current: Prepared;
  beforeEach(async () => {
    await freshIntake();
    current = await prepared();
  });

  it.each([
    "Teilnahme an der Werkstatt",
    "\r\n Teilnahme an der Werkstatt \r\n\r\n",
    "Teilnahme an der Werkstatt\nTeilnahme an der Werkstatt",
    " Teilnahme an der Werkstatt \r\n\r\nTeilnahme an der Werkstatt\t",
  ])("a fixed purpose is text and cannot be overridden: %j", async (purposeOptions) => {
    await getDb().update(forms).set({ purposeOptions }).where(eq(forms.id, current.form.id));
    await reopened(current);
    const page = await openForm(current.jar);
    expect(page.body.terms.fixedPurpose).toBe("Teilnahme an der Werkstatt");
    expect(page.body.terms.purposeOptions).toEqual(["Teilnahme an der Werkstatt"]);
    current.data.purpose = "Manipulated purpose";
    expect((await post(current)).status).toBe(202);
    const claim = await onlyClaim();
    const [expense] = await getDb().select().from(expenses).where(eq(expenses.claimId, claim.id));
    expect(claim.purpose).toBe("Teilnahme an der Werkstatt");
    expect(expense!.purpose).toBe("Teilnahme an der Werkstatt");
  });

  it.each(["Teilnahme\nMitwirkung", "Teilnahme\nMitwirkung\n Teilnahme \nMitwirkung\n"])(
    "multiple purposes remain selectable: %j",
    async (purposeOptions) => {
      await getDb().update(forms).set({ purposeOptions }).where(eq(forms.id, current.form.id));
      const page = await openForm(new CookieJar());
      expect(page.body.terms.purposeOptions).toEqual(["Teilnahme", "Mitwirkung"]);
      expect(page.body.terms.fixedPurpose).toBeNull();
      expect(page.body.config.messages.receipt_hint).toContain("Weitere Dateien sind optional");
    },
  );

  it("receipt expenses inherit the entire claim purpose", async () => {
    current.data.purpose = "Workshop ".repeat(100);
    delete current.data.expenses[0].purpose;
    expect((await post(current)).status).toBe(202);
    const claim = await onlyClaim();
    const [expense] = await getDb().select().from(expenses).where(eq(expenses.claimId, claim.id));
    expect(expense!.purpose).toBe(claim.purpose);
  });

  it.each([false, true])(
    "mileage only needs no receipt or duplicate trip fields: round trip %s",
    async (roundTrip) => {
      Object.assign(current.data, {
        is_trip: false,
        trip_destination: "",
        trip_start: "",
        trip_end: "",
        expenses: [mileageRow({ round_trip: roundTrip, vehicle_registration: "b-ab 123" })],
      });
      if (!roundTrip) current.data.expenses[0].return_date = "stale invalid date";
      expect((await post(current)).status).toBe(202);
      const claim = await onlyClaim();
      const [row] = await getDb().select().from(expenses).where(eq(expenses.claimId, claim.id));
      expect(await getDb().$count(uploads, eq(uploads.claimId, claim.id))).toBe(1);
      expect(row!.vehicleRegistration).toBe("B-AB 123");
      expect(row!.purpose).toBe(claim.purpose);
      expect(Boolean(row!.returnDate)).toBe(roundTrip);
      expect(row!.distanceKm! * (row!.roundTrip ? 2 : 1)).toBe(289 * (roundTrip ? 2 : 1));
    },
  );

  it("references use the Berlin submission date and a unique sequence", async () => {
    const submitted = new Date(Date.UTC(2026, 9, 22, 23, 30));
    const first = await allocateReference("werkstatt", "Alex Beispiel", submitted);
    const second = await allocateReference("werkstatt", "Alex Beispiel", submitted);
    expect(first).toBe("Erst/2026-10-23/werkstatt/beispiel/000001");
    expect(second.endsWith("/000002")).toBe(true);
    expect(await allocateReference("werkstatt", "Zoë O’Neil-Łukasiewicz", submitted)).toBe(
      "Erst/2026-10-23/werkstatt/oneil-łukasiewicz/000003",
    );
  });

  it("the reference is stable and shown on the received page", async () => {
    const response = await post(current);
    const claim = await onlyClaim();
    const reference = claim.bookkeepingReference!;
    expect(reference).toMatch(/^Erst\/\d{4}-\d{2}-\d{2}\/test\/beispiel\/\d{6}$/);
    expect(response.body.reference).toBe(reference);
    await getDb()
      .update(forms)
      .set({ slug: "renamed", name: "Renamed" })
      .where(eq(forms.id, current.form.id));
    expect((await onlyClaim()).bookkeepingReference).toBe(reference);
    const received = await request("GET", `/api/v1/public/received/${claim.id}`, { jar: current.jar });
    expect(received.body.reference).toBe(reference);
    expect(received.body.form.name).toBe("Renamed");
  });

  it("rejected and replayed submissions do not consume more numbers", async () => {
    current.data.expenses[0].amount = "0";
    expect((await post(current)).status).toBe(400);
    expect(await getDb().$count(claimReferenceCounters)).toBe(0);
    current.data.expenses[0].amount = "12,50";
    expect((await post(current)).status).toBe(202);
    expect((await post(current)).status).toBe(202);
    const [counter] = await getDb().select().from(claimReferenceCounters);
    expect(counter!.value).toBe(1);
  });

  it("drafts opened before an intake change must reload", async () => {
    await getDb().update(drafts).set({ revision: "0123456789abcdef" }).where(eq(drafts.id, current.draft.id));
    const response = await post(current);
    expect(response.status).toBe(409);
    expect(errorMessage(response)).toContain("aktualisiert");
    expect(await claimCount()).toBe(0);
    expect((await openForm(current.jar)).status).toBe(200);
    const form = (await loadForm({ id: current.form.id }))!;
    expect(await getDb().$count(drafts, eq(drafts.revision, (await terms.of(form)).revision))).toBe(1);
  });

  it("a submitted form's link starts a new claim", async () => {
    expect((await post(current)).status).toBe(202);
    expect((await openForm(current.jar)).status).toBe(200);
    const open = await getDb().select().from(drafts);
    expect(open.filter((draft) => draft.id !== current.draft.id && draft.claimId === null)).toHaveLength(1);
  });

  it("UUIDs are read as Python reads them", () => {
    const id = "6f6d3e0a-6a5f-4d3b-9d64-1d2d0f6a1c11";
    expect(normalizeUuid(id.toUpperCase())).toBe(id);
    expect(normalizeUuid(`{${id.replaceAll("-", "")}}`)).toBe(id);
    expect(normalizeUuid(`urn:uuid:${id}`)).toBe(id);
    expect(() => normalizeUuid("invalid")).toThrow();
    expect(() => normalizeUuid(1)).toThrow();
  });
});
