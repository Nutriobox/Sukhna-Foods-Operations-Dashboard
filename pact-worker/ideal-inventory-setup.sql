-- Ideal Inventory snapshots — one row per saved snapshot.
--
-- An Ideal Inventory snapshot is the full per-RM table the operator sees on
-- the Ideal Inventory tab at the moment they click 💾 Save:
--   Opening (L1), Purchase (L1), Consumption (L1), Variance (L1),
--   Ideal Closing (L1), and the Full / Loose split per RM.
-- Everything the view needs to re-render later is baked into items (jsonb),
-- so re-opening a snapshot does NOT require re-walking live sales / GRN
-- data — important because those live sources drift over time (new sales
-- come in, PACT syncs refresh).
--
-- order_number is a per-outlet monotonic counter: #1 is the outlet's first
-- saved snapshot, #2 the second, and so on. Lets the UI reference "Rajinder
-- Nagar #5" without pasting a UUID. Computed server-side at insert time
-- (API endpoint fetches max(order_number) WHERE outlet=… and adds 1).

create table if not exists public.ideal_inventory_snapshots (
  id             uuid primary key default gen_random_uuid(),
  outlet         text not null,
  order_number   integer,                              -- per-outlet sequence; may be null for legacy rows
  window_from    text not null,                        -- "YYYY-MM-DDTHH:MM" (IST wall clock, same shape as OI dt_iso)
  window_to      text not null,                        -- "YYYY-MM-DDTHH:MM" (IST wall clock)
  total_items    integer not null default 0,
  opening_count  jsonb,                                -- {id, filled_count, total_items} snapshot of the OI count that anchored the window
  items          jsonb not null default '[]'::jsonb,   -- array of per-RM rows (see note above)
  approved_at    timestamptz,                          -- set when Variance tab's Approve action fires. Null = pending.
  approved_by    text,                                 -- email or label of whoever approved it (OTP email once wired)
  created_by     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Backfill for repos that ran the earlier version of this migration.
alter table public.ideal_inventory_snapshots add column if not exists approved_at timestamptz;
alter table public.ideal_inventory_snapshots add column if not exists approved_by text;

create index if not exists idx_ii_snap_outlet_order on public.ideal_inventory_snapshots (outlet, order_number desc);
create index if not exists idx_ii_snap_created      on public.ideal_inventory_snapshots (created_at desc);

alter table public.ideal_inventory_snapshots enable row level security;
drop policy if exists ii_snap_read on public.ideal_inventory_snapshots;
create policy ii_snap_read on public.ideal_inventory_snapshots
  for select to anon, authenticated using (true);
