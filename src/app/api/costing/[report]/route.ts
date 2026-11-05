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
const REPORTS = new Set(["pf", "pm", "bom", "si", "bs"]);

export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

export async function GET(_req: Request, { params }: { params: { report: string } }) {
  const report = String(params.report || "").toLowerCase();
  if (!REPORTS.has(report)) {
    return NextResponse.json({ ok: false, error: "unknown report (use pf | pm | bom | si | bs)" }, { status: 400, headers: CORS });
  }
  const sbUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!sbUrl || !sbKey) {
    return NextResponse.json({ ok: false, error: "Supabase not configured on the server." }, { status: 500, headers: CORS });
  }
  try {
    // 2026-11-05: serve the newest snapshot that HAS DATA. A failed sync (e.g.
    // PACT login failure) still writes a row with row_count 0; reading "newest
    // row" blindly made that empty row hide the last good data, which emptied
    // Item Master and stopped all outlet consumption. The newest attempt is
    // still reported as last_attempt when it failed after the served data.
    const base = `${sbUrl.replace(/\/$/, "")}/rest/v1/costing_snapshots?report=eq.${encodeURIComponent(report)}`;
    const hdr = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, Accept: "application/json" };
    const [r, rLast] = await Promise.all([
      fetch(`${base}&row_count=gt.0&select=report,status,synced_at,row_count,source,error,data&order=synced_at.desc&limit=1`, { headers: hdr, cache: "no-store" }),
      fetch(`${base}&select=status,synced_at,row_count,error&order=synced_at.desc&limit=1`, { headers: hdr, cache: "no-store" }),
    ]);
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `Supabase ${r.status} ${t}`.slice(0, 300) }, { status: 502, headers: CORS });
    }
    const rows = (await r.json()) as Array<Record<string, unknown>>;
    const lastRows = rLast.ok ? ((await rLast.json()) as Array<Record<string, unknown>>) : [];
    const snap = rows && rows[0];
    const last = lastRows && lastRows[0];
    const lastAttempt = last && (!snap || String(last.synced_at) > String(snap.synced_at))
      ? { status: last.status ?? "", synced_at: last.synced_at ?? null, row_count: last.row_count ?? 0, error: String(last.error ?? "").slice(0, 600) }
      : null;
    if (!snap) {
      return NextResponse.json({ ok: true, report, status: last ? (last.status ?? "failed") : "none", synced_at: null, row_count: 0, data: [], last_attempt: lastAttempt }, { headers: CORS });
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
      last_attempt: lastAttempt,
    }, { headers: CORS });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: "read error: " + msg }, { status: 500, headers: CORS });
  }
}
