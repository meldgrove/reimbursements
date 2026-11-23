/** Acceptance: a participant's draft becomes one claim, once. */
import { eq, inArray } from "drizzle-orm";
import { claims, drafts, expenses, type Claim } from "../db/schema";
import { atomic, q } from "../db/tx";
import { t } from "../i18n";
import { IntakeError } from "../intake";
import type { Participant } from "../participants";
import { amountText, submission } from "./claim-validation";
import * as confirmations from "./confirmations";
import { AlreadySubmitted, Outdated, SUBMIT, constantTimeEquals, digest, gate } from "./drafts";
import * as queue from "./queue";
import { allocateReference } from "./references";
import * as retention from "./retention";
import * as terms from "./terms";
import { pythonJson } from "./terms";
import { claimable } from "./uploads";

/** JSON as Python's json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False) writes it. */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return pythonJson(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Accept the participant's draft as a claim; a repeated identical request returns it.
 *
 * `numbered: false` is for the setup check: its claim takes no bookkeeping reference,
 * so the sequence Finance books has no gap, and goes by its ID instead.
 */
export function submitClaim(
  participant: Participant,
  formSlug: string,
  data: unknown,
  options: { numbered?: boolean } = {},
): Promise<Claim> {
  const numbered = options.numbered ?? true;
  return atomic(async () => {
    if (!isRecord(data) || data.website) throw new IntakeError(t("Invalid request."));
    // Compare an exact canonical request on replay, even if the form changed or closed later.
    const replayData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data))
      if (key !== "token" && key !== "website") replayData[key] = value;
    const payloadHash = digest(canonicalJson(replayData));
    let gated;
    try {
      gated = await gate(participant, formSlug, data.draft_id, data.token, SUBMIT);
    } catch (error) {
      if (!(error instanceof AlreadySubmitted)) throw error;
      if (!constantTimeEquals(error.draft.payloadHash, payloadHash))
        throw new IntakeError(t("This form has already been submitted with different details."), {
          status: 409,
        });
      const [claim] = await q().select().from(claims).where(eq(claims.id, error.draft.claimId!));
      return claim!;
    }
    const { draft, form } = gated;
    // A privacy notice published since the gate's check must not enter this claim.
    const accepted = await terms.of(form);
    if (accepted.revision !== draft.revision) throw new Outdated();
    const snapshot = terms.snapshot(form, accepted);
    const entries = submission(data, accepted).requireValid();
    const files = await claimable(draft, entries.expenses, entries.signature!);
    const rowIds = entries.expenses.map((row) => row.id);
    if (
      rowIds.length &&
      (await q().select({ id: expenses.id }).from(expenses).where(inArray(expenses.id, rowIds))).length
    )
      throw new IntakeError(t("Invalid item ID. Please open a new form."), { status: 409 });
    const submittedAt = new Date();
    const values = entries.claim;
    const [claim] = await q()
      .insert(claims)
      .values({
        formId: form.id,
        submittedAt,
        bookkeepingReference: numbered
          ? await allocateReference(form.slug, values.full_name, submittedAt)
          : null,
        snapshot,
        total: amountText(entries.total),
        resolutionDue: retention.resolutionDue(submittedAt),
        fullName: values.full_name,
        email: values.email,
        street: values.street,
        postalCode: values.postal_code,
        city: values.city,
        country: values.country,
        accountHolder: values.account_holder,
        iban: values.iban,
        bic: values.bic,
        purpose: values.purpose,
        purposeDetails: values.purpose_details,
        tripDestination: values.trip_destination,
        tripStart: values.trip_start,
        tripEnd: values.trip_end,
      })
      .returning();
    for (const row of entries.expenses) {
      await q()
        .insert(expenses)
        .values({
          id: row.id,
          claimId: claim!.id,
          position: row.position,
          kind: row.kind,
          merchant: row.merchant ?? "",
          purpose: row.purpose,
          receiptReference: row.receipt_reference ?? "",
          travelDate: row.travel_date ?? null,
          returnDate: row.return_date ?? null,
          vehicleRegistration: row.vehicle_registration ?? "",
          routeFrom: row.route_from ?? "",
          routeTo: row.route_to ?? "",
          distanceKm: row.distance_km ?? null,
          roundTrip: row.round_trip ?? false,
          mileageRate: row.mileage_rate ?? null,
          amount: amountText(row.amount),
        });
    }
    await files.attach(claim!.id);
    // A replay returns this claim until it is deleted; the draft no longer expires.
    await q().update(drafts).set({ claimId: claim!.id, payloadHash }).where(eq(drafts.id, draft.id));
    await queue.enqueue("render", claim!);
    await confirmations.schedule(claim!);
    return claim!;
  });
}
