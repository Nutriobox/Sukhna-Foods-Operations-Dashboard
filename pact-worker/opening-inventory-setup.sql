-- Opening Inventory counts — one row per saved count at an outlet.
-- Replaces the per-browser localStorage so counts survive refreshes, are
-- visible across devices, and feed into the Ideal Inventory tab's Opening
-- column once that is wired to read from here.
--
-- One row per (outlet, dt_iso) — if an operator re-saves at the same
-- datetime for the same outlet, we upsert (last write wins). A fresh save
-- at a different datetime creates a new row, so historical counts stay.
--
-- qty       — jsonb map of rm_code -> packing-unit count
-- qty_loose — jsonb map of rm_code -> loose-unit count (the second Qty
--             column on the OI count sheet, meaningful for RMs with a
--             Loose Denomination mark)
-- filled_count / total_items are denormalised at write time so the list
-- query doesn't have to count jsonb keys per row for the Score column.
create table if not exists public.opening_inventory_counts (
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

-- Latest-first list on the OI form view; outlet filter when the Ideal
-- Inventory tab needs the latest count for a chosen outlet.
create index if not exists idx_oi_counts_outlet_dt on public.opening_inventory_counts (outlet, dt_iso desc);
create index if not exists idx_oi_counts_updated  on public.opening_inventory_counts (updated_at desc);

-- Lock it down: writes go through the service_role key the API uses.
-- Read for anon/authenticated so a future Supabase Realtime subscription
-- can push list updates to the browser without exposing writes.
alter table public.opening_inventory_counts enable row level security;
drop policy if exists oi_counts_read on public.opening_inventory_counts;
create policy oi_counts_read on public.opening_inventory_counts
  for select to anon, authenticated using (true);
