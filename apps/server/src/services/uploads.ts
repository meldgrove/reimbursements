/**
 * Uploads: receipts and signatures from intake through validation to a claim or expiry.
 *
 * An upload is busy while a validation runs or an execution workspace holds it. Busy
 * uploads are never discarded, and their files are removed only through this module.
 */
import { randomUUID } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { and, count, eq, exists, inArray, isNotNull, isNull, lt, or, sum, type SQL } from "drizzle-orm";
import {
  drafts,
  forms as formsTable,
  jobs,
  uploads,
  workspaceReservations,
  type Draft,
  type Upload,
} from "../db/schema";
import { atomic, q } from "../db/tx";
import { t } from "../i18n";
import * as intake from "../intake";
import { IntakeError } from "../intake";
import type { Participant } from "../participants";
import { CapacityError, admitUpload, releaseUpload, storageAvailable } from "./capacity";
import type { ExpenseEntry } from "./claim-validation";
import { normalizeUuid } from "./claim-validation";
import * as draftGate from "./drafts";
import type { NormalizedUpload } from "./documents";
import * as queue from "./queue";
import { StorageError, pathFor, removeKeys, saveUpload, uploadSourceKey } from "./storage";

/** Capacity refusals a participant caused; the others mean the service is busy (503). */
export const CAPACITY_TOO_MANY: ReadonlySet<string> = new Set(["draft_work_limit", "network_work_limit"]);
/** Uploads left out of an accepted claim go this long after their upload. */
export const UNACCEPTED_LIFETIME_MS = 24 * 3600 * 1000;

/** A received file: its name as the browser sent it, its size, and where it waits. */
export type ReceivedFile = { name: string; size: number; path: string };

/** Uploads among `condition` that a running validation or an execution workspace holds. */
function busy(condition: SQL | undefined): Promise<boolean> {
  return q()
    .select({ id: uploads.id })
    .from(uploads)
    .where(
      and(
        condition,
        or(
          exists(
            q()
              .select({ id: jobs.id })
              .from(jobs)
              .where(and(eq(jobs.uploadId, uploads.id), eq(jobs.state, queue.RUNNING))),
          ),
          exists(
            q()
              .select({ id: workspaceReservations.id })
              .from(workspaceReservations)
              .where(eq(workspaceReservations.uploadId, uploads.id)),
          ),
        ),
      ),
    )
    .limit(1)
    .then((rows) => rows.length > 0);
}

export function removeFiles(upload: Pick<Upload, "sourceKey" | "normalizedKey">) {
  removeKeys(upload.sourceKey, upload.normalizedKey);
}

/** The last path segment of a browser's file name (Path(name).name), at most 200 characters. */
function baseName(name: string): string {
  return [...path.posix.basename(name)].slice(0, 200).join("");
}

/**
 * Store a source file for the participant's accepting draft and queue its validation.
 *
 * Upload admission: every limit is checked here, with its message from intake. First
 * free storage, the file's kind, type and size, then the Draft gate, the draft's files
 * and receipt total, and finally the draft's and network's work budgets and disk
 * capacity. `truncated` means the request stopped the file at the receipt limit.
 */
