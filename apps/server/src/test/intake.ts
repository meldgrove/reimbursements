/**
 * Fixtures of the intake tests (the Django version's tests/conftest.py:
 * `Participant`, `local_settings`, `prepared`, and the helpers `post`,
 * `validate`, `upload_file` and `mileage_row` of its test modules). Requests
 * go through the participant API with a browser's cookies, as the Django
 * test client did.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { overrideConfigForTests, type Config } from "../config";
import { getDb } from "../db/client";
import { drafts, uploads, type Draft, type Form } from "../db/schema";
import { imageBytes } from "../documents/test-files";
import type { Participant } from "../participants";
import { pathFor } from "../services/storage";
import { createForm } from "./fixtures";
import { CookieJar, request, resetDatabase, type TestResponse } from "./helpers";

/** An in-memory participant: a browser session and its remembered drafts. */
export class TestParticipant implements Participant {
  memory = new Map<string, { id: string; token: string }>();

  constructor(
    readonly network = "192.0.2.1/32",
    public session: string | null = null,
  ) {}

  async binding(options: { create?: boolean } = {}): Promise<string | null> {
    if (this.session === null && options.create) this.session = randomUUID().replaceAll("-", "");
    return this.session;
  }

  async remembered(formSlug: string) {
    return this.memory.get(formSlug) ?? null;
  }

  async remember(formSlug: string, draftId: string, token: string) {
    this.memory.set(formSlug, { id: String(draftId), token });
  }
}

let root: string | undefined;

/** The settings of every intake test (conftest's local_settings), with a private storage of its own. */
export function intakeSettings(values: Partial<Config> = {}) {
  root ??= mkdtempSync(path.join(os.tmpdir(), "intake-"));
  return overrideConfigForTests({
    PRIVATE_STORAGE_ROOT: root,
    MIN_FREE_STORAGE_BYTES: 0,
    UPLOAD_SCANNER: "disabled",
    MAIL_DELIVERY_MODE: "local",
    APPROVED_DELIVERY_RECIPIENTS: ["finance@example.invalid"],
    TEST_RECIPIENT_ALLOWLIST: [],
    MAIL_FROM_ADDRESS: "no-reply@example.invalid",
    MAIL_REPLY_TO_ADDRESS: "finance@example.invalid",
    ...values,
  });
}

/** A fresh database and private storage for each test. */
export async function freshIntake(values: Partial<Config> = {}) {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  intakeSettings(values);
  await resetDatabase();
}

export function storageDirectory(): string {
  return root!;
}

/** The form page of `slug` as a browser opens it: the answer, with the jar keeping its cookies. */
export function openForm(
  jar: CookieJar,
  slug = "test",
  options: { remoteAddress?: string; headers?: Record<string, string> } = {},
) {
  return request("GET", `/api/v1/public/forms/${slug}`, { jar, ...options });
}

export type Prepared = {
  jar: CookieJar;
  form: Form;
  draft: Draft;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the request body, changed freely by tests
  data: Record<string, any>;
};

/**
 * A participant's draft of the published form "test" with a ready receipt and
 * signature, and the request body that submits it (conftest's `prepared`).
 */
