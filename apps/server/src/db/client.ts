import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { config } from "../config";
import { logger } from "../logger";

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;
/** A transaction handle; services accept `DbOrTx` so callers can compose them in one transaction. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

// count(*) and other bigint results as numbers; values stay far below 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

let pool: pg.Pool | undefined;
let database: Db | undefined;

/** `?connect_timeout=` (seconds) of a database URL, in milliseconds. */
function urlConnectTimeoutMs(url: string): number | undefined {
  try {
    const seconds = Number(new URL(url).searchParams.get("connect_timeout") ?? "");
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The database URL with the meaning PostgreSQL gives `sslmode`, as in the
 * Django version: `require` and `prefer` encrypt without checking the
 * certificate (unless sslrootcert names a CA), `verify-ca` checks it against
 * sslrootcert but not the name. node-postgres alone checks all three like
 * `verify-full`, so a server with a certificate of its own, or reached by
 * another name, would refuse a URL that worked before. Unlike PostgreSQL,
 * `prefer` never falls back to an unencrypted connection, and `verify-ca`
 * without sslrootcert stays `verify-full` (docs/configuration.md).
 */
export function withLibpqSslModes(url: string): string {
  // The query alone, from the first "?": URLs such as postgresql://reimbursement@/reimbursement?host=…
  // have no host that URL accepts, and values may hold a "?".
  const start = url.indexOf("?");
  if (start < 0) return url;
  const params = new URLSearchParams(url.slice(start + 1).split("#")[0]);
  // The last one counts, as in libpq and node-postgres.
  const mode = params.getAll("sslmode").at(-1) ?? "";
  const libpq = ["require", "prefer"].includes(mode) || (mode === "verify-ca" && params.has("sslrootcert"));
  if (!libpq || params.has("uselibpqcompat")) return url;
  return `${url}&uselibpqcompat=true`;
}

/** How every connection connects: waiting fails instead of hanging, and dead connections are noticed. */
export function connectionOptions(): pg.ClientConfig {
  return {
    connectionString: withLibpqSslModes(config().DATABASE_URL),
    // Also the longest wait for a free connection of the pool. A
    // connect_timeout in DATABASE_URL wins, as it did in the Django version
    // (node-postgres itself reads it only for its native driver).
    connectionTimeoutMillis: urlConnectTimeoutMs(config().DATABASE_URL) ?? 10_000,
    // Probes idle connections, so ones the network or a failover cut are dropped.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  };
}

export function getPool(): pg.Pool {
  if (!pool) {
    const { DATABASE_POOL_SIZE, DATABASE_STATEMENT_TIMEOUT_SECONDS } = config();
    pool = new pg.Pool({
      ...connectionOptions(),
      max: DATABASE_POOL_SIZE,
      // No statement, and no transaction left open, holds a connection forever.
      statement_timeout: DATABASE_STATEMENT_TIMEOUT_SECONDS * 1000,
      idle_in_transaction_session_timeout: 60_000,
    });
    // An idle client can lose its connection (database restart); the pool replaces it.
    pool.on("error", (error) => logger.warn({ err: error }, "idle database client error"));
    pool.on("connect", (client) => {
      client.on("error", (error) => logger.warn({ err: error }, "database client error"));
    });
  }
  return pool;
}

export function getDb(): Db {
  database ??= drizzle(getPool(), { schema });
  return database;
}

export async function closeDb() {
  const current = pool;
  pool = undefined;
  database = undefined;
  await current?.end();
}

export { schema };
