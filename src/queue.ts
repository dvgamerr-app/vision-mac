import { connect } from "pgque";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { migrate } from "./migrate";
import { mkdir, rm, readFile, writeFile, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { call } from "./native";
import { synthesize, type TtsOpts } from "./tts";
import { aiSpan, runTask, shutdownTelemetry, type AiResult } from "./telemetry";

// Jobs: pgque carries the event (job id), `vision_jobs` holds input paths + result. See docs/queue.md.
const QUEUE = "vision";
const CONSUMER = "vision-worker";
const JOBS_DIR = process.env.JOBS_DIR ?? join(tmpdir(), "vision-mac-jobs");
export const STORAGE_DIR = resolve(process.env.STORAGE_DIR ?? fileURLToPath(new URL("../storage", import.meta.url)));
const FILE_TTL_HOURS = Number(process.env.FILE_TTL_HOURS ?? 6);
const RETENTION_HOURS = Number(process.env.RETENTION_HOURS ?? 24);
const STUCK_MINUTES = Number(process.env.STUCK_MINUTES ?? 10);

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required (see .env.example)");
const client = await connect(process.env.DATABASE_URL);
const db = client.rawPool;
// One instance per database: two consumers on queue `vision` (or two tickers) would double-process jobs. The lock lives on a
// dedicated connection for the whole life of the process, so it frees itself when the process dies or the connection drops.
const lockConn = await db.connect();
const { rows: [lock] } = await lockConn.query("select pg_try_advisory_lock(hashtext('vision-mac')) as ok");
if (!lock.ok) {
  console.error("another vision-mac instance is already running against this database (advisory lock held); exiting");
  process.exit(1);
}
lockConn.on("error", (e) => { console.error("lock connection lost:", e.message); process.exit(1); }); // let the supervisor restart us

if (process.env.AUTO_MIGRATE !== "false") await migrate(db); // pgque, queue and tables (src/migrations); `bun run migrate` does the same by hand
await mkdir(JOBS_DIR, { recursive: true });
await mkdir(STORAGE_DIR, { recursive: true });

// pgque.ticker() must never run in parallel: its snapshot is taken before any lock (pgque.sql:1284), so two overlapping
// ticks can put the same events in two batches. Every tick in this process goes through this one chain.
let ticking: Promise<unknown> = Promise.resolve();
const tick = (label: string, fn: () => Promise<unknown>) =>
  (ticking = ticking.then(fn).catch((e) => console.error(`${label}:`, (e as Error).message)));

/** `trace` is the queuing request's traceparent (see telemetry.ts), so the job's spans continue that trace */
export async function enqueue(op: string, files: Uint8Array[], opts: unknown = {}, trace: string | null = null) {
  const id = crypto.randomUUID();
  const dir = join(JOBS_DIR, id);
  await mkdir(dir, { recursive: true });
  try {
    const paths = await Promise.all(files.map(async (f, i) => { const p = join(dir, String(i)); await writeFile(p, f); return p; }));
    // row and event commit together: a failed send leaves no orphan 'queued' row behind
    const c = await db.connect();
    try {
      await c.query("begin");
      await c.query("insert into vision_jobs (id, op, opts, files, trace) values ($1, $2, $3, $4, $5)", [id, op, JSON.stringify(opts), paths, trace]);
      await c.query("select pgque.send($1, $2, $3::jsonb)", [QUEUE, "job", JSON.stringify({ id })]);
      await c.query("commit");
    } catch (e) {
      await c.query("rollback").catch(() => {});
      throw e;
    } finally { c.release(); }
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
  // low latency: cut a tick now instead of waiting for the 1s timer (send/tick/receive must be separate txns)
  tick("tick", () => client.forceNextTick(QUEUE).then(() => client.ticker(QUEUE)));
  return id;
}

const COLS = "id, op, status, result, error, attempts, created_at as \"createdAt\", started_at as \"startedAt\", finished_at as \"finishedAt\"";

const fileJson = (f: { name: string; mime: string; size: string; expiresAt: Date | null; deletedAt: Date | null }, jobId: string) => ({
  name: f.name, mime: f.mime, size: Number(f.size), url: `/jobs/${jobId}/files/${encodeURIComponent(f.name)}`,
  expiresAt: f.expiresAt, expired: f.deletedAt !== null || (f.expiresAt !== null && f.expiresAt.getTime() <= Date.now()),
});

export async function listFiles(jobId: string) {
  const { rows } = await db.query(
    "select name, mime, size, expires_at as \"expiresAt\", deleted_at as \"deletedAt\" from vision_files where job_id = $1 order by name", [jobId]);
  return rows.map((f) => fileJson(f, jobId));
}

export async function getJob(id: string, waitMs = 0) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const { rows } = await db.query(`select ${COLS} from vision_jobs where id = $1`, [id]);
    const job = rows[0];
    if (!job || job.status === "done" || job.status === "failed" || Date.now() >= deadline) {
      return job ? { ...job, files: await listFiles(id) } : null;
    }
    await Bun.sleep(200);
  }
}

