// The claim PDF and the workspaces documents are processed in, with
// PostgreSQL: tests/test_documents.py and tests/test_pdf_integrity.py (the
// claim PDF, the confined assembly), tests/test_capacity_recovery.py and
// tests/test_resource_limits.py (workspace reservations and their recovery).
// Their parts that run jobs or HTTP requests belong to the job and upload tests.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { overrideConfigForTests, config } from "../config";
import { MAX_NORMALIZED_FILE_BYTES } from "../constants";
import { getDb } from "../db/client";
import { claims, drafts, expenses, uploads, workspaceReservations } from "../db/schema";
import { atomic } from "../db/tx";
import { addonPath } from "../documents/sandbox";
import { prepareSandbox, removeSandboxBuild } from "../documents/sandbox-test-support";
import type { ReceiptInput } from "../documents/manifest";
import { blankPdf, imageBytes, noisePdf, pdfText, summaryFixture } from "../documents/test-files";
import { SERVER_ROOT } from "../paths";
import { createForm } from "../test/fixtures";
import {
  admitUpload,
  CapacityError,
  disk,
  recoverAbandonedWorkspaces,
  temporaryWorkspace,
  workspaceFiles,
} from "./capacity";
import {
  assemblePdf,
  buildClaimPdf,
  claimReference,
  inspectUpload,
  ProcessingError,
  validateUpload,
} from "./documents";
import { pathFor, storageRoot } from "./storage";

const TABLES = [
  "portal_workspacereservation",
  "portal_job",
  "portal_upload",
  "portal_expense",
  "portal_draft",
  "portal_claim",
  "portal_draftadmission",
  "portal_capacitylock",
  "portal_form_owners",
  "portal_form",
  "portal_templatefield",
  "portal_formtemplate",
  "portal_privacynotice",
  "portal_appsettings",
];

const DECLARATION =
  "Hiermit bestätige ich, dass die angegebenen Auslagen tatsächlich entstanden sind, dem angegebenen Zweck dienen und bisher nicht erstattet wurden.";

let root: string;
const processes: ChildProcess[] = [];

beforeAll(async () => {
  await prepareSandbox();
}, 120_000);

afterAll(() => removeSandboxBuild());

beforeEach(async () => {
  await getDb().execute(sql.raw(`truncate table ${TABLES.join(", ")} restart identity cascade`));
  root = mkdtempSync(path.join(os.tmpdir(), "documents-int-"));
  useStorage();
});

/** The settings of every test (the Django tests' local_settings), applied again after an override reset. */
function useStorage(values: Parameters<typeof overrideConfigForTests>[0] = {}) {
  return overrideConfigForTests({ PRIVATE_STORAGE_ROOT: root, MIN_FREE_STORAGE_BYTES: 0, ...values });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const child of processes.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});

function store(key: string, content: Uint8Array) {
  const file = pathFor(key);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

async function draftOf(formId: number) {
  const [draft] = await getDb()
    .insert(drafts)
    .values({ formId, sessionHash: "session", tokenHash: "token", revision: "abc" })
    .returning();
  return draft!;
}

/** An accepted claim with a receipt and a signature (conftest's `prepared` and `accepted`). */
async function accepted(language: "de" | "en" = "de") {
  const form = await createForm();
  const draft = await draftOf(form.id);
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
      purpose: "Teilnahme am synthetischen Workshop",
      tripDestination: "Berlin",
      tripStart: "2026-10-20",
      tripEnd: "2026-10-21",
      total: "12.50",
      snapshot: {
        name: form.name,
        slug: form.slug,
        template: "Test-Vorlage",
        internal_values: [
          ["Kostenstelle (KST)", "TEST-KST"],
          ["Kostenträger (KTR)", "TEST-KTR"],
        ],
        recipient: "finance@example.invalid",
        support_email: "finance@example.invalid",
        declaration: DECLARATION,
        declaration_version: "reimbursement-v1",
        privacy_version: 1,
        mileage_rate: "0.30",
        revision: "0123456789abcdef",
        language,
      },
    })
    .returning();
  const [expense] = await getDb()
    .insert(expenses)
    .values({
      claimId: claim!.id,
      position: 0,
      merchant: "Belegverkauf",
      purpose: "Workshop-Anreise",
      receiptReference: "TEST-1",
      amount: "12.50",
    })
    .returning();
  for (const kind of ["receipt", "signature"] as const) {
    const id = randomUUID();
    const content = await imageBytes({ signature: kind === "signature" });
    const key = `uploads/${id}/normalized.png`;
    store(key, content);
    await getDb()
      .insert(uploads)
      .values({
        id,
        draftId: draft.id,
        claimId: claim!.id,
        kind,
        expenseId: kind === "receipt" ? expense!.id : null,
        originalName: `${kind}.png`,
        sourceKey: key,
        normalizedKey: key,
        size: content.length,
        checksum: "0".repeat(64),
        state: "ready",
        mediaType: "image/png",
        pages: 1,
      });
  }
  return claim!;
}

