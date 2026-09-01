import { NextResponse } from "next/server";

/**
 * Enqueues a Factory Sales Invoice push and triggers GitHub Actions to run it
 * with a real headless browser. The device (Sukhna app) or the dashboard calls
 * this once the operator has scanned + verified an order.
 *
 * POST { order, dryRun?, diag? }
 *   order = { soNumber, company?, customer?, barcodes: [ "FG0298_F2B057/25082601_5760", ... ] }
 *   dryRun (default true)  — fill the invoice but STOP before Post (safe).
 *   diag   (optional)      — "1" to dump the invoice form and stop (selector wiring).
 * Returns { ok, jobId } — poll pact_jobs for status, same as the stock-inward push.
 *
 * Server env required (same as push-to-pact):
 *   GH_DISPATCH_TOKEN, GH_REPO, SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_KEY
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const order = body?.order;
  const dryRun = body?.dryRun === undefined ? true : !!body.dryRun; // default safe
  const diag = body?.diag ? "1" : "";
  if (!order || !Array.isArray(order.barcodes) || !order.barcodes.length) {
    return NextResponse.json({ ok: false, error: "Missing order or order.barcodes." }, { status: 400 });
  }

  const token = process.env.GH_DISPATCH_TOKEN;
  const repo = process.env.GH_REPO;
  if (!token || !repo) {
    return NextResponse.json({ ok: false, error: "GH_DISPATCH_TOKEN / GH_REPO not configured on the server." }, { status: 500 });
  }

  const jobId = crypto.randomUUID();
  const sbUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;

  // 1) record the job as queued (best-effort)
  if (sbUrl && sbKey) {
    try {
      await fetch(`${sbUrl.replace(/\/$/, "")}/rest/v1/pact_jobs`, {
        method: "POST",
        headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, "content-type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ id: jobId, invoice: order.soNumber ?? null, vendor: order.customer ?? null, status: "queued" }),
      });
    } catch { /* non-fatal */ }
  }

  // 2) trigger the GitHub Actions workflow with the order payload
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "content-type": "application/json",
        "User-Agent": "sukhna-ops-dashboard",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ event_type: "push-fsi", client_payload: { jobId, dryRun, diag, order } }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `GitHub dispatch failed: ${r.status} ${t}`.slice(0, 300), jobId }, { status: 502 });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: "Dispatch error: " + msg, jobId }, { status: 500 });
  }

  return NextResponse.json({ ok: true, jobId });
}
