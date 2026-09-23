-- Real-time live-dispatch coordination tables.
-- Run ONCE in the Supabase SQL editor (Dashboard -> SQL Editor -> New query -> Run).

create table if not exists pact_live_sessions (
  omr         text primary key,
  outlet      text        not null default '',
  category    text        not null default 'Frozen',
  status      text        not null default 'open',   -- open | submit | posting | done | error | cancelled
  voucher_no  text        not null default '',
  error       text        not null default '',
  opened_at   timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists pact_live_scans (
  id          bigint generated always as identity primary key,
  omr         text        not null,
  barcode     text        not null,
  fed         boolean     not null default false,
  outcome     text        not null default '',       -- added | skipped | error
  created_at  timestamptz not null default now(),
  fed_at      timestamptz
);

create index if not exists idx_live_scans_omr_id on pact_live_scans (omr, id);
