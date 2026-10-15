-- vision-mac job store. Run in database `queue` after db/pgque.sql.
-- pgque carries only the event (job id); results live here.
create table if not exists vision_jobs (
  id          uuid primary key default gen_random_uuid(),
  op          text not null,
  status      text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  opts        jsonb not null default '{}',
  files       text[] not null default '{}',   -- uploaded inputs on disk (removed when the job finishes)
  result      jsonb,
  error       text,
  attempts    int not null default 0,
  created_at  timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz
);
create index if not exists vision_jobs_status_idx on vision_jobs (status, created_at);
create index if not exists vision_jobs_finished_idx on vision_jobs (finished_at) where finished_at is not null;

-- Output files of finished jobs (images, audio, video, ...). Bytes live on disk under $STORAGE_DIR/<job_id>/<name>;
-- expires_at = job finish + FILE_TTL_HOURS (default 6). The sweeper deletes the file and sets deleted_at; the row stays.
create table if not exists vision_files (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references vision_jobs (id) on delete cascade,
  name       text not null,
  mime       text not null,
  size       bigint not null,
  path       text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,                 -- null until the job finishes
  deleted_at timestamptz,
  unique (job_id, name)
);
create index if not exists vision_files_expiry_idx on vision_files (expires_at) where deleted_at is null;
