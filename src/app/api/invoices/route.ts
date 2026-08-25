import { NextResponse } from "next/server";

/**
 * Past sales invoices already uploaded to PACT. Read from Supabase
 * `sales_invoices` (empty until the PACT invoice sync is wired). Server-side.
 *
 *  GET /api/invoices -> { ok, invoices: [{id, vendor, invoiceNumber, invoiceDate, amount}] }
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS" };

export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

export async function GET() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured." }, { status: 500, headers: CORS });
  try {
    const r = await fetch(`${url}/rest/v1/sales_invoices?select=*&order=created_at.desc`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store",
    });
    const rows = (await r.json()) as Array<Record<string, unknown>>;
    const invoices = (Array.isArray(rows) ? rows : []).map((o) => ({
      id: o.id, vendor: o.vendor_name, invoiceNumber: o.invoice_number, invoiceDate: o.invoice_date, amount: o.amount,
    }));
    return NextResponse.json({ ok: true, invoices }, { headers: CORS });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500, headers: CORS });
  }
}
