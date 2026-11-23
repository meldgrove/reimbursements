/**
 * The document child: the only process that parses receipts and signatures
 * (portal/file_worker.py and the bootstrap of portal/document_sandbox.py).
 *
 *   file-worker [--sandboxed] validate SOURCE DESTINATION KIND
 *   file-worker [--sandboxed] build MANIFEST OUTPUT
 *   file-worker --sandboxed self-test WORKSPACE
 *
 * --sandboxed: started by the launcher, which already applied the resource
 * limits and Landlock; lockdown() adds the seccomp filter before any parser
 * module loads (they load with the dynamic import below). Without it
 * (development only) the same work runs unconfined.
 *
 * The answer is one line of JSON on stdout, which the parent opened as a file
 * in the workspace. A failure answers {"error": code} and exits with 1. Library
 * errors never leave the child with their text, which may hold file names,
 * document text or personal data: only DocumentError codes or invalid_document.
 */
import { readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { sandboxAddon } from "./sandbox";

/** EPERM, which the seccomp filter answers. */
const EPERM = 1;

function answer(value: unknown, failed = false) {
  writeSync(1, `${JSON.stringify(value)}\n`);
  if (failed) process.exitCode = 1;
}

function selfTest(workspace: string): boolean {
  const addon = sandboxAddon();
  if (!addon) return false;
  try {
    readFileSync("/etc/passwd");
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EACCES") return false;
  }
  if (addon.probe("ipv4", 0) !== EPERM) return false;
  const probe = path.join(workspace, "probe");
  writeFileSync(probe, "sandbox probe");
  unlinkSync(probe);
  return true;
}

async function main(argv: string[]) {
  // Library chatter must not reach stdout, which holds the answer.
  // eslint-disable-next-line no-console -- the one place that redirects the console
  console.log = console.info = console.debug = console.error;
  const sandboxed = argv[0] === "--sandboxed";
  const [action, ...args] = sandboxed ? argv.slice(1) : argv;
  if (sandboxed) {
    try {
      const addon = sandboxAddon();
      if (!addon) throw new Error("add-on missing");
      addon.lockdown();
    } catch {
      answer({ error: "document_sandbox_unavailable" }, true);
      return;
    }
  }
  if (action === "self-test") {
    if (!sandboxed || !selfTest(args[0] ?? "")) {
      process.exitCode = 1;
      return;
    }
    writeSync(1, "sandbox_ok\n");
    return;
  }
  // Parsers load only now, after lockdown().
  const { DocumentError, buildPdf, validateFile } = await import("./convert");
  try {
    if (action === "validate" && args.length === 3) {
      const kind = args[2] === "signature" ? "signature" : "receipt";
      answer(await validateFile(args[0]!, args[1]!, kind));
    } else if (action === "build" && args.length === 2) {
      answer(await buildPdf(args[0]!, args[1]!));
    } else {
      answer({ error: "invalid_document" }, true);
    }
  } catch (error) {
    answer({ error: error instanceof DocumentError ? error.code : "invalid_document" }, true);
  }
}

await main(process.argv.slice(2));
