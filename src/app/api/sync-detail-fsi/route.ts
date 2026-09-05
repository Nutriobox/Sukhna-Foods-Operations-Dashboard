import { NextResponse } from "next/server";

/**
 * Queues a "Detail Factory Sales Invoices" report pull for the AWS worker
 * (public.pact_jobs, payload.__sync = "detail-fsi"). On-demand pulls cover the
 * current IST business day (04:00 IST -> now; before 4 AM = the previous day). The worker filters report rows to that
 * day by Doc Date and upserts public.detail_fsi_snapshot (read by /api/detail-fsi).
 *
 * Server env: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_KEY
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST,OPTIONS" };
export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

function istBusinessDay(): string {
  // Business day starts at 04:00 IST: before 4 AM still belongs to the previous day.
  const d = new Date(Date.now() + 5.5 * 3600 * 1000);
  if (d.getUTCHours() < 4) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export async function POST() {
  const sbUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  if (!sbUrl || !sbKey) return NextResponse.json({ ok: false, error: "SUPABASE not configured on the server." }, { status: 500, headers: CORS });
  const day = istBusinessDay();
  const jobId = crypto.randomUUID();
  try {
    const r = await fetch(`${sbUrl.replace(/\/$/, "")}/rest/v1/pact_jobs`, {
      method: "POST",
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, "content-type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ id: jobId, invoice: "sync:detail-fsi", status: "queued", dry_run: false, payload: { __sync: "detail-fsi", from: day, to: day } }),
    });
    if (!r.ok) { const t = await r.text().catch(() => ""); return NextResponse.json({ ok: false, error: `Enqueue failed: ${r.status} ${t}`.slice(0, 300) }, { status: 502, headers: CORS }); }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: "Enqueue error: " + msg }, { status: 500, headers: CORS });
  }
  return NextResponse.json({ ok: true, jobId, from: day, to: day }, { headers: CORS });
}
