-- NutrioBox past-dispatch invoices snapshot (View past sales invoice (NB)).
-- One row (id=1) holding the latest grouped snapshot, written by the worker
-- (sync-outlet-requisitions.js) and read by /api/nb-invoices.
create table if not exists public.outlet_dispatch_snapshot (
  id          integer primary key,
  synced_at   timestamptz,
  date_from   text,
  date_to     text,
  columns     jsonb,
  rows        jsonb,
  row_count   integer
);
