import { type Kysely, sql } from "kysely";

// Queue `vision` and its single consumer. Both calls are idempotent.
export async function up(db: Kysely<any>) {
  await sql`select pgque.create_queue('vision')`.execute(db);
  await sql`select pgque.subscribe('vision', 'vision-worker')`.execute(db);
}

export async function down(db: Kysely<any>) {
  await sql`select pgque.unsubscribe('vision', 'vision-worker')`.execute(db);
  await sql`select pgque.drop_queue('vision', true)`.execute(db);
}
