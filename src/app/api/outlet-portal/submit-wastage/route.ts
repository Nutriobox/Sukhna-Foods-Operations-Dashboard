import { NextResponse } from "next/server";
import { readSessionFromRequest } from "@/lib/outlet-portal-session";
import { clientIpFromRequest, ipIsAllowed, fetchAllowedIps } from "@/lib/outlet-portal-ip";

/**
 * POST /api/outlet-portal/submit-wastage
 *   body: { dt_iso, qty, qty_loose, total_items }
 *
 * Mirror of /api/outlet-portal/submit-on-hand but writes to the
 * outlet_wastage_counts table. Outlet is pulled from the session cookie
 * — the browser never names it — so a Rajinder session can never submit
 * wastage claiming to be Dwarka. Upsert on (outlet, dt_iso) so a re-save
 * at the same datetime overwrites.
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

/** See submit-on-hand/route.ts — strips "NutrioBox (…)" wrapper. */
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

  // Defense-in-depth IP check — must take effect immediately when the
  // allowlist is edited between login and submit.
  const allowed = await fetchAllowedIps(url, key, sess.slug);
  const ip = clientIpFromRequest(req);
  if (!ipIsAllowed(ip, allowed)) {
    return NextResponse.json({ ok: false, error: "This network is no longer authorized for this outlet." }, { status: 403 });
  }

  type Body = { dt_iso?: string; qty?: Record<string, number>; qty_loose?: Record<string, number>; total_items?: number };
  let body: Body = {};
  try { body = (await req.json()) as Body; } catch { /* ignore */ }
  const dt_iso = String(body.dt_iso || "").trim();
  if (!dt_iso) return NextResponse.json({ ok: false, error: "dt_iso is required" }, { status: 400 });
  const qty       = (body.qty       && typeof body.qty       === "object") ? body.qty       : {};
  const qty_loose = (body.qty_loose && typeof body.qty_loose === "object") ? body.qty_loose : {};
  const total     = typeof body.total_items === "number" ? body.total_items : 0;
  const filled    = Object.keys(qty).filter((k) => Number(qty[k]) > 0 || Number(qty_loose[k]) > 0).length;

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
    `${url}/rest/v1/outlet_wastage_counts?on_conflict=outlet,dt_iso`,
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
