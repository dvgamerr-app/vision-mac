import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type Kysely, sql } from "kysely";

// Installs vendored pgque (schema `pgque`) from db/pgque.sql. Skipped when it is already there (databases set up by hand before migrations).
const PGQUE_SQL = fileURLToPath(new URL("../../db/pgque.sql", import.meta.url));

export async function up(db: Kysely<any>) {
  const { rows } = await sql<{ installed: boolean }>`select to_regclass('pgque.queue') is not null as installed`.execute(db);
  if (rows[0]?.installed) return;
  // the install creates the cluster-wide roles pgque_reader/writer/admin: say so up front instead of failing halfway
  const { rows: who } = await sql<{ can: boolean; roles: number }>`
    select rolsuper or rolcreaterole as can,
           (select count(*) from pg_roles where rolname in ('pgque_reader', 'pgque_writer', 'pgque_admin'))::int as roles
      from pg_roles where rolname = current_user`.execute(db);
  if (!who[0]?.can && (who[0]?.roles ?? 0) < 3) {
    throw new Error("installing pgque needs CREATEROLE (it creates roles pgque_reader, pgque_writer, pgque_admin): "
      + "grant CREATEROLE to this user once, or create those three roles as a superuser first");
  }
  await sql.raw(await readFile(PGQUE_SQL, "utf8")).execute(db);
}

export async function down(db: Kysely<any>) {
  await sql`drop schema if exists pgque cascade`.execute(db);
}
