-- Dispatch queue: one row per scanned order submitted from the Sukhna app.
-- Written by /api/dispatch-inbox; drained by the PACT-desktop worker
-- (dispatch_watcher.py), which posts ONE Stock Outward voucher per order and
-- writes the voucher back. Read by /api/dispatch-status for the app popup.
create table if not exists public.dispatch_jobs (
  id          uuid primary key,
  order_no    text,                         -- OMR-AF/26-27/2454
  outlet      text,                         -- Nutriobox (Karkardooma)
  issue_type  text default 'Frozen',
  barcodes    jsonb,                         -- ["FG0042_FN0042/01092601_28000", ...]
  txt         text,                          -- full dispatch TXT, written verbatim by the worker
  status      text default 'queued',         -- queued | processing | posted | failed
  voucher     text,                          -- SOT-AF/26-27/xxxx once posted
  note        text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- Fast lookups for the worker (oldest queued) and the app (latest per order).
create index if not exists dispatch_jobs_status_idx  on public.dispatch_jobs (status, created_at);
create index if not exists dispatch_jobs_order_idx    on public.dispatch_jobs (order_no, updated_at desc);
