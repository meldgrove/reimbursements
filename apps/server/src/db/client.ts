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

/** The query parameters of a database URL, from the first "?" (hosts in the query are not URL hosts). */
function queryOf(url: string): URLSearchParams | null {
  const start = url.indexOf("?");
  return start < 0 ? null : new URLSearchParams(url.slice(start + 1).split("#")[0]);
}

/**
 * The database URL with the meaning PostgreSQL gives `sslmode`, as in the
 * Django version: `require` encrypts without checking the certificate
 * (unless sslrootcert names a CA), `verify-ca` checks it against sslrootcert
 * but not the name. node-postgres alone checks both like `verify-full`, so
 * a server with a certificate of its own, or reached by another name, would
 * refuse a URL that worked before. `prefer`, PostgreSQL's default, is
 * `preferTls` below; `verify-ca` without sslrootcert stays `verify-full`.
 */
export function withLibpqSslModes(url: string): string {
  const params = queryOf(url);
  if (!params) return url;
  // The last one counts, as in libpq and node-postgres.
  const mode = params.getAll("sslmode").at(-1) ?? "";
  const libpq = ["require", "prefer"].includes(mode) || (mode === "verify-ca" && params.has("sslrootcert"));
  if (!libpq || params.has("uselibpqcompat")) return url;
  return `${url}&uselibpqcompat=true`;
}

/**
 * Whether the URL leaves TLS to `prefer`, as libpq (and so the Django
 * version) does without an `sslmode`, or with `sslmode=prefer`: encrypt when
 * the server offers it, without checking its certificate, and connect
 * unencrypted when it does not. node-postgres knows no such mode; it either
 * never asks for TLS or fails without it. URLs with certificates of their
 * own (sslrootcert, sslcert, sslkey) or PGSSLMODE keep node-postgres's
 * handling.
 */
export function prefersTls(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const params = queryOf(url) ?? new URLSearchParams();
  if (["sslrootcert", "sslcert", "sslkey", "ssl", "uselibpqcompat"].some((name) => params.has(name)))
    return false;
  const mode = params.getAll("sslmode").at(-1);
  if (mode !== undefined) return mode === "prefer";
  return !env.PGSSLMODE;
}

/** The URL without its sslmode, which would win over the `ssl` option. */
function withoutSslMode(url: string): string {
  const start = url.indexOf("?");
  if (start < 0) return url;
  const [query, fragment] = url.slice(start + 1).split("#");
  const kept = (query ?? "").split("&").filter((part) => part && !/^sslmode=/i.test(part));
  return `${url.slice(0, start)}${kept.length ? `?${kept.join("&")}` : ""}${fragment !== undefined ? `#${fragment}` : ""}`;
}

/** The server answered the request for TLS with "no" (libpq then connects without it). */
export function tlsRefused(error: unknown): boolean {
  return error instanceof Error && error.message === "The server does not support SSL connections";
}

/** Set once a server of DATABASE_URL refused TLS: connections of this process then skip asking. */
let plaintextAfterRefusal = false;

/** Tests only: ask for TLS again. */
export function resetTlsFallbackForTests() {
  plaintextAfterRefusal = false;
}

/** How every connection connects: waiting fails instead of hanging, and dead connections are noticed. */
export function connectionOptions(url: string = config().DATABASE_URL): pg.ClientConfig {
  const prefer = prefersTls(url);
  return {
    connectionString: prefer ? withoutSslMode(url) : withLibpqSslModes(url),
    ...(prefer ? { ssl: plaintextAfterRefusal ? false : { rejectUnauthorized: false } } : {}),
    // Also the longest wait for a free connection of the pool. A
    // connect_timeout in DATABASE_URL wins, as it did in the Django version
    // (node-postgres itself reads it only for its native driver).
    connectionTimeoutMillis: urlConnectTimeoutMs(url) ?? 10_000,
    // Probes idle connections, so ones the network or a failover cut are dropped.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  };
}

/**
 * A connected client of its own (migrations), with libpq's `prefer`: when
 * the server refuses TLS, a second connection without it.
 */
export async function connectClient(url: string = config().DATABASE_URL): Promise<pg.Client> {
  const options = connectionOptions(url);
  const client = new pg.Client(options);
  try {
    await client.connect();
    return client;
  } catch (error) {
    if (!options.ssl || !tlsRefused(error)) throw error;
    plaintextAfterRefusal = true;
    const plain = new pg.Client({ ...options, ssl: false });
    await plain.connect();
    return plain;
  }
}

/**
 * Gives a pool libpq's `prefer` (see `prefersTls`): when the server refuses
 * TLS, the pool connects without it from then on. Every connection that
 * asked for TLS and was refused tries again without it, also those already
 * on their way when the first refusal switched the pool to plain.
 */
export function withTlsFallback(pool: pg.Pool): pg.Pool {
  const connect = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;
  const options = (pool as unknown as { options: pg.PoolConfig }).options;
  const attempt = async (): Promise<pg.PoolClient> => {
    const askedForTls = Boolean(options.ssl);
    try {
      return await connect();
    } catch (error) {
      if (!askedForTls || !tlsRefused(error)) throw error;
      plaintextAfterRefusal = true;
      options.ssl = false;
      return connect();
    }
  };
  type Callback = (error: Error | undefined, client: pg.PoolClient | undefined, done: () => void) => void;
  // pg-pool's own query() calls connect with a callback; everyone else awaits it.
  pool.connect = ((callback?: Callback) => {
    if (!callback) return attempt();
    attempt().then(
      (client) => callback(undefined, client, () => client.release()),
      (error: Error) => callback(error, undefined, () => undefined),
    );
    return undefined;
  }) as typeof pool.connect;
  return pool;
}

export function getPool(): pg.Pool {
  if (!pool) {
    const { DATABASE_POOL_SIZE, DATABASE_STATEMENT_TIMEOUT_SECONDS } = config();
    pool = withTlsFallback(
      new pg.Pool({
        ...connectionOptions(),
        max: DATABASE_POOL_SIZE,
        // No statement, and no transaction left open, holds a connection forever.
        statement_timeout: DATABASE_STATEMENT_TIMEOUT_SECONDS * 1000,
        idle_in_transaction_session_timeout: 60_000,
      }),
    );
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
