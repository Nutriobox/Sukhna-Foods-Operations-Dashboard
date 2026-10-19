-- Loose Denomination state — a single row holding the current L3/L2/L1 "L"
-- marks across all RM codes. Replaces the per-browser localStorage so marks
-- Satvik or anyone on the team makes on one device appear on every other
-- device opening the Outlet Consumption dashboard.
--
-- Shape of denom:
--   { "<rm_code>": { "L3": true, "L2": true, "L1": true }, ... }
-- A level is only present when it's loose; an empty object or missing key
-- means that RM has no loose levels. Submit on the UI zeroes the marks that
-- were moved to Opening Inventory.
--
-- Single-row table (id=1 always, enforced by CHECK) because this is global
-- state. The id column exists only so PostgREST can address the row.
create table if not exists public.loose_denomination_state (
  id         integer primary key default 1,
  denom      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text,
  constraint single_row check (id = 1)
);

-- Seed the row so the API's PATCH / upsert path always has a row to hit.
insert into public.loose_denomination_state (id, denom)
values (1, '{}'::jsonb)
on conflict (id) do nothing;

-- Read for the anon role so the browser can fetch the current state directly
-- via Supabase Realtime when we add a subscription (next phase). Writes stay
-- behind the service_role key, which only the /api route uses.
alter table public.loose_denomination_state enable row level security;
drop policy if exists loose_denom_read on public.loose_denomination_state;
create policy loose_denom_read on public.loose_denomination_state
  for select to anon, authenticated using (true);