export async function accept(
  participant: Participant,
  formSlug: string,
  options: {
    file: ReceivedFile | null;
    kind: unknown;
    expenseId: unknown;
    draftId: unknown;
    token: unknown;
    truncated?: boolean;
  },
): Promise<Upload> {
  const { file, kind } = options;
  if (!storageAvailable()) throw new IntakeError(intake.message("upload_unavailable")!, { status: 503 });
  if (kind !== "receipt" && kind !== "signature")
    throw new IntakeError(t("Please choose a receipt file or signature."));
  if (options.truncated) throw new IntakeError(intake.message(`${kind}_too_large`)!, { status: 413 });
  if (!file || !file.name) throw new IntakeError(t("Please choose a receipt file or signature."));
  const extension = path.extname(file.name).toLowerCase();
  if (!(kind === "signature" ? intake.SIGNATURE_EXTENSIONS : intake.RECEIPT_EXTENSIONS).has(extension))
    throw new IntakeError(intake.message("unsupported_type")!);
  let expenseId: string | null = null;
  if (kind === "receipt") {
    try {
      expenseId = normalizeUuid(options.expenseId);
    } catch {
      throw new IntakeError(t("The expense item is missing."));
    }
  }
  const limits = intake.limits();
  let key = "";
  try {
    return await atomic(async () => {
      const { draft } = await draftGate.gate(
        participant,
        formSlug,
        options.draftId,
        options.token,
        draftGate.UPLOAD,
      );
      const [ofKind] = await q()
        .select({ value: count() })
        .from(uploads)
        .where(
          and(
            eq(uploads.draftId, draft.id),
            eq(uploads.kind, kind),
            expenseId === null ? isNull(uploads.expenseId) : eq(uploads.expenseId, expenseId),
          ),
        );
      const [all] = await q().select({ value: count() }).from(uploads).where(eq(uploads.draftId, draft.id));
      if (
        Number(ofKind?.value ?? 0) >=
          (kind === "receipt" ? limits.files_per_expense : intake.MAX_SIGNATURE_FILES) ||
        Number(all?.value ?? 0) >= intake.draftFiles(limits)
      ) {
        throw new IntakeError(t("Please remove an existing file first."));
      }
      if (kind === "receipt") ensureReceiptsFit((await receiptBytes(draft.id)) + file.size);
      let reservation: number;
      try {
        reservation = await admitUpload(participant.network, draft.id, file.size);
      } catch (error) {
        if (!(error instanceof CapacityError)) throw error;
        throw new IntakeError(intake.message(error.code, intake.message("upload_capacity"))!, {
          status: CAPACITY_TOO_MANY.has(error.code) ? 429 : 503,
        });
      }
      const uploadId = randomUUID();
      key = uploadSourceKey(uploadId, extension);
      let stored: { size: number; checksum: string };
      try {
        stored = await saveUpload(
          createReadStream(file.path, { highWaterMark: 64 * 1024 }),
          key,
          kind === "signature" ? limits.signature_bytes : limits.receipt_bytes,
        );
      } catch (error) {
        if (error instanceof StorageError && error.code === "file_too_large")
          throw new IntakeError(intake.message(`${kind}_too_large`)!, { status: 413 });
        throw error;
      }
      if (!stored.size) throw new IntakeError(t("The file is empty."));
      const [upload] = await q()
        .insert(uploads)
        .values({
          id: uploadId,
          draftId: draft.id,
          expenseId,
          kind,
          originalName: baseName(file.name),
          sourceKey: key,
          size: stored.size,
          checksum: stored.checksum,
          reservedBytes: reservation,
        })
        .returning();
      await queue.enqueue("validate", upload!);
      return upload!;
    });
  } catch (error) {
    if (key) removeKeys(key);
    throw error;
  }
}

async function receiptBytes(draftId: string): Promise<number> {
  const [row] = await q()
    .select({ value: sum(uploads.size) })
    .from(uploads)
    .where(and(eq(uploads.draftId, draftId), eq(uploads.kind, "receipt")));
  return Number(row?.value ?? 0);
}

/** The receipts of one claim stay within its size and page limits. */
export function ensureReceiptsFit(receiptBytesTotal: number, receiptPages = 0) {
  const limits = intake.limits();
  if (receiptBytesTotal > limits.submission_bytes)
    throw new IntakeError(intake.message("submission_too_large")!, { status: 413 });
  if (receiptPages > limits.claim_pages)
    throw new IntakeError(intake.message("claim_pages")!, { status: 413 });
}

