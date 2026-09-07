import { NextResponse } from "next/server";

/**
 * Latest snapshot of NutrioBox past-dispatch invoices, grouped from the PACT
 * "Pending Outlet Requisition Quantity" report by Outlet No (SOT dispatch = the
 * invoice). Written by the worker (sync-outlet-requisitions.js) into
 * public.outlet_dispatch_snapshot (id=1). Same shape as /api/detail-fsi so the
 * app can render it with the same screen.
 *
 * GET /api/nb-invoices -> { ok, syncedAt, dateFrom, dateTo, columns:[...], rows:[[...]], rowCount }
 * Columns: Doc No (Outlet No), Account Name (Location Transfer / outlet),
 *          Outlet ReqNo (order), Product Name, Req Qty, Outlet Qty, Units.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS" };
export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

export async function GET() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured." }, { status: 500, headers: CORS });
  try {
    const r = await fetch(`${url}/rest/v1/outlet_dispatch_snapshot?id=eq.1&select=*`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store",
    });
    if (!r.ok) { const t = await r.text().catch(() => ""); return NextResponse.json({ ok: false, error: `Supabase ${r.status} ${t}`.slice(0, 200) }, { status: 502, headers: CORS }); }
    const rows = (await r.json()) as Array<Record<string, unknown>>;
    const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
    return NextResponse.json({
      ok: true,
      syncedAt: row?.synced_at ?? null,
      dateFrom: row?.date_from ?? null,
      dateTo: row?.date_to ?? null,
      columns: row?.columns ?? [],
      rows: row?.rows ?? [],
      rowCount: row?.row_count ?? 0,
    }, { headers: CORS });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500, headers: CORS });
  }
}
