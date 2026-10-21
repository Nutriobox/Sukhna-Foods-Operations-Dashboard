import { NextResponse } from "next/server";

/**
 * Opening Inventory counts — persistent, cross-device.
 *
 *   GET  /api/opening-inventory
 *     -> { ok, counts: [{ id, outlet, dt_iso, filled_count, total_items,
 *                         created_by, created_at, updated_at }] }
 *     Lists every saved count (latest updated_at first) WITHOUT the qty maps,
 *     so the OI form-view list stays small even with hundreds of counts.
 *
 *   GET  /api/opening-inventory?id=<uuid>
 *     -> { ok, count: { ...full record incl qty + qty_loose } }
 *
 *   POST /api/opening-inventory
 *     body: { outlet, dt_iso, qty, qty_loose, total_items, created_by? }
 *     Upserts on (outlet, dt_iso): a re-save at the same datetime for the
 *     same outlet overwrites; a different datetime creates a new row.
 *     -> { ok, id, filled_count, total_items, updated_at }
 *
 *   DELETE /api/opening-inventory?id=<uuid>
 *     -> { ok, deleted: id }
 *
 * See pact-worker/opening-inventory-setup.sql for the table migration.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

function sbEnv() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return { url, key: key as string | undefined };
}

export async function GET(req: Request) {
  const { url, key } = sbEnv();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured." }, { status: 500, headers: CORS });
  const sp = new URL(req.url).searchParams;
  const id = sp.get("id");
  const outlet = sp.get("outlet");
  const h = { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" };

  try {
    if (id) {
      const r = await fetch(`${url}/rest/v1/opening_inventory_counts?id=eq.${encodeURIComponent(id)}&select=*`, { headers: h, cache: "no-store" });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        return NextResponse.json({ ok: false, error: `Supabase ${r.status}: ${t.slice(0, 200)}` }, { status: 500, headers: CORS });
      }
      const rows = (await r.json()) as unknown[];
      if (!rows.length) return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: CORS });
      return NextResponse.json({ ok: true, count: rows[0] }, { headers: CORS });
    }

    // Latest-updated first; omit qty / qty_loose for list payload.
    const outletFilter = outlet ? `&outlet=eq.${encodeURIComponent(outlet)}` : "";
    const r = await fetch(
      `${url}/rest/v1/opening_inventory_counts?select=id,outlet,dt_iso,filled_count,total_items,created_by,created_at,updated_at&order=updated_at.desc${outletFilter}`,
      { headers: h, cache: "no-store" }
    );
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `Supabase ${r.status}: ${t.slice(0, 200)}` }, { status: 500, headers: CORS });
    }
    const counts = (await r.json()) as unknown[];
    return NextResponse.json({ ok: true, counts }, { headers: CORS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: CORS });
  }
}

type NumMap = Record<string, number>;
function sanitiseQtyMap(obj: unknown): NumMap {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out: NumMap = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) continue;
    if (!k || typeof k !== "string" || k.length > 64) continue;
    out[k] = n;
  }
  return out;
}

export async function POST(req: Request) {
  const { url, key } = sbEnv();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured." }, { status: 500, headers: CORS });
  let body: {
    outlet?: unknown; dt_iso?: unknown; qty?: unknown; qty_loose?: unknown;
    total_items?: unknown; created_by?: unknown;
  };
  try { body = await req.json(); }
  catch { return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400, headers: CORS }); }

  const outlet = typeof body.outlet === "string" ? body.outlet.trim() : "";
  const dt_iso = typeof body.dt_iso === "string" ? body.dt_iso.trim() : "";
  if (!outlet)  return NextResponse.json({ ok: false, error: "outlet required" }, { status: 400, headers: CORS });
  if (!dt_iso)  return NextResponse.json({ ok: false, error: "dt_iso required (YYYY-MM-DDTHH:mm from datetime-local)" }, { status: 400, headers: CORS });

  const qty = sanitiseQtyMap(body.qty);
  const qty_loose = sanitiseQtyMap(body.qty_loose);
  const filled_count = new Set([...Object.keys(qty), ...Object.keys(qty_loose)]).size;
  const total_items = Number(body.total_items) > 0 ? Math.floor(Number(body.total_items)) : 0;
  const created_by = typeof body.created_by === "string" ? body.created_by.slice(0, 120) : null;

  const payload = {
    outlet, dt_iso, qty, qty_loose,
    filled_count, total_items, created_by,
    updated_at: new Date().toISOString(),
  };

  try {
    // Upsert on (outlet, dt_iso). PostgREST uses the ?on_conflict parameter and the merge-duplicates
    // Prefer header. created_at stays as the original row's value on conflict (DB default).
    const r = await fetch(
      `${url}/rest/v1/opening_inventory_counts?on_conflict=outlet,dt_iso`,
      {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=representation",
        },
        body: JSON.stringify(payload),
        cache: "no-store",
      }
    );
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `Supabase ${r.status}: ${t.slice(0, 200)}` }, { status: 500, headers: CORS });
    }
    const rows = (await r.json()) as Array<{ id: string; filled_count: number; total_items: number; updated_at: string }>;
    const row = rows[0];
    return NextResponse.json({ ok: true, id: row?.id, filled_count: row?.filled_count ?? filled_count, total_items: row?.total_items ?? total_items, updated_at: row?.updated_at ?? payload.updated_at }, { headers: CORS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: CORS });
  }
}

export async function DELETE(req: Request) {
  const { url, key } = sbEnv();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured." }, { status: 500, headers: CORS });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400, headers: CORS });

  try {
    const r = await fetch(
      `${url}/rest/v1/opening_inventory_counts?id=eq.${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "return=minimal" },
        cache: "no-store",
      }
    );
    if (!r.ok && r.status !== 204) {
      const t = await r.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `Supabase ${r.status}: ${t.slice(0, 200)}` }, { status: 500, headers: CORS });
    }
    return NextResponse.json({ ok: true, deleted: id }, { headers: CORS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: CORS });
  }
}
