-- Live PACT inventory (BatchWise Stock Analysis), synced by the scheduled
-- GitHub Actions job (scripts/sync-inventory.js). Each sync writes ONE new
-- snapshot row whose `data` holds every batch as JSON, so a read is atomic and
-- the dashboard never sees a half-written inventory.
--
-- Run this once in the Supabase SQL editor.

create table if not exists public.inventory_snapshots (
  id         bigint generated always as identity primary key,
  synced_at  timestamptz not null default now(),
  products   integer     not null default 0,
  batches    integer     not null default 0,
  source     text,                       -- e.g. 'pact-batchwise' or 'manual-import'
  status     text        not null default 'ok',   -- 'ok' | 'failed'
  error      text,
  -- data = [{ code, name, batch, warehouse, unit, qty, rate, exp, mfg }, ...]
  data       jsonb       not null default '[]'::jsonb
);

create index if not exists inventory_snapshots_synced_at_idx
  on public.inventory_snapshots (synced_at desc);

alter table public.inventory_snapshots enable row level security;

-- Dashboard (anon key) may READ snapshots only.
drop policy if exists inv_anon_read on public.inventory_snapshots;
create policy inv_anon_read on public.inventory_snapshots
  for select using (true);

-- Writes are performed by the sync job with the SERVICE ROLE key, which
-- bypasses RLS — so no insert/update policy is granted to anon on purpose.

-- Optional housekeeping: keep only the most recent 200 snapshots.
-- (Run occasionally, or wire into the sync job.)
-- delete from public.inventory_snapshots
--  where id < (select min(id) from (
--    select id from public.inventory_snapshots order by id desc limit 200
--  ) keep);
