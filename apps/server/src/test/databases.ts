import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS = path.join(here, "../../drizzle");

/** Drops and creates the database of `url`, then applies the migrations (unless `empty`). */
export async function recreateDatabase(url: string, options: { empty?: boolean } = {}) {
  const parsed = new URL(url);
  const database = parsed.pathname.slice(1);
  if (!/^[a-z0-9_]+$/.test(database)) throw new Error(`Unsafe test database name: ${database}`);
  const admin = new pg.Client({
    connectionString: Object.assign(new URL(parsed), { pathname: "/postgres" }).toString(),
  });
  await admin.connect();
  await admin.query(`drop database if exists ${database} with (force)`);
  await admin.query(`create database ${database}`);
  await admin.end();
  if (options.empty) return;
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });
  await pool.end();
}

/** A URL of another database on the same server. */
export function databaseUrl(base: string, name: string): string {
  return Object.assign(new URL(base), { pathname: `/${name}` }).toString();
}
