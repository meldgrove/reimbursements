/** Allocate readable references once, within the claim's acceptance transaction. */
import { eq, sql } from "drizzle-orm";
import { zonedParts } from "@reimbursements/shared/dates";
import { claimReferenceCounters } from "../db/schema";
import { atomic, q } from "../db/tx";
import { applied } from "../i18n";

/** Django's slugify(value, allow_unicode=True). */
export function slugify(value: string): string {
  const lowered = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, "");
  return lowered.replace(/[-\s]+/gu, "-").replace(/^[-_]+|[-_]+$/g, "");
}

/**
 * The next bookkeeping reference: Erst/<date>/<form slug>/<surname>/<number>, the date
 * in the app timezone and the number from the permanent counter.
 */
export function allocateReference(formSlug: string, fullName: string, submittedAt: Date): Promise<string> {
  return atomic(async () => {
    await q().insert(claimReferenceCounters).values({ id: 1, value: 0 }).onConflictDoNothing();
    const [counter] = await q()
      .update(claimReferenceCounters)
      .set({ value: sql`${claimReferenceCounters.value} + 1` })
      .where(eq(claimReferenceCounters.id, 1))
      .returning({ value: claimReferenceCounters.value });
    const words = fullName.split(/\s+/).filter(Boolean);
    const surname = [...slugify(words.at(-1) ?? "")].slice(0, 60).join("") || "name";
    const parts = zonedParts(submittedAt, applied().timezone);
    const date = `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
    return `Erst/${date}/${formSlug}/${surname}/${String(counter!.value).padStart(6, "0")}`;
  });
}
