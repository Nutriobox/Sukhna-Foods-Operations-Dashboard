-- Per-invoice line items for the "View past sales invoice" screens (B2B + NB).
-- The summary lists (detail_fsi_snapshot / outlet_dispatch_snapshot) hold one row
-- per invoice; this table holds each invoice's product lines, fetched on demand.
create table if not exists public.invoice_lines (
  kind       text not null,          -- 'b2b' or 'nb'
  doc_no     text not null,          -- invoice number (FSIV.. or SOT..)
  cols       jsonb,                  -- detail column headers
  lines      jsonb,                  -- array of line-rows (arrays)
  item_count integer,
  primary key (kind, doc_no)
);
