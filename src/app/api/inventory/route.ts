import { NextResponse } from "next/server";

/**
 * Public read of the latest synced PACT inventory snapshot, used by the native
 * Android Sales Order app. Reads server-side with the Supabase key so no key is
 * ever shipped inside the app.
 *
 * GET -> { ok, syncedAt, products, batches, data: [{ code,name,batch,warehouse,unit,qty,rate,exp,mfg }] }
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS" };

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    return NextResponse.json({ ok: false, error: "Supabase not configured on the server." }, { status: 500, headers: CORS });
  }
  try {
    const q = `${url.replace(/\/$/, "")}/rest/v1/inventory_snapshots` +
      `?select=synced_at,products,batches,data&status=eq.ok&order=synced_at.desc&limit=1`;
    const r = await fetch(q, { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `Supabase ${r.status} ${t}`.slice(0, 200) }, { status: 502, headers: CORS });
    }
    const rows = (await r.json()) as Array<{ synced_at: string; products: number; batches: number; data: unknown }>;
    const snap = Array.isArray(rows) && rows[0] ? rows[0] : null;
    if (!snap) {
      return NextResponse.json({ ok: true, syncedAt: null, products: 0, batches: 0, data: [] }, { headers: CORS });
    }
    return NextResponse.json(
      { ok: true, syncedAt: snap.synced_at, products: snap.products, batches: snap.batches, data: snap.data ?? [] },
      { headers: CORS }
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: CORS });
  }
}
