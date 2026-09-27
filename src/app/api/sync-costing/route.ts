import { NextResponse } from "next/server";

/**
 * Queue a live PACT costing sync for the always-on AWS worker (pact-worker/worker.js).
 * Inserts one queued row per report into public.pact_jobs with
 *   invoice = "sync:costing-<k>",  payload.__sync = "costing-<k>"
 * which the worker maps to scripts/sync-costing-<k>.js. The script logs into PACT,
 * replays that report's ReportDataSet call, and writes a fresh row to
 * costing_snapshots (which /api/costing/<k> then serves to the dashboard).
 *
 * POST /api/sync-costing            -> queue all 4 reports (the "Live Sync" button)
 * POST /api/sync-costing?report=si  -> queue one report
 * GET  /api/sync-costing?report=pf  -> same, so a cron can trigger it on a schedule.
 *   If CRON_SECRET is set, GET requires ?secret=... (or x-cron-secret header).
 *
 * Server env: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_KEY
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" };
const ALL = ["pf", "pm", "bom", "si"] as const;
type Report = (typeof ALL)[number];

export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

function pickReports(url: URL): Report[] {
  const q = (url.searchParams.get("report") || "all").toLowerCase();
  if (q === "all" || q === "") return [...ALL];
  return q.split(",").map((s) => s.trim()).filter((s): s is Report => (ALL as readonly string[]).includes(s));
}

async function enqueue(reports: Report[]) {
  const sbUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  if (!sbUrl || !sbKey) {
    return { status: 500, body: { ok: false, error: "SUPABASE_URL / SUPABASE_SERVICE_KEY not configured on the server." } };
  }
  const jobs = reports.map((k) => ({
    id: crypto.randomUUID(),
    invoice: `sync:costing-${k}`,
    status: "queued",
    dry_run: false,
    payload: { __sync: `costing-${k}`, report: k },
  }));
  try {
    const r = await fetch(`${sbUrl.replace(/\/$/, "")}/rest/v1/pact_jobs`, {
      method: "POST",
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, "content-type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(jobs),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return { status: 502, body: { ok: false, error: `Enqueue failed: ${r.status} ${t}`.slice(0, 300) } };
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: 500, body: { ok: false, error: "Enqueue error: " + msg } };
  }
  return { status: 200, body: { ok: true, queued: jobs.map((j) => ({ report: (j.payload as { report: string }).report, jobId: j.id })) } };
}

export async function POST(req: Request) {
  const reports = pickReports(new URL(req.url));
  if (!reports.length) return NextResponse.json({ ok: false, error: "no valid report(s)" }, { status: 400, headers: CORS });
  const { status, body } = await enqueue(reports);
  return NextResponse.json(body, { status, headers: CORS });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const given = url.searchParams.get("secret") || req.headers.get("x-cron-secret") || "";
    if (given !== secret) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401, headers: CORS });
  }
  const reports = pickReports(url);
  if (!reports.length) return NextResponse.json({ ok: false, error: "no valid report(s)" }, { status: 400, headers: CORS });
  const { status, body } = await enqueue(reports);
  return NextResponse.json(body, { status, headers: CORS });
}
