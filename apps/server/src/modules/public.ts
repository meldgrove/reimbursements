/**
 * The participant API (the participant views of portal/views.py in the
 * Django version): the start page's redirect, the privacy notice, the form
 * page with the participant's draft, uploads, live validation, submission and
 * the received page. Mounted under /api/v1: changes need the app's origin.
 */
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { Busboy } from "@fastify/busboy";
import { Hono, type Context } from "hono";
import { and, eq } from "drizzle-orm";
import { countries } from "@reimbursements/shared/countries";
import { dateFormat } from "@reimbursements/shared/dates";
import { example } from "@reimbursements/shared/numbers";
import type {
  ClosedFormPage,
  FormPage,
  PrivacyAnswer,
  ReceivedAnswer,
  StartAnswer,
  SubmitAnswer,
  UploadAccepted,
  ValidateAnswer,
} from "@reimbursements/shared/api/public";
import { manages } from "../auth/roles";
import { config } from "../config";
import { claims, drafts, forms } from "../db/schema";
import { q } from "../db/tx";
import type { AppEnv } from "../http/env";
import { BodyTooLarge, isBodyTooLarge } from "../http/middleware";
import { applied, formatDateTime, formatInstantDate, language, t, zoneName } from "../i18n";
import * as intake from "../intake";
import { IntakeError } from "../intake";
import { currentPrivacyNotice, displayDescription, displayTitle, isOpen, loadForm } from "../models";
import { RequestParticipant } from "../participants";
import * as claimStatus from "../services/claim-status";
import * as confirmations from "../services/confirmations";
import { review } from "../services/claim-validation";
import { REVIEW, gate, openDraft } from "../services/drafts";
import { storageRoot } from "../services/storage";
import { submitClaim } from "../services/submissions";
import * as terms from "../services/terms";
import * as uploads from "../services/uploads";
import { UploadAborted, withUploadSlot } from "../services/upload-slots";

const router = new Hono<AppEnv>();

/** An IntakeError as the participant API answers it. */
function intakeResponse(c: Context<AppEnv>, error: IntakeError) {
  return c.json(
    { error: { code: "intake_error", message: error.message, fields: error.errors } },
    error.status as 400,
  );
}

const invalidRequest = () => new IntakeError(t("Invalid request."));

/**
 * How deeply a request's JSON may nest. Python's json module stops at its
 * recursion limit (RecursionError: an invalid request in the Django version);
 * a claim needs four levels.
 */
const MAX_JSON_DEPTH = 64;

/**
 * Every text of a JSON value is well-formed Unicode (no lone surrogate), as
 * Python's encode() requires, and it nests at most MAX_JSON_DEPTH levels.
 */
function wellFormed(value: unknown, depth = 0): boolean {
  if (typeof value === "string") return value.isWellFormed();
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || value === null) return true;
  if (depth >= MAX_JSON_DEPTH) return false;
  if (Array.isArray(value)) return value.every((item) => wellFormed(item, depth + 1));
  return Object.entries(value).every(([key, item]) => key.isWellFormed() && wellFormed(item, depth + 1));
}

/**
 * The request's JSON. Text that is not Unicode (a lone surrogate) and numbers
 * Python cannot read are an invalid request, as in the Django version.
 */
async function claimJson(c: Context<AppEnv>): Promise<unknown> {
  let data: unknown;
  try {
    data = JSON.parse(await c.req.text());
  } catch (error) {
    if (isBodyTooLarge(error)) throw new BodyTooLarge();
    throw invalidRequest();
  }
  if (!wellFormed(data)) throw invalidRequest();
  return data;
}

/** Runs a handler; an IntakeError becomes its answer. */
function handle(fn: (c: Context<AppEnv>) => Promise<Response>) {
  return async (c: Context<AppEnv>) => {
    try {
      return await fn(c);
    } catch (error) {
      if (error instanceof IntakeError) return intakeResponse(c, error);
      throw error;
    }
  };
}

/** A route parameter (every route here names its own). */
function param(c: Context<AppEnv>, name: string): string {
  return c.req.param(name) ?? "";
}

/** The form script sends the draft token with every request about an upload. */
function draftToken(c: Context<AppEnv>): string | undefined {
  return c.req.header("x-draft-token");
}

router.get("/public/start", async (c) => {
  const [primary] = await q().select().from(forms).where(eq(forms.primary, true));
  const form = primary ? await loadForm({ id: primary.id }) : null;
  const body: StartAnswer = { redirect: form && (await terms.accepting(form)) ? form.slug : null };
  return c.json(body);
});

router.get("/public/privacy", async (c) => {
  const notice = await currentPrivacyNotice();
  const body: PrivacyAnswer = {
    notice: notice
      ? {
          text: notice.text,
          version: notice.version,
          createdAt: notice.createdAt.toISOString(),
          date: formatInstantDate(notice.createdAt),
        }
      : null,
  };
  return c.json(body);
});

