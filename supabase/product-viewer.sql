-- Sukhna Product Viewer — shared 3D product catalog
-- Run this ONCE in Supabase → SQL Editor (New query → paste → Run).
-- Mirrors the permissive-RLS convention used by public.bills (see schema.sql).

-- 1) Table: one row per product. Images live in Storage; here we keep paths.
create table if not exists public.viewer_products (
  id          text primary key,
  name        text not null,
  dims        jsonb,                                -- { "width":..,"height":..,"depth":.. } or null
  faces       jsonb not null default '{}'::jsonb,   -- { "front":"<path>","back":"<path>",... }
  extra       jsonb not null default '[]'::jsonb,   -- [ "<path>", ... ]
  updated_at  timestamptz default now()
);

alter table public.viewer_products enable row level security;
drop policy if exists "vp read"   on public.viewer_products;
drop policy if exists "vp insert" on public.viewer_products;
drop policy if exists "vp update" on public.viewer_products;
drop policy if exists "vp delete" on public.viewer_products;
create policy "vp read"   on public.viewer_products for select using (true);
create policy "vp insert" on public.viewer_products for insert with check (true);
create policy "vp update" on public.viewer_products for update using (true) with check (true);
create policy "vp delete" on public.viewer_products for delete using (true);

-- 2) Public storage bucket for the images.
insert into storage.buckets (id, name, public) values ('product-viewer','product-viewer', true)
  on conflict (id) do nothing;

-- 3) Storage policies scoped to THIS bucket only (won't touch other buckets).
drop policy if exists "pv_read"   on storage.objects;
drop policy if exists "pv_insert" on storage.objects;
drop policy if exists "pv_update" on storage.objects;
drop policy if exists "pv_delete" on storage.objects;
create policy "pv_read"   on storage.objects for select using (bucket_id = 'product-viewer');
create policy "pv_insert" on storage.objects for insert with check (bucket_id = 'product-viewer');
create policy "pv_update" on storage.objects for update using (bucket_id = 'product-viewer');
create policy "pv_delete" on storage.objects for delete using (bucket_id = 'product-viewer');
