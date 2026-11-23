/**
 * The admission budget of a client network, shared by its new drafts and uploads.
 *
 * One DraftAdmission row per network, keyed by a secret digest of it. It counts new drafts
 * and uploads (number and bytes) over a 24-hour window, and uploads over a one-minute
 * window; this module resets both. Lock order is Draft, then network budget, then capacity.
 */
import { eq } from "drizzle-orm";
import { djangoSaltedHmac } from "../auth/session";
import { config } from "../config";
import { draftAdmissions } from "../db/schema";
import { atomic, q } from "../db/tx";

type Budget = typeof draftAdmissions.$inferSelect;

/**
 * The key of a network's budget row: the Django version's digest, so the
 * budgets a network spent stay spent across an upgrade or a rollback.
 */
export function budgetKey(network: string): string {
  return djangoSaltedHmac("draft-admission", network);
}

/** The network's budget row, locked for this transaction, with expired windows reset. */
async function locked(network: string): Promise<Budget> {
  const key = budgetKey(network);
  await q().insert(draftAdmissions).values({ key }).onConflictDoNothing();
  const [budget] = await q().select().from(draftAdmissions).where(eq(draftAdmissions.key, key)).for("update");
  const now = new Date();
  const row = { ...budget! };
  if (row.windowStart.getTime() <= now.getTime() - 24 * 3600 * 1000) {
    Object.assign(row, { windowStart: now, count: 0, uploadCount: 0, uploadBytes: 0 });
    Object.assign(row, { uploadWindowStart: now, uploadWindowCount: 0 });
  }
  if (row.uploadWindowStart.getTime() <= now.getTime() - 60 * 1000) {
    Object.assign(row, { uploadWindowStart: now, uploadWindowCount: 0 });
  }
  return row;
}

async function save(budget: Budget) {
  const { key, ...values } = budget;
  await q().update(draftAdmissions).set(values).where(eq(draftAdmissions.key, key));
}

/** Counts a new draft against the network; false when its drafts for the day are spent. */
export function chargeDraft(network: string): Promise<boolean> {
  return atomic(async () => {
    const budget = await locked(network);
    if (budget.count >= config().MAX_DRAFTS_PER_NETWORK) return false;
    budget.count += 1;
    await save(budget);
    return true;
  });
}

/**
 * Counts an upload against the network; false when its upload budget is spent.
 * Runs in the upload's transaction, so a later admission failure refunds the charge.
 */
export async function chargeUpload(network: string, size: number): Promise<boolean> {
  const settings = config();
  const budget = await locked(network);
  if (
    budget.uploadCount >= settings.MAX_UPLOADS_PER_NETWORK ||
    budget.uploadBytes + size > settings.MAX_UPLOAD_BYTES_PER_NETWORK ||
    budget.uploadWindowCount >= settings.MAX_UPLOADS_PER_NETWORK_PER_MINUTE
  ) {
    return false;
  }
  budget.uploadCount += 1;
  budget.uploadBytes += size;
  budget.uploadWindowCount += 1;
  await save(budget);
  return true;
}
