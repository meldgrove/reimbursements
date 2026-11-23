// tests/test_database_outage.py of the Django version: which errors mean a lost
// connection, and the backoff and reporting while the database is away.
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectionLost, markConnectionError, Outage, REPORT_AFTER_SECONDS } from "./database";
import { logger } from "./logger";

afterEach(() => vi.restoreAllMocks());

/** An error PostgreSQL sent, as node-postgres raises it. */
function serverError(code: string, message: string): pg.DatabaseError {
  const error = new pg.DatabaseError(message, message.length, "error");
  error.code = code;
  return error;
}

/** An error of the database's own connection, as db/client.ts marks it. */
function connectionError(message: string, code?: string): Error {
  const error = Object.assign(new Error(message), code ? { code } : {});
  markConnectionError(error);
  return error;
}

/** A query error as Drizzle raises it: wrapped around the driver's error. */
function drizzleError(cause: Error): Error {
  return Object.assign(new Error("Failed query: select 1\nparams: "), {
    query: "select 1",
    params: [],
    cause,
  });
}

function lost() {
  return serverError("57P01", "terminating connection due to administrator command");
}

describe("a lost connection", () => {
  it.each([
    ["AdminShutdown", serverError("57P01", "terminating connection due to administrator command")],
    ["CrashShutdown", serverError("57P02", "terminating connection because of crash")],
    ["CannotConnectNow", serverError("57P03", "the database system is starting up")],
    ["ConnectionFailure", serverError("08006", "connection failure")],
    ["refused", connectionError("connect ECONNREFUSED 127.0.0.1:5432", "ECONNREFUSED")],
    ["reset", connectionError("read ECONNRESET", "ECONNRESET")],
    ["unknown host", connectionError("getaddrinfo ENOTFOUND database", "ENOTFOUND")],
    ["ended", connectionError("Connection terminated unexpectedly")],
    ["closed", new Error("Client has encountered a connection error and is not queryable")],
    ["closed by the client", new Error("Client was closed and is not queryable")],
    ["wrapped by Drizzle", drizzleError(serverError("57P01", "terminating connection"))],
  ])("errors of a restarting database mean a lost connection: %s", (_name, error) => {
    expect(connectionLost(error)).toBe(true);
  });

  it.each([
    ["statement timeout", serverError("57014", "canceling statement due to statement timeout")],
    ["deadlock", serverError("40P01", "deadlock detected")],
    ["too many clients", serverError("53300", "sorry, too many clients already")],
    ["unique violation", drizzleError(serverError("23505", "duplicate key value"))],
    ["undefined table", serverError("42P01", 'relation "x" does not exist')],
    ["misuse", new Error("Client has already been connected. You cannot reuse a client.")],
    // The scanner or the email provider refused: not the database.
    [
      "another service refused",
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3310"), { code: "ECONNREFUSED" }),
    ],
    ["not a database error", new Error("not a database error")],
  ])("real errors are not a lost connection: %s", (_name, error) => {
    expect(connectionLost(error)).toBe(false);
  });
});

describe("an outage", () => {
  function logs() {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    return { warn, error, info };
  }

  it("backs off and only warns while it is short", () => {
    const { warn, error, info } = logs();
    let now = 0;
    const outage = new Outage(() => now);
    const waits: number[] = [];
    for (let index = 0; index < 7; index += 1) {
      waits.push(outage.lost(lost()));
      now += waits.at(-1)!;
    }
    expect(waits).toEqual([1, 2, 4, 8, 16, 30, 30]);
    expect(now).toBeLessThan(REPORT_AFTER_SECONDS);
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith({ seconds: 0, error: "57P01", retry_in: 1 }, "database_unavailable");
    outage.ended();
    expect(info).toHaveBeenCalledWith({ seconds: 91 }, "database_available");
    expect(outage.lost(lost())).toBe(1);
  });

  it("is reported once when it lasts several minutes", () => {
    const { error } = logs();
    let now = 0;
    const outage = new Outage(() => now);
    while (now < 2 * REPORT_AFTER_SECONDS) now += outage.lost(lost());
    expect(error.mock.calls).toEqual([[{ seconds: 301, error: "57P01" }, "database_unreachable"]]);
    outage.ended();
    error.mockClear();
    while (now < 4 * REPORT_AFTER_SECONDS) now += outage.lost(lost());
    expect(error).toHaveBeenCalledTimes(1);
  });
});
