import raw from "./bills.json";
import type { Bill } from "./types";

// Seed bills (the 10 already processed). Used as the initial render and as a
// fallback whenever Supabase isn't configured.
export const seedBills: Bill[] = (raw as any[]).map((b) => ({
  ...b,
  otherCharges: b.otherCharges || [],
  voided: false,
  items: b.items.map((i: any) => ({ ...i, uploaded: false })),
})) as Bill[];

// Map a Supabase row (snake_case) to a Bill.
export function rowToBill(r: any): Bill {
  return {
    id: r.id,
    vendor: r.vendor,
    vendorGst: r.vendor_gst,
    invoice: r.invoice,
    date: r.bill_date,
    dateFull: r.date_full,
    buyer: r.buyer,
    buyerGst: r.buyer_gst,
    taxable: Number(r.taxable),
    gstTotal: Number(r.gst_total),
    roundOff: Number(r.round_off),
    grandTotal: Number(r.grand_total),
    otherCharges: r.other_charges || [],
    note: r.note || undefined,
    scanUrl: r.scan_url || undefined,
    voided: !!r.voided,
    items: (r.items || []) as Bill["items"],
  };
}

// Map a Bill to a Supabase row for upsert.
export function billToRow(b: Bill) {
  return {
    id: b.id,
    vendor: b.vendor,
    vendor_gst: b.vendorGst,
    invoice: b.invoice,
    bill_date: b.date,
    date_full: b.dateFull,
    buyer: b.buyer,
    buyer_gst: b.buyerGst,
    taxable: b.taxable,
    gst_total: b.gstTotal,
    round_off: b.roundOff,
    grand_total: b.grandTotal,
    other_charges: b.otherCharges,
    note: b.note ?? null,
    scan_url: b.scanUrl ?? null,
    voided: b.voided,
    items: b.items,
  };
}
