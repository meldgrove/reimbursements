/**
 * The document child as the server uses it (portal/services/documents.py):
 * which runner starts it, the limits and confinement it runs under, and the
 * two jobs it does: validating an upload and building a claim's PDF.
 *
 * Production runs the child sandboxed: native/build/launcher applies resource
 * limits and Landlock (only the files the execution needs), then starts node,
 * whose first act is lockdown() (seccomp: no network, processes, signals or
 * metadata changes). Development may run it directly
 * (DOCUMENT_SANDBOX_ENABLED=0); production refuses to run without the sandbox.
 */
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { countryName } from "@reimbursements/shared/countries";
import { config } from "../config";
import { APP_NAME, MAX_NORMALIZED_FILE_BYTES } from "../constants";
import { claims, expenses, uploads } from "../db/schema";
import { q } from "../db/tx";
import type {
  BuildManifest,
  BuildResult,
  ClaimSummary,
  ReceiptInput,
  UploadKind,
  ValidateResult,
} from "../documents/manifest";
import { CHILD_FAILURE_CODES, manifestInputs } from "../documents/manifest";
import { addonPath, launcherPath, nativeBuilt } from "../documents/sandbox";
import { fontsDirectory } from "../documents/summary";
import {
  formatAmount,
  formatDate,
  formatInstantDate,
  formatShortDateTime,
  language,
  t,
  zoneName,
} from "../i18n";
import { IS_BUNDLED, SERVER_ROOT } from "../paths";
import { forClaim } from "./app-settings";
import { temporaryWorkspace, workspaceLock } from "./capacity";
import { normalizedUploadKey, pathFor, publishFile, removeKeys, workspaceRoot } from "./storage";

/** A document could not be processed: `code` names why (the child's code, or the runner's). */
export class ProcessingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProcessingError";
  }
}

/**
 * The child's resource limits (0.4's resource_limits).
 *
 * 0.4 bounded the parser's memory with 2 GB of address space (RLIMIT_AS). V8
 * reserves far more address space than it uses (WebAssembly memories come with
 * guard regions of several GB), and failed reservations crash it; the bound is
 * therefore on the memory the process can make writable (RLIMIT_DATA, 2 GB),
 * with a generous address-space ceiling against runaway reservations. The
 * old-space flag below keeps V8's heap inside, the launcher makes the child
 * the OOM killer's first choice, and the worker container's memory limit
 * (compose.yaml) bounds the rest.
 */
export function resourceLimits() {
  return {
    as: 32 * 1024 ** 3,
    data: 2_000_000_000,
    cpu: config().JOB_TIMEOUT_SECONDS,
    fsize: 600_000_000,
    nofile: 128,
  };
}

/** Node flags of the child. */
const NODE_FLAGS = ["--max-old-space-size=1024"];

/** Document children get no credentials or inherited configuration. */
export function childEnvironment(workspace: string): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    TMPDIR: workspace,
    XDG_CACHE_HOME: path.join(workspace, "cache"),
    // Node reads its OpenSSL configuration at start; the sandbox allows no file for it.
    OPENSSL_CONF: "/dev/null",
    // Where the child finds its add-on and fonts, wherever its bundle lies.
    DOCUMENT_SANDBOX_ADDON: addonPath(),
    DOCUMENT_FONTS: fontsDirectory(),
  };
}

/** Where the child's code is. Tests point the sandbox at a bundle they build. */
export const runnerOptions: { workerScript: string | undefined } = { workerScript: undefined };

/** The child's bundle, which `npm run build` writes next to the server's. */
export function builtWorker(): string {
  return path.join(SERVER_ROOT, "dist", "file-worker.mjs");
}

function bundledWorker(): string | undefined {
  if (runnerOptions.workerScript) return runnerOptions.workerScript;
  return IS_BUNDLED ? builtWorker() : undefined;
}

/**
 * The bundle the sandbox runs. The sources' development server (tsx) has no
 * bundle of its own: it uses the built one, as 0.4's development server
 * could use the sandbox.
 */
function sandboxWorker(): string | undefined {
  return bundledWorker() ?? (existsSync(builtWorker()) ? builtWorker() : undefined);
}

/** How node starts the child's code: the bundle, or (development) the sources through tsx. */
function workerEntry(): string[] {
  const bundle = bundledWorker();
  if (bundle) return [bundle];
  return ["--import", "tsx", path.join(SERVER_ROOT, "src", "documents", "file-worker.ts")];
}

