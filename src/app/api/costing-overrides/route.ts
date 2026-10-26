import { NextResponse } from "next/server";

/**
 * Costing dashboard shared overrides.
 *
 *   GET /api/costing-overrides
 *     -> { ok, overrides: { <key>: <data>, ... }, updated_at: { <key>: ts, ... } }
 *     One entry per localStorage namespace the dashboard syncs
 *     (bom_approved, bom_active, bom_wt_ovr, bom_spk_ovr, final_price).
 *     The data map is whatever the dashboard already stored under that
 *     localStorage key — a flat { "<bom_or_rm_code>": <value> }.
 *
 *   PATCH /api/costing-overrides
 *     body: { key: "<namespace>", data: {...}, updated_by?: string }
 *     -> upserts the row for that key with the full data map (replace,
 *        not merge — the client's in-memory map is authoritative at
 *        write time). Returns the written row.
 *
 * Reads/writes go through the service_role key the dashboard already uses
 * for sync-costing. The costing_overrides table has RLS allowing anon
 * SELECT, so a future Supabase Realtime subscription from the browser
 * can push updates to open dashboards without exposing writes.
 *
 * See pact-worker/costing-overrides-setup.sql for the table migration —
 * Satvik needs to run that in the Supabase SQL editor once before this
 * endpoint can write.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,PATCH,OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

function sbEnv() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return { url, key: key as string | undefined };
}

// Only these namespaces are allowed through — stops a stray write from
// polluting the table with random keys. New keys added here must also
// be synced on the client side (public/costing/index.html).
const ALLOWED_KEYS = new Set<string>([
  "bom_approved",
  "bom_active",
  "bom_wt_ovr",
  "bom_spk_ovr",
  "final_price",
]);

export async function GET(req: Request) {
  const { url, key } = sbEnv();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured" }, { status: 500, headers: CORS });

  try {
    const r = await fetch(
      `${url}/rest/v1/costing_overrides?select=key,data,updated_at,updated_by&limit=100`,
      { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" }, cache: "no-store" }
    );
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      // 404 before Satvik runs the migration — surface a clear message
      // instead of a mystery 500 so the frontend can keep working off
      // localStorage until the table exists.
      if (r.status === 404 || /relation .* does not exist/i.test(t)) {
        return NextResponse.json({
          ok: false,
          error: "costing_overrides table not found — run pact-worker/costing-overrides-setup.sql in Supabase first",
          overrides: {},
          updated_at: {},
        }, { status: 200, headers: CORS });
      }
      return NextResponse.json({ ok: false, error: `Supabase ${r.status}: ${t.slice(0, 200)}` }, { status: 500, headers: CORS });
    }
    const rows = (await r.json()) as Array<{ key: string; data: Record<string, unknown>; updated_at: string; updated_by: string | null }>;
    const overrides: Record<string, Record<string, unknown>> = {};
    const updatedAt: Record<string, string> = {};
    const updatedBy: Record<string, string | null> = {};
    for (const row of rows) {
      if (!ALLOWED_KEYS.has(row.key)) continue;
      overrides[row.key]  = row.data || {};
      updatedAt[row.key]  = row.updated_at;
      updatedBy[row.key]  = row.updated_by;
    }
    return NextResponse.json({ ok: true, overrides, updated_at: updatedAt, updated_by: updatedBy }, { headers: CORS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: CORS });
  }
}

export async function PATCH(req: Request) {
  const { url, key } = sbEnv();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured" }, { status: 500, headers: CORS });

  type Body = { key?: unknown; data?: unknown; updated_by?: unknown };
  let body: Body;
  try { body = (await req.json()) as Body; }
  catch { return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400, headers: CORS }); }

  const nsKey = typeof body.key === "string" ? body.key.trim() : "";
  if (!nsKey || !ALLOWED_KEYS.has(nsKey)) {
    return NextResponse.json({ ok: false, error: `key must be one of: ${[...ALLOWED_KEYS].join(", ")}` }, { status: 400, headers: CORS });
  }
  if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) {
    return NextResponse.json({ ok: false, error: "data must be a JSON object" }, { status: 400, headers: CORS });
  }
  const data = body.data as Record<string, unknown>;
  const updatedBy = typeof body.updated_by === "string" ? body.updated_by.slice(0, 120) : null;

  // Guard against runaway payloads — the dashboard's maps are keyed by
  // short BOM/RM codes, so even 1000 entries is well under 50 KB.
  const estSize = JSON.stringify(data).length;
  if (estSize > 500_000) {
    return NextResponse.json({ ok: false, error: `data too large (${estSize} bytes; max 500000)` }, { status: 413, headers: CORS });
  }

  try {
    const r = await fetch(
      `${url}/rest/v1/costing_overrides?on_conflict=key`,
      {
        method: "POST",
        headers: {
          apikey: key, Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=representation",
        },
        body: JSON.stringify({ key: nsKey, data, updated_at: new Date().toISOString(), updated_by: updatedBy }),
        cache: "no-store",
      }
    );
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `Supabase ${r.status}: ${t.slice(0, 200)}` }, { status: 500, headers: CORS });
    }
    const rows = (await r.json()) as Array<{ key: string; data: Record<string, unknown>; updated_at: string }>;
    const row = rows[0];
    return NextResponse.json({ ok: true, key: nsKey, updated_at: row ? row.updated_at : null, entries: Object.keys(data).length }, { headers: CORS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: CORS });
  }
}
