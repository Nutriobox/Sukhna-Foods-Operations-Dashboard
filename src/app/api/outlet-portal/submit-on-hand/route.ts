import { NextResponse } from "next/server";
import { readSessionFromRequest } from "@/lib/outlet-portal-session";
import { clientIpFromRequest, ipIsAllowed, fetchAllowedIps } from "@/lib/outlet-portal-ip";
import { fetchWindowState, windowRefusal } from "@/lib/outlet-portal-window";

/**
 * POST /api/outlet-portal/submit-on-hand
 *   body: { dt_iso, qty, qty_loose, total_items }
 *
 * Writes an on-hand count to the opening_inventory_counts table on behalf of
 * the signed-in outlet. The outlet is taken from the session cookie — the
 * browser cannot name it — so a Rajinder session can never save a count
 * claiming to be Dwarka's. Upserts on (outlet, dt_iso) so a re-save at the
 * same datetime overwrites the previous one (same convention as the main
 * dashboard's Opening Inventory tab).
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

/**
 * Strip the "NutrioBox (…)" brand wrapper so this row keys off the same
 * short branch name the main dashboard uses in its outlet filter.
 * "NutrioBox (Rajinder Nagar)" -> "Rajinder Nagar". Verified 2026-10-24
 * when portal submissions landed in opening_inventory_counts but didn't
 * surface in the Variance View because the dashboard queries
 * outlet=eq.Rajinder Nagar.
 */
function toCountsOutletName(fullName: string): string {
  const m = String(fullName || "").match(/^\s*NutrioBox\s*\(\s*(.+?)\s*\)\s*$/i);
  return (m ? m[1] : fullName).trim();
}

export async function POST(req: Request) {
  const sess = readSessionFromRequest(req);
  if (!sess) return NextResponse.json({ ok: false, error: "Not signed in" }, { status: 401 });
  const { url, key } = sbEnv();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured" }, { status: 500 });

  const outletName = await outletNameForSlug(url, key, sess.slug);
  if (!outletName) return NextResponse.json({ ok: false, error: "Account not found" }, { status: 404 });

  // Defense-in-depth IP check: an IP allowlist edit between login and submit
  // must take effect immediately. Session-valid + wrong-network submits are
  // refused with 403 so the portal can bounce back to the login screen.
  const allowed = await fetchAllowedIps(url, key, sess.slug);
  const ip = clientIpFromRequest(req);
  if (!ipIsAllowed(ip, allowed)) {
    return NextResponse.json({ ok: false, error: "This network is no longer authorized for this outlet." }, { status: 403 });
  }

  // 2026-10-30 (Satvik's #4): outlet-portal submissions only accepted
  // during the 2-hour window stamped by the admin's Ideal Inventory save.
  // See src/lib/outlet-portal-window.ts.
  const windowState = await fetchWindowState(url, key, toCountsOutletName(outletName));
  const refusal = windowRefusal(windowState);
  if (refusal) return NextResponse.json(refusal.body, { status: refusal.status });

  type Body = { dt_iso?: string; qty?: Record<string, number>; qty_loose?: Record<string, number>; total_items?: number };
  let body: Body = {};
  try { body = (await req.json()) as Body; } catch { /* ignore */ }
  const dt_iso = String(body.dt_iso || "").trim();
  if (!dt_iso) return NextResponse.json({ ok: false, error: "dt_iso is required" }, { status: 400 });
  const qty       = (body.qty       && typeof body.qty       === "object") ? body.qty       : {};
  const qty_loose = (body.qty_loose && typeof body.qty_loose === "object") ? body.qty_loose : {};
  const total     = typeof body.total_items === "number" ? body.total_items : 0;
  const filled    = Object.keys(qty).filter((k) => Number(qty[k]) > 0 || Number(qty_loose[k]) > 0).length;

  // Upsert on (outlet, dt_iso) — same convention the main dashboard uses.
  // outlet is written as the SHORT branch name ("Rajinder Nagar"), not the
  // branded form ("NutrioBox (Rajinder Nagar)"), so the main dashboard's
  // outlet=eq.<name> queries hit these rows.
  const payload = {
    outlet:       toCountsOutletName(outletName),
    dt_iso,
    qty,
    qty_loose,
    total_items:  total,
    filled_count: filled,
    created_by:   `portal:${sess.slug}`,
    updated_at:   new Date().toISOString(),
  };
  const r = await fetch(
    `${url}/rest/v1/opening_inventory_counts?on_conflict=outlet,dt_iso`,
    {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=representation",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    }
  );
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    return NextResponse.json({ ok: false, error: `Save failed: ${r.status} ${t}`.slice(0, 300) }, { status: 502 });
  }
  const rows = (await r.json()) as Array<{ id: string; updated_at: string }>;
  const row = rows[0];
  return NextResponse.json({
    ok: true,
    id: row?.id || null,
    outlet: outletName,
    dt_iso,
    filled_count: filled,
    total_items: total,
    updated_at: row?.updated_at || payload.updated_at,
  });
}