function closed(c: Context<AppEnv>, status: number, values: Partial<ClosedFormPage> = {}): Response {
  const body: ClosedFormPage = { state: "closed", name: null, message: null, supportEmail: null, ...values };
  return c.json(body, status as 403);
}

router.get("/public/forms/:slug", async (c) => {
  const form = await loadForm({ slug: param(c, "slug") });
  if (!form) return c.json({ error: { code: "not_found", message: t("The form was not found.") } }, 404);
  // Owners can look at a form before it opens; nothing can be uploaded or submitted.
  const open = isOpen(form);
  const preview = !open && (await manages(c.get("user"), form));
  if (!open && !preview) {
    // Draft and archived form names are private even when the link is known.
    return closed(
      c,
      403,
      form.status === "published" ? { name: form.name, supportEmail: form.supportEmail } : {},
    );
  }
  let draft: FormPage["draft"] = null;
  if (!preview) {
    try {
      const opened = await openDraft(new RequestParticipant(c), form);
      draft = { id: opened.draft.id, token: opened.token };
    } catch (error) {
      if (!(error instanceof IntakeError)) throw error;
      return closed(c, error.status, {
        name: form.name,
        message: error.message,
        supportEmail: form.supportEmail,
      });
    }
  }
  const offered = await terms.of(form);
  const settings = applied();
  const body: FormPage = {
    state: preview ? "preview" : "open",
    form: {
      slug: form.slug,
      name: form.name,
      title: displayTitle(form),
      description: displayDescription(form),
      deadline: form.closesAt
        ? t("Submit by {date} {zone}", { date: formatDateTime(form.closesAt), zone: zoneName(form.closesAt) })
        : "",
      intro: form.template.intro,
      instructions: form.instructions,
      supportEmail: form.supportEmail,
      tripStart: form.tripStart ?? "",
      tripEnd: form.tripEnd ?? "",
    },
    terms: {
      declaration: offered.declaration,
      privacyText: offered.privacyNotice?.text ?? "",
      travel: offered.travel,
      mileageRate: offered.mileageRate,
      purposeOptions: [...offered.purposeOptions],
      fixedPurpose: offered.fixedPurpose,
    },
    draft,
    config: {
      ...intake.clientConfig(),
      date_format: dateFormat(settings.dateFormat).pattern,
      amount_placeholder: example(settings.numberFormat, "0.00"),
      field_lengths: { ...intake.EXPENSE_FIELD_LENGTHS },
    },
    countries: countries(language()).map(([code, name]) => [code, name]),
    development: config().isDevelopment,
    confirmation: await confirmations.enabled(),
  };
  return c.json(body);
});

type Received = {
  fields: Record<string, string>;
  file: uploads.ReceivedFile | null;
  truncated: boolean;
};

/**
 * Reads a multipart upload: its fields, and its one file streamed into a
 * private temporary file. A file larger than the receipt limit is stopped
 * there and reported as `truncated`, as the Django version's upload handler
 * did. The caller removes the file and holds an upload slot meanwhile.
 */
async function receiveUpload(c: Context<AppEnv>): Promise<Received> {
  const type = c.req.header("content-type") ?? "";
  const body = c.req.raw.body;
  if (!type.toLowerCase().startsWith("multipart/form-data") || !body)
    return { fields: {}, file: null, truncated: false };
  const directory = path.join(storageRoot(), "incoming");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fields: Record<string, string> = {};
  let file: uploads.ReceivedFile | null = null;
  let truncated = false;
  let files = 0;
  const writes: Promise<void>[] = [];
  const parts: Readable[] = [];
  let parser: InstanceType<typeof Busboy>;
  try {
    parser = new Busboy({
      headers: { "content-type": type },
      limits: { fileSize: config().MAX_RECEIPT_BYTES, fieldSize: 128_000, fields: 400, parts: 1000 },
    });
  } catch {
    throw invalidRequest();
  }
  const source = Readable.fromWeb(body as WebReadableStream);
  parser.on("field", (name: string, value: string) => {
    if (!(name in fields)) fields[name] = value;
  });
  parser.on("file", (name: string, stream: Readable, filename: string) => {
    files += 1;
    if (name !== "file" || file || files > 1) {
      stream.resume();
      return;
    }
    const target = path.join(directory, `upload-${randomUUID()}`);
    const received: uploads.ReceivedFile = { name: filename ?? "", size: 0, path: target };
    file = received;
    parts.push(stream);
    stream.on("data", (chunk: Buffer) => (received.size += chunk.length));
    stream.on("limit", () => (truncated = true));
    const write = pipeline(stream, createWriteStream(target, { mode: 0o600 }));
    // Observed from the start: a failed write stops the request instead of
    // becoming an unhandled rejection while the request is still being read.
    write.catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      // The parser waits for the file stream the failure destroyed: stop both ends.
      parser.destroy(failure);
      source.destroy(failure);
    });
    writes.push(write);
  });
  try {
    await pipeline(source, parser);
    await Promise.all(writes);
  } catch (error) {
    // The file stream is closed before its path is removed.
    for (const part of parts) part.destroy();
    await Promise.allSettled(writes);
    const pending = file as uploads.ReceivedFile | null;
    if (pending) rmSync(pending.path, { force: true });
    // The same 413 as for a declared length that is too large (requestLimits).
    if (isBodyTooLarge(error) || (error instanceof Error && /too large|limit/i.test(error.message)))
      throw new BodyTooLarge();
    throw invalidRequest();
  }
  // Django accepts one file per request (DATA_UPLOAD_MAX_NUMBER_FILES).
  if (files > 1) {
    const pending = file as uploads.ReceivedFile | null;
    if (pending) rmSync(pending.path, { force: true });
    throw invalidRequest();
  }
  return { fields, file, truncated };
}

