/**
 * Upload admission and the participant's upload requests
 * (tests/test_upload_admission.py and the HTTP parts of tests/test_resource_limits.py).
 */
import { chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { translate } from "@reimbursements/shared/i18n";
import { getDb } from "../db/client";
import { draftAdmissions, drafts, jobs, uploads, workspaceReservations } from "../db/schema";
import { blankPdf, imageBytes } from "../documents/test-files";
import { IntakeError, message } from "../intake";
import { loadForm } from "../models";
import { createForm } from "../test/fixtures";
import { CookieJar, eventually, peer, request, testApp, type TestResponse } from "../test/helpers";
import {
  TestParticipant,
  freshIntake,
  intakeSettings,
  openForm,
  prepared,
  storageDirectory,
  uploadFile,
  uploadRequest,
  type Prepared,
} from "../test/intake";
import { disk } from "./capacity";
import { openDraft } from "./drafts";
import { runOne } from "./jobs";
import { chargeDraft, chargeUpload } from "./network-budget";
import { pathFor } from "./storage";
import * as uploadService from "./uploads";

type Opened = { participant: TestParticipant; draftId: string; token: string; file: string };

let counter = 0;

async function opened(): Promise<Opened> {
  const form = await createForm();
  const participant = new TestParticipant();
  const { draft, token } = await openDraft(participant, (await loadForm({ id: form.id }))!);
  return { participant, draftId: draft.id, token, file: "" };
}

/** A received file waiting in the private storage, as the upload route leaves it. */
async function received(
  kind: "receipt" | "signature",
  content?: Uint8Array,
): Promise<uploadService.ReceivedFile> {
  const bytes = content ?? (await imageBytes({ signature: kind === "signature" }));
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const directory = path.join(storageDirectory(), "incoming");
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `test-${(counter += 1)}`);
  writeFileSync(file, bytes);
  return { name: `${kind}.png`, size: bytes.length, path: file };
}

async function accept(
  current: Opened,
  options: { kind?: "receipt" | "signature"; truncated?: boolean } = {},
) {
  const kind = options.kind ?? "receipt";
  return uploadService.accept(current.participant, "test", {
    file: await received(kind),
    kind,
    expenseId: kind === "receipt" ? "6f6d3e0a-6a5f-4d3b-9d64-1d2d0f6a1c11" : null,
    draftId: current.draftId,
    token: current.token,
    truncated: options.truncated,
  });
}

async function refused(
  current: Opened,
  status: number,
  code: string,
  options: { kind?: "receipt" | "signature"; truncated?: boolean } = {},
) {
  const error = await accept(current, options).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(IntakeError);
  expect([(error as IntakeError).status, (error as IntakeError).message]).toEqual([status, message(code)]);
  expect(await getDb().$count(uploads)).toBe(0);
}

