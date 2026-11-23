import pg from "pg";
import { reportError } from "./error-reporting";
import { logger } from "./logger";

/**
 * A lost database connection, and the worker's wait until PostgreSQL is back
 * (portal/database.py of the Django version).
 *
 * PostgreSQL restarts during updates. Until it accepts connections again,
 * every query fails. The worker treats that as an outage: it logs a warning
 * and tries again with backoff. Only an outage that outlasts
 * REPORT_AFTER_SECONDS is an error. Every other database error is a real one
 * and stays an error.
 */

// The server ended or refused the session because it shuts down, crashed or
// still starts up. Class 08 is every connection exception.
const LOST_SQLSTATES = new Set(["57P01", "57P02", "57P03"]);
export const FIRST_WAIT_SECONDS = 1;
export const LONGEST_WAIT_SECONDS = 30;
// A restart during an update takes seconds; recovery after a crash can take a
// minute or two. Five minutes is longer than both and well before the
// worker's heartbeat check (420 seconds) marks the worker unhealthy, so the
// error names the cause first.
export const REPORT_AFTER_SECONDS = 5 * 60;

// What node-postgres raises for a query on a client whose connection is gone.
const DEAD_CLIENT = new Set([
  "Client has encountered a connection error and is not queryable",
  "Client was closed and is not queryable",
]);
// node-postgres's own fixed messages for a connection that ended or never came
// up: they quote nothing, so the log may show them.
const DRIVER_MESSAGES = new Set([
  ...DEAD_CLIENT,
  "Connection terminated unexpectedly",
  "Connection terminated due to connection timeout",
  "timeout expired",
  "timeout exceeded when trying to connect",
]);

/** Errors of a database connection itself: failed connects and broken sockets (db/client.ts). */
const connectionErrors = new WeakSet<object>();

/**
 * Marks an error of the database connection: a connect that failed, or a
 * socket that broke. A refused or reset connection looks the same for every
 * service, so only the database's own are marked; a scanner that refuses is
 * not an outage of the database.
 */
export function markConnectionError(error: unknown): void {
  if (error instanceof Error) connectionErrors.add(error);
}

/**
 * Whether a database error means the connection is gone, not that a query
 * failed: a connection the server refused, reset or closed, an unknown host
 * while the database's container is replaced (all without a SQLSTATE), class
 * 08, or 57P01-57P03. Timeouts, deadlocks, too many connections, constraint
 * violations and errors of other services stay real errors. Follows `cause`,
 * as Drizzle wraps the driver's error.
 */
export function connectionLost(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current instanceof pg.DatabaseError) {
      const code = current.code ?? "";
      return code.startsWith("08") || LOST_SQLSTATES.has(code);
    }
    if (connectionErrors.has(current) || DEAD_CLIENT.has(current.message)) return true;
    current = current.cause;
  }
  return false;
}

/**
 * A short name of the error for the log: its SQLSTATE or system code (57P01,
 * ECONNREFUSED), node-postgres's own message, else its type. Never another
 * message, which can quote a query's values (logger.ts).
 */
function errorName(error: unknown): string {
  let current: unknown = error;
  let name = "Error";
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
    if (DRIVER_MESSAGES.has(current.message)) return current.message;
    name = current.name;
    current = current.cause;
  }
  return name;
}

/** Backoff and reporting while the database is unreachable. */
export class Outage {
  private started: number | null = null;
  private wait = FIRST_WAIT_SECONDS;
  private reported = false;

  /** `clock` in seconds. */
  constructor(private readonly clock: () => number = () => performance.now() / 1000) {}

  /** Logs the lost connection. Returns the seconds to wait before retrying. */
  lost(error: unknown): number {
    const now = this.clock();
    this.started ??= now;
    const seconds = Math.floor(now - this.started);
    const name = errorName(error);
    if (seconds >= REPORT_AFTER_SECONDS && !this.reported) {
      this.reported = true;
      logger.error({ seconds, error: name }, "database_unreachable");
      reportError(new Error(`database_unreachable seconds=${seconds} error=${name}`));
    } else {
      logger.warn({ seconds, error: name, retry_in: this.wait }, "database_unavailable");
    }
    const wait = this.wait;
    this.wait = Math.min(this.wait * 2, LONGEST_WAIT_SECONDS);
    return wait;
  }

  /** The database answered again. */
  ended(): void {
    if (this.started === null) return;
    logger.info({ seconds: Math.floor(this.clock() - this.started) }, "database_available");
    this.started = null;
    this.wait = FIRST_WAIT_SECONDS;
    this.reported = false;
  }
}
