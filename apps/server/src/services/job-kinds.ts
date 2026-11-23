/**
 * Job kinds (portal/job_kinds.py of the Django version). Each owns its
 * target's transitions for every outcome.
 *
 * A kind runs with a `Lease` (services/jobs.ts) and answers:
 * - `failure(error)`: what an exception from `run` means (code, retryable, expected).
 * - `retrying(job, code)` / `failed(job, code)`: the target's state for that outcome.
 * - `interrupted(job)`: the target's state after a worker died; returns the job's error code.
 * - `resumable`: whether an interrupted job may run again.
 */
import { eq } from "drizzle-orm";
import { config } from "../config";
import { claims, uploads, type Claim, type Job } from "../db/schema";
import { atomic, q } from "../db/tx";
import { temporaryWorkspace } from "./capacity";
import { CLAIM_STATES } from "./claim-status";
import * as confirmations from "./confirmations";
import * as delivery from "./delivery";
import { ProcessingError, buildClaimPdf, validateUpload } from "./documents";
import * as evidence from "./evidence";
import * as outbound from "./outbound";
import * as queue from "./queue";
import { ScanError, scanFile } from "./scanner";
import { claimPdfKey, pathFor, publishFile, removeKeys } from "./storage";
import { FAILED, PENDING, UNKNOWN, sendResult, type Message, type SendResult } from "./transport";
import { markFailed, markReady, markRetrying } from "./uploads";

export const INTERRUPTED = "worker_interrupted";

export type Failure = { code: string; retryable: boolean; expected: boolean };

const failure = (code: string, options: { retryable?: boolean; expected?: boolean } = {}): Failure => ({
  code,
  retryable: options.retryable ?? false,
  expected: options.expected ?? true,
});

export const UNEXPECTED = failure("processing_error", { expected: false });

/** The part of a job's lease a kind uses (services/jobs.ts). */
export interface JobLease {
  readonly token: string | null;
  live(): Promise<boolean>;
  finish(state?: string, errorCode?: string, delay?: number): Promise<void>;
  cancel(): Promise<void>;
  retry(errorCode: string, options?: { minimumDelay?: number }): Promise<boolean>;
}

export interface JobKind {
  readonly resumable: boolean;
  run(job: Job, lease: JobLease): Promise<void>;
  failure(error: unknown): Failure;
  retrying(job: Job, code: string): Promise<void>;
  failed(job: Job, code: string): Promise<void>;
  interrupted(job: Job): Promise<string>;
}

/** Scan and normalize an upload. Scanner outages retry; the upload stays pending. */
class Validate implements JobKind {
  readonly resumable = true;

  async run(job: Job, lease: JobLease) {
    const [upload] = await q().select().from(uploads).where(eq(uploads.id, job.uploadId!));
    if (!upload) throw new Error(`Upload ${job.uploadId} does not exist`);
    if (!(await atomic(() => lease.live()))) return;
    await scanFile(pathFor(upload.sourceKey));
    await validateUpload(upload, async (output) => {
      const recorded = await atomic(async () => {
        if (!(await lease.live()) || !(await markReady(upload.id, output))) return false;
        await lease.finish();
        return true;
      });
      if (recorded) output.keep();
    });
  }

  failure(error: unknown): Failure {
    if (error instanceof ScanError) return failure(error.code, { retryable: error.retryable });
    if (error instanceof ProcessingError) return failure(error.code);
    return UNEXPECTED;
  }

  async retrying(job: Job, code: string) {
    await markRetrying(job.uploadId!, code);
  }

  async failed(job: Job, code: string) {
    await markFailed(job.uploadId!, code);
  }

  async interrupted(job: Job) {
    await this.failed(job, INTERRUPTED);
    return INTERRUPTED;
  }
}

/** Build and publish a claim's authoritative PDF, then schedule its delivery. */
class Render implements JobKind {
  readonly resumable = true;
  static readonly WITHDRAWN: ReadonlySet<string> = new Set([CLAIM_STATES.PURGING]);

  async run(job: Job, lease: JobLease) {
    const claim = await atomic(async () => {
      if (!(await lease.live())) return null;
      const [locked] = await lockClaim(job.claimId!);
      if (Render.WITHDRAWN.has(locked!.state)) {
        await lease.cancel();
        return null;
      }
      await q().update(claims).set({ state: CLAIM_STATES.RENDERING }).where(eq(claims.id, locked!.id));
      return locked!;
    });
    if (!claim) return;
    await temporaryWorkspace({ claim }, async (workspace) => {
      const { path, result } = await buildClaimPdf(claim, workspace);
      await atomic(async () => {
        if (!(await lease.live())) return;
        const [current] = await lockClaim(claim.id);
        if (Render.WITHDRAWN.has(current!.state)) {
          await lease.cancel();
          return;
        }
        await this.publish(current!, path, result, claimPdfKey(current!.id, lease.token!));
        await delivery.schedule(current!);
        await lease.finish();
      });
    });
  }

