-- Pending sales orders (per vendor) + past sales invoices for the Android app.
-- These tables are read by /api/sales-orders and /api/invoices. For now they hold
-- a couple of sample orders so the flow works today; the PACT sync will populate
-- them for real once its recording is captured. Run once in the Supabase SQL editor.

create table if not exists public.pending_sales_orders (
  id          bigint generated always as identity primary key,
  vendor_name text not null,
  so_number   text not null,
  so_date     text,
  status      text not null default 'pending',           -- pending | scanning | done
  items       jsonb not null default '[]'::jsonb,         -- [{code,name,qty,unit,rate}]
  created_at  timestamptz not null default now()
);
create unique index if not exists pending_so_number_uidx on public.pending_sales_orders (so_number);
alter table public.pending_sales_orders enable row level security;

create table if not exists public.sales_invoices (
  id             bigint generated always as identity primary key,
  vendor_name    text,
  invoice_number text,
  invoice_date   text,
  amount         text,
  items          jsonb default '[]'::jsonb,
  created_at     timestamptz not null default now()
);
alter table public.sales_invoices enable row level security;

-- Tag scanned order lines with the sales order they belong to (nullable, so the
-- website's overall Sales Order view keeps working unchanged).
alter table public.sales_order_lines add column if not exists so_number text;
alter table public.sales_order_lines add column if not exists vendor text;

-- Re-scan now merges within a sales order (so two orders can hold the same batch).
drop index if exists public.sales_order_lines_code_batch_uidx;
create unique index if not exists sales_order_lines_so_code_batch_uidx
  on public.sales_order_lines (coalesce(so_number, ''), product_code, coalesce(batch_number, ''));

-- Sample pending orders (real product codes so scanning matches). Safe to delete;
-- the PACT sync will replace them later.
insert into public.pending_sales_orders (vendor_name, so_number, so_date, items) values
 ('Just Order Enterprises', 'SO-26-27/0001', '24/Aug/2026',
   '[{"code":"RM0274","name":"Protein Chocolate Powder","qty":20,"unit":"Kg"},{"code":"RM0265","name":"Plain Protein Powder","qty":15,"unit":"Kg"}]'::jsonb),
 ('NutrioBox Retail', 'SO-26-27/0002', '24/Aug/2026',
   '[{"code":"RM0275","name":"Protein Vanilla Powder","qty":10,"unit":"Kg"}]'::jsonb)
on conflict (so_number) do nothing;
