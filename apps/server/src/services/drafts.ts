/**
 * Drafts: session-bound, token-authorized forms that become one claim on acceptance.
 *
 * `openDraft` gives a participant their editable draft of a form, or admits a new one.
 * `gate` decides whether a participant may act on a draft now. Every participant action
 * passes it with one of these actions, which says which checks run:
 *
 * | Action | session, token, expiry | unsubmitted | form accepting | locks            |
 * |--------|------------------------|-------------|----------------|------------------|
 * | READ   | yes                    |             |                |                  |
 * | REVIEW | yes                    | yes         | yes            |                  |
 * | REMOVE | yes                    | yes         |                | draft            |
 * | UPLOAD | yes                    | yes         | yes            | draft            |
 * | SUBMIT | yes                    | yes         | yes            | draft, then form |
 *
 * A form is accepting while it is open, available (an approved recipient and a privacy
 * notice; `terms.refusal`) and on the draft's revision: the digest of the form's terms
 * (services/terms.ts). A draft is accepting while it is unsubmitted and its form is.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import { config } from "../config";
import { drafts, forms, type Draft } from "../db/schema";
import { atomic, q } from "../db/tx";
import { t } from "../i18n";
import { IntakeError } from "../intake";
import { loadForm, type FormWithTemplate } from "../models";
import type { Participant } from "../participants";
import * as emailConnection from "./email-connection";
import { chargeDraft } from "./network-budget";
import * as terms from "./terms";
import { normalizeUuid } from "./claim-validation";

/** New drafts one browser session may open per day. */
export const MAX_DRAFTS_PER_SESSION = 10;

export type Action = {
  /** The draft must still be unsubmitted. */
  unsubmitted: boolean;
  /** The draft stays locked until the transaction ends. */
  locksDraft: boolean;
  /** The form must be accepting: open, available and on the draft's revision. */
  accepts: boolean;
  /** The form cannot change until the transaction ends. */
  locksForm: boolean;
};

export const READ: Action = { unsubmitted: false, locksDraft: false, accepts: false, locksForm: false };
export const REVIEW: Action = { unsubmitted: true, locksDraft: false, accepts: true, locksForm: false };
export const REMOVE: Action = { unsubmitted: true, locksDraft: true, accepts: false, locksForm: false };
export const UPLOAD: Action = { unsubmitted: true, locksDraft: true, accepts: true, locksForm: false };
export const SUBMIT: Action = { unsubmitted: true, locksDraft: true, accepts: true, locksForm: true };

/** The draft is already a claim. Submit replays it; every other edit is refused. */
export class AlreadySubmitted extends IntakeError {
  constructor(readonly draft: Draft) {
    super(t("This form has already been submitted."), { status: 409 });
    this.name = "AlreadySubmitted";
  }
}

/** The form is on another revision than the draft: the participant must reload. */
export class Outdated extends IntakeError {
  constructor() {
    super(t("The form was updated. Please reload it and check your details again."), { status: 409 });
    this.name = "Outdated";
  }
}

export function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Constant-time comparison of two strings (Django's constant_time_compare). */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * The form's terms if it is accepting. `revision` is the draft's; null checks a form
 * before a draft exists.
 */
async function ensureAccepting(form: FormWithTemplate, revision: string | null): Promise<terms.Terms> {
  const current = await terms.of(form);
  const refused = terms.refusal(form, current.privacyNotice, await emailConnection.ready());
  if (refused === terms.CLOSED)
    throw new IntakeError(t("This form is closed for new claims."), { status: 409 });
  if (refused) throw new IntakeError(t("The form is currently unavailable."), { status: 503 });
  if (revision !== null && current.revision !== revision) throw new Outdated();
  return current;
}

const notFound = () => new IntakeError(t("The form was not found."), { status: 404 });

/**
 * The participant's draft and its form, if `action` is allowed now.
 *
 * Throws IntakeError: 404 for another session or a wrong token, 410 for an expired
 * unsubmitted draft, AlreadySubmitted (409) when an action for unsubmitted drafts meets
 * a claim, and 409 or 503 when an accepting action meets a form that is closed,
 * unavailable or on another revision. Locks need a transaction (`atomic`).
 */
export async function gate(
  participant: Participant,
  formSlug: string,
  draftId: unknown,
  token: unknown,
  action: Action,
): Promise<{ draft: Draft; form: FormWithTemplate }> {
  let id: string;
  try {
    id = normalizeUuid(typeof draftId === "string" ? draftId : String(draftId));
  } catch {
    throw notFound();
  }
  const binding = await participant.binding();
  if (binding === null) throw notFound();
  // Lock only the draft: the form slug join must not lock the form row as well.
  const query = q()
    .select({ draft: drafts })
    .from(drafts)
    .innerJoin(forms, eq(drafts.formId, forms.id))
    .where(and(eq(drafts.id, id), eq(forms.slug, formSlug), eq(drafts.sessionHash, binding)));
  const [row] = action.locksDraft ? await query.for("update", { of: drafts }) : await query;
  if (!row) throw notFound();
  const draft = row.draft;
  if (typeof token !== "string" || !constantTimeEquals(draft.tokenHash, digest(token))) throw notFound();
  if (!draft.claimId && draft.expiresAt.getTime() <= Date.now())
    throw new IntakeError(t("The form has expired. Please open the form again."), { status: 410 });
  const form = await loadForm({ id: draft.formId }, { forUpdate: action.locksForm });
  if (action.unsubmitted && draft.claimId) throw new AlreadySubmitted(draft);
  if (action.accepts) await ensureAccepting(form!, draft.revision);
  return { draft, form: form! };
}

let newDrafts: Promise<unknown> = Promise.resolve();

/** Runs `fn` after every earlier call of this process has finished. */
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = newDrafts.then(fn, fn);
  newDrafts = run.catch(() => undefined);
  return run;
}

