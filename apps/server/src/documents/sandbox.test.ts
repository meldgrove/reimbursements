// The document sandbox: the launcher's Landlock rules and limits, the
// add-on's seccomp filter, and the runner (tests/test_resource_limits.py's
// confinement test and the runner behaviour of portal/services/documents.py).
// It needs Linux with Landlock ABI 3+ and libseccomp, as 0.4's tests did.
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { overrideConfigForTests } from "../config";
import { SERVER_ROOT } from "../paths";
import {
  builtWorker,
  childEnvironment,
  configuredRunner,
  execute,
  inspectUpload,
  assemblePdf,
  ProcessingError,
  runnerOptions,
  sandboxCommand,
  sandboxReady,
} from "../services/documents";
import { launcherPath, sandboxAddon } from "./sandbox";
import { prepareSandbox, removeSandboxBuild, workerBuild } from "./sandbox-test-support";
import { filledFormPdf, imageBytes, writeManifest } from "./test-files";

let directory: string;
let workerScript: string;

beforeAll(async () => {
  workerScript = await prepareSandbox();
}, 120_000);

afterAll(() => removeSandboxBuild());

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function fresh(): string {
  // Inside the repository's folder, so the child's node_modules are those of the app.
  directory = mkdtempSync(path.join(os.tmpdir(), "sandbox-"));
  return directory;
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toSatisfy((error) => error instanceof ProcessingError && error.code === code);
}

const PROBE = `
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(import.meta.url);
const addon = require(process.env.DOCUMENT_SANDBOX_ADDON);
const [workspace, allowed, privateFile] = process.argv.slice(2);
const parent = process.ppid;
// The execution lock the parent holds and passed on as descriptor 3.
const lock = 3;
addon.lockdown();
if (fs.readFileSync(allowed, "utf8") !== "synthetic receipt") throw new Error("allowed input unreadable");
const raw = (name) => () => {
  const errno = addon.probe(name, parent);
  if (errno) throw Object.assign(new Error(name), { code: errno === 1 ? "EPERM" : "E" + errno });
};
const attempts = [
  ["private_read", () => fs.readFileSync(privateFile)],
  ["private_write", () => fs.writeFileSync(privateFile, "changed")],
  ["private_chmod", () => fs.chmodSync(privateFile, 0)],
  ...["ipv4", "ipv6", "unix_socket", "parent_signal", "parent_pidfd", "parent_pidfd_signal", "parent_sigqueue",
      "parent_thread_sigqueue", "parent_limits", "parent_priority", "parent_affinity", "parent_scheduler",
      "parent_schedparam", "exec"].map((name) => [name, raw(name)]),
  ["execution_unlock", () => addon.flock(lock, "unlock")],
  ["outside_create", () => fs.writeFileSync(path.join(path.dirname(workspace), "escape"), "changed")],
];
const denied = [];
for (const [name, attempt] of attempts) {
  try {
    attempt();
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error.code) || /not permitted|denied/i.test(error.message)) {
      denied.push(name);
      continue;
    }
    throw error;
  }
  throw new Error("allowed: " + name);
}
fs.writeFileSync(path.join(workspace, "output.txt"), "bounded output");
console.log(JSON.stringify(denied));
`;