function words(text: string): string {
  return text.replace(/\s+/g, " ");
}

describe("the claim PDF", () => {
  it("holds the participant's details, the internal values, the receipt and the signature", async () => {
    const claim = await accepted();
    await temporaryWorkspace({ claim }, async (workspace) => {
      const { path: output, result } = await buildClaimPdf(claim, workspace);
      const bytes = readFileSync(output);
      const pages = await pdfText(bytes);
      const text = words(pages.map((page) => page.text).join(" "));
      expect(text).toContain("Alex Beispiel");
      expect(text).toContain("DE89370400440532013000");
      expect(text).toContain("TEST-KST");
      expect(text).toContain("TEST-KTR");
      expect(text.replace(/ /g, "")).toContain("Belegverkauf");
      expect(text).toContain("bisher nicht erstattet");
      expect(text).toContain("12,50");
      expect(text).toContain("Erstattungsformular");
      expect(result.pages).toBe(2);
      const document = await PDFDocument.load(bytes, { updateMetadata: false });
      const xobjects = document.getPage(0).node.Resources()?.lookupMaybe(PDFName.of("XObject"), PDFDict);
      const images = (xobjects?.entries() ?? []).filter(([, value]) => {
        const object = document.context.lookup(value);
        return (
          object &&
          "dict" in object &&
          String((object as { dict: PDFDict }).dict.get(PDFName.of("Subtype"))) === "/Image"
        );
      });
      expect(images.length).toBeGreaterThanOrEqual(1);
      expect(document.catalog.get(PDFName.of("Outlines"))).toBeDefined();
      expect(document.getTitle()).toBe(`Erstattung ${claimReference(claim)}`);
      expect(document.getProducer()).toBe("Meldgrove Reimbursement");
    });
  }, 60_000);

  it("uses the language its participant saw", async () => {
    const claim = await accepted("en");
    await temporaryWorkspace({ claim }, async (workspace) => {
      const { path: output } = await buildClaimPdf(claim, workspace);
      const bytes = readFileSync(output);
      const [first] = await pdfText(bytes);
      expect(words(first!.text)).toContain("Reimbursement form");
      expect(first!.text).not.toContain("Erstattungsformular");
      const document = await PDFDocument.load(bytes, { updateMetadata: false });
      expect(document.getTitle()).toBe(`Reimbursement ${claimReference(claim)}`);
    });
  }, 60_000);

  it("keeps the summary's text inside the page margins", async () => {
    const claim = await accepted();
    await temporaryWorkspace({ claim }, async (workspace) => {
      const { path: output } = await buildClaimPdf(claim, workspace);
      const [first] = await pdfText(readFileSync(output));
      expect(first!.right).toBeLessThanOrEqual(first!.width - 30);
    });
  }, 60_000);

  it("survives the largest number of receipt pages in the confined assembly", async () => {
    useStorage({ DOCUMENT_SANDBOX_ENABLED: true });
    const inputs = path.join(root, "inputs");
    mkdirSync(inputs);
    const receipts: ReceiptInput[] = [];
    for (const [index, count] of [30, 30, 30, 10].entries()) {
      const source = path.join(inputs, `receipt-${index}.pdf`);
      writeFileSync(source, await blankPdf(count));
      receipts.push({ path: source, mediaType: "application/pdf", label: `Receipt ${index}` });
    }
    const claim = await accepted();
    await temporaryWorkspace({ claim }, async (workspace) => {
      const manifest = path.join(workspace, "manifest.json");
      writeFileSync(
        manifest,
        JSON.stringify({
          summary: summaryFixture("Synthetic maximum-page claim"),
          signature: null,
          receipts,
          title: "synthetic",
          maxBytes: 10_000_000,
        }),
      );
      const output = path.join(workspace, "complete.pdf");
      const result = await assemblePdf(manifest, output);
      expect(result.pages).toBe(101);
      expect(statSync(output).size).toBeGreaterThan(0);
      expect(statSync(output).size).toBeLessThanOrEqual(10_000_000);
      expect((await PDFDocument.load(readFileSync(output))).getPageCount()).toBe(101);
    });
  }, 300_000);

  it("brings large PDF rasters to the final compression with every page", async () => {
    useStorage({ DOCUMENT_SANDBOX_ENABLED: true });
    const source = path.join(root, "detail.pdf");
    writeFileSync(source, await noisePdf([42, 43]));
    expect(statSync(source).size).toBeLessThan(10_000_000);
    const claim = await accepted();
    await temporaryWorkspace({ claim }, async (workspace) => {
      const validated = await inspectUpload(source, workspace);
      expect(validated.pages).toBe(2);
      const manifest = path.join(workspace, "manifest.json");
      writeFileSync(
        manifest,
        JSON.stringify({
          summary: summaryFixture("Synthetic high-detail claim"),
          signature: null,
          receipts: [{ path: source, mediaType: "application/pdf", label: "Detail" }],
          title: "synthetic",
          maxBytes: 1_000_000,
        }),
      );
      const output = path.join(workspace, "complete.pdf");
      const result = await assemblePdf(manifest, output);
      const rasters = readdirSync(workspace).filter((name) => /^receipt-\d+\.jpg$/.test(name));
      expect(rasters).toHaveLength(2);
      for (const raster of rasters)
        expect(statSync(path.join(workspace, raster)).size).toBeGreaterThan(10_000_000);
      expect(result.size).toBeLessThanOrEqual(1_000_000);
      expect(result.pages).toBe(3);
      expect((await PDFDocument.load(readFileSync(output))).getPageCount()).toBe(3);
    });
  }, 300_000);
});

