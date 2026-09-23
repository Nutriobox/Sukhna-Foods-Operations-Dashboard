-- Snapshot of the PACT "Detail Factory Sales Invoices" report (single latest row).
create table if not exists public.detail_fsi_snapshot (
  id         int primary key,
  synced_at  timestamptz,
  date_from  date,
  date_to    date,
  columns    jsonb,     -- ["SO No","Doc No","Doc Date", ...]
  rows       jsonb,     -- [["...","...",...], ...]
  row_count  int,
  constraint detail_fsi_single_row check (id = 1)
);
-- seed the single row so upsert(onConflict:id) always has a target
insert into public.detail_fsi_snapshot (id, row_count) values (1, 0)
  on conflict (id) do nothing;
