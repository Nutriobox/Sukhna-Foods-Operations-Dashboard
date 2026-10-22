import { NextResponse } from "next/server";

/**
 * Queue an on-demand PACT "Stock Outlet Outward (Transfer Location)" sync for
 * the always-on pact-windows worker (pact-worker/worker.js). Inserts one
 * queued row into public.pact_jobs with:
 *   invoice      = "sync:outlet-outward"
 *   payload.__sync = "outlet-outward"
 * The worker maps __sync to scripts/sync-outlet-outward.js, which logs into
 * PACT, replays the BI report's ReportDataSet call, dedupes and upserts into
 * public.pact_stock_outlet_outward (served by /api/outlet-grns to the
 * Purchase tab).
 *
 * POST /api/sync-outlet-outward            -> queue a sync (dedupes against any already-queued run)
 * GET  /api/sync-outlet-outward            -> same, so a cron can trigger it.
 *   If CRON_SECRET is set, GET requires ?secret=... (or x-cron-secret header).
 *
 * Server env: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_KEY
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" };

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

type EnqueueResult =
  | { status: number; body: { ok: true; id: string; dedup?: boolean } }
  | { status: number; body: { ok: false; error: string } };

async function enqueue(): Promise<EnqueueResult> {
  const sbUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  if (!sbUrl || !sbKey) {
    return { status: 500, body: { ok: false, error: "SUPABASE_URL / SUPABASE_SERVICE_KEY not configured on the server." } };
  }
  const base = sbUrl.replace(/\/$/, "");
  const h = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, "content-type": "application/json" } as const;

  try {
    // Skip if a sync is already queued or in-flight (same guard the worker's
    // scheduler uses) so a user-mashed button doesn't pile up 10 jobs.
    const pendRes = await fetch(
      `${base}/rest/v1/pact_jobs?select=id,status&invoice=eq.sync%3Aoutlet-outward&status=in.(queued,processing)&limit=1`,
      { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, Accept: "application/json" }, cache: "no-store" }
    );
    if (pendRes.ok) {
      const pend = (await pendRes.json()) as Array<{ id: string }>;
      if (pend.length) {
        return { status: 200, body: { ok: true, id: pend[0].id, dedup: true } };
      }
    }

    const id = crypto.randomUUID();
    const r = await fetch(`${base}/rest/v1/pact_jobs`, {
      method: "POST",
      headers: { ...h, Prefer: "return=minimal" },
      body: JSON.stringify({
        id,
        invoice: "sync:outlet-outward",
        status: "queued",
        dry_run: false,
        payload: { __sync: "outlet-outward" },
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return { status: 500, body: { ok: false, error: `Supabase ${r.status}: ${t.slice(0, 200)}` } };
    }
    return { status: 200, body: { ok: true, id } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: 500, body: { ok: false, error: msg } };
  }
}

export async function POST() {
  const { status, body } = await enqueue();
  return NextResponse.json(body, { status, headers: CORS });
}

export async function GET(req: Request) {
  // Allow a GET-only cron (same shape as /api/sync-costing). Gate with
  // CRON_SECRET if the env var is set.
  const secretExpected = process.env.CRON_SECRET || "";
  if (secretExpected) {
    const sp = new URL(req.url).searchParams;
    const provided = sp.get("secret") || req.headers.get("x-cron-secret") || "";
    if (provided !== secretExpected) {
      return NextResponse.json({ ok: false, error: "bad or missing secret" }, { status: 401, headers: CORS });
    }
  }
  const { status, body } = await enqueue();
  return NextResponse.json(body, { status, headers: CORS });
}