/** Pass the Draft gate for the upload's draft; the upload, or null if it is gone since. */
async function uploadGate(
  participant: Participant,
  formSlug: string,
  uploadId: unknown,
  token: unknown,
  action: draftGate.Action,
): Promise<Upload | null> {
  let id: string;
  try {
    id = normalizeUuid(uploadId);
  } catch {
    throw new IntakeError(t("The file was not found."), { status: 404 });
  }
  const [row] = await q()
    .select({ draftId: uploads.draftId })
    .from(uploads)
    .innerJoin(drafts, eq(uploads.draftId, drafts.id))
    .where(and(eq(uploads.id, id), formSlugCondition(formSlug)));
  if (!row) throw new IntakeError(t("The file was not found."), { status: 404 });
  await draftGate.gate(participant, formSlug, row.draftId, token, action);
  const [upload] = await q().select().from(uploads).where(eq(uploads.id, id));
  return upload ?? null;
}

/** The upload's draft belongs to the form with this slug. */
function formSlugCondition(formSlug: string): SQL {
  return inArray(
    drafts.formId,
    q().select({ id: formsTable.id }).from(formsTable).where(eq(formsTable.slug, formSlug)),
  );
}

/** The upload, if the participant may read it; IntakeError otherwise. */
export async function owned(
  participant: Participant,
  formSlug: string,
  uploadId: unknown,
  token: unknown,
): Promise<Upload> {
  const upload = await uploadGate(participant, formSlug, uploadId, token, draftGate.READ);
  if (!upload) throw new IntakeError(t("The file was not found."), { status: 404 });
  return upload;
}

export type UploadStatus = { id: string; state: string; pages: number; message: string };

export function status(upload: Upload): UploadStatus {
  return {
    id: upload.id,
    state: upload.state,
    pages: upload.pages,
    message: upload.errorCode ? intake.message(upload.errorCode, intake.message("upload_unchecked"))! : "",
  };
}

/** Remove an upload of the participant's unsubmitted draft unless it is busy. */
export function discard(
  participant: Participant,
  formSlug: string,
  uploadId: unknown,
  token: unknown,
): Promise<void> {
  return atomic(async () => {
    let upload: Upload | null;
    try {
      upload = await uploadGate(participant, formSlug, uploadId, token, draftGate.REMOVE);
    } catch (error) {
      if (error instanceof draftGate.AlreadySubmitted)
        throw new IntakeError(t("Submitted receipts cannot be changed."), { status: 409 });
      throw error;
    }
    if (!upload) return; // A concurrent removal of the same upload got the draft lock first.
    await q().select({ id: jobs.id }).from(jobs).where(eq(jobs.uploadId, upload.id)).for("update");
    if (await busy(eq(uploads.id, upload.id)))
      throw new IntakeError(t("The file is being checked. Please try again shortly."), { status: 409 });
    removeFiles(upload);
    await q().delete(uploads).where(eq(uploads.id, upload.id));
  });
}

/** The checked files of a claim, ready to attach once the claim exists. */
export class ClaimFiles {
  constructor(
    /** (upload, expense ID, position) in row order. */
    readonly receipts: Array<[Upload, string, number]>,
    readonly signature: Upload,
  ) {}

  async attach(claimId: string) {
    for (const [upload, , position] of this.receipts) {
      await q().update(uploads).set({ claimId, position }).where(eq(uploads.id, upload.id));
    }
    await q().update(uploads).set({ claimId }).where(eq(uploads.id, this.signature.id));
  }
}

function isFile(key: string): boolean {
  try {
    return statSync(pathFor(key)).isFile();
  } catch {
    return false;
  }
}

/**
 * Lock and check the draft's files for a claim before anything is written.
 *
 * Each expense row's files are receipts of that row, the signature is a signature, all
 * are ready, unattached and on disk, and the receipts fit one claim's limits. Caller
 * holds the draft lock in a transaction.
 */