describe("upload admission", () => {
  beforeEach(async () => {
    await freshIntake();
  });

  it.each(["receipt", "signature"] as const)(
    "a file stopped at the receipt limit gets its kind's limit: %s",
    async (kind) => {
      await refused(await opened(), 413, `${kind}_too_large`, { kind, truncated: true });
    },
  );

  it("a signature above its limit is named as a signature", async () => {
    const current = await opened();
    intakeSettings({ MAX_SIGNATURE_BYTES: 10 });
    await refused(current, 413, "signature_too_large", { kind: "signature" });
  });

  it("the receipts of a draft stay within the submission size", async () => {
    const current = await opened();
    intakeSettings({ MAX_SUBMISSION_BYTES: 10 });
    await refused(current, 413, "submission_too_large");
  });

  it("work budgets refuse with intake messages", async () => {
    const current = await opened();
    intakeSettings({ MAX_UPLOADS_PER_NETWORK: 0 });
    await refused(current, 429, "network_work_limit");
    intakeSettings({ MAX_UPLOADS_PER_NETWORK: 10, MAX_UPLOADS_PER_DRAFT: 0 });
    await refused(current, 429, "draft_work_limit");
  });

  it("a busy service refuses with the capacity message", async () => {
    const current = await opened();
    intakeSettings({ MAX_PENDING_VALIDATIONS: 0 });
    await refused(current, 503, "upload_capacity");
  });

  it("a refused upload does not spend the network budget", async () => {
    const current = await opened();
    intakeSettings({ MAX_PENDING_VALIDATIONS: 0 });
    await refused(current, 503, "upload_capacity");
    expect((await getDb().select().from(draftAdmissions))[0]!.uploadCount).toBe(0);
    intakeSettings({ MAX_PENDING_VALIDATIONS: 10 });
    await accept(current);
    expect((await getDb().select().from(draftAdmissions))[0]!.uploadCount).toBe(1);
  });

  it("the network budget owns both of its windows", async () => {
    intakeSettings({ MAX_UPLOADS_PER_NETWORK_PER_MINUTE: 1, MAX_DRAFTS_PER_NETWORK: 1 });
    const network = "198.51.100.0/32";
    const { atomic } = await import("../db/tx");
    expect(await atomic(() => chargeUpload(network, 5))).toBe(true);
    expect(await atomic(() => chargeUpload(network, 5))).toBe(false);
    await getDb()
      .update(draftAdmissions)
      .set({ uploadWindowStart: new Date(Date.now() - 2 * 60 * 1000) });
    expect(await atomic(() => chargeUpload(network, 5))).toBe(true);
    expect(await chargeDraft(network)).toBe(true);
    expect(await chargeDraft(network)).toBe(false);
    await getDb()
      .update(draftAdmissions)
      .set({ windowStart: new Date(Date.now() - 25 * 3600 * 1000) });
    expect(await chargeDraft(network)).toBe(true);
    expect((await getDb().select().from(draftAdmissions))[0]!.uploadBytes).toBe(0);
  });

  it("uploads wait while the private storage is unavailable", async () => {
    const current = await opened();
    intakeSettings({ MIN_FREE_STORAGE_BYTES: Number.MAX_SAFE_INTEGER });
    await refused(current, 503, "upload_unavailable");
  });

  it("an accepted upload is stored and queued for validation", async () => {
    const current = await opened();
    const upload = await accept(current);
    expect(upload.state).toBe("pending");
    expect(upload.originalName).toBe("receipt.png");
    expect(upload.reservedBytes).toBe(10_000_000);
    const [job] = await getDb().select().from(jobs).where(eq(jobs.uploadId, upload.id));
    expect(job!.kind).toBe("validate");
    const [draft] = await getDb().select().from(drafts).where(eq(drafts.id, current.draftId));
    expect([draft!.uploadCount, draft!.uploadBytes]).toEqual([1, upload.size]);
    // The received file is copied; its source key is the stored one.
    expect(readdirSync(path.dirname(pathFor(upload.sourceKey)))).toEqual([path.basename(upload.sourceKey)]);
  });

  it("a file of another type or extension is refused", async () => {
    const current = await opened();
    const file = await received("receipt");
    const error = await uploadService
      .accept(current.participant, "test", {
        file: { ...file, name: "receipt.gif" },
        kind: "receipt",
        expenseId: crypto.randomUUID(),
        draftId: current.draftId,
        token: current.token,
      })
      .catch((caught: unknown) => caught);
    expect((error as IntakeError).message).toBe(message("unsupported_type"));
    const missing = await uploadService
      .accept(current.participant, "test", {
        file: await received("receipt"),
        kind: "receipt",
        expenseId: "",
        draftId: current.draftId,
        token: current.token,
      })
      .catch((caught: unknown) => caught);
    expect((missing as IntakeError).message).toBe("Die Auslagenposition fehlt.");
  });

  it("a draft holds at most the files of its expenses and signature attempts", async () => {
    const current = await opened();
    intakeSettings({ MAX_FILES_PER_EXPENSE: 1 });
    await accept(current);
    const error = await accept(current).catch((caught: unknown) => caught);
    expect((error as IntakeError).message).toBe("Bitte entferne zuerst eine vorhandene Datei.");
    for (let attempt = 0; attempt < 3; attempt += 1) await accept(current, { kind: "signature" });
    const fourth = await accept(current, { kind: "signature" }).catch((caught: unknown) => caught);
    expect((fourth as IntakeError).status).toBe(400);
  });
});