/** Existing paths only, each once. */
function existing(paths: string[]): string[] {
  return [...new Set(paths.filter((entry) => existsSync(entry)))];
}

/** Folders from `start` up to the root: where node looks for packages and package.json files. */
function ancestors(start: string): string[] {
  const result: string[] = [];
  for (let current = start; ; current = path.dirname(current)) {
    result.push(current);
    if (path.dirname(current) === current) return result;
  }
}

/** The ELF interpreters node may need (x86_64, aarch64). */
const INTERPRETERS = [
  "/lib64/ld-linux-x86-64.so.2",
  "/lib/ld-linux-aarch64.so.1",
  "/lib/ld-linux-x86-64.so.2",
];

/**
 * The launcher with its arguments (limits and the files the child may use),
 * then node and `script`. The document child's script is the worker bundle.
 */
export function sandboxCommand(readonly: string[], workspace: string, script = sandboxWorker()): string[] {
  if (!script) throw new ProcessingError("document_sandbox_unavailable");
  const node = realpathSync(process.execPath);
  const runtime = existing([
    "/lib",
    "/lib64",
    "/usr/lib",
    "/etc/ld.so.cache",
    path.dirname(script),
    fontsDirectory(),
    ...ancestors(SERVER_ROOT).map((folder) => path.join(folder, "node_modules")),
  ]);
  // Node reads the package.json files above a module; Landlock would answer EACCES, not ENOENT.
  const packages = existing(
    ancestors(path.dirname(script)).map((folder) => path.join(folder, "package.json")),
  );
  return [
    launcherPath(),
    ...limitArguments(),
    ...runtime.flatMap((entry) => ["--read", entry]),
    ...existing([
      node,
      ...INTERPRETERS.map((file) => (existsSync(file) ? realpathSync(file) : file)),
    ]).flatMap((entry) => ["--exec", entry]),
    ...[addonPath(), ...packages, ...readonly].flatMap((entry) => ["--read-file", entry]),
    "--write",
    workspace,
    "--",
    node,
    ...NODE_FLAGS,
    script,
  ];
}

type Runner = {
  command(args: string[], options: { readonly: string[]; workspace: string }): string[];
  ready(root: string): Promise<boolean>;
};

/** Production: the launcher's limits and Landlock, then seccomp before any parser loads. */
const sandboxedRunner: Runner = {
  command(args, { readonly, workspace }) {
    if (!nativeBuilt()) throw new ProcessingError("document_sandbox_unavailable");
    return [...sandboxCommand(readonly, workspace), "--sandboxed", ...args];
  },
  async ready(root) {
    try {
      return await successfulSandboxProbe(root);
    } catch {
      return false;
    }
  },
};

/** The launcher's limit options (0.4 applied them to both runners). */
function limitArguments(): string[] {
  return Object.entries(resourceLimits()).flatMap(([name, value]) => ["--limit", `${name}=${value}`]);
}

/** Development: the same child, without confinement; with the limits when the launcher is built. */
const directRunner: Runner = {
  command(args) {
    const child = [process.execPath, ...workerEntry(), ...args];
    if (!existsSync(launcherPath())) return child;
    return [launcherPath(), ...limitArguments(), "--limits-only", "--", ...child];
  },
  async ready() {
    return true;
  },
};

const unavailableRunner: Runner = {
  command() {
    throw new ProcessingError("document_sandbox_unavailable");
  },
  async ready() {
    return false;
  },
};

export function configuredRunner(): Runner {
  const settings = config();
  if (settings.DOCUMENT_SANDBOX_ENABLED) return sandboxedRunner;
  return settings.isDevelopment ? directRunner : unavailableRunner;
}

/** Successes only: a failed probe is tried again next time. */
const probed = new Set<string>();

type ChildResult = { code: number | null; stdout: Buffer };

function runChild(
  command: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    stdio: Array<"ignore" | number | "pipe">;
    timeoutMs: number;
  },
): Promise<ChildResult | "timeout"> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio,
      // A process group of its own, so the kill below reaches every descendant.
      detached: true,
    });
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, options.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Descendants inherit confinement and cannot change process groups.
      killGroup(child.pid);
      resolve(timedOut ? "timeout" : { code, stdout: Buffer.concat(chunks) });
    });
  });
}

function killGroup(pid: number | undefined) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

