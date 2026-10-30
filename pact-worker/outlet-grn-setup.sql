-- Stock Outlet Outward (Transfer Location) report lines, pulled from PACT's
-- BI tab. Each row is one line item of one SOT dispatch document — the same
-- shape the on-screen report shows (Doc No, Doc Date, Transfer Location,
-- Product Name, Unit, Outlet Qty, Batch No, Outlet Issue Type, Narration).
--
-- One SOT doc contains many line items (one row per product + batch), so the
-- Purchase tab's list view aggregates these rows per doc_no via a view below.
--
-- outlet_name is the dashboard-friendly branch label stripped from
-- transfer_location ('Nutribox (Prashant Vihar)' -> 'Prashant Vihar'). The
-- scraper fills both so joins / downstream tools can go either way.
create table if not exists public.pact_stock_outlet_outward (
  id                 bigserial primary key,
  doc_no             text not null,
  doc_date           date not null,
  -- 2026-10-30 (Satvik's #1): PACT's SOT report now carries a "Created
  -- Time" column (e.g. "08:36:00"). Stored as text so an ambiguous or
  -- missing value doesn't poison the row; the scraper pulls it verbatim
  -- from the report, and the frontend formats with doc_date for display.
  doc_time           text,
  transfer_location  text not null,
  outlet_name        text,                 -- normalised branch label
  product_name       text not null,
  rm_code            text,                 -- resolved against PACT product master if available
  unit               text,
  outlet_qty         numeric,
  batch_no           text,
  outlet_issue_type  text,                 -- the storage category (Frozen / Chiller / …)
  narration          text,
  scraped_at         timestamptz not null default now(),
  unique (doc_no, product_name, batch_no, unit)
);

-- Idempotent migration: on an existing database the column is added
-- without rewriting the table.
alter table public.pact_stock_outlet_outward
  add column if not exists doc_time text;

-- Per-doc index for the detail drawer.
create index if not exists idx_pact_sotout_doc on public.pact_stock_outlet_outward (doc_no);
-- Date + outlet filter for the list view.
create index if not exists idx_pact_sotout_date_outlet on public.pact_stock_outlet_outward (doc_date desc, outlet_name);

-- Convenience view: one row per Doc No for the Purchase tab list, with the
-- category rolled up as the MOST COMMON Outlet Issue Type across that doc's
-- line items (SOT docs are usually single-category in practice, so this is
-- just picking the one). line_count is handy for the UI.
-- 2026-10-30: adding doc_time to the view in the middle of the column
-- list fails on the Postgres CREATE OR REPLACE VIEW rule
-- ("42P16: cannot change name of view column") because that path can
-- only APPEND columns. DROP the view first so the recreate is clean.
-- There is nothing downstream that stores view-derived state, so the
-- drop is safe. (The hotfix in the API falls back to a doc_time-less
-- SELECT, so a brief window where the view is being recreated keeps
-- rendering date-only rows instead of 500ing.)
drop view if exists public.pact_stock_outlet_outward_docs;
create view public.pact_stock_outlet_outward_docs as
  with per_doc_cat as (
    select
      doc_no,
      outlet_issue_type,
      row_number() over (
        partition by doc_no
        order by count(*) desc nulls last, outlet_issue_type
      ) as rk
    from public.pact_stock_outlet_outward
    group by doc_no, outlet_issue_type
  )
  select
    o.doc_no,
    max(o.doc_date)         as doc_date,
    -- 2026-10-30 (Satvik's #1): roll up Created Time with min() so the
    -- earliest line's time stands for the doc's time (the scraper fills
    -- doc_time per line, but every line of one SOT voucher shares one
    -- Created Time in PACT's report).
    min(o.doc_time)         as doc_time,
    max(o.outlet_name)      as outlet_name,
    max(o.transfer_location) as transfer_location,
    (select outlet_issue_type from per_doc_cat c where c.doc_no = o.doc_no and c.rk = 1) as category,
    count(*)                as line_count,
    sum(coalesce(o.outlet_qty, 0)) as total_qty,
    max(o.scraped_at)       as scraped_at
  from public.pact_stock_outlet_outward o
  group by o.doc_no;

-- Read via anon for a future Realtime subscription; writes go through
-- service_role (the Playwright scraper / API).
alter table public.pact_stock_outlet_outward enable row level security;
drop policy if exists pact_sotout_read on public.pact_stock_outlet_outward;
create policy pact_sotout_read on public.pact_stock_outlet_outward
  for select to anon, authenticated using (true);