export async function claimable(
  draft: Pick<Draft, "id">,
  expenseRows: Array<Pick<ExpenseEntry, "id" | "uploads">>,
  signatureId: string,
): Promise<ClaimFiles> {
  const ids = [...expenseRows.flatMap((row) => row.uploads), signatureId];
  const rows = await q()
    .select()
    .from(uploads)
    .where(and(eq(uploads.draftId, draft.id), inArray(uploads.id, ids), isNull(uploads.claimId)))
    .for("update");
  const found = new Map(rows.map((upload) => [upload.id, upload]));
  const wanted = new Set(ids);
  if (found.size !== wanted.size || [...wanted].some((id) => !found.has(id)))
    throw new IntakeError(t("A file is unavailable. Please upload it again."));
  const receipts = expenseRows.flatMap((row) =>
    row.uploads.map((fileId, position) => [found.get(fileId)!, row.id, position] as [Upload, string, number]),
  );
  if (receipts.some(([upload, expenseId]) => upload.kind !== "receipt" || upload.expenseId !== expenseId))
    throw new IntakeError(t("A receipt does not belong to this expense item."));
  const signature = found.get(signatureId)!;
  if (signature.kind !== "signature") throw new IntakeError(t("Please draw or upload a signature."));
  if ([...found.values()].some((upload) => upload.state !== "ready"))
    throw new IntakeError(t("Please wait until all receipts and the signature have been checked."));
  if ([...found.values()].some((upload) => !isFile(upload.normalizedKey)))
    throw new IntakeError(t("A file is unavailable. Please upload it again."));
  ensureReceiptsFit(
    receipts.reduce((total, [upload]) => total + upload.size, 0),
    receipts.reduce((total, [upload]) => total + upload.pages, 0),
  );
  return new ClaimFiles(receipts, signature);
}

/** Record a validation's `NormalizedUpload`. False when the upload was discarded meanwhile. */
export async function markReady(uploadId: string, output: NormalizedUpload): Promise<boolean> {
  const [upload] = await q().select().from(uploads).where(eq(uploads.id, uploadId)).for("update");
  if (!upload) return false;
  await q()
    .update(uploads)
    .set({
      normalizedKey: output.key,
      normalizedSize: output.size,
      mediaType: output.mediaType,
      pages: output.pages,
      state: "ready",
      errorCode: "",
    })
    .where(eq(uploads.id, uploadId));
  await releaseUpload(uploadId);
  return true;
}

/** Validation will run again; the pending output reservation stays admitted. */
export async function markRetrying(uploadId: string, errorCode: string) {
  await q().update(uploads).set({ state: "pending", errorCode }).where(eq(uploads.id, uploadId));
}

export async function markFailed(uploadId: string, errorCode: string) {
  await q().update(uploads).set({ state: "failed", errorCode }).where(eq(uploads.id, uploadId));
  await releaseUpload(uploadId);
}

/** Delete an expired, unsubmitted draft and its files unless an upload is busy. */
export function expireDraft(draftId: string): Promise<void> {
  return atomic(async () => {
    const [draft] = await q()
      .select()
      .from(drafts)
      .where(and(eq(drafts.id, draftId), isNull(drafts.claimId)))
      .for("update");
    if (!draft || (await busy(eq(uploads.draftId, draft.id)))) return;
    for (const upload of await q().select().from(uploads).where(eq(uploads.draftId, draft.id)))
      removeFiles(upload);
    await q().delete(drafts).where(eq(drafts.id, draft.id));
  });
}

/**
 * Accepted drafts can hold uploads left out of the claim. Each goes 24 hours after its
 * upload. Returns the number of uploads whose files could not be removed.
 */
export async function expireUnattached(now: Date): Promise<number> {
  let failures = 0;
  const unused = await q()
    .select({ upload: uploads })
    .from(uploads)
    .innerJoin(drafts, eq(uploads.draftId, drafts.id))
    .where(
      and(
        isNull(uploads.claimId),
        isNotNull(drafts.claimId),
        lt(uploads.createdAt, new Date(now.getTime() - UNACCEPTED_LIFETIME_MS)),
      ),
    );
  for (const { upload } of unused) {
    if (await busy(eq(uploads.id, upload.id))) continue;
    try {
      removeFiles(upload);
      await q().delete(uploads).where(eq(uploads.id, upload.id));
    } catch (error) {
      if (!(error instanceof Error && "code" in error)) throw error;
      failures += 1;
    }
  }
  return failures;
}
