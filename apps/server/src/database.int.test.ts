// tests/test_database_outage.py of the Django version, on PostgreSQL: a job
// that loses its connection is handed on as if its worker died, the worker
// carries on across a restart, and a kept connection reconnects after one.
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getDb, getPool } from "./db/client";
import { confirmations, forms, jobs, uploads, type Job } from "./db/schema";
import { atomic, q } from "./db/tx";
import { logger } from "./logger";
import { CLAIM_STATES } from "./services/claim-status";
import { CONFIRM, RENDER, VALIDATE } from "./services/job-kinds";
import { Interrupted, runOne } from "./services/jobs";
import { accepted, claimRow, freshState, queuedUpload, unusedPort } from "./test/back-office";
import { createForm } from "./test/fixtures";
import { TEST_DATABASE_URL } from "./test/env";
import { loop, runJobs } from "./worker";

beforeEach(freshState);
afterEach(() => vi.restoreAllMocks());

function serverError(code: string, message: string): pg.DatabaseError {
  const error = new pg.DatabaseError(message, message.length, "error");
  error.code = code;
  return error;
}

const lost = () => serverError("57P01", "terminating connection due to administrator command");

async function jobRow(id: number): Promise<Job> {
  const [job] = await getDb().select().from(jobs).where(eq(jobs.id, id));
  return job!;
}

async function jobOf(kind: string): Promise<Job> {
  const [job] = await getDb().select().from(jobs).where(eq(jobs.kind, kind));
  return job!;
}

function logs() {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
  vi.spyOn(logger, "info").mockImplementation(() => undefined);
  return { warn, error };
}

/**
 * What PostgreSQL does to every session when it shuts down for a restart:
 * ends the session `pid`, or every other session of the test database, and
 * waits until they are gone.
 */
async function terminate(pid?: number) {
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  const which = pid
    ? { text: "pid = $1", values: [pid] }
    : { text: "datname = current_database() and pid <> pg_backend_pid()", values: [] };
  try {
    await admin.query(
      `select pg_terminate_backend(pid) from pg_stat_activity where ${which.text}`,
      which.values,
    );
    for (let index = 0; index < 100; index += 1) {
      const { rowCount } = await admin.query(
        `select 1 from pg_stat_activity where ${which.text}`,
        which.values,
      );
      if (!rowCount) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("sessions still running");
  } finally {
    await admin.end();
  }
}

/** Points the pool's new connections at `url` (a closed port while the database restarts). */
function connectTo(url: string) {
  (getPool() as unknown as { options: pg.PoolConfig }).options.connectionString = url;
}

it("a job that loses its connection runs again once the database is back", async () => {
  const { claim } = await accepted();
  const job = await jobOf("render");
  const runs: number[] = [];
  vi.spyOn(RENDER, "run").mockImplementation(async (current, lease) => {
    runs.push(current.attempts);
    if (runs.length === 1) throw lost();
    await lease.finish();
  });
  const interruption = await runOne().catch((error: unknown) => error);
  expect(interruption).toBeInstanceOf(Interrupted);
  const running = await jobRow(job.id);
  expect(running.state).toBe("running");
  await (interruption as Interrupted).lease.abandon();
  const handedOn = await jobRow(job.id);
  expect([handedOn.state, handedOn.errorCode, handedOn.runAfter]).toEqual([
    "pending",
    "worker_interrupted",
    running.runAfter,
  ]);
  expect([handedOn.leaseToken, (await claimRow(claim.id)).state]).toEqual([null, CLAIM_STATES.RECEIVED]);
  expect(await runOne()).toBe(true);
  expect([runs, (await jobRow(job.id)).state]).toEqual([[1, 2], "done"]);
});

it("an email that loses its connection is never sent twice", async () => {
  const { claim } = await accepted();
  await getDb()
    .delete(jobs)
    .where(sql`${jobs.kind} <> 'confirm'`);
  const job = await jobOf("confirm");
  vi.spyOn(CONFIRM, "run").mockRejectedValue(lost());
  const interruption = await runOne().catch((error: unknown) => error);
  expect(interruption).toBeInstanceOf(Interrupted);
  await (interruption as Interrupted).lease.abandon();
  const failed = await jobRow(job.id);
  expect([failed.state, failed.errorCode]).toEqual(["failed", "send_unknown"]);
  const [confirmation] = await getDb()
    .select()
    .from(confirmations)
    .where(eq(confirmations.claimId, claim.id));
  expect(confirmation!.state).toBe("send_unknown");
});

it.each([
  ["timeout", serverError("57014", "canceling statement due to statement timeout")],
  ["integrity", serverError("23505", "duplicate key value violates unique constraint")],
])("real database errors still fail the job: %s", async (_name, error) => {
  const { error: errors } = logs();
  await accepted();
  const job = await jobOf("render");
  vi.spyOn(RENDER, "run").mockRejectedValue(error);
  expect(await runOne()).toBe(true);
  const failed = await jobRow(job.id);
  expect([failed.state, failed.errorCode]).toEqual(["failed", "processing_error"]);
  expect(errors.mock.calls.map((call) => call[1])).toEqual(["job_failed"]);
});

it("the worker carries on across a database restart", async () => {
  const { warn, error } = logs();
  const { upload, job } = await queuedUpload();
  const closed = `postgresql://reimbursement:reimbursement@127.0.0.1:${await unusedPort()}/reimbursements`;
  const realRun = VALIDATE.run.bind(VALIDATE);
  const runs: number[] = [];
  vi.spyOn(VALIDATE, "run").mockImplementation(async (current, lease) => {
    runs.push(current.attempts);
    if (runs.length === 1) {
      // PostgreSQL ends every session, the job's open transaction too, then
      // refuses connections while it starts again.
      await atomic(async () => {
        await q().execute(sql`select 1`);
        await terminate();
        connectTo(closed);
        await q().execute(sql`select 1`);
      });
    }
    await realRun(current, lease);
  });
  const sleeps: number[] = [];
  vi.spyOn(loop, "sleep").mockImplementation(async (ms: number) => {
    sleeps.push(ms / 1000);
    // Started again.
    if (sleeps.length === 3) connectTo(TEST_DATABASE_URL);
  });
  try {
    await runJobs({ once: true });
  } finally {
    connectTo(TEST_DATABASE_URL);
  }
  const done = await jobRow(job.id);
  const [validated] = await getDb().select().from(uploads).where(eq(uploads.id, upload.id));
  expect([runs, sleeps]).toEqual([
    [1, 2],
    [1, 2, 4],
  ]);
  expect([done.state, done.attempts, validated!.state]).toEqual(["done", 2, "ready"]);
  expect(error).not.toHaveBeenCalled();
  // Error and wait of each warning: the ended session, then two refused connections.
  const warnings = warn.mock.calls
    .filter((call) => call[1] === "database_unavailable")
    .map((call) => {
      const fields = call[0] as unknown as { error: string; retry_in: number };
      return [fields.error, fields.retry_in];
    });
  expect(warnings).toEqual([
    ["Client has encountered a connection error and is not queryable", 1],
    ["ECONNREFUSED", 2],
    ["ECONNREFUSED", 4],
  ]);
});

it("a kept connection is checked after a restart", async () => {
  // Web requests and the worker keep idle connections in the pool.
  const form = await createForm();
  const { rows } = await getPool().query<{ pid: number }>("select pg_backend_pid() as pid");
  await terminate(rows[0]!.pid);
  // What the next request does.
  const [found] = await getDb().select().from(forms);
  expect(found!.id).toBe(form.id);
});
