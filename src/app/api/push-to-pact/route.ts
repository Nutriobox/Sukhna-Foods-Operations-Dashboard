import { NextResponse } from "next/server";

/**
 * Enqueues a PACT push and triggers a GitHub Actions run to execute it with a
 * real browser (serverless Chromium can't render the heavy ERP).
 *
 * POST { bill, dryRun? } — bill = {
 *   company, vendor, vendorSearch, billNo, billDate, billId?,
 *   items: [{ search, name, unitLevel, qty, batch?: { mfgDate?, expiryDate? } }]
 * }
 * Returns { ok, jobId } — the dashboard polls the pact_jobs table for status.
 *
 * Server env required:
 *   GH_DISPATCH_TOKEN  — GitHub PAT with repo/actions dispatch access
 *   GH_REPO            — "owner/name"
 *   SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_KEY — record the job
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const bill = body?.bill;
  const dryRun = !!body?.dryRun;
  if (!bill || !Array.isArray(bill.items) || !bill.items.length) {
    return NextResponse.json({ ok: false, error: "Missing bill or bill.items." }, { status: 400 });
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
        body: JSON.stringify({ id: jobId, bill_id: bill.billId ?? null, invoice: bill.billNo ?? null, vendor: bill.vendor ?? null, status: "queued" }),
      });
    } catch { /* non-fatal */ }
  }

  // 2) trigger the GitHub Actions workflow with the bill payload
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
      body: JSON.stringify({ event_type: "push-to-pact", client_payload: { jobId, dryRun, bill } }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      if (sbUrl && sbKey) {
        await fetch(`${sbUrl.replace(/\/$/, "")}/rest/v1/pact_jobs?id=eq.${jobId}`, {
          method: "PATCH",
          headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, "content-type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ status: "failed", error: `GitHub dispatch failed: ${r.status}`, updated_at: new Date().toISOString() }),
        }).catch(() => {});
      }
      return NextResponse.json({ ok: false, error: `GitHub dispatch failed: ${r.status} ${t}`.slice(0, 300), jobId }, { status: 502 });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: "Dispatch error: " + msg, jobId }, { status: 500 });
  }

  return NextResponse.json({ ok: true, jobId });
}
