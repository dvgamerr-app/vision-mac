import { type Kysely, sql } from "kysely";

// pgque grants SELECT on its tables and sequences to PUBLIC (pgque.sql:3932, grant_perms), so any role that can log in could read
// event payloads, i.e. job ids, which are the keys to job files. Only the owner (this app) and the pgque_* roles need them.
// Covers the event tables `vision` already has; a queue created later re-copies grants from event_template, which no longer has PUBLIC.
export async function up(db: Kysely<any>) {
  await sql`revoke select on all tables in schema pgque from public`.execute(db);
  await sql`revoke select on all sequences in schema pgque from public`.execute(db);
}

export async function down(db: Kysely<any>) {
  await sql`grant select on pgque.consumer, pgque.queue, pgque.tick, pgque.subscription, pgque.event_template, pgque.retry_queue to public`.execute(db);
}
