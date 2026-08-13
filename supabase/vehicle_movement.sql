-- Vehicle Movement summary table (one row per trip, per daily run)
create table if not exists public.vehicle_movement (
  id            bigserial primary key,
  run_date      date not null,
  sr_no         int,
  vehicle       text,
  driver        text,
  attendant     text,
  start_dest    text,
  finish_dest   text,
  dispatch_time text,
  loc_30 text,  time_30 text,
  loc_60 text,  time_60 text,
  loc_90 text,  time_90 text,
  loc_120 text, time_120 text,
  outlet_reached text,
  total_travel   text,
  time_at_outlet text,
  remarks        text,
  created_at timestamptz default now()
);
alter table public.vehicle_movement enable row level security;
drop policy if exists "vm public read" on public.vehicle_movement;
create policy "vm public read" on public.vehicle_movement for select using (true);
