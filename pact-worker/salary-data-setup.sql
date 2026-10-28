-- Allsure Salary Structure — persistent storage for /salary.
--
-- The salary tool (public/salary/index.html) stores its entire app state as
-- one JSON blob through a window.allsureDesktop shim. On a desktop host
-- that shim writes to a file; in our web deployment the shim POSTs to
-- /api/salary-data and we persist the blob here.
--
-- One row per logical database (id='main' is the shared salary sheet; we
-- keep room for separate entities later by making id a text PK rather than
-- hardcoding a single row).  Every save is a full-blob replace, mirroring
-- the desktop semantic.  The backup table captures the pre-replace blob so
-- "Refresh data" + routine saves keep a durable version history even when
-- the primary row is overwritten.

create table if not exists public.salary_data (
  id          text primary key default 'main',
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

create table if not exists public.salary_data_backups (
  id          bigserial primary key,
  snapshot_id text not null,                       -- matches salary_data.id
  data        jsonb not null,
  size_bytes  integer,
  note        text,                                -- "refresh", "explicit", etc.
  created_at  timestamptz not null default now()
);

create index if not exists idx_salary_backups_sid_created
  on public.salary_data_backups (snapshot_id, created_at desc);

-- RLS: writes go through the service_role key the dashboard API uses.
-- SELECT open to anon/authenticated so the dashboard can read on page load
-- without needing a Supabase session (same pattern as costing_overrides).
alter table public.salary_data enable row level security;
drop policy if exists salary_data_read on public.salary_data;
create policy salary_data_read on public.salary_data
  for select to anon, authenticated using (true);

alter table public.salary_data_backups enable row level security;
drop policy if exists salary_backups_read on public.salary_data_backups;
create policy salary_backups_read on public.salary_data_backups
  for select to anon, authenticated using (true);
