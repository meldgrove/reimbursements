import path from "node:path";
import type pg from "pg";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { config } from "../config";
import { SERVER_ROOT } from "../paths";
import { connectClient } from "./client";
import { adoptDjangoDatabase, endDjangoSessions } from "./django";
import { logger } from "../logger";

export function migrationsFolder(): string {
  return config().MIGRATIONS_DIR ?? path.join(SERVER_ROOT, "drizzle");
}

/**
 * Applies the SQL migrations under an advisory lock, so parallel deploys
 * wait for each other. A database of the Django version is taken over first
 * (src/db/django.ts). Lock and migrations share a connection of their own,
 * outside the pool and without its statement timeout (migrations may take
 * long).
 */
export async function runMigrations() {
  const client = await connectClient();
  client.on("error", (error) => logger.warn({ err: error }, "database client error"));
  try {
    await client.query("select pg_advisory_lock(hashtext('reimbursements.migrations'))");
    await migrateWith(client, migrationsFolder());
  } finally {
    // Ending the session also releases the lock.
    await client.end().catch(() => undefined);
  }
}

/**
 * Takes over a database of the Django version, applies the migrations and
 * ends the Django version's sessions, all in one transaction: a failure at
 * any step leaves the database as it was, Django's version included. True
 * when the database was taken over now.
 */
export async function migrateWith(client: pg.Client, folder: string): Promise<boolean> {
  await client.query("begin");
  try {
    const adopted = await adoptDjangoDatabase(client, folder);
    logger.info({ folder }, "applying database migrations");
    await applyMigrations(client, folder);
    await endDjangoSessions(client);
    await client.query("commit");
    logger.info("database migrations applied");
    return adopted;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

/**
 * Drizzle's migrator (drizzle-orm/pg-core/dialect.js, `migrate`), run inside
 * the caller's transaction: Drizzle's own opens and commits one of its own,
 * which would commit the takeover before the migrations ran. Same journal
 * table, same rule: every migration newer than the last one recorded.
 */
async function applyMigrations(client: pg.Client, folder: string): Promise<void> {
  const migrations = readMigrationFiles({ migrationsFolder: folder });
  await client.query('create schema if not exists "drizzle"');
  await client.query(`
    create table if not exists "drizzle"."__drizzle_migrations" (
      id serial primary key, hash text not null, created_at bigint
    )
  `);
  const { rows } = await client.query<{ created_at: string }>(
    'select created_at from "drizzle"."__drizzle_migrations" order by created_at desc limit 1',
  );
  const last = rows[0] ? Number(rows[0].created_at) : undefined;
  for (const migration of migrations) {
    if (last !== undefined && last >= migration.folderMillis) continue;
    for (const statement of migration.sql) {
      if (statement.trim()) await client.query(statement);
    }
    await client.query(
      'insert into "drizzle"."__drizzle_migrations" ("hash", "created_at") values ($1, $2)',
      [migration.hash, migration.folderMillis],
    );
  }
}
