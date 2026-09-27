-- Real-time Factory-Costing snapshot store.
-- Run ONCE in the Supabase SQL editor (Dashboard -> SQL Editor -> New query -> Run).
--
-- One row = the latest pull of one PACT report, stored as the SAME array-of-arrays
-- the dashboard's Excel parser consumes (header row first, then data rows) in `data`.
-- The costing dashboard reads the newest row per `report` and feeds it straight
-- into its existing detectType()/parseXX() pipeline.
--
--   report: 'pf' | 'pm' | 'bom' | 'si'
--   status: 'ok' | 'failed'

create table if not exists costing_snapshots (
  id          bigint generated always as identity primary key,
  report      text        not null,                    -- pf | pm | bom | si
  synced_at   timestamptz not null default now(),
  row_count   integer     not null default 0,
  source      text        not null default 'pact-reportdataset',
  status      text        not null default 'ok',       -- ok | failed
  error       text        not null default '',
  data        jsonb       not null default '[]'::jsonb -- [[headers...],[row...],...]
);

-- Fast "latest snapshot for this report" lookups.
create index if not exists idx_costing_snap_report_time
  on costing_snapshots (report, synced_at desc);

-- Optional: keep the table small by trimming old snapshots per report.
-- (Run manually if it grows; the app only reads the newest row per report.)
-- delete from costing_snapshots c using (
--   select report, max(synced_at) latest from costing_snapshots group by report
-- ) k where c.report = k.report and c.synced_at < k.latest;
