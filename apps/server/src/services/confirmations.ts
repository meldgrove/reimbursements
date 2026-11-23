/**
 * Participant receipt emails (portal/services/confirmations.py of the Django
 * version). Never attach receipts or banking details.
 *
 * Admins turn the confirmation off, or write its subject and text per language,
 * under Admin > Email (services/email-connection.ts); without their own text it
 * uses the standard one. A claim accepted while confirmations are off gets none.
 *
 * A confirmation changes through its send result and provider evidence, which
 * the Evidence module applies through `settle`. It is never sent twice.
 */
import { eq } from "drizzle-orm";
import { translate, type Language } from "@reimbursements/shared/i18n";
import { APP_NAME, PAYMENT_TIMING } from "../constants";
import { claims, confirmations, type Claim, type Confirmation, type EmailSettingsRow } from "../db/schema";
import { q } from "../db/tx";
import { language, t } from "../i18n";
import { forClaim } from "./app-settings";
import { CLAIM_STATES } from "./claim-status";
import { snapshotText } from "./delivery";
import { claimReference } from "./documents";
import * as emailConnection from "./email-connection";
import * as queue from "./queue";
import { FINAL, PENDING, SENDING, type Message, type SendResult } from "./transport";

/** What admins may write in braces, and what each placeholder becomes. */
export const PLACEHOLDERS: Readonly<Record<string, string>> = {
  name: "the participant's name",
  form: "the form's name",
  reference: "the claim's reference",
  payment_timing: "when reimbursements are usually paid",
  support: "the form's contact for questions",
  app_name: `“${APP_NAME}”`,
};
export const MAX_SUBJECT_LENGTH = 200;
export const MAX_BODY_LENGTH = 5000;

const STANDARD_SUBJECT = "Confirmation of receipt: reimbursement claim {reference}";
const STANDARD_BODY =
  "Hello {name},\n\nyour reimbursement claim for {form} has been received.\n\nYour reference: {reference}\nPlease quote this reference with any questions.\n\nThis confirmation of receipt is not yet an approval of the reimbursement.\n{payment_timing}\n\nIf you have questions, you can reach us at {support}.\n\nBest regards\nYour {app_name} team\n";

/** Whether participants receive a confirmation of receipt. */
export async function enabled(): Promise<boolean> {
  return (await emailConnection.loadEmailSettings()).confirmationEnabled;
}

/** The standard subject and text in language `code`, with their placeholders. */
export function standardTexts(code: Language): [subject: string, body: string] {
  return [translate(code, STANDARD_SUBJECT), translate(code, STANDARD_BODY)];
}

/** The subject and text a confirmation in language `code` uses, with placeholders. */
export function texts(saved: Pick<EmailSettingsRow, "confirmationTexts">, code: Language): [string, string] {
  const own = saved.confirmationTexts[code] ?? {};
  const [subject, body] = standardTexts(code);
  return [own.subject || subject, own.body || body];
}

/** Characters Python's str.split() and str.strip() take for whitespace. */
const PYTHON_SPACE = "\t\n\x0b\x0c\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000";
const SPACES = new RegExp(`[${PYTHON_SPACE}]+`, "g");
const EDGES = new RegExp(`^[${PYTHON_SPACE}]+|[${PYTHON_SPACE}]+$`, "g");

/** Python's " ".join(text.split()): one space between words, none around them. */
export function collapseSpaces(text: string): string {
  return text.replace(SPACES, " ").replace(EDGES, "");
}

/** Python's text.strip(). */
export function stripSpaces(text: string): string {
  return text.replace(EDGES, "");
}

type Segment = { literal: string; field: { name: string; spec: string; conversion: string } | null };

/**
 * The pieces of `text` as Python's string.Formatter().parse yields them (CPython's
 * MarkupIterator), or null where Python raises ValueError.
 */