describe("validated uploads", () => {
  async function pendingUpload(kind: "receipt" | "signature", content: Uint8Array, extension: string) {
    const form = await createForm();
    const draft = await draftOf(form.id);
    const id = randomUUID();
    const key = `uploads/${id}/source${extension}`;
    store(key, content);
    const [upload] = await getDb()
      .insert(uploads)
      .values({
        id,
        draftId: draft.id,
        kind,
        originalName: `${kind}${extension}`,
        sourceKey: key,
        size: content.length,
        checksum: "0".repeat(64),
        reservedBytes: MAX_NORMALIZED_FILE_BYTES,
      })
      .returning();
    return upload!;
  }

  it("publishes an image's output under a new key and removes it unless it is kept", async () => {
    const upload = await pendingUpload("receipt", await imageBytes(), ".png");
    let published = "";
    await validateUpload(upload, async (output) => {
      published = output.key;
      expect(output.key).toMatch(new RegExp(`^uploads/${upload.id}/[0-9a-f-]{36}\\.jpg$`));
      expect(output.mediaType).toBe("image/jpeg");
      expect(statSync(pathFor(output.key)).size).toBe(output.size);
      const [reservation] = await getDb().select().from(workspaceReservations);
      expect(reservation?.size).toBe(MAX_NORMALIZED_FILE_BYTES);
      const [current] = await getDb().select().from(uploads).where(eq(uploads.id, upload.id));
      expect(current?.reservedBytes).toBe(0);
    });
    // A stale validator removes its unrecorded output.
    expect(existsSync(pathFor(published))).toBe(false);
    await validateUpload(upload, async (output) => {
      published = output.key;
      output.keep();
    });
    expect(existsSync(pathFor(published))).toBe(true);
    expect(await getDb().select().from(workspaceReservations)).toHaveLength(0);
  });

  it("keeps a PDF as its own output and never removes its source", async () => {
    const upload = await pendingUpload("receipt", await blankPdf(2), ".pdf");
    await validateUpload(upload, async (output) => {
      expect(output).toMatchObject({
        key: upload.sourceKey,
        size: 0,
        mediaType: "application/pdf",
        pages: 2,
      });
    });
    expect(existsSync(pathFor(upload.sourceKey))).toBe(true);
  });

  it("reports a refused file's code", async () => {
    const upload = await pendingUpload("signature", await blankPdf(1), ".pdf");
    await expect(validateUpload(upload, async () => undefined)).rejects.toSatisfy(
      (error) => error instanceof ProcessingError && error.code === "unsupported_type",
    );
    expect(await getDb().select().from(workspaceReservations)).toHaveLength(0);
  });
});