router.post(
  "/public/forms/:slug/uploads",
  handle((c) =>
    // The body is read only with a slot: the storage kept free for spooled
    // uploads covers TOTAL_WEB_WORKERS of them (UPLOAD_TEMP_HEADROOM_BYTES).
    withUploadSlot(c.req.raw.signal, async () => {
      const received = await receiveUpload(c);
      try {
        const item = await uploads.accept(new RequestParticipant(c), param(c, "slug"), {
          file: received.file,
          truncated: received.truncated,
          kind: received.fields.kind ?? "receipt",
          expenseId: received.fields.expense_id,
          draftId: received.fields.draft_id,
          token: received.fields.token,
        });
        const body: UploadAccepted = {
          id: item.id,
          state: item.state,
          name: item.originalName,
          size: item.size,
        };
        return c.json(body, 202);
      } finally {
        if (received.file) rmSync(received.file.path, { force: true });
      }
    }).catch((error: unknown) => {
      // Nobody is left to answer: the client went away while waiting.
      if (error instanceof UploadAborted) throw invalidRequest();
      throw error;
    }),
  ),
);

router.get(
  "/public/forms/:slug/uploads/:uploadId",
  handle(async (c) => {
    const upload = await uploads.owned(
      new RequestParticipant(c),
      param(c, "slug"),
      param(c, "uploadId"),
      draftToken(c),
    );
    return c.json(uploads.status(upload));
  }),
);

router.delete(
  "/public/forms/:slug/uploads/:uploadId",
  handle(async (c) => {
    await uploads.discard(new RequestParticipant(c), param(c, "slug"), param(c, "uploadId"), draftToken(c));
    return c.json({ removed: true });
  }),
);

/** Validate current entries without saving them or requiring a signature. */
router.post(
  "/public/forms/:slug/validate",
  handle(async (c) => {
    const data = await claimJson(c);
    if (typeof data !== "object" || data === null || Array.isArray(data)) throw invalidRequest();
    const { form } = await gate(
      new RequestParticipant(c),
      param(c, "slug"),
      (data as Record<string, unknown>).draft_id,
      draftToken(c),
      REVIEW,
    );
    const body: ValidateAnswer = { fields: review(data, await terms.of(form)).errors };
    return c.json(body);
  }),
);

router.post(
  "/public/forms/:slug/submit",
  handle(async (c) => {
    const data = await claimJson(c);
    const claim = await submitClaim(new RequestParticipant(c), param(c, "slug"), data);
    const body: SubmitAnswer = {
      reference: claim.bookkeepingReference || claim.id,
      claimId: claim.id,
    };
    return c.json(body, 202);
  }),
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get("/public/received/:claimId", async (c) => {
  const claimId = param(c, "claimId").toLowerCase();
  const notFound = () =>
    c.json({ error: { code: "not_found", message: t("The claim was not found.") } }, 404);
  if (!UUID.test(claimId)) return notFound();
  const binding = await new RequestParticipant(c).binding();
  if (binding === null) return notFound();
  const [row] = await q()
    .select({ claim: claims, form: forms })
    .from(claims)
    .innerJoin(drafts, eq(drafts.claimId, claims.id))
    .innerJoin(forms, eq(forms.id, claims.formId))
    .where(and(eq(claims.id, claimId), eq(drafts.sessionHash, binding)));
  if (!row) return notFound();
  const current = await claimStatus.of(row.claim);
  const body: ReceivedAnswer = {
    reference: row.claim.bookkeepingReference || row.claim.id,
    state: current.outcome,
    final: current.final,
    form: { name: row.form.name, supportEmail: row.form.supportEmail },
  };
  return c.json(body);
});

export default router;
