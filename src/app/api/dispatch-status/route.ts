import { NextResponse } from "next/server";

/**
 * The app polls this after Submit to learn the posted voucher, so it can show
 * the 3-second "Order X posted under Voucher Y" popup.
 *
 * GET /api/dispatch-status?order=OMR-AF/26-27/2454
 *   -> { ok, status: "queued|processing|posted|failed", voucher, note, updatedAt }
 *
 * Server env: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_KEY
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS" };
export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

export async function GET(req: Request) {
  const sbUrl = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  if (!sbUrl || !sbKey) {
    return NextResponse.json({ ok: false, error: "Supabase not configured." }, { status: 500, headers: CORS });
  }
  const order = new URL(req.url).searchParams.get("order") || "";
  if (!order) return NextResponse.json({ ok: false, error: "order is required" }, { status: 400, headers: CORS });

  try {
    const q = `${sbUrl}/rest/v1/dispatch_jobs?order_no=eq.${encodeURIComponent(order)}` +
              `&select=status,voucher,note,updated_at&order=updated_at.desc&limit=1`;
    const r = await fetch(q, { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` }, cache: "no-store" });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `Supabase ${r.status} ${t}`.slice(0, 200) }, { status: 502, headers: CORS });
    }
    const rows = (await r.json()) as Array<{ status: string; voucher: string | null; note: string | null; updated_at: string }>;
    const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
    if (!row) return NextResponse.json({ ok: true, status: "none", voucher: "", note: "", updatedAt: null }, { headers: CORS });
    return NextResponse.json({
      ok: true, status: row.status || "queued", voucher: row.voucher || "", note: row.note || "", updatedAt: row.updated_at,
    }, { headers: CORS });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: CORS });
  }
}
