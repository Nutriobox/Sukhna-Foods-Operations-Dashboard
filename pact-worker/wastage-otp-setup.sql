-- 2026-11-03 (Satvik): email-OTP gate for wastage approval.
-- One active OTP per snapshot; a new "send" overwrites the previous one.
-- Codes are stored hashed (sha256 hex), never in plain text.
create table if not exists public.wastage_approval_otps (
  snapshot_id uuid primary key,
  code_hash   text not null,
  expires_at  timestamptz not null,
  attempts    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Service-role key (used by the API routes) bypasses RLS; no anon access.
alter table public.wastage_approval_otps enable row level security;
