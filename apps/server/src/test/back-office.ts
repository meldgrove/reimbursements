import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import { overrideConfigForTests, type Config } from "../config";
import { getDb } from "../db/client";
import {
  claims,
  confirmations,
  deliveries,
  drafts,
  expenses,
  forms,
  jobs,
  uploads,
  type Claim,
  type Delivery,
  type Form,
  type Job,
  type Upload,
} from "../db/schema";
import { imageBytes } from "../documents/test-files";
import { withTemplate } from "../models";
import type { Participant } from "../participants";
import { openDraft } from "../services/drafts";
import { accept as acceptUpload } from "../services/uploads";
import { disk } from "../services/capacity";
import { outboxKey, pathFor } from "../services/storage";
import * as terms from "../services/terms";
import { createForm } from "./fixtures";
import { resetDatabase } from "./helpers";

/**
 * Fixtures of the back-office tests (the Django version's conftest.py:
 * `local_settings`, `accepted` and `delivery`). The claim is written as the
 * submission writes it, so these tests do not depend on the participant API.
 */

let root: string | undefined;

/** The settings of every test (conftest's local_settings), with a private storage of its own. */
export function localSettings(values: Partial<Config> = {}) {
  root ??= mkdtempSync(path.join(os.tmpdir(), "back-office-"));
  return overrideConfigForTests({
    PRIVATE_STORAGE_ROOT: root,
    MIN_FREE_STORAGE_BYTES: 0,
    UPLOAD_SCANNER: "disabled",
    MAIL_DELIVERY_MODE: "local",
    APPROVED_DELIVERY_RECIPIENTS: ["finance@example.invalid"],
    TEST_RECIPIENT_ALLOWLIST: [],
    MAIL_FROM_ADDRESS: "no-reply@example.invalid",
    MAIL_REPLY_TO_ADDRESS: "finance@example.invalid",
    // As set in the environment; tests that send with "mailersend" mode use it. Tests of
    // Admin > Email clear it.
    MAILERSEND_API_TOKEN: "synthetic-test-token",
    ...values,
  });
}

/** A fresh database and storage for each test. */
export async function freshState() {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  localSettings();
  await resetDatabase();
}

export function storageDirectory(): string {
  return root!;
}