describe("confinement", () => {
  it("gives the parser no unrelated files, network or process authority", () => {
    const root = fresh();
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { mode: 0o700 });
    const allowed = path.join(root, "allowed.txt");
    writeFileSync(allowed, "synthetic receipt");
    const privateFile = path.join(root, "unrelated.env");
    writeFileSync(privateFile, "synthetic private value");
    // The probe sits next to the worker bundle: it resolves no packages.
    const probe = path.join(path.dirname(workerScript), "probe.mjs");
    writeFileSync(probe, PROBE);
    const lock = openSync(path.join(root, "execution.lock"), "a+");
    expect(sandboxAddon()!.flock(lock, "shared")).toBe(true);
    const command = sandboxCommand([allowed], workspace, probe);
    const result = spawnSync(command[0]!, [...command.slice(1), workspace, allowed, privateFile], {
      env: childEnvironment(workspace),
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["ignore", "pipe", "pipe", lock],
    });
    closeSync(lock);
    expect(result.status, result.stderr).toBe(0);
    const denied = JSON.parse(result.stdout) as string[];
    expect(denied).toHaveLength(19);
    expect(readFileSync(privateFile, "utf8")).toBe("synthetic private value");
    expect(existsSync(path.join(root, "escape"))).toBe(false);
    expect(readFileSync(path.join(workspace, "output.txt"), "utf8")).toBe("bounded output");
  });

  it("filters the threads that run before lockdown too", () => {
    const workspace = fresh();
    // A thread started before lockdown() asks for a socket after it (TSYNC).
    const probe = path.join(path.dirname(workerScript), "thread-probe.mjs");
    writeFileSync(
      probe,
      `
import { once } from "node:events";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
const addon = createRequire(import.meta.url)(process.env.DOCUMENT_SANDBOX_ADDON);
const worker = new Worker(
  'const { parentPort } = require("node:worker_threads");' +
    'const addon = require(process.env.DOCUMENT_SANDBOX_ADDON);' +
    'parentPort.on("message", () => parentPort.postMessage(addon.probe("ipv4", 0)));' +
    'parentPort.postMessage("ready");',
  { eval: true },
);
await once(worker, "message");
addon.lockdown();
worker.postMessage("probe");
const [errno] = await once(worker, "message");
console.log(JSON.stringify({ errno }));
process.exit(0);
`,
    );
    const command = sandboxCommand([], workspace, probe);
    const result = spawnSync(command[0]!, command.slice(1), {
      env: childEnvironment(workspace),
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ errno: 1 });
  });

  it("lets the development server from the sources use the built bundle", async () => {
    const bundle = builtWorker();
    const created = !existsSync(bundle);
    if (created) {
      await (
        await workerBuild()
      ).buildFileWorker(path.dirname(bundle), {
        logLevel: "silent",
        sourcemap: false,
      });
    }
    const previous = runnerOptions.workerScript;
    runnerOptions.workerScript = undefined;
    overrideConfigForTests({ DOCUMENT_SANDBOX_ENABLED: true });
    try {
      const root = fresh();
      const image = path.join(root, "receipt.png");
      writeFileSync(image, await imageBytes());
      const workspace = path.join(root, "workspace");
      mkdirSync(workspace);
      expect(sandboxCommand([], workspace)).toContain(bundle);
      expect(await inspectUpload(image, workspace, "receipt")).toMatchObject({ mediaType: "image/jpeg" });
    } finally {
      runnerOptions.workerScript = previous;
      if (created) {
        rmSync(bundle, { force: true });
        rmSync(path.join(path.dirname(bundle), "file-worker-chunks"), { recursive: true, force: true });
      }
    }
  }, 60_000);

  it("fails closed when the child runs without the launcher's rules", () => {
    const workspace = fresh();
    const result = spawnSync(process.execPath, [workerScript, "--sandboxed", "self-test", workspace], {
      env: childEnvironment(workspace),
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ error: "document_sandbox_unavailable" });
  });

  it("refuses to start without Landlock rules for a workspace", () => {
    const launcher = path.join(SERVER_ROOT, "native", "build", "launcher");
    const result = spawnSync(launcher, ["--", process.execPath, "-e", "console.log('ran')"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(125);
    expect(result.stdout).toBe("");
  });

  it("passes its probe, and only with the sandbox enabled", async () => {
    const restore = overrideConfigForTests({ DOCUMENT_SANDBOX_ENABLED: true });
    try {
      expect(await sandboxReady()).toBe(true);
    } finally {
      restore();
    }
    overrideConfigForTests({ DOCUMENT_SANDBOX_ENABLED: false, isDevelopment: false });
    expect(await configuredRunner().ready("/nonexistent")).toBe(false);
    await expectCode(
      execute(["validate"], { readonly: [], workspace: fresh() }),
      "document_sandbox_unavailable",
    );
  });
});

describe("the sandboxed child", () => {
  it("validates receipts and builds a claim PDF with every parser", async () => {
    overrideConfigForTests({ DOCUMENT_SANDBOX_ENABLED: true });
    const root = fresh();
    const inputs = path.join(root, "inputs");
    mkdirSync(inputs);
    const image = path.join(inputs, "receipt.png");
    writeFileSync(image, await imageBytes());
    const pdf = path.join(inputs, "form.pdf");
    writeFileSync(pdf, await filledFormPdf());
    const signature = path.join(inputs, "signature.png");
    writeFileSync(signature, await imageBytes({ signature: true }));
    const validation = path.join(root, "validation");
    mkdirSync(validation);
    const normalized = await inspectUpload(image, validation, "receipt");
    expect(normalized).toMatchObject({ mediaType: "image/jpeg", pages: 1 });
    expect(normalized.normalized).toBe(path.join(validation, "normalized.jpg"));
    expect(await inspectUpload(pdf, validation, "receipt")).toEqual({
      normalized: pdf,
      mediaType: "application/pdf",
      pages: 1,
    });
    const cleanSignature = await inspectUpload(signature, validation, "signature");
    const build = path.join(root, "build");
    mkdirSync(build);
    const manifest = writeManifest(build, {
      receipts: [
        { path: normalized.normalized, mediaType: "image/jpeg", label: "Item 1" },
        { path: pdf, mediaType: "application/pdf", label: "Item 2" },
      ],
      signature: cleanSignature.normalized,
      maxBytes: 10_000_000,
    });
    const result = await assemblePdf(manifest, path.join(build, "complete.pdf"));
    expect(result).toMatchObject({ pages: 3, dpi: 160 });
    expect(readFileSync(path.join(build, "complete.pdf")).subarray(0, 5).toString()).toBe("%PDF-");
  }, 60_000);

  it("answers a library's failure only with a code", async () => {
    overrideConfigForTests({ DOCUMENT_SANDBOX_ENABLED: true });
    const root = fresh();
    const broken = path.join(root, "broken.pdf");
    writeFileSync(broken, "%PDF-1.4\nsecret participant text that must not leak\n");
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace);
    await expectCode(inspectUpload(broken, workspace, "receipt"), "invalid_document");
    expect(readFileSync(path.join(workspace, "process-result.json"), "utf8").trim()).toBe(
      '{"error":"invalid_document"}',
    );
  });

  it("reads only the inputs it was given", async () => {
    overrideConfigForTests({ DOCUMENT_SANDBOX_ENABLED: true });
    const root = fresh();
    const other = path.join(root, "other.png");
    writeFileSync(other, await imageBytes());
    const allowed = path.join(root, "allowed.png");
    writeFileSync(allowed, await imageBytes());
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace);
    // The command allows `allowed.png` only; the child is asked for another file.
    await expectCode(
      execute(["validate", other, workspace, "receipt"], { readonly: [allowed], workspace }),
      "invalid_document",
    );
    expect(
      (await execute(["validate", allowed, workspace, "receipt"], { readonly: [allowed], workspace })).pages,
    ).toBe(1);
  });
});

