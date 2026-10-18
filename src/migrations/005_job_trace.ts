import { type Kysely, sql } from "kysely";

// W3C traceparent of the request that queued the job, so the worker's task and AI spans join that request's trace in Traceway
export async function up(db: Kysely<any>) {
  await sql`alter table vision_jobs add column if not exists trace text`.execute(db);
}

export async function down(db: Kysely<any>) {
  await sql`alter table vision_jobs drop column if exists trace`.execute(db);
}