describe("workspace capacity", () => {
  /** A persistent disk and a separate 700 MB tmpfs for workspaces (FakeDisk with workspace_free). */
  function separateFilesystems() {
    useStorage({ MIN_FREE_STORAGE_BYTES: 1_000_000_000 });
    const settings = config();
    const free =
      settings.MIN_FREE_STORAGE_BYTES +
      settings.UPLOAD_TEMP_HEADROOM_BYTES +
      2 * settings.MAX_FINAL_PDF_BYTES;
    vi.spyOn(disk, "free").mockImplementation((target) =>
      path.basename(target) === "work" ? 700_000_000 : free,
    );
    vi.spyOn(disk, "shared").mockReturnValue(false);
  }

  it("reserves the workspace on a shared filesystem above the storage floor", async () => {
    const claim = await accepted();
    useStorage({ MIN_FREE_STORAGE_BYTES: 1_000_000_000 });
    vi.spyOn(disk, "free").mockReturnValue(1_100_000_000);
    vi.spyOn(disk, "shared").mockReturnValue(true);
    await expect(temporaryWorkspace({ claim }, async () => "entered")).rejects.toSatisfy(
      (error) => error instanceof CapacityError && error.code === "storage_capacity",
    );
    expect(await getDb().select().from(workspaceReservations)).toHaveLength(0);
  });

  it("refuses overlapping render workspaces on a separate tmpfs", async () => {
    const claim = await accepted();
    separateFilesystems();
    await temporaryWorkspace({ claim }, async () => {
      await expect(temporaryWorkspace({ claim }, async () => "entered")).rejects.toSatisfy(
        (error) => error instanceof CapacityError && error.code === "workspace_capacity",
      );
    });
    await temporaryWorkspace({ claim }, async (directory) => {
      expect(statSync(directory).isDirectory()).toBe(true);
    });
    expect(await getDb().select().from(workspaceReservations)).toHaveLength(0);
  });

  it("moves an upload's reservation into its workspace until cleanup", async () => {
    const form = await createForm();
    const draft = await draftOf(form.id);
    const [upload] = await getDb()
      .insert(uploads)
      .values({
        draftId: draft.id,
        originalName: "r.png",
        sourceKey: "uploads/x/source.png",
        size: 1,
        checksum: "0",
        reservedBytes: MAX_NORMALIZED_FILE_BYTES,
      })
      .returning();
    await temporaryWorkspace({ upload: upload! }, async (directory) => {
      const [current] = await getDb().select().from(uploads).where(eq(uploads.id, upload!.id));
      expect(current?.reservedBytes).toBe(0);
      const [reservation] = await getDb()
        .select()
        .from(workspaceReservations)
        .where(eq(workspaceReservations.uploadId, upload!.id));
      expect(reservation?.size).toBe(MAX_NORMALIZED_FILE_BYTES);
      expect(statSync(directory).isDirectory()).toBe(true);
    });
    expect(await getDb().select().from(workspaceReservations)).toHaveLength(0);
  });

  it("keeps the reservation when the workspace cannot be removed, until recovery", async () => {
    const claim = await accepted();
    vi.spyOn(workspaceFiles, "removeTree").mockImplementationOnce(() => {
      throw new Error("synthetic");
    });
    await expect(temporaryWorkspace({ claim }, async () => undefined)).rejects.toThrow("synthetic");
    expect(await getDb().select().from(workspaceReservations)).toHaveLength(1);
    await getDb()
      .update(workspaceReservations)
      .set({ createdAt: new Date(Date.now() - 25 * 3600 * 1000) });
    await recoverAbandonedWorkspaces();
    expect(await getDb().select().from(workspaceReservations)).toHaveLength(0);
  });

  /** A process that holds the workspace's lock, as a running parser does. */
  async function holdLock(lockFile: string): Promise<ChildProcess> {
    const holder = spawn(
      process.execPath,
      [
        "-e",
        `const a = require(${JSON.stringify(addonPath())}); const fd = require("fs").openSync(process.argv[1], "a+");` +
          `if (!a.flock(fd, "shared")) process.exit(2); console.log("locked"); process.stdin.resume();`,
        lockFile,
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    processes.push(holder);
    await new Promise<void>((resolve, reject) => {
      holder.stdout!.once("data", (chunk: Buffer) =>
        chunk.toString().trim() === "locked" ? resolve() : reject(new Error("no lock")),
      );
      holder.once("exit", () => reject(new Error("the holder exited")));
    });
    return holder;
  }

  async function ended(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve) => child.once("exit", resolve));
  }

  for (const ageSeconds of [421, 25 * 3600]) {
    it(`keeps a live execution, then releases a crashed one (${ageSeconds} s old)`, async () => {
      const claim = await accepted();
      separateFilesystems();
      const key = `work/job-${randomUUID()}`;
      const directory = pathFor(key);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(directory, "partial.pdf"), "synthetic partial output");
      const lockFile = path.join(path.dirname(directory), ".locks", path.basename(directory));
      mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
      const [reservation] = await getDb()
        .insert(workspaceReservations)
        .values({
          directory: key,
          size: config().MAX_RENDER_WORKSPACE_BYTES,
          outputBytes: config().MAX_FINAL_PDF_BYTES,
          claimId: claim.id,
          createdAt: new Date(Date.now() - ageSeconds * 1000),
        })
        .returning();
      // An execution, including an orphaned parser, holds the external shared lock.
      const holder = await holdLock(lockFile);
      await recoverAbandonedWorkspaces();
      expect(
        await getDb()
          .select()
          .from(workspaceReservations)
          .where(eq(workspaceReservations.id, reservation!.id)),
      ).toHaveLength(1);
      expect(existsSync(path.join(directory, "partial.pdf"))).toBe(true);
      holder.kill("SIGKILL");
      await ended(holder);
      await recoverAbandonedWorkspaces();
      expect(
        await getDb()
          .select()
          .from(workspaceReservations)
          .where(eq(workspaceReservations.id, reservation!.id)),
      ).toHaveLength(0);
      expect(existsSync(directory)).toBe(false);
      await temporaryWorkspace({ claim }, async () => undefined);
    });
  }

  it("recovers a workspace a restart took away (tmpfs)", async () => {
    const claim = await accepted();
    separateFilesystems();
    const [reservation] = await getDb()
      .insert(workspaceReservations)
      .values({
        directory: `work/job-${randomUUID()}`,
        size: config().MAX_RENDER_WORKSPACE_BYTES,
        outputBytes: config().MAX_FINAL_PDF_BYTES,
        claimId: claim.id,
        createdAt: new Date(Date.now() - 421 * 1000),
      })
      .returning();
    await recoverAbandonedWorkspaces();
    expect(
      await getDb().select().from(workspaceReservations).where(eq(workspaceReservations.id, reservation!.id)),
    ).toHaveLength(0);
  });

  it("gives a crashed validation's output reservation back to its pending upload", async () => {
    const form = await createForm();
    const draft = await draftOf(form.id);
    const [upload] = await getDb()
      .insert(uploads)
      .values({
        draftId: draft.id,
        originalName: "r.png",
        sourceKey: "uploads/x/source.png",
        size: 1,
        checksum: "0",
        state: "pending",
      })
      .returning();
    const [reservation] = await getDb()
      .insert(workspaceReservations)
      .values({
        directory: `work/job-${randomUUID()}`,
        size: MAX_NORMALIZED_FILE_BYTES,
        outputBytes: MAX_NORMALIZED_FILE_BYTES,
        uploadId: upload!.id,
        createdAt: new Date(Date.now() - 421 * 1000),
      })
      .returning();
    await recoverAbandonedWorkspaces();
    const [current] = await getDb().select().from(uploads).where(eq(uploads.id, upload!.id));
    expect(current?.reservedBytes).toBe(MAX_NORMALIZED_FILE_BYTES);
    expect(
      await getDb().select().from(workspaceReservations).where(eq(workspaceReservations.id, reservation!.id)),
    ).toHaveLength(0);
  });

  it("lets the parser keep the execution lock when its supervisor crashes", async () => {
    const claim = await accepted();
    const key = `work/job-${randomUUID()}`;
    const directory = pathFor(key);
    mkdirSync(directory, { recursive: true });
    const [reservation] = await getDb()
      .insert(workspaceReservations)
      .values({
        directory: key,
        size: config().MAX_RENDER_WORKSPACE_BYTES,
        outputBytes: config().MAX_FINAL_PDF_BYTES,
        claimId: claim.id,
        createdAt: new Date(Date.now() - 421 * 1000),
      })
      .returning();
    const source = path.join(root, "source.png");
    writeFileSync(source, "synthetic");
    const coordinator = path.join(root, "child.pid");
    const sleeper = path.join(root, "sleeping-parser.mjs");
    writeFileSync(
      sleeper,
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(coordinator)}, String(process.pid)); setTimeout(() => {}, 60_000);`,
    );
    const supervisorScript = path.join(SERVER_ROOT, "src", "services", `zz-supervisor-${process.pid}.ts`);
    writeFileSync(
      supervisorScript,
      `import { runnerOptions, execute } from "./documents";
import { workspaceLock } from "./capacity";
const [source, directory, sleeper] = process.argv.slice(2);
runnerOptions.workerScript = sleeper;
await workspaceLock(directory, {}, () => execute(["validate", source, directory, "receipt"], { readonly: [source], workspace: directory }));
`,
    );
    try {
      const supervisor = spawn(
        process.execPath,
        ["--import", "tsx", supervisorScript, source, directory, sleeper],
        {
          cwd: SERVER_ROOT,
          env: {
            ...process.env,
            DOCUMENT_SANDBOX_ENABLED: "0",
            DEPLOYMENT_ENV: "development",
            PRIVATE_STORAGE_ROOT: storageRoot(),
            JOB_TIMEOUT_SECONDS: "60",
          },
          stdio: ["ignore", "ignore", "inherit"],
        },
      );
      processes.push(supervisor);
      const deadline = Date.now() + 20_000;
      while (!existsSync(coordinator) && supervisor.exitCode === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(existsSync(coordinator)).toBe(true);
      const childPid = Number(readFileSync(coordinator, "utf8"));
      supervisor.kill("SIGKILL");
      await ended(supervisor);
      try {
        await recoverAbandonedWorkspaces();
        expect(
          await getDb()
            .select()
            .from(workspaceReservations)
            .where(eq(workspaceReservations.id, reservation!.id)),
        ).toHaveLength(1);
      } finally {
        process.kill(childPid, "SIGKILL");
      }
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          process.kill(childPid, 0);
          await new Promise((resolve) => setTimeout(resolve, 50));
        } catch {
          break;
        }
      }
      await recoverAbandonedWorkspaces();
      expect(
        await getDb()
          .select()
          .from(workspaceReservations)
          .where(eq(workspaceReservations.id, reservation!.id)),
      ).toHaveLength(0);
    } finally {
      rmSync(supervisorScript, { force: true });
    }
  }, 60_000);
});

describe("upload admission", () => {
  async function draft() {
    const form = await createForm();
    return draftOf(form.id);
  }

  it("charges the draft and network and reserves the normalized output", async () => {
    const current = await draft();
    const reserved = await atomic(() => admitUpload("192.0.2.1/32", current.id, 1000));
    expect(reserved).toBe(MAX_NORMALIZED_FILE_BYTES);
    const [row] = await getDb().select().from(drafts).where(eq(drafts.id, current.id));
    expect([row?.uploadCount, row?.uploadBytes]).toEqual([1, 1000]);
  });

  it("refuses work beyond the draft's, the network's and the disk's limits", async () => {
    const current = await draft();
    const refused = async (code: string) =>
      expect(atomic(() => admitUpload("192.0.2.1/32", current.id, 1000))).rejects.toSatisfy(
        (error) => error instanceof CapacityError && error.code === code,
      );
    for (const [values, code] of [
      [{ MAX_UPLOADS_PER_DRAFT: 0 }, "draft_work_limit"],
      [{ MAX_UPLOADS_PER_NETWORK: 0 }, "network_work_limit"],
      [{ MIN_FREE_STORAGE_BYTES: 1_000_000_000 }, "storage_capacity"],
      [{ MAX_DRAFT_DERIVED_BYTES: MAX_NORMALIZED_FILE_BYTES - 1 }, "draft_storage_limit"],
      [{ MAX_PENDING_VALIDATIONS: 0 }, "validation_backlog"],
    ] as const) {
      const restore = useStorage(values);
      if (code === "storage_capacity") vi.spyOn(disk, "free").mockReturnValue(1_000_000_000);
      try {
        await refused(code);
      } finally {
        restore();
        vi.restoreAllMocks();
      }
    }
    // Every refusal rolled back its charges.
    const [row] = await getDb().select().from(drafts).where(eq(drafts.id, current.id));
    expect(row?.uploadCount).toBe(0);
  });

  it("needs a transaction", async () => {
    const current = await draft();
    await expect(admitUpload("192.0.2.1/32", current.id, 1000)).rejects.toThrow("transaction");
  });
});

void storageRoot;
