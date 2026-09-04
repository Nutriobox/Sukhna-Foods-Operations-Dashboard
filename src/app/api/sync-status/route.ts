import { NextResponse } from "next/server";

/**
 * Status of the most recent sync run so the app can wait for it to finish
 * (green) instead of guessing from the snapshot. Reads the latest sync job from
 * public.pact_jobs (payload.__sync). Optional ?type=inventory|sales-orders
 * (default inventory).
 *
 * GET -> { ok, run: { id, status, conclusion, createdAt, url } | null }
 *   status:     "queued" | "in_progress" | "completed"
 *   conclusion: "success" | "failure" | null (only once completed)
 *
 * Server env required: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_KEY
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS" };

export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

export async function GET(req: Request) {
  const sbUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  if (!sbUrl || !sbKey) {
    return NextResponse.json({ ok: false, error: "SUPABASE_URL / SUPABASE_SERVICE_KEY not configured on the server." }, { status: 500, headers: CORS });
  }
  const type = new URL(req.url).searchParams.get("type") || "inventory";
  try {
    const q = `${sbUrl.replace(/\/$/, "")}/rest/v1/pact_jobs?invoice=eq.${encodeURIComponent("sync:" + type)}&select=id,status,updated_at&order=updated_at.desc&limit=1`;
    const r = await fetch(q, { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` }, cache: "no-store" });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `Supabase ${r.status} ${t}`.slice(0, 200) }, { status: 502, headers: CORS });
    }
    const rows = (await r.json()) as Array<{ id: string; status: string; updated_at: string }>;
    const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
    let status = "completed";
    let conclusion: string | null = null;
    if (row) {
      if (row.status === "queued") status = "queued";
      else if (row.status === "processing") status = "in_progress";
      else if (row.status === "done") { status = "completed"; conclusion = "success"; }
      else if (row.status === "failed") { status = "completed"; conclusion = "failure"; }
    }
    return NextResponse.json(
      { ok: true, run: row ? { id: row.id, status, conclusion, createdAt: row.updated_at, url: null } : null },
      { headers: CORS }
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: CORS });
  }
}