/** Writes a stored artifact. */
export function store(key: string, content: Uint8Array) {
  const file = pathFor(key);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

export type Accepted = { claim: Claim; form: Form; draftId: string; receiptId: string; signatureId: string };

/**
 * An accepted claim as `submit_claim` leaves it: a numbered claim of the
 * published form "test" with one receipt item of 12.50 EUR, its receipt and
 * signature uploads ready and attached, the draft accepted, a render job, a
 * confirmation and its job (conftest's `prepared` + `accepted`).
 */
export async function accepted(values: Partial<typeof claims.$inferInsert> = {}): Promise<Accepted> {
  const form = await createForm();
  const full = await withTemplate(form);
  const snapshot = terms.snapshot(full, await terms.of(full));
  const [draft] = await getDb()
    .insert(drafts)
    .values({
      formId: form.id,
      sessionHash: "a".repeat(64),
      tokenHash: "b".repeat(64),
      revision: String(snapshot.revision),
    })
    .returning();
  const submittedAt = new Date();
  const [claim] = await getDb()
    .insert(claims)
    .values({
      formId: form.id,
      fullName: "Alex Beispiel",
      email: "participant@example.invalid",
      street: "Teststraße 1",
      postalCode: "12345",
      city: "Berlin",
      country: "DE",
      accountHolder: "Alex Beispiel",
      iban: "DE89370400440532013000",
      bic: "",
      purpose: "Teilnahme am synthetischen Workshop",
      tripDestination: "Berlin",
      tripStart: "2026-10-20",
      tripEnd: "2026-10-21",
      submittedAt,
      bookkeepingReference: `TEST-${randomUUID().slice(0, 8)}`,
      snapshot,
      total: "12.50",
      resolutionDue: new Date(submittedAt.getTime() + 90 * 24 * 3600 * 1000),
      ...values,
    })
    .returning();
  const expenseId = randomUUID();
  await getDb().insert(expenses).values({
    id: expenseId,
    claimId: claim!.id,
    position: 0,
    merchant: "Belegverkauf",
    purpose: "Workshop-Anreise",
    receiptReference: "TEST-1",
    amount: "12.50",
  });
  const ids: Record<"receipt" | "signature", string> = { receipt: randomUUID(), signature: randomUUID() };
  for (const kind of ["receipt", "signature"] as const) {
    const content = await imageBytes({ signature: kind === "signature" });
    const key = `uploads/${ids[kind]}/normalized.png`;
    store(key, content);
    await getDb()
      .insert(uploads)
      .values({
        id: ids[kind],
        draftId: draft!.id,
        claimId: claim!.id,
        kind,
        expenseId: kind === "receipt" ? expenseId : null,
        originalName: `${kind}.png`,
        sourceKey: key,
        normalizedKey: key,
        size: content.length,
        checksum: createHash("sha256").update(content).digest("hex"),
        state: "ready",
        mediaType: "image/png",
        pages: 1,
      });
  }
  await getDb()
    .update(drafts)
    .set({ claimId: claim!.id, payloadHash: "c".repeat(64) })
    .where(eq(drafts.id, draft!.id));
  await getDb()
    .insert(jobs)
    .values({ key: `render:${claim!.id}`, kind: "render", claimId: claim!.id });
  await getDb().insert(confirmations).values({ claimId: claim!.id });
  await getDb()
    .insert(jobs)
    .values({ key: `confirm:${claim!.id}`, kind: "confirm", claimId: claim!.id });
  return { claim: claim!, form, draftId: draft!.id, receiptId: ids.receipt, signatureId: ids.signature };
}

export const SYNTHETIC_PDF = Buffer.from("%PDF-1.4 synthetic provider unit fixture");

/** An accepted claim with a ready synthetic PDF, a delivery and no queued jobs (conftest's `delivery`). */
export async function readyDelivery(): Promise<{ delivery: Delivery; claim: Claim; accepted: Accepted }> {
  const result = await accepted();
  await getDb().delete(jobs);
  store("pdf/test.pdf", SYNTHETIC_PDF);
  const [claim] = await getDb()
    .update(claims)
    .set({
      state: "ready",
      pdfKey: "pdf/test.pdf",
      pdfHash: createHash("sha256").update(SYNTHETIC_PDF).digest("hex"),
      pdfSize: SYNTHETIC_PDF.length,
    })
    .where(eq(claims.id, result.claim.id))
    .returning();
  const [delivery] = await getDb()
    .insert(deliveries)
    .values({ claimId: claim!.id, recipient: "finance@example.invalid" })
    .returning();
  return { delivery: delivery!, claim: claim!, accepted: result };
}

export async function claimRow(id: string): Promise<Claim> {
  const [row] = await getDb().select().from(claims).where(eq(claims.id, id));
  return row!;
}

export async function deliveryRow(id: number): Promise<Delivery> {
  const [row] = await getDb().select().from(deliveries).where(eq(deliveries.id, id));
  return row!;
}

/** The local outbox's .eml of an email record, decoded enough to read: headers and text parts. */
export function readOutbox(id: string): {
  headers: Record<string, string>;
  text: string;
  attachment: Buffer | null;
  filename: string;
} {
  const raw = readFileSync(pathFor(outboxKey(id)), "utf8");
  return parseEml(raw);
}

function decodeWord(value: string): string {
  return value.replace(/=\?utf-8\?b\?([^?]*)\?=/gi, (_, encoded: string) =>
    Buffer.from(encoded, "base64").toString("utf8"),
  );
}

/** A small parser for the .eml files this app writes (services/transport.ts). */
export function parseEml(raw: string) {
  const [head, ...rest] = raw.split("\r\n\r\n");
  const headers: Record<string, string> = {};
  for (const line of head!.split("\r\n")) {
    const at = line.indexOf(":");
    headers[line.slice(0, at).toLowerCase()] = decodeWord(line.slice(at + 1).trim());
  }
  const body = rest.join("\r\n\r\n");
  const boundary = /boundary="([^"]+)"/.exec(headers["content-type"] ?? "")?.[1];
  const parts = boundary
    ? body
        .split(`--${boundary}`)
        .slice(1, -1)
        .map((part) => part.replace(/^\r\n/, ""))
    : [
        `${Object.entries(headers)
          .map(([key, value]) => `${key}: ${value}`)
          .join("\r\n")}\r\n\r\n${body}`,
      ];
  let text = "";
  let attachment: Buffer | null = null;
  let filename = "";
  for (const part of parts) {
    const [partHead, ...partBody] = part.split("\r\n\r\n");
    const content = Buffer.from(partBody.join("\r\n\r\n").replace(/\r\n/g, ""), "base64");
    if (/content-type: text\/plain/i.test(partHead!)) text = content.toString("utf8");
    if (/content-type: application\/pdf/i.test(partHead!)) {
      attachment = content;
      filename = decodeWord(/filename="([^"]*)"/.exec(partHead!)?.[1] ?? "");
    }
  }
  return { headers, text, attachment, filename };
}