describe("upload requests", () => {
  let current: Prepared;
  beforeEach(async () => {
    await freshIntake();
    current = await prepared();
  });

  it("an upload answers 202 with its state, then reports its validation", async () => {
    const response = await uploadFile(current);
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ state: "pending", name: "receipt.png" });
    const pending = await uploadRequest(current, "GET", response.body.id);
    expect(pending.body).toEqual({ id: response.body.id, state: "pending", pages: 0, message: "" });
    expect(await runOne()).toBe(true);
    const ready = await uploadRequest(current, "GET", response.body.id);
    expect(ready.body).toMatchObject({ state: "ready", pages: 1, message: "" });
  });

  it("an invalid file fails with its message", async () => {
    const response = await uploadFile(current, { content: Buffer.from("invalid image") });
    expect(await runOne()).toBe(true);
    const failed = await uploadRequest(current, "GET", response.body.id);
    expect(failed.body.state).toBe("failed");
    expect(failed.body.message).toBe(message("unsupported_type"));
  });

  it.each(["receipt", "signature"] as const)(
    "a replacement does not refund the processing budget: %s",
    async (kind) => {
      intakeSettings({ MAX_UPLOADS_PER_DRAFT: 2 });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await uploadFile(current, { kind });
        expect(response.status).toBe(202);
        expect(await runOne()).toBe(true);
        expect((await uploadRequest(current, "DELETE", response.body.id)).status).toBe(200);
      }
      expect((await uploadFile(current, { kind })).status).toBe(429);
      const [draft] = await getDb().select().from(drafts).where(eq(drafts.id, current.draft.id));
      expect(draft!.uploadCount).toBe(2);
      expect((await getDb().select().from(draftAdmissions))[0]!.uploadCount).toBe(2);
      expect(await getDb().$count(workspaceReservations)).toBe(0);
    },
  );

  it("a failed validation also consumes the work budget", async () => {
    intakeSettings({ MAX_UPLOADS_PER_DRAFT: 1 });
    const response = await uploadFile(current, { content: Buffer.from("invalid image") });
    expect(await runOne()).toBe(true);
    const [item] = await getDb().select().from(uploads).where(eq(uploads.id, response.body.id));
    expect([item!.state, item!.reservedBytes]).toEqual(["failed", 0]);
    expect((await uploadRequest(current, "DELETE", response.body.id)).status).toBe(200);
    expect((await uploadFile(current)).status).toBe(429);
  });

  it("the network upload budget survives new cookies and rolls over", async () => {
    intakeSettings({ MAX_UPLOADS_PER_NETWORK: 1 });
    expect((await uploadFile(current)).status).toBe(202);
    const other = new CookieJar();
    const page = await openForm(other);
    expect(page.status).toBe(200);
    const [draft] = await getDb().select().from(drafts).where(eq(drafts.id, page.body.draft.id));
    const otherPrepared = {
      ...current,
      jar: other,
      draft: draft!,
      data: { ...current.data, token: page.body.draft.token },
    };
    expect((await uploadFile(otherPrepared)).status).toBe(429);
    await getDb()
      .update(draftAdmissions)
      .set({ windowStart: new Date(Date.now() - 25 * 3600 * 1000) });
    expect((await uploadFile(otherPrepared)).status).toBe(202);
    expect((await getDb().select().from(draftAdmissions))[0]!.uploadCount).toBe(1);
  });

  it("normalized bytes are measured and reserved before conversion", async () => {
    const sharp = (await import("sharp")).default;
    const pixels = Buffer.alloc(1000 * 1000 * 3);
    for (let y = 0; y < 1000; y += 1)
      for (let x = 0; x < 1000; x += 1)
        if ((x + y) % 2) pixels.fill(255, (y * 1000 + x) * 3, (y * 1000 + x) * 3 + 3);
    const content = await sharp(pixels, { raw: { width: 1000, height: 1000, channels: 3 } })
      .png()
      .toBuffer();
    const response = await uploadFile(current, { content });
    let [item] = await getDb().select().from(uploads).where(eq(uploads.id, response.body.id));
    expect(item!.reservedBytes).toBe(10_000_000);
    expect(await runOne()).toBe(true);
    [item] = await getDb().select().from(uploads).where(eq(uploads.id, response.body.id));
    expect(item!.state, item!.errorCode).toBe("ready");
    const { statSync } = await import("node:fs");
    expect(item!.normalizedSize).toBe(statSync(pathFor(item!.normalizedKey)).size);
    expect(item!.normalizedSize).toBeGreaterThan(item!.size * 10);
    expect(item!.reservedBytes).toBe(0);
    expect(await getDb().$count(workspaceReservations)).toBe(0);
  });

  it("the backlog is checked before the source is published", async () => {
    intakeSettings({ MAX_PENDING_VALIDATIONS: 1 });
    expect((await uploadFile(current)).status).toBe(202);
    const sources = () =>
      readdirSync(storageDirectory(), { recursive: true })
        .filter((name) => String(name).includes("source"))
        .sort();
    const before = sources();
    expect((await uploadFile(current)).status).toBe(503);
    expect(sources()).toEqual(before);
  });

  /** The multipart body of an upload, split where a test holds it open. */
  function multipart(
    current: Prepared,
    content: Uint8Array,
  ): { head: Uint8Array; tail: Uint8Array; type: string } {
    const boundary = "----reimbursements-test";
    const field = (name: string, value: string) =>
      `--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    const head =
      field("draft_id", current.draft.id) +
      field("token", current.data.token) +
      field("expense_id", current.data.expenses[0].id) +
      field("kind", "receipt") +
      `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="receipt.png"\r\n` +
      "content-type: application/octet-stream\r\n\r\n";
    const half = Math.floor(content.length / 2);
    return {
      head: Buffer.concat([Buffer.from(head), content.subarray(0, half)]),
      tail: Buffer.concat([content.subarray(half), Buffer.from(`\r\n--${boundary}--\r\n`)]),
      type: `multipart/form-data; boundary=${boundary}`,
    };
  }

  /** An upload whose body (without a declared length) arrives in two parts: the second when `finish` is called. */
  function heldUpload(current: Prepared, parts: ReturnType<typeof multipart>) {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(parts.head);
        await finished;
        controller.enqueue(parts.tail);
        controller.close();
      },
    });
    const response = testApp().request(
      "/api/v1/public/forms/test/uploads",
      {
        method: "POST",
        headers: {
          origin: "http://localhost:8000",
          "content-type": parts.type,
          cookie: current.jar.header() ?? "",
        },
        body,
        duplex: "half",
      } as RequestInit,
      peer(),
    );
    return { response, finish };
  }

  const spools = () => {
    const incoming = path.join(storageDirectory(), "incoming");
    return existsSync(incoming) ? readdirSync(incoming).filter((name) => name.startsWith("upload-")) : [];
  };

  // Review I1/F10: a body without a declared length is spooled as it arrives, and
  // no more bodies are read at once than the reserved headroom covers.
  it("uploads are read one slot at a time, as they arrive", async () => {
    intakeSettings({ TOTAL_WEB_WORKERS: 1 });
    const first = heldUpload(current, multipart(current, await imageBytes()));
    await eventually(async () => (spools().length === 1 ? true : undefined), 5000);
    let second: TestResponse | undefined;
    const waiting = uploadFile(current).then((response) => (second = response));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(second).toBeUndefined();
    expect(spools()).toHaveLength(1);
    first.finish();
    expect((await first.response).status).toBe(202);
    await waiting;
    expect(second!.status).toBe(202);
    expect(spools()).toEqual([]);
  });

  it("a body without a declared length above the limit is refused while it arrives", async () => {
    intakeSettings({ MAX_RECEIPT_BYTES: 1000 });
    const parts = multipart(current, Buffer.alloc(400_000, 1));
    const held = heldUpload(current, parts);
    held.finish();
    const response = await held.response;
    expect(response.status).toBe(413);
    expect(spools()).toEqual([]);
  });

  // Review I2: a temporary file that cannot be written is an invalid request, not a crash.
  it("a failing temporary file is an invalid request without an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    const incoming = path.join(storageDirectory(), "incoming");
    mkdirSync(path.join(incoming, ".slots"), { recursive: true });
    chmodSync(incoming, 0o500);
    try {
      const response = await uploadFile(current, { content: Buffer.alloc(300_000, 1) });
      expect(response.status).toBe(400);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(unhandled).toEqual([]);
    } finally {
      chmodSync(incoming, 0o700);
      process.off("unhandledRejection", record);
    }
  });

  it("a file larger than the receipt limit is refused as too large", async () => {
    intakeSettings({ MAX_RECEIPT_BYTES: 1000 });
    const response = await uploadFile(current, { content: Buffer.alloc(5000, 1) });
    expect(response.status).toBe(413);
    expect(response.body.error.message).toBe(message("receipt_too_large"));
    expect(await getDb().$count(uploads, eq(uploads.draftId, current.draft.id))).toBe(2);
  });

  it("a PDF receipt is stored with its own name and checked", async () => {
    const response = await uploadFile(current, { content: await blankPdf(), name: "Rechnung März.pdf" });
    expect(response.status).toBe(202);
    expect(response.body.name).toBe("Rechnung März.pdf");
    expect(await runOne()).toBe(true);
    expect((await uploadRequest(current, "GET", response.body.id)).body.state).toBe("ready");
  });

  it("an upload being checked cannot be removed", async () => {
    const response = await uploadFile(current);
    await getDb().update(jobs).set({ state: "running" }).where(eq(jobs.uploadId, response.body.id));
    const removal = await uploadRequest(current, "DELETE", response.body.id);
    expect(removal.status).toBe(409);
    expect(removal.body.error.message).toBe(
      translate("de", "The file is being checked. Please try again shortly."),
    );
    expect(await getDb().$count(uploads, eq(uploads.id, response.body.id))).toBe(1);
  });

  it("submitted receipts cannot be removed", async () => {
    const receiptId = current.data.expenses[0].uploads[0];
    const { post } = await import("../test/intake");
    expect((await post(current)).status).toBe(202);
    const removal = await uploadRequest(current, "DELETE", receiptId);
    expect(removal.status).toBe(409);
    expect(removal.body.error.message).toBe(translate("de", "Submitted receipts cannot be changed."));
  });

  it("another browser cannot see or remove an upload", async () => {
    const receiptId = current.data.expenses[0].uploads[0];
    const other = await request("DELETE", `/api/v1/public/forms/test/uploads/${receiptId}`, {
      jar: new CookieJar(),
      headers: { "x-draft-token": current.data.token },
    });
    expect(other.status).toBe(404);
    const wrongToken = await request("GET", `/api/v1/public/forms/test/uploads/${receiptId}`, {
      jar: current.jar,
      headers: { "x-draft-token": "wrong" },
    });
    expect(wrongToken.status).toBe(404);
    expect(await getDb().$count(uploads, and(eq(uploads.id, receiptId)))).toBe(1);
  });

  it("competing drafts cannot reserve the same last space", async () => {
    const jars = [new CookieJar(), new CookieJar()];
    const pages: Array<Awaited<ReturnType<typeof openForm>>> = [];
    for (const jar of jars) pages.push(await openForm(jar));
    const content = await imageBytes();
    const settings = (await import("../config")).config();
    const original = disk.free;
    disk.free = () => settings.UPLOAD_TEMP_HEADROOM_BYTES + 10_000_000 + content.length * 2;
    try {
      const statuses = await Promise.all(
        jars.map((jar, index) => {
          const body = new FormData();
          body.append("draft_id", pages[index]!.body.draft.id);
          body.append("token", pages[index]!.body.draft.token);
          body.append("kind", "receipt");
          body.append("expense_id", crypto.randomUUID());
          body.append("file", new Blob([new Uint8Array(content)]), "receipt.png");
          return request("POST", "/api/v1/public/forms/test/uploads", { jar, body }).then(
            (answer) => answer.status,
          );
        }),
      );
      expect(statuses.sort()).toEqual([202, 503]);
    } finally {
      disk.free = original;
    }
    expect(await getDb().$count(uploads, eq(uploads.kind, "receipt"))).toBe(2);
    expect((await getDb().select().from(draftAdmissions))[0]!.uploadCount).toBe(1);
  });
});
