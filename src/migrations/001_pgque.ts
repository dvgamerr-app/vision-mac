import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type Kysely, sql } from "kysely";

// Installs vendored pgque (schema `pgque`) from db/pgque.sql. Skipped when it is already there (databases set up by hand before migrations).
const PGQUE_SQL = fileURLToPath(new URL("../../db/pgque.sql", import.meta.url));

export async function up(db: Kysely<any>) {
  const { rows } = await sql<{ installed: boolean }>`select to_regclass('pgque.queue') is not null as installed`.execute(db);
  if (rows[0]?.installed) return;
  await sql.raw(await readFile(PGQUE_SQL, "utf8")).execute(db);
}

export async function down(db: Kysely<any>) {
  await sql`drop schema if exists pgque cascade`.execute(db);
}
