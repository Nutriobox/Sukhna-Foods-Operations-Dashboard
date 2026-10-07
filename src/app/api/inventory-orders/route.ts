import { NextResponse } from "next/server";

/**
 * Inventory Orders for the scanner's Inventory Order flow.
 * Stored in Supabase `inventory_orders`. Server-side (service key) — no keys in the app.
 *
 *  GET  /api/inventory-orders         -> { ok, orders: [{id, orderNo, itemCount, status, createdAt}] }
 *  GET  /api/inventory-orders?id=UUID -> { ok, order: {id, orderNo, itemCount, status, createdAt, codes:[...]} }
 *  POST /api/inventory-orders  {orderNo, codes:[...]} -> { ok, id }
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "content-type" };

function creds() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return { url, key };
}
function headers() {
  const { key } = creds();
  return { apikey: key as string, Authorization: `Bearer ${key}`, "content-type": "application/json" };
}

export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

export async function GET(req: Request) {
  const { url, key } = creds();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured." }, { status: 500, headers: CORS });
  const id = new URL(req.url).searchParams.get("id");
  const base = `${url}/rest/v1/inventory_orders`;
  try {
    if (id) {
      const r = await fetch(`${base}?id=eq.${encodeURIComponent(id)}&select=*`, { headers: headers(), cache: "no-store" });
      const rows = (await r.json()) as Array<Record<string, unknown>>;
      const o = rows[0];
      if (!o) return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: CORS });
      return NextResponse.json({
        ok: true,
        order: { id: o.id, orderNo: o.order_no, itemCount: o.item_count, status: o.status, createdAt: o.created_at, codes: Array.isArray(o.codes) ? o.codes : [] },
      }, { headers: CORS });
    }
    const r = await fetch(`${base}?select=id,order_no,item_count,status,created_at&order=created_at.desc`, { headers: headers(), cache: "no-store" });
    const rows = (await r.json()) as Array<Record<string, unknown>>;
    const orders = (Array.isArray(rows) ? rows : []).map((o) => ({
      id: o.id, orderNo: o.order_no, itemCount: o.item_count, status: o.status, createdAt: o.created_at,
    }));
    return NextResponse.json({ ok: true, orders }, { headers: CORS });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500, headers: CORS });
  }
}

export async function POST(req: Request) {
  const { url, key } = creds();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured." }, { status: 500, headers: CORS });
  try {
    const body = (await req.json().catch(() => ({}))) as { orderNo?: string; codes?: unknown };
    const orderNo = String(body.orderNo || "").trim();
    const codes = Array.isArray(body.codes) ? body.codes.map((c) => String(c)).filter(Boolean) : [];
    if (!orderNo) return NextResponse.json({ ok: false, error: "orderNo required" }, { status: 400, headers: CORS });
    const r = await fetch(`${url}/rest/v1/inventory_orders`, {
      method: "POST",
      headers: { ...headers(), Prefer: "return=representation" },
      body: JSON.stringify({ order_no: orderNo, codes, item_count: codes.length, status: "open" }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `Insert failed: ${r.status} ${t}`.slice(0, 300) }, { status: 502, headers: CORS });
    }
    const rows = (await r.json().catch(() => [])) as Array<Record<string, unknown>>;
    return NextResponse.json({ ok: true, id: rows[0]?.id ?? null, orderNo }, { headers: CORS });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500, headers: CORS });
  }
}
