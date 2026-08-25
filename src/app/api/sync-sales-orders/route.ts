import { NextResponse } from "next/server";

/**
 * Triggers the pending-sales-order sync on demand. Fires a GitHub Actions
 * repository_dispatch(sync-sales-orders), which runs scripts/sync-sales-orders.js
 * and refreshes public.pending_sales_orders from PACT's "Pending Sales Order
 * Quantity" report. The app's "Fetch sales order" screen then reads the fresh
 * list via /api/sales-orders.
 *
 * Server env required (same as the inventory sync trigger):
 *   GH_DISPATCH_TOKEN — GitHub PAT with actions dispatch access
 *   GH_REPO           — "owner/name"
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST,OPTIONS" };

export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

export async function POST() {
  const token = process.env.GH_DISPATCH_TOKEN;
  const repo = process.env.GH_REPO;
  if (!token || !repo) {
    return NextResponse.json(
      { ok: false, error: "GH_DISPATCH_TOKEN / GH_REPO not configured on the server." },
      { status: 500, headers: CORS }
    );
  }

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
      body: JSON.stringify({ event_type: "sync-sales-orders" }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return NextResponse.json(
        { ok: false, error: `GitHub dispatch failed: ${r.status} ${t}`.slice(0, 300) },
        { status: 502, headers: CORS }
      );
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: "Dispatch error: " + msg }, { status: 500, headers: CORS });
  }

  return NextResponse.json({ ok: true }, { headers: CORS });
}
