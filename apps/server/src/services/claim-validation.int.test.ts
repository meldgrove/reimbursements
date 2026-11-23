/**
 * Review and submission share the same rules without accepting or reserving work
 * (tests/test_claim_validation.py, the live validation of tests/test_improvements.py
 * and tests/test_intake.py).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../db/client";
import { claims, forms, jobs } from "../db/schema";
import { eq, getTableColumns } from "drizzle-orm";
import { CLAIM_FIELDS } from "../forms";
import { IntakeError } from "../intake";
import { loadForm } from "../models";
import { CookieJar, request } from "../test/helpers";
import {
  fieldErrors,
  freshIntake,
  intakeSettings,
  mileageRow,
  post,
  prepared,
  validate,
  type Prepared,
} from "../test/intake";
import { NOT_STORED, review, submission, totalLimit } from "./claim-validation";
import * as terms from "./terms";

async function offered(current: Prepared) {
  return terms.of((await loadForm({ id: current.form.id }))!);
}

async function nothingCreated() {
  expect(await getDb().$count(claims)).toBe(0);
  expect(await getDb().$count(jobs)).toBe(0);
}

describe("claim validation", () => {
  let current: Prepared;
  beforeEach(async () => {
    await freshIntake();
    current = await prepared();
  });

  it.each([
    [{ return_date: "2026-10-19" }, "return_date"],
    [{ travel_date: "wrong" }, "travel_date"],
    [{ distance_km: "1.5" }, "distance_km"],
    [{ route_to: "" }, "route_to"],
    [{ vehicle_registration: "ß".repeat(20) }, "vehicle_registration"],
    [{ round_trip: "true" }, "round_trip"],
  ])("expense errors agree through both HTTP paths: %o", async (changes, field) => {
    const row = mileageRow(changes);
    current.data.expenses = [row];
    const reviewed = await validate(current);
    const submitted = await post(current);
    expect(reviewed.status).toBe(200);
    expect(submitted.status).toBe(400);
    expect(fieldErrors(reviewed)).toEqual(fieldErrors(submitted));
    expect(Object.keys(fieldErrors(reviewed))).toContain(`expense-${row.id}-${field}`);
    await nothingCreated();
  });

  it("checks collect fields from multiple rows even when claim fields fail", async () => {
    const first = mileageRow({ route_from: "" });
    const second = mileageRow({ return_date: "" });
    const result = review(
      { ...current.data, full_name: "", expenses: [first, second] },
      await offered(current),
    );
    expect(new Set(Object.keys(result.errors))).toEqual(
      new Set(["full_name", `expense-${first.id}-route_from`, `expense-${second.id}-return_date`]),
    );
    expect(result.entries).toBeNull();
    expect(() => result.requireValid()).toThrow(IntakeError);
  });

  it("a valid review returns exact values without consent, signature or storage", async () => {
    const data = structuredClone(current.data);
    data.expenses = [mileageRow({ distance_km: "123", vehicle_registration: "b-ab 123", amount: "999" })];
    for (const key of ["signature", "declaration", "privacy_acknowledged"]) delete data[key];
    const original = structuredClone(data);
    const reviewed = review(data, await offered(current));
    const entries = reviewed.requireValid();
    expect(entries.total).toBe(7380n);
    expect(entries.signature).toBeNull();
    expect(entries.expenses[0]!.vehicle_registration).toBe("B-AB 123");
    expect(entries.claim.trip_destination).toBe("");
    expect(entries.claim.trip_start).toBeNull();
    for (const key of ["declaration", "privacy_acknowledged", "is_trip"])
      expect(key in entries.claim).toBe(false);
    expect(data).toEqual(original);
    expect(new Set(Object.keys(submission(data, await offered(current)).errors))).toEqual(
      new Set(["signature", "declaration", "privacy_acknowledged"]),
    );
    await nothingCreated();
  });

  it("the total and receipt association rules agree", async () => {
    totalLimit.cents = 1000n;
    try {
      expect(fieldErrors(await validate(current))).toEqual(fieldErrors(await post(current)));
      expect(Object.keys(fieldErrors(await validate(current)))).toContain("__all__");
      // An unrelated invalid field must not suppress the total check.
      current.data.expenses[0].merchant = "";
      expect(Object.keys(fieldErrors(await validate(current)))).toContain("__all__");
      current.data.expenses[0].merchant = "Belegverkauf";
      totalLimit.cents = 10000n;
      const first = current.data.expenses[0];
      const second = { ...first, id: mileageRow().id };
      current.data.expenses.push(second);
      expect(fieldErrors(await validate(current))).toEqual(fieldErrors(await post(current)));
      expect(Object.keys(fieldErrors(await validate(current)))).toContain(`expense-${second.id}-__all__`);
    } finally {
      totalLimit.cents = 999_999_999_999n;
    }
  });

  it.each([null, {}, [], [null], ["invalid"], [{ id: 1 }], [mileageRow({ uploads: [null] })]])(
    "malformed rows are rejections in both paths: %j",
    async (rows) => {
      current.data.expenses = rows;
      expect(fieldErrors(await validate(current))).toEqual(fieldErrors(await post(current)));
      expect(await getDb().$count(claims)).toBe(0);
    },
  );

  it("reordered rows keep their error identity", async () => {
    current.data.expenses.push(mileageRow({ route_to: "" }));
    const errors = fieldErrors(await validate(current));
    current.data.expenses.reverse();
    expect(fieldErrors(await validate(current))).toEqual(errors);
  });

  it("every stored claim form field is a claim column", () => {
    const columns = Object.values(getTableColumns(claims)).map((column) => column.name);
    for (const field of CLAIM_FIELDS.filter((name) => !NOT_STORED.has(name)))
      expect(columns).toContain(field);
  });

  it.each([
    // Values a form field cannot read as text.
    { trip_start: 5, trip_end: ["2026-10-21"] },
    { trip_start: true },
    // A lone surrogate is not Unicode text.
    { full_name: "Alex \ud800 Beispiel" },
  ])("JSON values that are not text are refused, not crashed on: %o", async (changes) => {
    Object.assign(current.data, changes);
    const reviewed = await validate(current);
    expect(reviewed.status === 400 || Object.keys(fieldErrors(reviewed)).length > 0).toBe(true);
    expect((await post(current)).status).toBe(400);
    expect(await getDb().$count(claims)).toBe(0);
  });

  it.each([
    "[".repeat(100_000),
    `{"full_name": ${"1".repeat(5000)}}`,
    // Review I8: well-formed but nested deeper than Python's json reads.
    `{"full_name": ${"[".repeat(40_000)}${"]".repeat(40_000)}}`,
  ])("JSON the app cannot load is an invalid request", async (body) => {
    for (const path of ["validate", "submit"]) {
      const response = await request("POST", `/api/v1/public/forms/test/${path}`, {
        jar: current.jar,
        body,
        headers: { "content-type": "application/json", "x-draft-token": current.data.token },
      });
      expect(response.status).toBe(400);
    }
  });

  it("expense text with a NUL character is refused", async () => {
    const row = current.data.expenses[0];
    row.merchant = "Beleg\u0000verkauf";
    expect(Object.keys(fieldErrors(await validate(current)))).toContain(`expense-${row.id}-merchant`);
    expect((await post(current)).status).toBe(400);
  });

  it("the server rejects rows beyond the configured file limit", async () => {
    intakeSettings({ MAX_FILES_PER_EXPENSE: 1 });
    current.data.expenses[0].uploads.push(current.data.signature);
    const result = submission(current.data, await offered(current));
    try {
      result.requireValid();
      throw new Error("valid");
    } catch (error) {
      expect(error).toBeInstanceOf(IntakeError);
      expect(JSON.stringify((error as IntakeError).errors)).toContain("1 bis 1 Belegdateien");
    }
  });

  it("the claim total cannot exceed the stored precision", async () => {
    totalLimit.cents = 1000n;
    try {
      const response = await post(current);
      expect(response.status).toBe(400);
      expect(response.body.error.message).toContain("Summe");
      expect(await getDb().$count(claims)).toBe(0);
    } finally {
      totalLimit.cents = 999_999_999_999n;
    }
  });
});

describe("live validation", () => {
  let current: Prepared;
  beforeEach(async () => {
    await freshIntake();
    current = await prepared();
  });

  it("uses the submission rules without creating claims", async () => {
    const response = await validate(current, {
      iban: "DE89 3704 0044 0532 0130 01",
      postal_code: "123",
      full_name: "Alex123",
    });
    expect(response.status).toBe(200);
    expect(new Set(Object.keys(fieldErrors(response)))).toEqual(
      new Set(["iban", "postal_code", "full_name"]),
    );
    await nothingCreated();
    expect((await validate(current)).body).toEqual({ fields: {} });
  });

  it("checks dependencies and omits review requirements", async () => {
    const response = await validate(current, {
      country: "AT",
      postal_code: "1010",
      iban: "AE070331234567890123456",
      bic: "",
      declaration: false,
      privacy_acknowledged: false,
    });
    expect(Object.keys(fieldErrors(response))).toEqual(["bic"]);
    expect(fieldErrors(response).bic![0]!.message).toContain("SEPA");
    expect(Object.keys(fieldErrors(await validate(current, { trip_end: "2026-01-01" })))).toContain(
      "trip_end",
    );
    expect((await validate(current, { trip_end: "", expenses: [mileageRow()] })).body).toEqual({
      fields: {},
    });
    // A browser-supplied flag cannot disable travel rules for receipt-only claims.
    expect(Object.keys(fieldErrors(await validate(current, { trip_end: "", has_mileage: true })))).toContain(
      "trip_end",
    );
  });

  it("requires the owning session, token and current draft", async () => {
    expect((await validate(current, { draft_id: "missing" })).status).toBe(404);
    const other = await request("POST", "/api/v1/public/forms/test/validate", {
      jar: new CookieJar(),
      body: current.data,
      headers: { "x-draft-token": current.data.token },
    });
    expect(other.status).toBe(404);
    await getDb()
      .update(forms)
      .set({ purposeOptions: "Changed purpose" })
      .where(eq(forms.id, current.form.id));
    expect((await validate(current)).status).toBe(409);
  });

  it("refuses submitted drafts", async () => {
    expect((await post(current)).status).toBe(202);
    expect((await validate(current)).status).toBe(409);
  });

  it("answers in English when that is the app language", async () => {
    const { saveSettings } = await import("./app-settings");
    await saveSettings({ language: "en" });
    const response = await validate(current, { postal_code: "1234", street: "" });
    expect(fieldErrors(response).postal_code![0]!.message).toBe("Please enter a five-digit postcode.");
    expect(fieldErrors(response).street![0]!.message).toBe("This field is required.");
  });
});
