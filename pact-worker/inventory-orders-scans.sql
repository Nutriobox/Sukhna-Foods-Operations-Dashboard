-- Adds scan storage to inventory_orders (run once, after inventory-orders-setup.sql).
alter table public.inventory_orders add column if not exists scans jsonb not null default '[]'::jsonb;
alter table public.inventory_orders add column if not exists scanned_at timestamptz;
