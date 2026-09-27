import { NextResponse } from "next/server";

/**
 * Latest live snapshot of one PACT costing report, for the costing dashboard.
 *
 * GET /api/costing/pf | pm | bom | si
 *   -> { ok, report, status, synced_at, row_count, source, error, data }
 *
 * `data` is the exact array-of-arrays (header row first, then data rows) the
 * dashboard's Excel parser already consumes, so the page feeds it straight into
 * detectType()/parseXX() with no new parsing. Reads the newest row per report
 * from public.costing_snapshots (written by the AWS worker).
 *
 * Server env: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_KEY
 * (or NEXT_PUBLIC_SUPABASE_ANON_KEY for read-only if RLS allows).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS" };
const REPORTS = new Set(["pf", "pm", "bom", "si"]);

export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

export async function GET(_req: Request, { params }: { params: { report: string } }) {
  const report = String(params.report || "").toLowerCase();
  if (!REPORTS.has(report)) {
    return NextResponse.json({ ok: false, error: "unknown report (use pf | pm | bom | si)" }, { status: 400, headers: CORS });
  }
  const sbUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!sbUrl || !sbKey) {
    return NextResponse.json({ ok: false, error: "Supabase not configured on the server." }, { status: 500, headers: CORS });
  }
  try {
    const url = `${sbUrl.replace(/\/$/, "")}/rest/v1/costing_snapshots`
      + `?report=eq.${encodeURIComponent(report)}`
      + `&select=report,status,synced_at,row_count,source,error,data`
      + `&order=synced_at.desc&limit=1`;
    const r = await fetch(url, {
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, Accept: "application/json" },
      cache: "no-store",
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `Supabase ${r.status} ${t}`.slice(0, 300) }, { status: 502, headers: CORS });
    }
    const rows = (await r.json()) as Array<Record<string, unknown>>;
    const snap = rows && rows[0];
    if (!snap) {
      return NextResponse.json({ ok: true, report, status: "none", synced_at: null, row_count: 0, data: [] }, { headers: CORS });
    }
    return NextResponse.json({
      ok: true,
      report,
      status: snap.status ?? "ok",
      synced_at: snap.synced_at ?? null,
      row_count: snap.row_count ?? 0,
      source: snap.source ?? "",
      error: snap.error ?? "",
      data: snap.data ?? [],
    }, { headers: CORS });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: "read error: " + msg }, { status: 500, headers: CORS });
  }
}
