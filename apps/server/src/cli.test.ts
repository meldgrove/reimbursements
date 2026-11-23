// The CLI's exit: refusals as written, other failures without their message,
// and no output lost to a pipe that reads slowly.
import { spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SERVER_ROOT } from "./paths";

const ENV = {
  PATH: process.env.PATH ?? "",
  DJANGO_DEBUG: "1",
  DEPLOYMENT_ENV: "development",
  PRIVATE_STORAGE_ROOT: "/tmp/reimbursements-cli-test",
  LOG_LEVEL: "info",
};

/** Runs the CLI with `command`; reads its output only after `delayMs`, as a slow pipe would. */
function cli(command: string, delayMs = 0): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(SERVER_ROOT, "src/test/cli-child.ts"), command],
      { cwd: SERVER_ROOT, env: ENV },
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.pause();
    setTimeout(() => {
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stdout.resume();
    }, delayMs);
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }),
    );
  });
}

describe("cli", () => {
  it("prints a refusal as written", async () => {
    const result = await cli("refuse");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Name the Finance inbox: --to <address>.");
  }, 60_000);

  it("logs an unexpected failure without its message", async () => {
    const result = await cli("fail-privately");
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("command_failed");
    expect(result.stdout + result.stderr).not.toContain("SYNTHETIC_PRIVATE");
  }, 60_000);

  it("passes on all output before it exits", async () => {
    const result = await cli("flood", 1000);
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBe(3000 * 1000);
  }, 60_000);
});