function formatSegments(text: string): Segment[] | null {
  const segments: Segment[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const start = i;
    let c = "";
    let markup = false;
    while (i < n) {
      c = text[i++]!;
      if (c === "{" || c === "}") {
        markup = true;
        break;
      }
    }
    const atEnd = i >= n;
    if (markup && c === "}" && (atEnd || text[i] !== "}")) return null; // Single '}'
    if (markup && c === "{" && atEnd) return null; // Single '{'
    let literalEnd = i;
    if (markup) {
      if (text[i] === c) {
        // An escaped brace: literal text, no field.
        i += 1;
        markup = false;
      } else literalEnd -= 1;
    }
    const literal = text.slice(start, literalEnd);
    if (!markup) {
      segments.push({ literal, field: null });
      continue;
    }
    // The field: its name ends at "}", ":" or "!" ("[" skips to "]").
    const nameStart = i;
    c = "";
    while (i < n) {
      c = text[i++]!;
      if (c === "{") return null; // unexpected '{' in field name
      if (c === "[") {
        while (i < n && text[i] !== "]") i += 1;
        continue;
      }
      if (c === "}" || c === ":" || c === "!") break;
    }
    const name = text.slice(nameStart, i - 1);
    if (c !== "!" && c !== ":") {
      if (c !== "}") return null; // expected '}' before end of string
      segments.push({ literal, field: { name, spec: "", conversion: "" } });
      continue;
    }
    let conversion = "";
    if (c === "!") {
      if (i >= n) return null; // end of string while looking for conversion specifier
      conversion = text[i++]!;
      if (i < n) {
        const next = text[i++]!;
        if (next === "}") {
          segments.push({ literal, field: { name, spec: "", conversion } });
          continue;
        }
        if (next !== ":") return null; // expected ':' after conversion specifier
      }
    }
    const specStart = i;
    let depth = 1;
    let closed = false;
    while (i < n) {
      const next = text[i++]!;
      if (next === "{") depth += 1;
      else if (next === "}" && --depth === 0) {
        closed = true;
        break;
      }
    }
    if (!closed) return null; // unmatched '{' in format spec
    segments.push({ literal, field: { name, spec: text.slice(specStart, i - 1), conversion } });
  }
  return segments;
}

/** Why `text` cannot be a confirmation's subject or text, or "" when it can. */
export function placeholderProblem(text: string): string {
  const segments = formatSegments(text);
  if (segments === null) return "Write a single brace as {{ or }}; braces otherwise enclose a placeholder.";
  for (const { field } of segments) {
    if (!field) continue;
    if (!Object.hasOwn(PLACEHOLDERS, field.name)) {
      const known = Object.keys(PLACEHOLDERS)
        .map((name) => `{${name}}`)
        .join(", ");
      return `{${field.name}} is not a placeholder. Use ${known}.`;
    }
    if (field.spec || field.conversion)
      return `Write the placeholder as {${field.name}}, without “:” or “!”.`;
  }
  return "";
}

/** `text` with its placeholders filled, as Python's str.format(**values) of a valid text. */
function fill(text: string, values: Record<string, string>): string {
  const segments = formatSegments(text);
  if (segments === null) throw new Error("Invalid confirmation text");
  return segments
    .map(({ literal, field }) => {
      if (!field) return literal;
      const value = Object.hasOwn(values, field.name) ? values[field.name] : undefined;
      if (value === undefined || field.spec || field.conversion) throw new Error("Invalid confirmation text");
      return literal + value;
    })
    .join("");
}

export async function schedule(claim: Pick<Claim, "id">) {
  if (!(await enabled())) return;
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
  const saved = await emailConnection.loadEmailSettings();
  const { subject, text } = await forClaim(claim, async () => {
    const [subjectText, bodyText] = texts(saved, language());
    const values = {
      name: claim.fullName,
      form: snapshotText(claim.snapshot, "name"),
      reference,
      payment_timing: t(PAYMENT_TIMING),
      support,
      app_name: APP_NAME,
    };
    return { subject: fill(subjectText, values), text: fill(bodyText, values) };
  });
  return {
    attemptId: confirmation.id,
    sender: (await emailConnection.current(saved)).sender,
    replyTo: support,
    recipient: claim.email,
    subject: collapseSpaces(subject),
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
