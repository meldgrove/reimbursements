import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateWith } from "./migrate";
import { databaseUrl, MIGRATIONS, recreateDatabase } from "../test/databases";
import { TEST_DATABASE_URL } from "../test/env";

const here = path.dirname(fileURLToPath(import.meta.url));
/**
 * A database of Reimbursements 0.4 (Django), with rows in every table:
 * users in both roles, a superuser and a deactivated one, settings with a
 * favicon, a second privacy notice, templates, forms with owners, delivered
 * and failed claims with expenses, uploads, deliveries, attempts, evidence,
 * confirmations, jobs, operations, drafts, admissions, reservations and a
 * Django session.
 */
const FIXTURE = fs.readFileSync(path.join(here, "fixtures/django-0.4.sql"), "utf8");

const DATABASE = new URL(TEST_DATABASE_URL).pathname.slice(1);
const DJANGO = databaseUrl(TEST_DATABASE_URL, `${DATABASE}_django`);
const FRESH = databaseUrl(TEST_DATABASE_URL, `${DATABASE}_fresh`);

async function withClient<T>(url: string, run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function loadFixture(transform: (sql: string) => string = (sql) => sql) {
  await recreateDatabase(DJANGO, { empty: true });
  // The dump empties search_path for its session: a client of its own.
  await withClient(DJANGO, (client) => client.query(transform(FIXTURE)));
}

/** Takes over and migrates as the migrate role does. */
async function upgrade(url: string) {
  return withClient(url, (client) => migrateWith(client, MIGRATIONS));
}

const APP_TABLES =
  "(table_name like 'portal\\_%' or table_name in ('auth_user', 'auth_group', 'auth_user_groups'))";

/** Columns, constraints, indexes and sequences of the app's tables, for comparing two databases. */
async function catalog(url: string) {
  return withClient(url, async (client) => {
    const columns = await client.query(`
      select table_name, column_name, data_type, character_maximum_length, numeric_precision,
             numeric_scale, is_nullable, column_default, is_identity, identity_generation
      from information_schema.columns
      where table_schema = 'public' and ${APP_TABLES}
      order by table_name, column_name
    `);
    const constraints = await client.query(`
      select conrelid::regclass::text as table_name, conname, pg_get_constraintdef(oid) as definition,
             condeferrable, condeferred
      from pg_constraint
      where connamespace = 'public'::regnamespace
        and (conrelid::regclass::text like 'portal\\_%'
             or conrelid::regclass::text in ('auth_user', 'auth_group', 'auth_user_groups'))
      order by 1, 2
    `);
    const indexes = await client.query(`
      select tablename, indexname, indexdef from pg_indexes
      where schemaname = 'public'
        and (tablename like 'portal\\_%' or tablename in ('auth_user', 'auth_group', 'auth_user_groups'))
      order by 1, 2
    `);
    const sequences = await client.query(`
      select sequence_name, data_type, start_value, minimum_value, maximum_value, increment
      from information_schema.sequences
      where sequence_schema = 'public'
        and (sequence_name like 'portal\\_%' or sequence_name like 'auth\\_user%' or sequence_name = 'auth_group_id_seq')
      order by 1
    `);
    return {
      columns: columns.rows,
      constraints: constraints.rows,
      indexes: indexes.rows,
      sequences: sequences.rows,
    };
  });
}

const COUNTED = [
  "auth_user",
  "auth_group",
  "auth_user_groups",
  "portal_appsettings",
  "portal_privacynotice",
  "portal_formtemplate",
  "portal_templatefield",
  "portal_form",
  "portal_form_owners",
  "portal_claim",
  "portal_expense",
  "portal_upload",
  "portal_draft",
  "portal_draftadmission",
  "portal_delivery",
  "portal_deliveryattempt",
  "portal_deliveryevent",
  "portal_confirmation",
  "portal_job",
  "portal_operation",
  "portal_workspacereservation",
  "portal_claimreferencecounter",
  "portal_capacitylock",
];

async function counts(url: string): Promise<Record<string, number>> {
  return withClient(url, async (client) => {
    const result: Record<string, number> = {};
    for (const table of COUNTED) {
      const { rows } = await client.query<{ count: string }>(`select count(*) from ${table}`);
      result[table] = Number(rows[0]!.count);
    }
    return result;
  });
}

describe("taking over the database of the Django version", () => {
  beforeAll(async () => {
    await recreateDatabase(FRESH);
  });

  afterAll(async () => {
    await withClient(databaseUrl(TEST_DATABASE_URL, "postgres"), async (client) => {
      await client.query(`drop database if exists ${DATABASE}_django with (force)`);
      await client.query(`drop database if exists ${DATABASE}_fresh with (force)`);
    });
  });

  it("ends with the schema of a new database, and keeps every row", async () => {
    await loadFixture();
    const before = await counts(DJANGO);
    expect(await upgrade(DJANGO)).toBe(true);
    expect(await catalog(DJANGO)).toEqual(await catalog(FRESH));
    expect(await counts(DJANGO)).toEqual(before);
    expect(before.portal_claim).toBe(2);
    expect(before.portal_job).toBeGreaterThan(0);
    // Values stay as Django wrote them.
    const claim = await withClient(DJANGO, (client) =>
      client.query(
        "select bookkeeping_reference, total::text, snapshot->>'language' as language from portal_claim order by bookkeeping_reference",
      ),
    );
    expect(claim.rows[0]).toEqual({ bookkeeping_reference: "R-2026-0001", total: "62.50", language: "en" });
    // A second migration changes nothing.
    expect(await upgrade(DJANGO)).toBe(false);
  });

  it("creates a new installation with the privacy notice and template of the Django version", async () => {
    const rows = await withClient(FRESH, async (client) => ({
      notices: (await client.query("select version, created_by from portal_privacynotice")).rows,
      templates: (
        await client.query(
          "select name, travel, mileage_enabled, mileage_rate::text from portal_formtemplate",
        )
      ).rows,
      fields: (
        await client.query(
          "select key, label, required, position from portal_templatefield order by position",
        )
      ).rows,
    }));
    expect(rows.notices).toEqual([{ version: 1, created_by: "initial" }]);
    expect(rows.templates).toEqual([
      { name: "Externe Erstattung", travel: "optional", mileage_enabled: true, mileage_rate: "0.30" },
    ]);
    expect(rows.fields).toEqual([
      { key: "kst", label: "Kostenstelle (KST)", required: true, position: 0 },
      { key: "ktr", label: "Kostenträger (KTR)", required: false, position: 1 },
      { key: "id", label: "ID", required: false, position: 2 },
    ]);
  });

  it("takes over a 0.3 database without the number format", async () => {
    await loadFixture((sql) =>
      sql
        .replace(/,\s*number_format character varying\(8\) NOT NULL/, "")
        .replace(
          /INSERT INTO public\.portal_appsettings \(([^)]*), number_format\) VALUES \((.*), '[a-z]+'\);/,
          "INSERT INTO public.portal_appsettings ($1) VALUES ($2);",
        )
        .replace(
          /INSERT INTO public\.django_migrations \(id, app, name, applied\) VALUES \(\d+, 'portal', '001[89]_[a-z_]+', [^)]*\);\n/g,
          "",
        ),
    );
    const before = await withClient(DJANGO, (client) =>
      client.query(
        "select count(*) from information_schema.columns where table_name = 'portal_appsettings' and column_name = 'number_format'",
      ),
    );
    expect(Number(before.rows[0].count)).toBe(0);
    expect(await upgrade(DJANGO)).toBe(true);
    expect(await catalog(DJANGO)).toEqual(await catalog(FRESH));
    const after = await withClient(DJANGO, async (client) => ({
      format: (await client.query("select number_format from portal_appsettings")).rows,
      migrations: (
        await client.query(
          "select name from django_migrations where app = 'portal' and name >= '0018' order by name",
        )
      ).rows,
    }));
    expect(after.format).toEqual([{ number_format: "european" }]);
    expect(after.migrations).toEqual([
      { name: "0018_number_format" },
      { name: "0019_accent_follows_meldgrove" },
    ]);
  });

  it("refuses a database of 0.2 or older, and changes nothing", async () => {
    await loadFixture((sql) =>
      sql.replace(
        /INSERT INTO public\.django_migrations \(id, app, name, applied\) VALUES \(\d+, 'portal', '001[789]_[a-z_]+', [^)]*\);\n/g,
        "",
      ),
    );
    await expect(upgrade(DJANGO)).rejects.toThrow(/Install 0\.4 first/);
    const journal = await withClient(DJANGO, (client) =>
      client.query("select to_regclass('drizzle.__drizzle_migrations') is not null as present"),
    );
    expect(journal.rows[0].present).toBe(false);
  });

  it("refuses tables without Django's migration records", async () => {
    await loadFixture();
    await withClient(DJANGO, (client) => client.query("drop table django_migrations"));
    await expect(upgrade(DJANGO)).rejects.toThrow(/neither Django's nor this version's migration records/);
  });

  it("ends Django's sessions at every migration, and keeps their table", async () => {
    await loadFixture();
    const sessions = () =>
      withClient(DJANGO, (client) => client.query("select count(*) from django_session")).then((result) =>
        Number(result.rows[0].count),
      );
    expect(await sessions()).toBe(1);
    await upgrade(DJANGO);
    expect(await sessions()).toBe(0);
    await withClient(DJANGO, (client) =>
      client.query(
        "insert into django_session (session_key, session_data, expire_date) values ('rollback-session', 'data', now() + interval '1 day')",
      ),
    );
    await upgrade(DJANGO);
    expect(await sessions()).toBe(0);
  });

  it("gives the foreign keys Django's rules on delete", async () => {
    await loadFixture();
    await upgrade(DJANGO);
    await withClient(DJANGO, async (client) => {
      const claim = (
        await client.query("select id from portal_claim where bookkeeping_reference = 'R-2026-0001'")
      ).rows[0].id;
      // The delivered claim's reservation-free content goes with it; drafts and operations stay.
      await client.query("delete from portal_claim where supersedes_id = $1", [claim]).catch(() => undefined);
      await client.query("update portal_claim set supersedes_id = null");
      await client.query("delete from portal_claim where id = $1", [claim]);
      const left = await client.query(
        `
        select (select count(*) from portal_expense where claim_id = $1) as expenses,
               (select count(*) from portal_delivery where claim_id = $1) as deliveries,
               (select count(*) from portal_draft where claim_id is null) as drafts,
               (select count(*) from portal_operation where claim_id is null) as operations
      `,
        [claim],
      );
      expect(left.rows[0]).toEqual({ expenses: 0, deliveries: 0, drafts: 2, operations: 2 });
      // A form with claims is protected, as in Django.
      await expect(client.query("delete from portal_form where slug = 'demo'")).rejects.toThrow(
        /foreign key/,
      );
    });
  });
});
