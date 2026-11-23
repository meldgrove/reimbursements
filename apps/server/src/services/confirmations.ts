/**
 * Participant receipt emails (portal/services/confirmations.py of the Django
 * version). Never attach receipts or banking details.
 *
 * A confirmation changes through its send result and provider evidence, which
 * the Evidence module applies through `settle`. It is never sent twice.
 */
import { eq } from "drizzle-orm";
import { config } from "../config";
import { APP_NAME, PAYMENT_TIMING } from "../constants";
import { claims, confirmations, type Claim, type Confirmation } from "../db/schema";
import { q } from "../db/tx";
import { t } from "../i18n";
import { forClaim } from "./app-settings";
import { CLAIM_STATES } from "./claim-status";
import { snapshotText } from "./delivery";
import { claimReference } from "./documents";
import * as queue from "./queue";
import { FINAL, PENDING, SENDING, type Message, type SendResult } from "./transport";

export async function schedule(claim: Pick<Claim, "id">) {
  await q().insert(confirmations).values({ claimId: claim.id }).onConflictDoNothing({
    target: confirmations.claimId,
  });
  await queue.enqueue("confirm", claim);
}

/** Inside a transaction, reserves a pending email before contacting the provider. */
export async function start(claimId: string): Promise<Confirmation | null> {
  const [claim] = await q().select().from(claims).where(eq(claims.id, claimId)).for("update");
  if (!claim) throw new Error(`Claim ${claimId} does not exist`);
  if (claim.state === CLAIM_STATES.PURGING) return null;
  const [confirmation] = await q()
    .select()
    .from(confirmations)
    .where(eq(confirmations.claimId, claim.id))
    .for("update");
  if (!confirmation) throw new Error(`Claim ${claimId} has no confirmation`);
  if (confirmation.state !== PENDING) return null;
  const [reserved] = await q()
    .update(confirmations)
    .set({ state: SENDING, updatedAt: new Date() })
    .where(eq(confirmations.id, confirmation.id))
    .returning();
  return reserved!;
}

export async function compose(confirmation: Pick<Confirmation, "id" | "claimId">): Promise<Message> {
  const [claim] = await q().select().from(claims).where(eq(claims.id, confirmation.claimId));
  if (!claim) throw new Error(`Claim ${confirmation.claimId} does not exist`);
  const reference = claimReference(claim);
  const support = snapshotText(claim.snapshot, "support_email");
  const { subject, text } = await forClaim(claim, async () => ({
    subject: t("Confirmation of receipt: reimbursement claim {reference}", { reference }),
    text: t(
      "Hello {name},\n\nyour reimbursement claim for {form} has been received.\n\nYour reference: {reference}\nPlease quote this reference with any questions.\n\nThis confirmation of receipt is not yet an approval of the reimbursement.\n{payment_timing}\n\nIf you have questions, you can reach us at {support}.\n\nBest regards\nYour {app_name} team\n",
      {
        name: claim.fullName,
        form: snapshotText(claim.snapshot, "name"),
        reference,
        payment_timing: t(PAYMENT_TIMING),
        support,
        app_name: APP_NAME,
      },
    ),
  }));
  return {
    attemptId: confirmation.id,
    sender: config().MAIL_FROM_ADDRESS,
    replyTo: support,
    recipient: claim.email,
    subject,
    text,
  };
}

/** In a transaction: stores a send result unless provider evidence already settled it. */
export async function record(claimId: string, result: SendResult) {
  const [confirmation] = await q()
    .select()
    .from(confirmations)
    .where(eq(confirmations.claimId, claimId))
    .for("update");
  if (!confirmation) throw new Error(`Claim ${claimId} has no confirmation`);
  const changes: Partial<Confirmation> = { updatedAt: new Date() };
  if (!FINAL.has(confirmation.state))
    Object.assign(changes, { state: result.state, errorCode: result.errorCode });
  if (result.messageId) changes.messageId = result.messageId;
  await q().update(confirmations).set(changes).where(eq(confirmations.id, confirmation.id));
}

/**
 * In a transaction: lets provider evidence change a confirmation.
 * `apply(confirmation, recipient)` runs on the locked confirmation unless its
 * claim is being deleted.
 */
export async function settle(
  confirmationId: string,
  apply: (confirmation: Confirmation, recipient: string) => Promise<boolean>,
) {
  const [found] = await q()
    .select({ claimId: confirmations.claimId })
    .from(confirmations)
    .where(eq(confirmations.id, confirmationId));
  if (!found) throw new Error(`Confirmation ${confirmationId} does not exist`);
  const [claim] = await q().select().from(claims).where(eq(claims.id, found.claimId)).for("update");
  const [confirmation] = await q()
    .select()
    .from(confirmations)
    .where(eq(confirmations.id, confirmationId))
    .for("update");
  if (claim!.state !== CLAIM_STATES.PURGING) await apply(confirmation!, claim!.email);
}