export async function prepared(form?: Form): Promise<Prepared> {
  const current = form ?? (await createForm());
  const jar = new CookieJar();
  const page = await openForm(jar, current.slug);
  if (page.status !== 200) throw new Error(`The form page answered ${page.status}: ${page.text}`);
  const [draft] = await getDb().select().from(drafts).where(eq(drafts.id, page.body.draft.id));
  const rowId = randomUUID();
  const receiptId = randomUUID();
  const signatureId = randomUUID();
  for (const [uploadId, kind] of [
    [receiptId, "receipt"],
    [signatureId, "signature"],
  ] as const) {
    const content = await imageBytes({ signature: kind === "signature" });
    const key = `uploads/${uploadId}/normalized.png`;
    const file = pathFor(key);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    await getDb()
      .insert(uploads)
      .values({
        id: uploadId,
        draftId: draft!.id,
        kind,
        expenseId: kind === "receipt" ? rowId : null,
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
  const data = {
    draft_id: draft!.id,
    token: page.body.draft.token,
    full_name: "Alex Beispiel",
    email: "participant@example.invalid",
    street: "Teststraße 1",
    postal_code: "12345",
    city: "Berlin",
    country: "DE",
    account_holder: "Alex Beispiel",
    iban: "DE89 3704 0044 0532 0130 00",
    bic: "",
    purpose: "Teilnahme am synthetischen Workshop",
    purpose_details: "",
    is_trip: true,
    trip_destination: "Berlin",
    trip_start: "2026-10-20",
    trip_end: "2026-10-21",
    declaration: true,
    privacy_acknowledged: true,
    signature: signatureId,
    expenses: [
      {
        id: rowId,
        merchant: "Belegverkauf",
        purpose: "Workshop-Anreise",
        receipt_reference: "TEST-1",
        amount: "12,50",
        uploads: [receiptId],
      },
    ],
  };
  return { jar, form: current, draft: draft!, data };
}

/** Submits the prepared claim, or `data` instead (tests/test_forms.py's `post`). */
export function post(current: Prepared, data?: unknown, slug = "test"): Promise<TestResponse> {
  return request("POST", `/api/v1/public/forms/${slug}/submit`, {
    jar: current.jar,
    body: data ?? current.data,
  });
}

/** Live validation of the prepared entries with `changes` (tests/test_improvements.py's `validate`). */
export function validate(current: Prepared, changes: Record<string, unknown> = {}): Promise<TestResponse> {
  return request("POST", "/api/v1/public/forms/test/validate", {
    jar: current.jar,
    body: { ...current.data, ...changes },
    headers: { "x-draft-token": current.data.token },
  });
}

/** Uploads a file to the prepared draft (tests/test_resource_limits.py's `upload_file`). */
export async function uploadFile(
  current: Prepared,
  options: { kind?: "receipt" | "signature"; content?: Uint8Array; name?: string; expenseId?: string } = {},
): Promise<TestResponse> {
  const kind = options.kind ?? "receipt";
  const content = options.content ?? (await imageBytes({ signature: kind === "signature" }));
  const body = new FormData();
  body.append("draft_id", current.draft.id);
  body.append("token", current.data.token);
  body.append("expense_id", kind === "receipt" ? (options.expenseId ?? current.data.expenses[0].id) : "");
  body.append("kind", kind);
  body.append("file", new Blob([new Uint8Array(content)]), options.name ?? "receipt.png");
  return request("POST", "/api/v1/public/forms/test/uploads", { jar: current.jar, body });
}

/** An upload's status, or its removal, with the draft token. */
export function uploadRequest(
  current: Prepared,
  method: "GET" | "DELETE",
  uploadId: string,
): Promise<TestResponse> {
  return request(method, `/api/v1/public/forms/test/uploads/${uploadId}`, {
    jar: current.jar,
    headers: { "x-draft-token": current.data.token },
  });
}

/** A valid mileage row (tests/test_forms.py's `mileage_row`). */
export function mileageRow(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    kind: "mileage",
    travel_date: "2026-10-20",
    return_date: "2026-10-21",
    vehicle_registration: "B-AB 123",
    route_from: "Hamburg",
    route_to: "Berlin",
    distance_km: "289",
    round_trip: true,
    purpose: "Fahrt zur Werkstatt",
    uploads: [],
    ...changes,
  };
}

/** The message of a participant API error answer. */
export function errorMessage(response: TestResponse): string {
  return response.body?.error?.message ?? "";
}

/** The field errors of an answer: `fields` of validation, or of an error answer. */
export function fieldErrors(
  response: TestResponse,
): Record<string, Array<{ message: string; code: string }>> {
  return response.body?.fields ?? response.body?.error?.fields ?? {};
}
