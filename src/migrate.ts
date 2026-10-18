import { Kysely, PostgresDialect } from "kysely";
import { Migrator, type Migration } from "kysely/migration";
import pg from "pg";
import * as m001 from "./migrations/001_pgque";
import * as m002 from "./migrations/002_queue";
import * as m003 from "./migrations/003_jobs";
import * as m004 from "./migrations/004_pgque_revoke";
import * as m005 from "./migrations/005_job_trace";

// Migrations are listed here (not read from disk) so they work the same under bun, on Windows and in a bundle. Add new ones at the end.
const migrations: Record<string, Migration> = {
  "001_pgque": m001,
  "002_queue": m002,
  "003_jobs": m003,
  "004_pgque_revoke": m004,
  "005_job_trace": m005,
};

function migrator(pool: pg.Pool) {
  const db = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });
  return new Migrator({ db, provider: { getMigrations: async () => migrations } });
}

/** Apply all pending migrations; throws on failure. Safe to call on every start (Kysely takes a lock). */
export async function migrate(pool: pg.Pool) {
  const { error, results } = await migrator(pool).migrateToLatest();
  for (const r of results ?? []) console.log(`migration ${r.migrationName}: ${r.status}`);
  if (error) throw error;
}

// CLI: `bun run migrate [up|down|status]`
if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required (see .env.example)");
  const pool = new pg.Pool({ connectionString: url });
  const m = migrator(pool);
  const cmd = process.argv[2] ?? "up";
  if (cmd === "status") for (const x of await m.getMigrations()) console.log(`${x.name}\t${x.executedAt?.toISOString() ?? "pending"}`);
  else if (cmd === "up") await migrate(pool);
  else if (cmd === "down") {
    const { error, results } = await m.migrateDown();
    for (const r of results ?? []) console.log(`migration ${r.migrationName}: ${r.status} (down)`);
    if (error) throw error;
  } else throw new Error(`unknown command: ${cmd} (up | down | status)`);
  await pool.end();
}