/** Look up a downloadable file: null = no such file, "expired" = TTL passed or already swept. */
export async function findFile(jobId: string, name: string) {
  const { rows } = await db.query(
    "select path, mime, size, expires_at, deleted_at from vision_files where job_id = $1 and name = $2", [jobId, name]);
  const f = rows[0];
  if (!f) return null;
  if (f.deleted_at || (f.expires_at && f.expires_at.getTime() <= Date.now())) return "expired" as const;
  return { path: f.path as string, mime: f.mime as string, size: Number(f.size) };
}

/** Write an output file for a job (image, audio, video, ...) into storage. The TTL clock starts when the job finishes. */
export async function saveFile(jobId: string, name: string, mime: string, bytes: Uint8Array) {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "_");
  const dir = join(STORAGE_DIR, jobId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, safe);
  await writeFile(path, bytes);
  await db.query(
    "insert into vision_files (job_id, name, mime, size, path) values ($1, $2, $3, $4, $5) on conflict (job_id, name) do update set mime = $3, size = $4, path = $5, deleted_at = null",
    [jobId, safe, mime, bytes.length, path]);
  return { name: safe, url: `/jobs/${jobId}/files/${encodeURIComponent(safe)}` };
}

// Vision returns images as base64 PNG fields named *Png (maskPng, heatmapPng): move them out of the JSON into storage files.
async function externalizeFiles(jobId: string, result: Record<string, unknown>) {
  for (const [key, v] of Object.entries(result)) {
    if (key.endsWith("Png") && typeof v === "string") {
      const file = await saveFile(jobId, `${key.slice(0, -3)}.png`, "image/png", Buffer.from(v, "base64"));
      result[key] = file;
    }
  }
  return result;
}

async function sweepFiles() {
  const { rows } = await db.query("select id, job_id, path from vision_files where deleted_at is null and expires_at < now()");
  for (const f of rows) {
    await rm(f.path, { force: true });
    await rmdir(join(STORAGE_DIR, f.job_id)).catch(() => {}); // only succeeds once the dir is empty
    await db.query("update vision_files set deleted_at = now() where id = $1", [f.id]);
  }
  return rows.length;
}

export const MAX_LIST = 200;
export async function listJobs(status?: string, limit = 50) {
  const { rows } = await db.query(
    `select ${COLS} from vision_jobs where ($1::text is null or status = $1) order by created_at desc limit $2`, [status ?? null, limit]);
  return rows;
}

async function finish(id: string, status: "done" | "failed", result: unknown, error?: string) {
  // only a running job: one the stuck sweeper already failed stays failed (no failed → done flip seen by pollers)
  await db.query("update vision_jobs set status = $2, result = $3, error = $4, finished_at = now() where id = $1 and status = 'running'",
    [id, status, result === undefined ? null : JSON.stringify(result), error ?? null]);
  // output files get their TTL either way, otherwise the file sweeper would never remove them
  await db.query("update vision_files set expires_at = now() + make_interval(hours => $2) where job_id = $1 and deleted_at is null", [id, FILE_TTL_HOURS]);
  await rm(join(JOBS_DIR, id), { recursive: true, force: true });
}

