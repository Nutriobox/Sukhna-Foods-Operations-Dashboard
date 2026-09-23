-- Pending NutrioBox outlet material requisitions (PEND QTY > 0), grouped by OMR.
create table if not exists public.pending_outlet_requisitions (
  id          bigserial primary key,
  omr_number  text,
  outlet      text,
  status      text default 'pending',
  items       jsonb,           -- [{name, qty(=PEND), unit, ordered(=ReqQty), delivered(=OutletQty)}]
  created_at  timestamptz default now()
);
