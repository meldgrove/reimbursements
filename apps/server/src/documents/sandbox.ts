/**
 * The native parts of the document sandbox (native/sandbox): the launcher,
 * which applies the resource limits and Landlock before node starts, and the
 * add-on with lockdown() (seccomp), flock() and the tests' probe().
 * `node native/sandbox/build.mjs` builds both into native/build/; the image
 * builds them too.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { SERVER_ROOT } from "../paths";

export type SandboxAddon = {
  /** Installs the seccomp deny-list for every thread; throws when Landlock is not in force. */
  lockdown(): void;
  /** flock(2): "shared" waits, "exclusive" does not (false when taken), "unlock". */
  flock(fd: number, mode: "shared" | "exclusive" | "unlock"): boolean;
  /** One raw system call (see sandbox.c); its errno, 0 on success. Tests only. */
  probe(name: string, pid: number): number;
};

export function nativeDirectory(): string {
  return path.join(SERVER_ROOT, "native", "build");
}

/** The add-on; the document child gets its path from the parent (DOCUMENT_SANDBOX_ADDON). */
export function addonPath(): string {
  return process.env.DOCUMENT_SANDBOX_ADDON || path.join(nativeDirectory(), "sandbox.node");
}

export function launcherPath(): string {
  return path.join(nativeDirectory(), "launcher");
}

/** Whether both native parts are built. */
export function nativeBuilt(): boolean {
  return existsSync(addonPath()) && existsSync(launcherPath());
}

let loaded: SandboxAddon | null | undefined;

/** The add-on, or null when it is not built (development without a C compiler). */
export function sandboxAddon(): SandboxAddon | null {
  if (loaded !== undefined) return loaded;
  try {
    loaded = createRequire(import.meta.url)(addonPath()) as SandboxAddon;
  } catch {
    loaded = null;
  }
  return loaded;
}
