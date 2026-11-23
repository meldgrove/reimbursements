// tests/test_database_outage.py of the Django version: the worker's loop waits
// out a lost database connection, hands on the job it interrupted, and still
// stops on a real database error.
import pg from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { logger } from "../logger";
import { Interrupted, type Lease } from "../services/jobs";
import { loop, runJobs } from "./index";

afterEach(() => vi.restoreAllMocks());

function serverError(code: string, message: string): pg.DatabaseError {
  const error = new pg.DatabaseError(message, message.length, "error");
  error.code = code;
  return error;
}

const lost = () => serverError("57P01", "terminating connection due to administrator command");

/** `loop.work` that throws or returns each outcome in turn. */
function scripted(...outcomes: (boolean | Error)[]) {
  const calls: number[] = [];
  vi.spyOn(loop, "work").mockImplementation(async () => {
    calls.push(calls.length);
    const outcome = outcomes.shift()!;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  return calls;
}

/** Records the worker's pauses (in seconds) instead of waiting. */
function workerSleeps() {
  const sleeps: number[] = [];
  vi.spyOn(loop, "sleep").mockImplementation(async (ms: number) => {
    sleeps.push(ms / 1000);
  });
  return sleeps;
}

function quietLogs() {
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
  const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
  return { info, error };
}

it("waits out a lost connection with backoff", async () => {
  const { info, error } = quietLogs();
  const calls = scripted(lost(), lost(), lost(), true);
  const sleeps = workerSleeps();
  await runJobs({ once: true });
  expect([calls.length, sleeps]).toEqual([4, [1, 2, 4]]);
  expect(error).not.toHaveBeenCalled();
  expect(info).toHaveBeenCalledWith({ seconds: 0 }, "database_available");
});

it("hands on an interrupted job before the next one", async () => {
  quietLogs();
  const abandoned: number[] = [];
  // The database is still away at the first try to hand the job on.
  const attempts = [lost(), null];
  const lease = {
    job: { id: 1 },
    abandon: async () => {
      abandoned.push(calls.length);
      const failure = attempts.shift();
      if (failure) throw failure;
    },
  } as unknown as Lease;
  const calls = scripted(new Interrupted(lease, { cause: lost() }), true);
  const sleeps = workerSleeps();
  await runJobs({ once: true });
  expect([abandoned, calls.length, sleeps]).toEqual([[1, 1], 2, [1, 2]]);
});

it("still stops on a real database error", async () => {
  quietLogs();
  const diskFull = serverError("53100", "could not extend file");
  scripted(diskFull);
  workerSleeps();
  await expect(runJobs({ once: true })).rejects.toBe(diskFull);
});
