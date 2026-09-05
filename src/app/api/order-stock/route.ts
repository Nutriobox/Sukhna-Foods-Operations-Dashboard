import { NextResponse } from "next/server";

/**
 * Stock for just ONE order's products — so the app doesn't download the whole
 * 8k-batch warehouse on a slow floor network. Looks up the order's items (by SO
 * number in pending_sales_orders, or OMR in pending_outlet_requisitions), then
 * returns only the inventory rows whose product name matches those items.
 *
 * GET /api/order-stock?so=FSOD-26-27/606   (B2B)
 * GET /api/order-stock?omr=OMR-AF/26-27/1063  (NutrioBox)
 *   -> { ok, syncedAt, products, batches, data:[ {code,name,batch,warehouse,unit,qty,rate,exp,mfg} ] }
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS" };
export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

const norm = (s: unknown) => String(s == null ? "" : s).toLowerCase().replace(/\s+/g, " ").trim();

export async function GET(req: Request) {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured." }, { status: 500, headers: CORS });
  const sp = new URL(req.url).searchParams;
  const so = sp.get("so");
  const omr = sp.get("omr");
  const h = { apikey: key as string, Authorization: `Bearer ${key}` };
  try {
    // 1) the order's item names
    let items: Array<{ name?: string; code?: string }> = [];
    if (so) {
      const r = await fetch(`${url}/rest/v1/pending_sales_orders?so_number=eq.${encodeURIComponent(so)}&select=items`, { headers: h, cache: "no-store" });
      const rows = (await r.json()) as Array<{ items?: unknown }>;
      if (Array.isArray(rows[0]?.items)) items = rows[0].items as Array<{ name?: string; code?: string }>;
    } else if (omr) {
      const r = await fetch(`${url}/rest/v1/pending_outlet_requisitions?omr_number=eq.${encodeURIComponent(omr)}&select=items`, { headers: h, cache: "no-store" });
      const rows = (await r.json()) as Array<{ items?: unknown }>;
      if (Array.isArray(rows[0]?.items)) items = rows[0].items as Array<{ name?: string; code?: string }>;
    } else {
      return NextResponse.json({ ok: false, error: "pass ?so= or ?omr=" }, { status: 400, headers: CORS });
    }
    const wantNames = items.map((it) => norm(it.name)).filter((s) => s.length > 0);
    const wantCodes = new Set(items.map((it) => norm(it.code)).filter((s) => s.length > 0));

    // 2) latest inventory snapshot
    const q = `${url}/rest/v1/inventory_snapshots?select=synced_at,data&status=eq.ok&order=synced_at.desc&limit=1`;
    const ir = await fetch(q, { headers: h, cache: "no-store" });
    const isnap = (await ir.json()) as Array<{ synced_at: string; data: Array<Record<string, unknown>> }>;
    const snap = Array.isArray(isnap) && isnap[0] ? isnap[0] : null;
    const all: Array<Record<string, unknown>> = snap && Array.isArray(snap.data) ? snap.data : [];

    // 3) keep only rows for this order's products (name match like the app does, or exact code)
    const data = all.filter((row) => {
      const nm = norm(row.name);
      if (wantCodes.size && wantCodes.has(norm(row.code))) return true;
      for (const w of wantNames) {
        if (nm === w) return true;
        if (w.length >= 5 && (nm.includes(w) || w.includes(nm))) return true;
      }
      return false;
    });

    return NextResponse.json(
      { ok: true, syncedAt: snap?.synced_at ?? null, products: items.length, batches: data.length, data },
      { headers: CORS }
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: CORS });
  }
}
