import { NextResponse } from "next/server";

/**
 * Queues a pending-sales-order sync for the always-on AWS worker (via
 * public.pact_jobs with payload.__sync = "sales-orders"). The worker runs
 * scripts/sync-sales-orders.js and refreshes public.pending_sales_orders from
 * PACT's "Pending Sales Order Quantity" report. The app's "Fetch sales order"
 * screen then reads the fresh list via /api/sales-orders.
 *
 * (Replaced the GitHub Actions repository_dispatch — same on-demand behaviour,
 * but it now runs on the warm AWS worker instead of a cold GitHub runner.)
 *
 * Server env required: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_KEY
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST,OPTIONS" };

export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

export async function POST() {
  const sbUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  if (!sbUrl || !sbKey) {
    return NextResponse.json({ ok: false, error: "SUPABASE_URL / SUPABASE_SERVICE_KEY not configured on the server." }, { status: 500, headers: CORS });
  }
  const jobId = crypto.randomUUID();
  try {
    const r = await fetch(`${sbUrl.replace(/\/$/, "")}/rest/v1/pact_jobs`, {
      method: "POST",
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, "content-type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ id: jobId, invoice: "sync:sales-orders", status: "queued", dry_run: false, payload: { __sync: "sales-orders" } }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `Enqueue failed: ${r.status} ${t}`.slice(0, 300) }, { status: 502, headers: CORS });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: "Enqueue error: " + msg }, { status: 500, headers: CORS });
  }
  return NextResponse.json({ ok: true, jobId }, { headers: CORS });
}
