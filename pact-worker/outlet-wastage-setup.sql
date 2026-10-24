-- Outlet wastage counts — the second entry workflow the portal exposes
-- after login (added 2026-10-24 at Satvik's ask). Same shape as
-- opening_inventory_counts so the main dashboard can read it with the same
-- pattern. One row per (outlet, dt_iso); re-save at the same datetime
-- overwrites via the unique index + Prefer: resolution=merge-duplicates.
--
-- qty       — jsonb map of rm_code -> wasted packing-unit count
-- qty_loose — jsonb map of rm_code -> wasted loose-unit count
-- Denormalised filled_count / total_items so the dashboard list query
-- doesn't have to count jsonb keys per row.

create table if not exists public.outlet_wastage_counts (
  id            uuid primary key default gen_random_uuid(),
  outlet        text not null,
  dt_iso        text not null,
  qty           jsonb not null default '{}'::jsonb,
  qty_loose     jsonb not null default '{}'::jsonb,
  filled_count  integer not null default 0,
  total_items   integer not null default 0,
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (outlet, dt_iso)
);

create index if not exists idx_wastage_outlet_dt on public.outlet_wastage_counts (outlet, dt_iso desc);
create index if not exists idx_wastage_updated   on public.outlet_wastage_counts (updated_at desc);

-- RLS: writes go through the service_role key the portal API uses.
-- SELECT open to anon/authenticated so a future Supabase Realtime
-- subscription can push updates to the main dashboard without exposing
-- writes.
alter table public.outlet_wastage_counts enable row level security;
drop policy if exists wastage_read on public.outlet_wastage_counts;
create policy wastage_read on public.outlet_wastage_counts
  for select to anon, authenticated using (true);
