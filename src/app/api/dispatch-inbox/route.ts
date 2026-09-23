import { NextResponse } from "next/server";

/**
 * Receives a scanned order's dispatch TXT from the Sukhna app and queues it for
 * the always-on PACT-desktop worker (Supabase `dispatch_jobs`, status "queued").
 * The worker fills "Stock Outward to Outlet" and posts ONE voucher, then writes
 * the voucher back (read by /api/dispatch-status).
 *
 * POST body: { order, outlet, issueType?, barcodes: string[], txt? }
 *   -> { ok, jobId }
 *
 * Server env: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_KEY
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST,OPTIONS" };
export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

export async function POST(req: Request) {
  const sbUrl = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  if (!sbUrl || !sbKey) {
    return NextResponse.json({ ok: false, error: "Supabase not configured on the server." }, { status: 500, headers: CORS });
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: "bad json" }, { status: 400, headers: CORS }); }

  const order = String(body.order || "").trim();
  const outlet = String(body.outlet || "").trim();
  const issueType = String(body.issueType || "Frozen").trim() || "Frozen";
  const barcodes = Array.isArray(body.barcodes) ? (body.barcodes as unknown[]).map((b) => String(b)).filter((b) => b.trim()) : [];
  const txt = typeof body.txt === "string" ? body.txt : "";

  if (!order) return NextResponse.json({ ok: false, error: "order is required" }, { status: 400, headers: CORS });
  if (!barcodes.length && !txt) return NextResponse.json({ ok: false, error: "no barcodes / txt" }, { status: 400, headers: CORS });

  const jobId = crypto.randomUUID();
  try {
    const r = await fetch(`${sbUrl}/rest/v1/dispatch_jobs`, {
      method: "POST",
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, "content-type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        id: jobId, order_no: order, outlet, issue_type: issueType,
        barcodes, txt, status: "queued",
      }),
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
