-- Tracks each "Upload to Pact" push so the dashboard can show its status.
create table if not exists public.pact_jobs (
  id uuid primary key,
  bill_id bigint,
  invoice text,
  vendor text,
  status text not null default 'queued',   -- queued | processing | done | failed
  grn text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.pact_jobs enable row level security;

-- Dashboard (anon) can read job status.
drop policy if exists "public read pact_jobs" on public.pact_jobs;
create policy "public read pact_jobs" on public.pact_jobs for select using (true);

-- Writes are done server-side with the service key (bypasses RLS).
