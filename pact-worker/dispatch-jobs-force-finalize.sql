-- Operator "finalize now" signal for the dispatch queue.
-- When an operator has manually verified in PACT that the current order posted,
-- the app sets force_finalize = true on that job. dispatch_watcher.py sees it,
-- stops waiting on the PACT agent for that order, marks the job posted, and
-- immediately claims the next queued order -- so the voucher-confirmation tail on
-- a big order no longer blocks everything behind it.
-- Run once in the Supabase SQL editor.
alter table public.dispatch_jobs
  add column if not exists force_finalize boolean not null default false;
