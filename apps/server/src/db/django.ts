import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type pg from "pg";
import { logger } from "../logger";

/**
 * Takes over the database of the Django version (Reimbursements 0.3 and 0.4)
 * in place.
 *
 * The tables, columns, constraints and indexes keep their names; the first
 * migration (0000_django_baseline) creates exactly them in a new database.
 * For a Django database, this brings it to the state of that migration and
 * records the migration as applied, so the migrations after it run as on a
 * new database:
 *
 * - adds `portal_appsettings.number_format` (Django migration 0018) when an
 *   installation of 0.3 never got it, and records 0018 and 0019 (which
 *   changed only help texts) for Django, so 0.4 runs on the database too;
 * - gives the foreign keys the rules on delete Django applied itself
 *   (cascade, set null, and protect as restrict), checked at once instead of
 *   at the end of the transaction;
 * - checks that every column of the baseline is there with its type.
 *
 * Django's own tables (sessions, permissions, content types, the admin log,
 * its migration list) stay, so going back to the version before still works.
 * Everything runs in one transaction: a failure changes nothing.
 *
 * 0.1 and 0.2 databases (before Django migration 0017) are refused: they
 * first install 0.4, which migrates them.
 */
export async function adoptDjangoDatabase(client: pg.Client, migrationsFolder: string): Promise<boolean> {
  const { rows } = await client.query<{ portal: boolean; django: boolean; journal: boolean }>(`
    select to_regclass('public.portal_form') is not null as portal,
           to_regclass('public.django_migrations') is not null as django,
           to_regclass('drizzle.__drizzle_migrations') is not null as journal
  `);
  const state = rows[0]!;
  if (state.journal) {
    const applied = await client.query("select 1 from drizzle.__drizzle_migrations limit 1");
    if (applied.rowCount) return false;
  }
  if (!state.portal) return false;
  if (!state.django) {
    throw new Error(
      "The database has the app's tables but neither Django's nor this version's migration records. " +
        "Restore a backup or use an empty database.",
    );
  }
  const django = await client.query<{ name: string }>(
    "select name from django_migrations where app = 'portal' order by name",
  );
  const djangoMigrations = new Set(django.rows.map((row) => row.name));
  if (!djangoMigrations.has("0017_appearance")) {
    throw new Error(
      "The database is from Reimbursements 0.2 or older. Install 0.4 first (REIMBURSEMENTS_VERSION=0.4), " +
        "let it migrate the database, then install this version.",
    );
  }

  const journal = readJournal(migrationsFolder);
  const baseline = journal.entries[0];
  if (!baseline || baseline.tag !== "0000_django_baseline") {
    throw new Error("The first migration must be 0000_django_baseline.");
  }
  const baselineSql = fs.readFileSync(path.join(migrationsFolder, `${baseline.tag}.sql`), "utf8");
  const statements = baselineSql.split("--> statement-breakpoint").map((statement) => statement.trim());
  const foreignKeys = statements.filter((statement) => /^ALTER TABLE .* FOREIGN KEY/s.test(statement));

  logger.info("taking over the database of the Django version");
  await client.query("begin");
  try {
    // Django migration 0018 (0.3 installations); 0019 changed only help texts.
    await client.query(
      "alter table portal_appsettings add column if not exists number_format varchar(8) not null default 'european'",
    );
    await client.query("alter table portal_appsettings alter column number_format drop default");
    for (const name of ["0018_number_format", "0019_accent_follows_meldgrove"]) {
      if (!djangoMigrations.has(name)) {
        await client.query(
          "insert into django_migrations (app, name, applied) values ('portal', $1, now())",
          [name],
        );
      }
    }

    // Foreign keys with the rules on delete Django applied in Python, under Django's names.
    for (const statement of foreignKeys) {
      const match = /^ALTER TABLE "([a-z_]+)" ADD CONSTRAINT "([a-z0-9_]+)"/.exec(statement);
      if (!match) throw new Error(`Unexpected statement in the baseline: ${statement.slice(0, 80)}`);
      await client.query(`alter table "${match[1]}" drop constraint if exists "${match[2]}"`);
      await client.query(statement.replace(/;$/, ""));
    }

    await checkColumns(client, statements);

    await client.query('create schema if not exists "drizzle"');
    await client.query(`
      create table if not exists "drizzle"."__drizzle_migrations" (
        id serial primary key, hash text not null, created_at bigint
      )
    `);
    await client.query('insert into "drizzle"."__drizzle_migrations" (hash, created_at) values ($1, $2)', [
      createHash("sha256").update(baselineSql).digest("hex"),
      baseline.when,
    ]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
  logger.info("took over the database of the Django version");
  return true;
}

/**
 * Ends the sessions of the Django version. This version never reads them:
 * after a rollback to 0.4, a browser that signed out here would still be
 * signed in there, and an admin who lost a role meanwhile would keep it
 * until the session ends. Runs at every migration, so sessions of a
 * rollback before end at the next upgrade. Drafts that participants opened
 * on 0.4 end with them. The table stays for the version before.
 */
export async function endDjangoSessions(client: pg.Client): Promise<void> {
  const { rows } = await client.query<{ present: boolean }>(
    "select to_regclass('public.django_session') is not null as present",
  );
  if (!rows[0]!.present) return;
  const { rowCount } = await client.query("delete from django_session");
  if (rowCount) logger.info({ count: rowCount }, "ended the sessions of the Django version");
}

const TYPES: [RegExp, string][] = [
  [/^bigint\b/, "bigint"],
  [/^integer\b/, "integer"],
  [/^smallint\b/, "smallint"],
  [/^varchar\(/, "character varying"],
  [/^text\b/, "text"],
  [/^jsonb\b/, "jsonb"],
  [/^boolean\b/, "boolean"],
  [/^date\b/, "date"],
  [/^uuid\b/, "uuid"],
  [/^numeric\(/, "numeric"],
  [/^"bytea"/, "bytea"],
  [/^timestamp with time zone\b/, "timestamp with time zone"],
];

/**
 * Refuses a database whose tables lack a column of the baseline, or have one
 * of another type (a partial restore, a hand-made schema): recording the
 * baseline would hide the problem until a page fails.
 */
async function checkColumns(client: pg.Client, statements: string[]): Promise<void> {
  const { rows } = await client.query<{ table_name: string; column_name: string; data_type: string }>(`
    select table_name, column_name, data_type from information_schema.columns
    where table_schema = 'public' and (table_name like 'portal\\_%' or table_name like 'auth\\_%')
  `);
  const found = new Map(rows.map((row) => [`${row.table_name}.${row.column_name}`, row.data_type]));
  const problems: string[] = [];
  for (const statement of statements) {
    const table = /^CREATE TABLE "([a-z_]+)" \(/.exec(statement)?.[1];
    if (!table) continue;
    for (const line of statement.split("\n").slice(1)) {
      const column = /^\s*"([a-z_]+)" (.+?)(?: PRIMARY KEY| NOT NULL|,|$)/.exec(line);
      if (!column) continue;
      const expected = TYPES.find(([pattern]) => pattern.test(column[2]!))?.[1];
      const actual = found.get(`${table}.${column[1]}`);
      if (actual === undefined) problems.push(`${table}.${column[1]} is missing`);
      else if (expected && actual !== expected)
        problems.push(`${table}.${column[1]} is ${actual}, not ${expected}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `The database does not have the tables of Reimbursements 0.4 (${problems.slice(0, 5).join("; ")}). ` +
        "Restore a complete backup, or migrate it with Reimbursements 0.4 first.",
    );
  }
}

type Journal = { entries: { idx: number; when: number; tag: string }[] };

function readJournal(migrationsFolder: string): Journal {
  return JSON.parse(fs.readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8")) as Journal;
}
