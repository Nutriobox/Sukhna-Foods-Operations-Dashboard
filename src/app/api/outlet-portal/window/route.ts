import { NextResponse } from "next/server";
import { readSessionFromRequest } from "@/lib/outlet-portal-session";
import { fetchWindowState } from "@/lib/outlet-portal-window";

/**
 * GET /api/outlet-portal/window
 *   -> { ok, status, closes_at, opens_at, closes_in_ms, snapshot_id }
 *
 * Reports the signed-in outlet's 2-hour submission window status to the
 * portal page so it can render a countdown and lock the form once the
 * window closes. Mirrors the server-side gate used by submit-on-hand
 * and submit-wastage — a 403 from those routes should align with
 * status: "closed" | "none" here.
 *
 * status values:
 *   "open"   — portal accepts submissions; closes_in_ms is positive
 *   "closed" — a snapshot exists but window has elapsed
 *   "none"   — no snapshot has ever been saved for this outlet
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sbEnv() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return { url, key: key as string | undefined };
}

async function outletNameForSlug(url: string, key: string, slug: string): Promise<string | null> {
  const r = await fetch(
    `${url}/rest/v1/outlet_portal_access?select=outlet_name&outlet_slug=eq.${encodeURIComponent(slug)}`,
    { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" }, cache: "no-store" }
  );
  if (!r.ok) return null;
  const rows = (await r.json()) as Array<{ outlet_name: string }>;
  return rows[0]?.outlet_name || null;
}

/** Match submit-*: strip the "NutrioBox (…)" wrapper so the join hits
 *  the same outlet string the admin dashboard uses. */
function toCountsOutletName(fullName: string): string {
  const m = String(fullName || "").match(/^\s*NutrioBox\s*\(\s*(.+?)\s*\)\s*$/i);
  return (m ? m[1] : fullName).trim();
}

export async function GET(req: Request) {
  const sess = readSessionFromRequest(req);
  if (!sess) return NextResponse.json({ ok: false, error: "Not signed in" }, { status: 401 });
  const { url, key } = sbEnv();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured" }, { status: 500 });

  const outletName = await outletNameForSlug(url, key, sess.slug);
  if (!outletName) return NextResponse.json({ ok: false, error: "Account not found" }, { status: 404 });
  const state = await fetchWindowState(url, key, toCountsOutletName(outletName));
  return NextResponse.json({
    ok: true,
    status:       state.status,
    opens_at:     state.opens_at ?? null,
    closes_at:    state.closes_at ?? null,
    closes_in_ms: state.closes_in_ms ?? null,
    snapshot_id:  state.snapshot_id ?? null,
    // Server-anchored clock so the portal doesn't drift if the device's
    // local clock is wrong — portal computes remaining time by diffing
    // closes_at against server_now, not Date.now().
    server_now:   new Date().toISOString(),
  });
}
