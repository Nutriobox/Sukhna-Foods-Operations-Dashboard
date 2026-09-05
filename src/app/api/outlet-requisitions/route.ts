import { NextResponse } from "next/server";

/**
 * Pending NutrioBox outlet material requisitions for the app's
 * "Fetch sales order (NB)" screen. Read from Supabase
 * `pending_outlet_requisitions` (filled by the AWS worker
 * scripts/sync-outlet-requisitions.js). Mapped to the same shape as the B2B
 * sales-orders API so the app reuses its order model: vendor = outlet,
 * soNumber = OMR number.
 *
 *  GET /api/outlet-requisitions        -> { ok, orders: [{id, vendor, soNumber, soDate, status, itemCount}] }
 *  GET /api/outlet-requisitions?id=NN  -> { ok, order: {..., items:[{name,qty,unit,ordered,delivered}]} }
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS" };
function creds() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return { url, key };
}
function headers() { const { key } = creds(); return { apikey: key as string, Authorization: `Bearer ${key}` }; }
export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

export async function GET(req: Request) {
  const { url, key } = creds();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured." }, { status: 500, headers: CORS });
  const sp = new URL(req.url).searchParams;
  const id = sp.get("id");
  const so = sp.get("so");
  const base = `${url}/rest/v1/pending_outlet_requisitions`;
  try {
    if (so) {
      const r = await fetch(`${base}?omr_number=eq.${encodeURIComponent(so)}&select=*`, { headers: headers(), cache: "no-store" });
      const rows = (await r.json()) as Array<Record<string, unknown>>;
      const o = rows[0];
      if (!o) return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: CORS });
      return NextResponse.json({
        ok: true,
        order: { id: o.id, vendor: o.outlet, soNumber: o.omr_number, soDate: null, status: o.status, items: Array.isArray(o.items) ? o.items : [] },
      }, { headers: CORS });
    }
    if (id) {
      const r = await fetch(`${base}?id=eq.${encodeURIComponent(id)}&select=*`, { headers: headers(), cache: "no-store" });
      const rows = (await r.json()) as Array<Record<string, unknown>>;
      const o = rows[0];
      if (!o) return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: CORS });
      return NextResponse.json({
        ok: true,
        order: { id: o.id, vendor: o.outlet, soNumber: o.omr_number, soDate: null, status: o.status, items: Array.isArray(o.items) ? o.items : [] },
      }, { headers: CORS });
    }
    // Supabase caps a single response at 1000 rows; page through so none are hidden.
    const rows: Array<Record<string, unknown>> = [];
    for (let from = 0; from < 20000; from += 1000) {
      const rr = await fetch(`${base}?select=id,omr_number,outlet,status,items&order=id.desc`, {
        headers: { ...headers(), Range: `${from}-${from + 999}`, "Range-Unit": "items" }, cache: "no-store",
      });
      const page = (await rr.json()) as Array<Record<string, unknown>>;
      if (!Array.isArray(page) || page.length === 0) break;
      rows.push(...page);
      if (page.length < 1000) break;
    }
    const orders = (Array.isArray(rows) ? rows : []).map((o) => ({
      id: o.id, vendor: o.outlet, soNumber: o.omr_number, soDate: null, status: o.status,
      itemCount: Array.isArray(o.items) ? o.items.length : 0,
    }));
    return NextResponse.json({ ok: true, orders }, { headers: CORS });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500, headers: CORS });
  }
}