describe("the runner", () => {
  const scripts: string[] = [];
  afterAll(() => scripts.forEach((script) => rmSync(script, { force: true })));

  function script(name: string, source: string): string {
    const file = path.join(SERVER_ROOT, "native", "build", `${name}-${process.pid}.mjs`);
    writeFileSync(file, source);
    scripts.push(file);
    return file;
  }

  it("kills a child that runs too long", async () => {
    overrideConfigForTests({ DOCUMENT_SANDBOX_ENABLED: false, isDevelopment: true, JOB_TIMEOUT_SECONDS: 1 });
    const previous = runnerOptions.workerScript;
    runnerOptions.workerScript = script("sleeper", "setTimeout(() => {}, 60_000);");
    try {
      const started = Date.now();
      await expectCode(execute(["validate"], { readonly: [], workspace: fresh() }), "document_timeout");
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      runnerOptions.workerScript = previous;
    }
  });

  it("refuses answers that are not one small JSON object", async () => {
    overrideConfigForTests({ DOCUMENT_SANDBOX_ENABLED: false, isDevelopment: true });
    const previous = runnerOptions.workerScript;
    try {
      for (const source of [
        "process.stdout.write('not json')",
        "process.stdout.write(JSON.stringify({ padding: 'x'.repeat(70000) }))",
        "process.stdout.write('[1, 2]')",
        "process.stdout.write('{}'); process.exitCode = 3",
        // Only known codes pass: other text may hold file names or document content.
        "process.stdout.write(JSON.stringify({ error: 'Alex Example /tmp/receipt.pdf' })); process.exitCode = 1",
      ]) {
        runnerOptions.workerScript = script("answer", source);
        await expectCode(
          execute(["validate"], { readonly: [], workspace: fresh() }),
          "document_process_failed",
        );
      }
      runnerOptions.workerScript = script(
        "answer",
        "process.stdout.write(JSON.stringify({ error: 'pdf_pages' })); process.exitCode = 1",
      );
      await expectCode(execute(["validate"], { readonly: [], workspace: fresh() }), "pdf_pages");
    } finally {
      runnerOptions.workerScript = previous;
    }
  });

  it("reports a launcher that cannot start the child as sandbox unavailable", async () => {
    overrideConfigForTests({ DOCUMENT_SANDBOX_ENABLED: false, isDevelopment: true });
    const previous = runnerOptions.workerScript;
    // The launcher's own failure: exit 125 before the child answers.
    runnerOptions.workerScript = script("launcher-failed", "process.exit(125);");
    try {
      await expectCode(
        execute(["validate"], { readonly: [], workspace: fresh() }),
        "document_sandbox_unavailable",
      );
    } finally {
      runnerOptions.workerScript = previous;
    }
  });

  it("keeps the resource limits in development without the sandbox", async () => {
    overrideConfigForTests({ DOCUMENT_SANDBOX_ENABLED: false, isDevelopment: true });
    const previous = runnerOptions.workerScript;
    runnerOptions.workerScript = script(
      "limits",
      "import fs from 'node:fs'; process.stdout.write(JSON.stringify({ limits: fs.readFileSync('/proc/self/limits', 'utf8') }))",
    );
    try {
      expect(configuredRunner().command(["validate"], { readonly: [], workspace: fresh() })[0]).toBe(
        launcherPath(),
      );
      const { limits } = await execute(["validate"], { readonly: [], workspace: fresh() });
      expect(limits).toMatch(/Max open files\s+128\s+128/);
      expect(limits).toMatch(/Max data size\s+2000000000\s+2000000000/);
    } finally {
      runnerOptions.workerScript = previous;
    }
  });

  it("gives the child no inherited configuration", async () => {
    overrideConfigForTests({ DOCUMENT_SANDBOX_ENABLED: false, isDevelopment: true });
    const previous = runnerOptions.workerScript;
    process.env.SECRET_FOR_TEST = "must not reach the child";
    runnerOptions.workerScript = script(
      "environment",
      "process.stdout.write(JSON.stringify({ keys: Object.keys(process.env).sort() }))",
    );
    try {
      const answer = await execute(["validate"], { readonly: [], workspace: fresh() });
      expect(answer.keys).toEqual(
        [
          "DOCUMENT_FONTS",
          "DOCUMENT_SANDBOX_ADDON",
          "LANG",
          "OPENSSL_CONF",
          "PATH",
          "TMPDIR",
          "XDG_CACHE_HOME",
        ].sort(),
      );
    } finally {
      delete process.env.SECRET_FOR_TEST;
      runnerOptions.workerScript = previous;
    }
  });
});
