import { NextResponse } from "next/server";

/**
 * Latest snapshot of the PACT "Detail Factory Sales Invoices" report, written by
 * the AWS worker (scripts/sync-detail-fsi.js) into public.detail_fsi_snapshot.
 *
 * GET /api/detail-fsi -> { ok, syncedAt, dateFrom, dateTo, columns:[...], rows:[[...]], rowCount }
 * Server env: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_KEY
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
    const r = await fetch(`${url}/rest/v1/detail_fsi_snapshot?id=eq.1&select=*`, {
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
