-- Inventory Orders — a saved selection of PACT product codes to count, each
-- with an allocated order number (IO-YYYYMMDD-HHMM). Created from the scanner's
-- Select Item / Group -> Continue -> Allocate order no. flow; listed as tiles on
-- Active Inventory Orders. Run once in the Supabase SQL editor.
create table if not exists public.inventory_orders (
  id          uuid primary key default gen_random_uuid(),
  order_no    text not null,
  codes       jsonb not null default '[]'::jsonb,   -- ["FG0298","RM0388", ...]
  item_count  int  not null default 0,
  status      text not null default 'open',          -- open | counting | done
  created_at  timestamptz not null default now()
);
create index if not exists inventory_orders_created_idx on public.inventory_orders (created_at desc);