const consumer = client.newConsumer(QUEUE, CONSUMER, { pollInterval: 500, retryAfter: 30 });
consumer.handle("job", async (msg) => {
  const { id } = JSON.parse(msg.payload) as { id: string };
  const { rows } = await db.query(
    "update vision_jobs set status = 'running', attempts = attempts + 1, started_at = now() where id = $1 and status in ('queued', 'running') returning op, opts, files, trace", [id]);
  if (!rows[0]) { // finished, expired or deleted: drop any inputs still on disk, ack and move on
    await rm(join(JOBS_DIR, id), { recursive: true, force: true });
    return;
  }
  const { op, opts, files, trace } = rows[0] as { op: string; opts: unknown; files: string[]; trace: string | null };
  // Traceway: a `job:<op>` Task span, and inside it the native call as a gen_ai.* AI span
  await runTask(`job:${op.replace(/^run:/, "")}`, trace, async (span) => {
    if (op === "tts") { // no input file: synthesize, store the audio as an output file
      try {
        let audio: Awaited<ReturnType<typeof synthesize>> | undefined;
        const res = await aiSpan(span, { op, jobId: id, opts, files: [] }, () => synthesize(join(JOBS_DIR, id), opts as TtsOpts)
          .then((a): AiResult => { audio = a; return { ok: true, result: a.info }; }, (e): AiResult => ({ ok: false, error: (e as Error).message })));
        if (!res.ok || !audio) return await finish(id, "failed", undefined, res.error);
        const file = await saveFile(id, audio.name, audio.mime, audio.bytes);
        await finish(id, "done", { ...audio.info, file });
      } catch (e) { await finish(id, "failed", undefined, (e as Error).message); }
      return;
    }
    const bytes = await Promise.all(files.map(async (f) => new Uint8Array(await readFile(f))));
    const res = await aiSpan(span, { op, jobId: id, opts, files: bytes }, () => call(op, bytes[0], opts, bytes[1]));
    // a Vision error (bad image, unsupported OS) is final; only infra errors above throw and get retried by pgque
    if (res.ok) await finish(id, "done", { ...(await externalizeFiles(id, res.result)), durationMs: res.durationMs });
    else await finish(id, "failed", undefined, res.error ?? "unknown error");
  }, { "job.id": id });
});

await sweepFiles().catch((e) => console.error("sweep:", e.message)); // expire anything that lapsed while the service was down

const ac = new AbortController();
consumer.start(ac.signal).catch((e) => console.error("consumer stopped:", e));

// no pg_cron in the postgres container → drive the ticker and maintenance from here
let timerTick = false; // at most one timer tick waiting in the chain, so a slow DB cannot pile them up
setInterval(() => {
  if (timerTick) return;
  timerTick = true;
  tick("ticker", () => client.tickerAll()).finally(() => { timerTick = false; });
}, 1000);
setInterval(async () => {
  try {
    await db.query("select pgque.maint()");
    // maint() leaves out retries and rotation step 2 (pgque.start() schedules those through pg_cron, which this setup has not).
    // Each runs as its own statement, so in its own transaction, as pgque requires.
    for (let i = 0; i < 100 && (await db.query("select pgque.maint_retry_events() as n")).rows[0].n > 0; i++);
    await db.query("select pgque.maint_rotate_tables_step2()");
    // stuck = running too long (by started_at, so a long backlog is not failed while it waits); a 'queued' row is only an
    // orphan once it is older than the retention window. Their inputs go too.
    const { rows: stuck } = await db.query(
      `update vision_jobs set status = 'failed', error = 'stuck: no result', finished_at = now()
        where (status = 'running' and started_at < now() - make_interval(mins => $1))
           or (status = 'queued' and created_at < now() - make_interval(hours => $2))
        returning id`, [STUCK_MINUTES, RETENTION_HOURS]);
    for (const { id } of stuck) await rm(join(JOBS_DIR, id), { recursive: true, force: true });
    await sweepFiles();
    // keep the job row until its files are gone, so a late download answers 410 rather than 404
    await db.query("delete from vision_jobs j where finished_at < now() - make_interval(hours => $1) and not exists (select 1 from vision_files f where f.job_id = j.id and f.deleted_at is null)", [RETENTION_HOURS]);
  } catch (e) { console.error("maint:", (e as Error).message); }
}, 30_000);

process.on("SIGTERM", () => { ac.abort(); shutdownTelemetry().finally(() => setTimeout(() => process.exit(0), 500)); });
