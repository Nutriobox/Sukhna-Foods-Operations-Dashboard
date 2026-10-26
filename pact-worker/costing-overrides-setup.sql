-- Costing dashboard overrides — until 2026-10-26, every editable field on
-- opsdashboard.sukhnafoods.com/costing (Approve / Mark Inactive buttons on
-- BOM rows, Wt/Unit and Sec Pack ₹ cells on the Summary tab, Final Price
-- edits on the Rate Dashboard, etc.) wrote only to the browser's
-- localStorage. Each laptop saw its own values and nothing synced between
-- devices. This table lets the dashboard round-trip those overrides
-- through the server so every laptop reads the same state.
--
-- One row per localStorage namespace key (e.g. 'bom_approved',
-- 'bom_wt_ovr', 'bom_spk_ovr', 'final_price', 'bom_active'). The row's
-- `data` jsonb holds the exact same shape the dashboard already keeps in
-- the matching JS global (APPR, WT_OVR, SPK_OVR, FINAL, ACTIVE…), which
-- is always a flat { "<bom_or_rm_code>": <value> } map — so the client
-- can swap the localStorage source for a server source with no data-shape
-- changes elsewhere.
--
-- updated_at lets a future "pull on focus" subscription detect which
-- namespaces have moved since the dashboard was last open; updated_by
-- stamps who edited last so a disagreement between two operators can
-- be traced (shared password gating for now; email-OTP later, same as
-- the Variance tab).

create table if not exists public.costing_overrides (
  key          text primary key,
  data         jsonb not null default '{}'::jsonb,
  updated_at   timestamptz not null default now(),
  updated_by   text
);

create index if not exists idx_costing_overrides_updated on public.costing_overrides (updated_at desc);

-- RLS: writes go through the service_role key the dashboard API uses
-- (same pattern as costing_snapshots / outlet_wastage_counts). SELECT
-- open to anon so the dashboard can read without an auth token — the
-- data is operational configuration (approval flags, override numbers),
-- not customer PII.
alter table public.costing_overrides enable row level security;
drop policy if exists costing_overrides_read on public.costing_overrides;
create policy costing_overrides_read on public.costing_overrides
  for select to anon, authenticated using (true);
