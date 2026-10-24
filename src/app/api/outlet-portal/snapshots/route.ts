import { NextResponse } from "next/server";
import { readSessionFromRequest } from "@/lib/outlet-portal-session";

/**
 * GET /api/outlet-portal/snapshots
 *   Lists Ideal Inventory snapshots for the logged-in outlet (session-
 *   gated — the client NEVER picks which outlet to see). Returns the same
 *   shape /api/ideal-inventory does, filtered to the signed-in outlet.
 *
 * GET /api/outlet-portal/snapshots?id=<uuid>
 *   Returns the full snapshot (with items[]) IF the snapshot's outlet
 *   matches the session. Any mismatch is a 403 — this is the critical
 *   check: a logged-in Rajinder Nagar session must never see Dwarka data
 *   even if it guesses a Dwarka snapshot id.
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

export async function GET(req: Request) {
  const sess = readSessionFromRequest(req);
  if (!sess) return NextResponse.json({ ok: false, error: "Not signed in" }, { status: 401 });
  const { url, key } = sbEnv();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured" }, { status: 500 });

  const outletName = await outletNameForSlug(url, key, sess.slug);
  if (!outletName) return NextResponse.json({ ok: false, error: "Account not found" }, { status: 404 });

  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    const r = await fetch(
      `${url}/rest/v1/ideal_inventory_snapshots?select=*&id=eq.${encodeURIComponent(id)}`,
      { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" }, cache: "no-store" }
    );
    if (!r.ok) return NextResponse.json({ ok: false, error: `Lookup failed: ${r.status}` }, { status: 502 });
    const rows = (await r.json()) as Array<{ outlet: string } & Record<string, unknown>>;
    const row = rows[0];
    if (!row) return NextResponse.json({ ok: false, error: "Snapshot not found" }, { status: 404 });
    // Cross-outlet guard: a Rajinder session must not see a Dwarka snapshot
    // even if it guesses the id.
    if (String(row.outlet || "") !== outletName) {
      return NextResponse.json({ ok: false, error: "Not allowed" }, { status: 403 });
    }
    return NextResponse.json({ ok: true, snapshot: row });
  }

  // Listing
  const r = await fetch(
    `${url}/rest/v1/ideal_inventory_snapshots?select=id,outlet,order_number,window_from,window_to,total_items,opening_count,created_at,updated_at,approved_at,approved_by&outlet=eq.${encodeURIComponent(outletName)}&order=created_at.desc`,
    { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" }, cache: "no-store" }
  );
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    return NextResponse.json({ ok: false, error: `List failed: ${r.status} ${t}`.slice(0, 200) }, { status: 502 });
  }
  const snapshots = await r.json();
  return NextResponse.json({ ok: true, outlet_slug: sess.slug, outlet_name: outletName, snapshots });
}