async function successfulSandboxProbe(root: string): Promise<boolean> {
  if (probed.has(root)) return true;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const workspace = mkdtempSync(path.join(root, "job-probe-"));
  try {
    if (!nativeBuilt()) return false;
    const command = [...sandboxCommand([], workspace), "--sandboxed", "self-test", workspace];
    const result = await runChild(command, {
      cwd: SERVER_ROOT,
      env: childEnvironment(workspace),
      stdio: ["ignore", "pipe", "ignore"],
      timeoutMs: 5000,
    });
    if (result === "timeout" || result.code !== 0 || result.stdout.toString().trim() !== "sandbox_ok")
      return false;
    probed.add(root);
    return true;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

/** Whether the configured runner can process documents now (readiness and setup checks). */
export function sandboxReady(): Promise<boolean> {
  return configuredRunner().ready(workspaceRoot());
}

/** Validates a source file; images are normalized into the workspace. */
export function inspectUpload(
  source: string,
  workspace: string,
  kind: UploadKind = "receipt",
): Promise<ValidateResult> {
  const resolvedSource = path.resolve(source);
  const resolvedWorkspace = path.resolve(workspace);
  return execute(["validate", resolvedSource, resolvedWorkspace, kind], {
    readonly: [resolvedSource],
    workspace: resolvedWorkspace,
  }) as Promise<ValidateResult>;
}

/** Builds the authoritative PDF next to its manifest from the listed inputs only. */
export function assemblePdf(manifestPath: string, outputPath: string): Promise<BuildResult> {
  const resolvedManifest = path.resolve(manifestPath);
  const output = path.resolve(outputPath);
  const manifest = JSON.parse(readFileSync(resolvedManifest, "utf8")) as BuildManifest;
  return execute(["build", resolvedManifest, output], {
    readonly: [resolvedManifest, ...manifestInputs(manifest)],
    workspace: path.dirname(output),
  }) as Promise<BuildResult>;
}

const MAX_ANSWER_BYTES = 65_536;
/** The launcher's exit status when it cannot confine or start the child. */
const LAUNCHER_FAILED = 125;

/** Runs the child on `args` in `workspace` and returns its answer; failures are ProcessingError. */
export async function execute(
  args: string[],
  options: { readonly: string[]; workspace: string },
): Promise<Record<string, unknown>> {
  const command = configuredRunner().command(args, options);
  const workspace = options.workspace;
  return workspaceLock(workspace, {}, async (executionLock) => {
    const output = openSync(path.join(workspace, "process-result.json"), "w+", 0o600);
    let stdout: Buffer;
    try {
      const result = await runChild(command, {
        cwd: SERVER_ROOT,
        env: childEnvironment(workspace),
        // The child keeps the execution lock (fd 3) if this process dies first.
        stdio: ["ignore", output, "ignore", executionLock],
        timeoutMs: config().JOB_TIMEOUT_SECONDS * 1000,
      });
      if (result === "timeout") throw new ProcessingError("document_timeout");
      const buffer = Buffer.alloc(MAX_ANSWER_BYTES + 1);
      const length = readSync(output, buffer, 0, buffer.length, 0);
      // The launcher failed before the child ran (no Landlock, a limit refused): an operator's matter.
      if (result.code === LAUNCHER_FAILED && length === 0)
        throw new ProcessingError("document_sandbox_unavailable");
      stdout = buffer.subarray(0, length);
      if (stdout.length > MAX_ANSWER_BYTES) throw new ProcessingError("document_process_failed");
      let payload: unknown;
      try {
        payload = JSON.parse(stdout.toString("utf8"));
      } catch {
        throw new ProcessingError("document_process_failed");
      }
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        throw new ProcessingError("document_process_failed");
      }
      const answer = payload as Record<string, unknown>;
      if (result.code !== 0 || "error" in answer) {
        // Only the codes the child knows: any other text is not passed on, stored or logged.
        throw new ProcessingError(
          typeof answer.error === "string" && CHILD_FAILURE_CODES.has(answer.error)
            ? answer.error
            : "document_process_failed",
        );
      }
      return answer;
    } catch (error) {
      if (error instanceof ProcessingError) throw error;
      throw new ProcessingError("document_process_failed");
    } finally {
      closeSync(output);
    }
  });
}

/** A validated upload's published output. A PDF is its own output: its source. */
export class NormalizedUpload {
  kept = false;
  constructor(
    readonly key: string,
    readonly size: number,
    readonly mediaType: string,
    readonly pages: number,
  ) {}

  /** The output was recorded; it outlives `validateUpload`. */
  keep() {
    this.kept = true;
  }
}

type UploadForValidation = { id: string; sourceKey: string; kind: string };

/**
 * Validates the upload's source in a temporary workspace and publishes its output,
 * then runs `use` with it. Unless `use` calls `keep()` once it is recorded, the
 * output is removed afterwards; a PDF's source is never removed here.
 */
export async function validateUpload<T>(
  upload: UploadForValidation,
  use: (output: NormalizedUpload) => Promise<T>,
): Promise<T> {
  const source = pathFor(upload.sourceKey);
  const kind: UploadKind = upload.kind === "signature" ? "signature" : "receipt";
  return temporaryWorkspace({ upload }, async (workspace) => {
    const result = await inspectUpload(source, workspace, kind);
    const normalized = path.resolve(String(result.normalized));
    if (result.mediaType === "application/pdf" && normalized === source) {
      return use(new NormalizedUpload(upload.sourceKey, 0, result.mediaType, result.pages));
    }
    const suffix = kind === "signature" ? ".png" : ".jpg";
    const expected = path.join(workspace, `normalized${suffix}`);
    let stats;
    try {
      stats = lstatSync(normalized);
    } catch {
      stats = undefined;
    }
    if (normalized !== expected || !stats || !stats.isFile() || stats.isSymbolicLink()) {
      throw new ProcessingError("invalid_processing_output");
    }
    if (!(stats.size > 0 && stats.size <= MAX_NORMALIZED_FILE_BYTES))
      throw new ProcessingError("normalized_size_limit");
    const key = normalizedUploadKey(upload.id, suffix);
    await publishFile(normalized, key, MAX_NORMALIZED_FILE_BYTES);
    const output = new NormalizedUpload(key, stats.size, result.mediaType, result.pages);
    try {
      return await use(output);
    } finally {
      if (!output.kept) removeKeys(key);
    }
  });
}

type ClaimRow = typeof claims.$inferSelect;
type ExpenseRow = typeof expenses.$inferSelect;

/** The claim's reference: its bookkeeping reference, else its ID. */
export function claimReference(claim: Pick<ClaimRow, "id" | "bookkeepingReference">): string {
  return claim.bookkeepingReference || claim.id;
}

function postalAddress(claim: ClaimRow): string {
  if (!claim.street) return "";
  return `${claim.street}\n${claim.postalCode} ${claim.city}\n${countryName(claim.country, language())}`;
}

function snapshotText(snapshot: Record<string, unknown>, key: string): string {
  const value = snapshot[key];
  return value === null || value === undefined ? "" : String(value);
}

function internalValues(snapshot: Record<string, unknown>): Array<[string, string]> {
  const value = snapshot.internal_values;
  if (!Array.isArray(value)) return [];
  return value
    .filter((pair): pair is [unknown, unknown] => Array.isArray(pair) && pair.length === 2)
    .map(([label, text]) => [String(label), String(text ?? "")]);
}

/** Kilometres billed: the distance, twice for a round trip. */
function billedKm(expense: ExpenseRow): number {
  return (expense.distanceKm ?? 0) * (expense.roundTrip ? 2 : 1);
}

/** The summary pages' texts, in the applied language and formats (summary.html of 0.4). */
export function claimSummary(claim: ClaimRow, rows: ExpenseRow[]): ClaimSummary {
  const snapshot = claim.snapshot;
  const reference = claimReference(claim);
  const version = snapshotText(snapshot, "revision") || snapshotText(snapshot, "config_version");
  const euro = (value: string | null) => `${formatAmount(value)} EUR`;
  const personal: Array<[string, string]> = [
    [t("Name"), claim.fullName],
    [t("Address"), postalAddress(claim)],
    [t("Email"), claim.email],
    [t("Account holder"), claim.accountHolder],
    [t("IBAN"), claim.iban],
    ...(claim.bic ? [[t("BIC"), claim.bic] as [string, string]] : []),
  ];
  const occasion: Array<[string, string]> = [[t("Occasion/project"), claim.purpose]];
  if (claim.purposeDetails) occasion.push([t("Additional details"), claim.purposeDetails]);
  if (claim.tripStart) {
    occasion.push([t("Destination"), claim.tripDestination]);
    occasion.push([
      t("Travel period"),
      t("{start} to {end}", { start: formatDate(claim.tripStart), end: formatDate(claim.tripEnd) }),
    ]);
  }
  return {
    language: language(),
    footer: `${APP_NAME} · ${reference}`,
    eyebrow: t("Reimbursement of privately paid costs"),
    title: t("Reimbursement form"),
    meta: [
      t("Reference {reference}", { reference }),
      t("Submitted on {date} {zone} · Form version {version}", {
        date: formatShortDateTime(claim.submittedAt),
        zone: zoneName(claim.submittedAt),
        version,
      }),
    ],
    personal: { heading: t("Personal details"), rows: personal },
    assignment: {
      heading: t("Assignment"),
      rows: [
        [t("Form"), snapshotText(snapshot, "name")],
        [t("Template"), snapshotText(snapshot, "template")],
        ...internalValues(snapshot),
      ],
    },
    occasion: { heading: t("Occasion/connection to the project or event"), rows: occasion },
    expenses: {
      heading: t("Expense items"),
      columns: [
        t("No."),
        t("Business partner / journey"),
        t("Occasion/purpose"),
        t("Reference"),
        t("Amount"),
      ],
      rows: rows.map((expense, index) => {
        if (expense.kind === "mileage") {
          const partner = [
            t("Mileage allowance"),
            `${formatDate(expense.travelDate)}: ${expense.routeFrom} – ${expense.routeTo}`,
          ];
          if (expense.roundTrip) {
            partner.push(
              expense.returnDate
                ? t("Return on {date}", { date: formatDate(expense.returnDate) })
                : t("Return"),
            );
          }
          if (expense.vehicleRegistration)
            partner.push(t("Registration: {plate}", { plate: expense.vehicleRegistration }));
          return {
            number: String(index + 1),
            partner,
            purpose: [expense.purpose, `${billedKm(expense)} km × ${formatAmount(expense.mileageRate)} EUR`],
            reference: "—",
            amount: euro(expense.amount),
          };
        }
        return {
          number: String(index + 1),
          partner: [expense.merchant],
          purpose: [expense.purpose],
          reference: expense.receiptReference || "—",
          amount: euro(expense.amount),
        };
      }),
      total: { label: t("Total"), amount: euro(claim.total) },
    },
    receiptNote: t(
      "The receipts follow in item order and, within each item, in the chosen file order. PDF bookmarks assign the pages to the items.",
    ),
    declaration: {
      heading: t("Declaration and signature"),
      text: snapshotText(snapshot, "declaration"),
      signatureLabel: t("Signature"),
      signed: `${claim.fullName} · ${formatInstantDate(claim.submittedAt)}`,
      versions: t("Declaration {version} confirmed. Privacy notice version {privacy} acknowledged.", {
        version: snapshotText(snapshot, "declaration_version"),
        privacy: snapshotText(snapshot, "privacy_version"),
      }),
    },
  };
}

/**
 * Builds the claim's PDF in `workspace` (a temporary workspace of the claim), in
 * the language its participant saw. Returns the PDF's path and the child's answer.
 */
export async function buildClaimPdf(
  claimRef: { id: string },
  workspace: string,
): Promise<{ path: string; result: BuildResult }> {
  const [claim] = await q().select().from(claims).where(eq(claims.id, claimRef.id));
  if (!claim) throw new Error(`Claim ${claimRef.id} does not exist`);
  return forClaim(claim, async () => {
    const files = await q().select().from(uploads).where(eq(uploads.claimId, claim.id));
    const rows = await q()
      .select()
      .from(expenses)
      .where(eq(expenses.claimId, claim.id))
      .orderBy(asc(expenses.position));
    const signature = files.find((upload) => upload.kind === "signature");
    // Acceptance guarantees a signature; without one the job fails as unexpected, as in 0.4.
    if (!signature) throw new Error(`Claim ${claim.id} has no signature`);
    const receipts: ReceiptInput[] = [];
    for (const expense of rows) {
      const own = files
        .filter((upload) => upload.expenseId === expense.id && upload.kind === "receipt")
        .sort((a, b) => a.position - b.position);
      for (const upload of own) {
        receipts.push({
          path: pathFor(upload.normalizedKey),
          mediaType: upload.mediaType,
          label: [t("Item {number}", { number: expense.position + 1 }), expense.receiptReference]
            .filter(Boolean)
            .join(" · "),
        });
      }
    }
    const manifest: BuildManifest = {
      summary: claimSummary(claim, rows),
      signature: pathFor(signature.normalizedKey),
      receipts,
      title: t("Reimbursement {reference}", { reference: claimReference(claim) }),
      maxBytes: config().MAX_FINAL_PDF_BYTES,
    };
    const manifestPath = path.join(workspace, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest), { encoding: "utf8", mode: 0o600 });
    const output = path.join(workspace, "complete.pdf");
    const result = await assemblePdf(manifestPath, output);
    return { path: output, result };
  });
}
