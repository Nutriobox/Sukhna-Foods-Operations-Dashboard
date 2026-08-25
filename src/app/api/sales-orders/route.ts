import { NextResponse } from "next/server";

/**
 * Pending sales orders (per vendor) for the Android app's "Fetch sales order"
 * screen. Read from Supabase `pending_sales_orders`; the PACT sync fills this
 * table later. Server-side (service key) — no keys in the app.
 *
 *  GET /api/sales-orders        -> { ok, orders: [{id, vendor, soNumber, soDate, status, itemCount}] }
 *  GET /api/sales-orders?id=NN  -> { ok, order: {..., items:[{code,name,qty,unit,rate}]} }
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS" };

function creds() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return { url, key };
}
function headers() {
  const { key } = creds();
  return { apikey: key as string, Authorization: `Bearer ${key}` };
}

export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

export async function GET(req: Request) {
  const { url, key } = creds();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured." }, { status: 500, headers: CORS });
  const id = new URL(req.url).searchParams.get("id");
  const base = `${url}/rest/v1/pending_sales_orders`;
  try {
    if (id) {
      const r = await fetch(`${base}?id=eq.${encodeURIComponent(id)}&select=*`, { headers: headers(), cache: "no-store" });
      const rows = (await r.json()) as Array<Record<string, unknown>>;
      const o = rows[0];
      if (!o) return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: CORS });
      return NextResponse.json({
        ok: true,
        order: {
          id: o.id, vendor: o.vendor_name, soNumber: o.so_number, soDate: o.so_date,
          status: o.status, items: Array.isArray(o.items) ? o.items : [],
        },
      }, { headers: CORS });
    }
    const r = await fetch(`${base}?select=id,vendor_name,so_number,so_date,status,items&order=created_at.desc`, { headers: headers(), cache: "no-store" });
    const rows = (await r.json()) as Array<Record<string, unknown>>;
    const orders = (Array.isArray(rows) ? rows : []).map((o) => ({
      id: o.id, vendor: o.vendor_name, soNumber: o.so_number, soDate: o.so_date, status: o.status,
      itemCount: Array.isArray(o.items) ? o.items.length : 0,
    }));
    return NextResponse.json({ ok: true, orders }, { headers: CORS });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500, headers: CORS });
  }
}
