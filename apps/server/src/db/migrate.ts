import path from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { config } from "../config";
import { SERVER_ROOT } from "../paths";
import { connectionOptions } from "./client";
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
  const client = new pg.Client(connectionOptions());
  client.on("error", (error) => logger.warn({ err: error }, "database client error"));
  await client.connect();
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
 * ends the Django version's sessions. True when the database was taken over
 * now.
 */
export async function migrateWith(client: pg.Client, folder: string): Promise<boolean> {
  const adopted = await adoptDjangoDatabase(client, folder);
  logger.info({ folder }, "applying database migrations");
  await migrate(drizzle(client), { migrationsFolder: folder });
  logger.info("database migrations applied");
  await endDjangoSessions(client);
  return adopted;
}
