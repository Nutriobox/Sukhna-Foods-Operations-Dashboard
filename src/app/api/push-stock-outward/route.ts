import { NextResponse } from "next/server";

/**
 * Enqueues a NutrioBox "Stock Outward to Outlet" push. The Sukhna app calls
 * this once the operator has scanned + verified an outlet requisition (OMR).
 * The job is written to public.pact_jobs as 'queued' with payload.kind =
 * "stock-outward"; the always-on EC2 worker claims it, logs into PACT and
 * FILLS the Stock Outward document. With dryRun (the default) it stops BEFORE
 * Post — the operator reviews and Posts it in PACT.
 *
 * POST { order, dryRun? }
 *   order = { omr, outlet?, barcodes: [ "FG0005_FN0005/03092601_1200", ... ] }
 *   dryRun (default true) — fill but STOP before Post (safe).
 * Returns { ok, jobId } — poll pact_jobs for status (same as push-fsi).
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
  if (!order.omr) {
    return NextResponse.json({ ok: false, error: "Missing order.omr (requisition number)." }, { status: 400 });
  }

  const jobId = crypto.randomUUID();
  const sbUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  if (!sbUrl || !sbKey) {
    return NextResponse.json({ ok: false, error: "SUPABASE_URL / SUPABASE_SERVICE_KEY not configured on the server." }, { status: 500 });
  }

  // Tag the payload so the worker routes it to the Stock Outward filler rather
  // than the Factory Sales Invoice filler. Same pact_jobs status flow otherwise.
  const payload = { ...order, kind: "stock-outward" };
  try {
    const r = await fetch(`${sbUrl.replace(/\/$/, "")}/rest/v1/pact_jobs`, {
      method: "POST",
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, "content-type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ id: jobId, invoice: order.omr ?? null, vendor: order.outlet ?? null, status: "queued", dry_run: dryRun, payload }),
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