/**
 * The participant's draft of an accepting form, or a newly admitted one, with its token.
 *
 * A submitted, expired or outdated draft starts a new one. Never call inside a
 * transaction: the new draft, its session and their cookie commit together here.
 */
export async function openDraft(
  participant: Participant,
  form: FormWithTemplate,
): Promise<{ draft: Draft; token: string }> {
  const revision = (await ensureAccepting(form, null)).revision;
  const now = new Date();
  const binding = await participant.binding();
  const remembered = await participant.remembered(form.slug);
  if (remembered && binding !== null) {
    let rememberedId: string | null;
    try {
      rememberedId = normalizeUuid(remembered.id);
    } catch {
      rememberedId = null;
    }
    if (rememberedId) {
      const [draft] = await q()
        .select()
        .from(drafts)
        .where(
          and(
            eq(drafts.id, rememberedId),
            eq(drafts.formId, form.id),
            eq(drafts.sessionHash, binding),
            isNull(drafts.claimId),
            gt(drafts.expiresAt, now),
            eq(drafts.revision, revision),
          ),
        );
      if (draft) return { draft, token: remembered.token };
    }
  }
  // One new-draft decision at a time, across processes (the advisory lock):
  // the counts below and the insert must not interleave, or concurrent
  // requests pass the global and per-session limits together. Within a
  // process they queue before taking a connection, so waiting requests do
  // not hold the pool's connections. The new session is written in the same
  // transaction (auth/session.ts), never on a second connection.
  const { draft, token } = await oneAtATime(() =>
    atomic(async () => {
      await q().execute(sql`select pg_advisory_xact_lock(hashtext('reimbursements.new-draft'))`);
      const [active] = await q()
        .select({ value: count() })
        .from(drafts)
        .where(and(isNull(drafts.claimId), gt(drafts.expiresAt, now)));
      if (Number(active?.value ?? 0) >= config().MAX_ACTIVE_DRAFTS)
        throw new IntakeError(t("The form is busy right now. Please try again later."), { status: 503 });
      if (binding !== null) {
        const [recent] = await q()
          .select({ value: count() })
          .from(drafts)
          .where(
            and(
              eq(drafts.sessionHash, binding),
              gt(drafts.createdAt, new Date(now.getTime() - 24 * 3600 * 1000)),
            ),
          );
        if (Number(recent?.value ?? 0) >= MAX_DRAFTS_PER_SESSION)
          throw new IntakeError(t("Too many new forms. Please try again later."), { status: 429 });
      }
      if (!(await chargeDraft(participant.network)))
        throw new IntakeError(t("Too many new forms from this network. Please try again later."), {
          status: 429,
        });
      // Only admitted visitors get a session.
      const token = randomBytes(32).toString("base64url");
      const sessionHash = (await participant.binding({ create: true }))!;
      const [draft] = await q()
        .insert(drafts)
        .values({ formId: form.id, sessionHash, tokenHash: digest(token), revision })
        .returning();
      return { draft: draft!, token };
    }),
  );
  await participant.remember(form.slug, draft.id, token);
  return { draft, token };
}
