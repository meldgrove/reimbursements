// tests/test_readiness_recovery.py of the Django version.
import type * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../db/client";
import { jobs } from "../db/schema";
import { prepareSandbox, removeSandboxBuild } from "../documents/sandbox-test-support";
import { accepted, freshState, localSettings } from "../test/back-office";
import { request } from "../test/helpers";
import { sandboxReady } from "./documents";

type ChildProcessModule = typeof childProcess;

/** What the next probe children do (spawn is replaced below). */
const children = vi.hoisted(() => ({ behaviours: [] as string[], spawned: 0, real: true }));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<ChildProcessModule>();
  const fake = (...args: Parameters<typeof original.spawn>) => {
    if (children.real) return original.spawn(...args);
    children.spawned += 1;
    const behaviour = children.behaviours.shift() ?? "ok";
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), pid: undefined });
    setImmediate(() => {
      if (behaviour === "os_error") {
        child.emit("error", Object.assign(new Error("synthetic transient failure"), { code: "EAGAIN" }));
        return;
      }
      if (behaviour === "timeout") {
        // Nothing answers: the runner's timer ends the wait.
        setTimeout(() => child.emit("close", null), 5_200);
        return;
      }
      child.stdout.emit("data", Buffer.from(behaviour === "invalid_output" ? "invalid" : "sandbox_ok\n"));
      child.emit("close", behaviour === "exit" ? 1 : 0);
    });
    return child;
  };
  return { ...original, spawn: fake, default: { ...original, spawn: fake } };
});

beforeEach(freshState);
afterEach(() => vi.useRealTimers());

describe("queue health", () => {
  it.each([
    ["pending", 3600, 0, 200],
    ["pending", -2, 2, 200],
    ["running", -2, 2, 200],
    ["pending", -901, 901, 503],
    ["running", -901, 901, 503],
  ])(
    "measures the time since a job became due (%s, %i s)",
    async (state, dueSeconds, expectedAge, status) => {
      await accepted();
      const now = new Date();
      vi.useFakeTimers({ toFake: ["Date"], now });
      localSettings({ MAX_JOB_AGE_SECONDS: 900 });
      await getDb()
        .update(jobs)
        .set({
          state,
          createdAt: new Date(now.getTime() - 24 * 3600 * 1000),
          runAfter: new Date(now.getTime() + dueSeconds * 1000),
        });
      const response = await request("GET", "/-/readyz");
      expect(response.status).toBe(status);
      expect(response.body.oldest_job_age_seconds).toBe(expectedAge);
      expect(response.body.checks.queue).toBe(status === 200);
    },
  );
});

describe("the sandbox probe", () => {
  beforeAll(async () => {
    await prepareSandbox();
  }, 120_000);

  afterAll(() => removeSandboxBuild());

  afterEach(() => {
    children.real = true;
    children.behaviours = [];
    children.spawned = 0;
  });

  it.each(["timeout", "os_error", "exit", "invalid_output"])(
    "can recover after a failure (%s)",
    async (failure) => {
      const root = mkdtempSync(path.join(os.tmpdir(), "probe-"));
      localSettings({ PRIVATE_STORAGE_ROOT: root, DOCUMENT_SANDBOX_ENABLED: true });
      children.real = false;
      children.behaviours = [failure];
      expect(await sandboxReady()).toBe(false);
      expect(await sandboxReady()).toBe(true);
      expect(await sandboxReady()).toBe(true);
      expect(children.spawned).toBe(2);
    },
    20_000,
  );
});
