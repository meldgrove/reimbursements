/**
 * Prepares the sandboxed document child for tests: builds the native parts
 * when they are missing or older than their sources, and bundles the child
 * into a folder of this test process, which the runner then uses. Tests only.
 */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SERVER_ROOT } from "../paths";
import { runnerOptions } from "../services/documents";

const outdir = path.join(SERVER_ROOT, "native", "build", `test-worker-${process.pid}`);

export async function prepareSandbox(): Promise<string> {
  execFileSync(process.execPath, [path.join(SERVER_ROOT, "native", "sandbox", "build.mjs"), "--if-missing"], {
    stdio: "ignore",
  });
  const module = (await import(
    pathToFileURL(path.join(SERVER_ROOT, "scripts", "build-file-worker.mjs")).href
  )) as {
    buildFileWorker(outdir: string, options?: { logLevel?: string; sourcemap?: boolean }): Promise<string>;
  };
  const script = await module.buildFileWorker(outdir, { logLevel: "silent", sourcemap: false });
  runnerOptions.workerScript = script;
  return script;
}

export function removeSandboxBuild() {
  runnerOptions.workerScript = undefined;
  rmSync(outdir, { recursive: true, force: true });
}
