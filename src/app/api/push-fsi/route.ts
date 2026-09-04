import { NextResponse } from "next/server";

/**
 * Enqueues a Factory Sales Invoice push. The device (Sukhna app) or the
 * dashboard calls this once the operator has scanned + verified an order.
 * The job (with its full order payload) is written to public.pact_jobs as
 * 'queued'; the always-on EC2 worker claims it, logs into PACT, fills + posts
 * the invoice, and writes the result back on the row.
 *
 * POST { order, dryRun? }
 *   order = { soNumber, company?, customer?, barcodes: [ "FG0298_F2B057/25082601_5760", ... ] }
 *   dryRun (default true)  — fill the invoice but STOP before Post (safe).
 * Returns { ok, jobId } — poll pact_jobs for status.
 *
 * Server env required:
 *   SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_KEY
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const order = body?.order;
  const dryRun = body?.dryRun === undefined ? true : !!body.dryRun; // default safe
  if (!order || !Array.isArray(order.barcodes) || !order.barcodes.length) {
    return NextResponse.json({ ok: false, error: "Missing order or order.barcodes." }, { status: 400 });
  }

  const jobId = crypto.randomUUID();
  const sbUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  if (!sbUrl || !sbKey) {
    return NextResponse.json({ ok: false, error: "SUPABASE_URL / SUPABASE_SERVICE_KEY not configured on the server." }, { status: 500 });
  }

  // Enqueue the job WITH its full order payload. The always-on EC2 worker polls
  // public.pact_jobs, atomically claims queued rows (claim_pact_job RPC), fills +
  // posts the Factory Sales Invoice in PACT, and writes the result back on this
  // row. (This replaced the per-order GitHub Actions dispatch — same status flow,
  // read via pact_jobs, but posting is now instant on the warm worker.)
  try {
    const r = await fetch(`${sbUrl.replace(/\/$/, "")}/rest/v1/pact_jobs`, {
      method: "POST",
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, "content-type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ id: jobId, invoice: order.soNumber ?? null, vendor: order.customer ?? null, status: "queued", dry_run: dryRun, payload: order }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `Enqueue failed: ${r.status} ${t}`.slice(0, 300), jobId }, { status: 502 });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: "Enqueue error: " + msg, jobId }, { status: 500 });
  }

  return NextResponse.json({ ok: true, jobId });
}
