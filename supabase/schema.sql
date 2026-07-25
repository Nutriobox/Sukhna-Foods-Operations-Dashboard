-- Nutriobox / Sukhna Foods — Operations Dashboard schema
-- Run this once in Supabase → SQL Editor (New query → paste → Run).

create table if not exists public.bills (
  id           bigint primary key,
  vendor       text not null,
  vendor_gst   text,
  invoice      text,
  bill_date    text,                    -- short label, e.g. "16 Jun"
  date_full    text,                    -- e.g. "16-Jun-2026"
  buyer        text default 'Allsure Services Pvt Ltd',
  buyer_gst    text default '09AANCA9064A1ZL',
  taxable      numeric,
  gst_total    numeric,
  round_off    numeric default 0,
  grand_total  numeric,
  other_charges jsonb default '[]'::jsonb,   -- [{ "label": "...", "amount": 0 }]
  note         text,
  scan_url     text,                    -- Supabase Storage URL of the scanned bill
  items        jsonb not null default '[]'::jsonb,  -- line items incl. per-item "uploaded" flag
  voided       boolean default false,
  created_at   timestamptz default now()
);

-- Row Level Security. For the prototype these policies are permissive so the
-- browser (anon key) can read and update. TIGHTEN before real production —
-- e.g. require an authenticated user / Supabase Auth.
alter table public.bills enable row level security;

drop policy if exists "bills read"   on public.bills;
drop policy if exists "bills insert" on public.bills;
drop policy if exists "bills update" on public.bills;

create policy "bills read"   on public.bills for select using (true);
create policy "bills insert" on public.bills for insert with check (true);
create policy "bills update" on public.bills for update using (true) with check (true);

-- Optional: a storage bucket for the scanned images.
-- insert into storage.buckets (id, name, public) values ('scans','scans', true)
--   on conflict (id) do nothing;
