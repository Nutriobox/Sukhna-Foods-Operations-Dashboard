import { NextResponse } from "next/server";

/**
 * Queues an inventory sync for the always-on AWS worker (via public.pact_jobs
 * with payload.__sync = "inventory"). The worker runs scripts/sync-inventory.js
 * and writes a fresh snapshot to Supabase.
 *
 * (Replaced the GitHub Actions repository_dispatch — same "Sync now" behaviour,
 * now on the warm AWS worker.)
 *
 * Server env required: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_KEY
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const sbUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  if (!sbUrl || !sbKey) {
    return NextResponse.json({ ok: false, error: "SUPABASE_URL / SUPABASE_SERVICE_KEY not configured on the server." }, { status: 500 });
  }
  const jobId = crypto.randomUUID();
  try {
    const r = await fetch(`${sbUrl.replace(/\/$/, "")}/rest/v1/pact_jobs`, {
      method: "POST",
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, "content-type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ id: jobId, invoice: "sync:inventory", status: "queued", dry_run: false, payload: { __sync: "inventory" } }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `Enqueue failed: ${r.status} ${t}`.slice(0, 300) }, { status: 502 });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: "Enqueue error: " + msg }, { status: 500 });
  }
  return NextResponse.json({ ok: true, jobId });
}