  private async publish(
    claim: Claim,
    source: string,
    result: { checksum: string; size: number; pages: number },
    key: string,
  ) {
    const { size, checksum } = await publishFile(source, key, config().MAX_FINAL_PDF_BYTES);
    if (checksum !== result.checksum || size !== result.size) {
      removeKeys(key);
      throw new ProcessingError("invalid_processing_output");
    }
    await q()
      .update(claims)
      .set({
        pdfKey: key,
        pdfHash: result.checksum,
        pdfSize: result.size,
        pdfPageCount: result.pages,
        state: CLAIM_STATES.READY,
        errorCode: "",
      })
      .where(eq(claims.id, claim.id));
  }

  failure(error: unknown): Failure {
    return error instanceof ProcessingError ? failure(error.code) : UNEXPECTED;
  }

  async retrying(): Promise<void> {
    throw new Error("Rendering failures are not retried automatically");
  }

  async failed(job: Job, code: string) {
    await q()
      .update(claims)
      .set({ state: CLAIM_STATES.FAILED, errorCode: code })
      .where(eq(claims.id, job.claimId!));
  }

  async interrupted(job: Job) {
    await this.failed(job, INTERRUPTED);
    return INTERRUPTED;
  }
}

function lockClaim(claimId: string) {
  return q().select().from(claims).where(eq(claims.id, claimId)).for("update");
}

/** Operator retry of a locked claim whose PDF was never produced. */
export async function requeueRender(claim: Pick<Claim, "id">) {
  await q()
    .update(claims)
    .set({ state: CLAIM_STATES.RECEIVED, errorCode: "" })
    .where(eq(claims.id, claim.id));
  await queue.enqueue("render", claim, { again: true });
}

/**
 * Send one email at most once: reserve it, transmit it outside any
 * transaction, then record the result. Only a send the provider refused
 * before acceptance (PENDING) is retried. Once the provider may hold the
 * message, nothing is sent again automatically.
 *
 * A sender names its record: `reserve(job)` returns the record of the email to
 * send, or null when nothing may be sent now; `compose(reserved)` its message;
 * `record(job, reserved, result)`; and `unknown(job, code)` for a send that
 * ended without a result.
 */
abstract class Email<R extends { id: string }> implements JobKind {
  readonly resumable = false;

  abstract reserve(job: Job): Promise<R | null>;
  abstract compose(reserved: R): Promise<Message>;
  abstract record(job: Job, reserved: R, result: SendResult): Promise<void>;
  abstract unknown(job: Job, code: string): Promise<void>;

  async run(job: Job, lease: JobLease) {
    const reserved = await atomic(async () => {
      if (!(await lease.live())) return null;
      const found = await this.reserve(job);
      if (!found) await lease.cancel();
      return found;
    });
    if (!reserved) return;
    const result = await outbound.send((email: R) => this.compose(email), reserved);
    await atomic(async () => {
      await this.record(job, reserved, result);
      if (result.state === PENDING) {
        if (!(await lease.retry(result.errorCode, { minimumDelay: result.retryAfter }))) {
          await this.record(job, reserved, sendResult(FAILED, { errorCode: "retry_exhausted" }));
          await lease.finish(queue.FAILED, "retry_exhausted");
        }
      } else if (result.state === FAILED || result.state === UNKNOWN) {
        await lease.finish(queue.FAILED, result.errorCode);
      } else {
        await lease.finish(queue.DONE, result.errorCode);
      }
    });
    await this.sent();
  }

  /** After a send's result is recorded. */
  async sent(): Promise<void> {}

  failure(): Failure {
    // Any exception around a provider call leaves the outcome unknown.
    return UNEXPECTED;
  }

  async retrying(): Promise<void> {
    throw new Error("Emails are not retried after an unexpected failure");
  }

  async failed(job: Job) {
    await this.unknown(job, "unexpected_send_failure");
  }

  async interrupted(job: Job) {
    await this.unknown(job, INTERRUPTED);
    return UNKNOWN;
  }
}

/** One attempt to deliver a claim's PDF to Finance. */
class Send extends Email<{ id: string; deliveryId: number }> {
  reserve(job: Job) {
    return delivery.startAttempt(job.deliveryId!);
  }

  compose(attempt: { id: string; deliveryId: number }) {
    return delivery.compose(attempt);
  }

  record(_job: Job, attempt: { id: string }, result: SendResult) {
    return delivery.recordResult(attempt.id, result);
  }

  unknown(job: Job, code: string) {
    return delivery.markUnknown(job.deliveryId!, code);
  }

  override async sent() {
    // Provider evidence can arrive before its attempt's send result.
    await evidence.reconcileUnmatched();
  }
}

/** The participant's confirmation of receipt, independent of Finance delivery. */
class Confirm extends Email<{ id: string; claimId: string }> {
  reserve(job: Job) {
    return confirmations.start(job.claimId!);
  }

  compose(confirmation: { id: string; claimId: string }) {
    return confirmations.compose(confirmation);
  }

  record(job: Job, _confirmation: { id: string }, result: SendResult) {
    return confirmations.record(job.claimId!, result);
  }

  unknown(job: Job, code: string) {
    return confirmations.record(job.claimId!, sendResult(UNKNOWN, { errorCode: code }));
  }
}

export const VALIDATE = new Validate();
export const RENDER = new Render();
export const SEND = new Send();
export const CONFIRM = new Confirm();

export const KINDS: Readonly<Record<string, JobKind>> = {
  validate: VALIDATE,
  render: RENDER,
  send: SEND,
  confirm: CONFIRM,
};
