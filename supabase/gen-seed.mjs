// Generates supabase/seed.sql from src/lib/bills.json.
// Run with:  npm run gen:seed
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bills = JSON.parse(readFileSync(join(here, "../src/lib/bills.json"), "utf8"));

const esc = (s) => String(s).replace(/'/g, "''");
const jsonLit = (o) => `'${JSON.stringify(o).replace(/'/g, "''")}'::jsonb`;
const val = (v) => (v === null || v === undefined ? "null" : typeof v === "number" ? v : `'${esc(v)}'`);

const rows = bills.map((b) => {
  const items = b.items.map((i) => ({ ...i, uploaded: false }));
  return `(${b.id}, ${val(b.vendor)}, ${val(b.vendorGst)}, ${val(b.invoice)}, ${val(b.date)}, ${val(b.dateFull)}, ${val(b.buyer)}, ${val(b.buyerGst)}, ${val(b.taxable)}, ${val(b.gstTotal)}, ${val(b.roundOff)}, ${val(b.grandTotal)}, ${jsonLit(b.otherCharges || [])}, ${val(b.note ?? null)}, ${val(b.scanUrl ?? null)}, ${jsonLit(items)}, false)`;
});

const sql = `-- Seed data — generated from src/lib/bills.json by npm run gen:seed
-- Run AFTER schema.sql, in Supabase → SQL Editor.

insert into public.bills
  (id, vendor, vendor_gst, invoice, bill_date, date_full, buyer, buyer_gst,
   taxable, gst_total, round_off, grand_total, other_charges, note, scan_url, items, voided)
values
${rows.join(",\n")}
on conflict (id) do update set
  vendor=excluded.vendor, vendor_gst=excluded.vendor_gst, invoice=excluded.invoice,
  bill_date=excluded.bill_date, date_full=excluded.date_full, buyer=excluded.buyer,
  buyer_gst=excluded.buyer_gst, taxable=excluded.taxable, gst_total=excluded.gst_total,
  round_off=excluded.round_off, grand_total=excluded.grand_total,
  other_charges=excluded.other_charges, note=excluded.note, scan_url=excluded.scan_url,
  items=excluded.items;
`;

writeFileSync(join(here, "seed.sql"), sql);
console.log("Wrote supabase/seed.sql with", bills.length, "bills");