/**
 * Runs a CLI command (Django's call_command) and returns what it printed. A
 * refusal throws, as call_command raised CommandError.
 */
export async function callCommand(name: string, args: string[] = []): Promise<string> {
  const { COMMANDS } = await import("../commands");
  const command = COMMANDS.get(name);
  if (!command) throw new Error(`No command ${name}`);
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    await command.run(args);
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

/** An in-memory participant: a browser session and its remembered drafts (conftest's Participant). */
export class TestParticipant implements Participant {
  session: string | null = null;
  readonly memory = new Map<string, { id: string; token: string }>();
  constructor(readonly network = "192.0.2.1/32") {}

  async binding(options: { create?: boolean } = {}) {
    if (this.session === null && options.create) this.session = randomUUID().replaceAll("-", "");
    return this.session;
  }

  async remembered(formSlug: string) {
    return this.memory.get(formSlug) ?? null;
  }

  async remember(formSlug: string, draftId: string, token: string) {
    this.memory.set(formSlug, { id: draftId, token });
  }
}

/**
 * A receipt the participant uploaded to an open draft of the form "test",
 * waiting for its validation job (the Django tests' upload request with
 * `prepared` and `uploaded_file`).
 */
export async function queuedUpload(): Promise<{ upload: Upload; job: Job; participant: TestParticipant }> {
  const [existing] = await getDb().select().from(forms).where(eq(forms.slug, "test"));
  const form = existing ?? (await createForm());
  const participant = new TestParticipant();
  const { draft, token } = await openDraft(participant, await withTemplate(form));
  const incoming = path.join(storageDirectory(), `incoming-${randomUUID()}.png`);
  const content = await imageBytes();
  writeFileSync(incoming, content);
  const upload = await acceptUpload(participant, form.slug, {
    file: { name: "receipt.png", size: content.length, path: incoming },
    kind: "receipt",
    expenseId: randomUUID(),
    draftId: draft.id,
    token,
  });
  const [job] = await getDb().select().from(jobs).where(eq(jobs.uploadId, upload.id));
  return { upload, job: job!, participant };
}

/** A port on this machine where nothing listens (an unreachable scanner). */
export async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * A fixed-size disk (conftest's FakeDisk); `workspaceFree` models a separate
 * tmpfs at private/work. Undone by vi.restoreAllMocks().
 */
export function fakeDisk(free: number, options: { workspaceFree?: number } = {}) {
  vi.spyOn(disk, "free").mockImplementation((target: string) =>
    options.workspaceFree !== undefined && path.basename(target) === "work" ? options.workspaceFree : free,
  );
  vi.spyOn(disk, "shared").mockImplementation(() => options.workspaceFree === undefined);
}
