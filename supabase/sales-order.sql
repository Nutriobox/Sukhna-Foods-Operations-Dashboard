-- Shared live sales order. Both the website and the Android app read/write these
-- rows through the server (/api/order), so a scan on the app appears on the
-- website and vice-versa. All rows together are "the current order".
--
-- Run once in the Supabase SQL editor.

create table if not exists public.sales_order_lines (
  id               bigint generated always as identity primary key,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  product_code     text not null,
  product_name     text,
  hsn              text,
  warehouse        text,
  sales_unit_level text,
  unit             text,
  quantity         numeric not null default 1,
  unit_price       text,
  sales_rate       text,
  gst_tax_type     text,
  batch_number     text,
  mfg_date         text,
  expiry_date      text,
  source           text            -- 'app' | 'web'
);

create index if not exists sales_order_lines_created_idx
  on public.sales_order_lines (created_at);

-- One row per product+batch in the current order (so re-scans merge by qty).
create unique index if not exists sales_order_lines_code_batch_uidx
  on public.sales_order_lines (product_code, coalesce(batch_number, ''));

alter table public.sales_order_lines enable row level security;
-- Reads and writes happen server-side with the service-role key (via /api/order),
-- which bypasses RLS, so no anon policy is granted here on purpose.
