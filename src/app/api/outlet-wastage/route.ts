import { NextResponse } from "next/server";

/**
 * Outlet wastage counts — read endpoint for the main dashboard.
 *
 *   GET  /api/outlet-wastage
 *     -> { ok, counts: [{ id, outlet, dt_iso, filled_count, total_items,
 *                         created_by, created_at, updated_at }] }
 *     Lists every saved wastage count (latest updated_at first) WITHOUT the
 *     qty maps so the list stays small.
 *
 *   GET  /api/outlet-wastage?id=<uuid>
 *     -> { ok, count: { ...full record incl qty + qty_loose } }
 *
 *   GET  /api/outlet-wastage?outlet=<name>
 *     -> same list shape, filtered to that outlet
 *
 *   DELETE /api/outlet-wastage?id=<uuid>
 *     -> { ok, deleted: id }
 *
 * See pact-worker/outlet-wastage-setup.sql for the table migration.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

function sbEnv() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return { url, key: key as string | undefined };
}

export async function GET(req: Request) {
  const { url, key } = sbEnv();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured" }, { status: 500, headers: CORS });

  const u = new URL(req.url);
  const id     = u.searchParams.get("id");
  const outlet = u.searchParams.get("outlet");

  if (id) {
    const r = await fetch(
      `${url}/rest/v1/outlet_wastage_counts?select=*&id=eq.${encodeURIComponent(id)}`,
      { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" }, cache: "no-store" }
    );
    if (!r.ok) return NextResponse.json({ ok: false, error: `Lookup failed: ${r.status}` }, { status: 502, headers: CORS });
    const rows = (await r.json()) as Array<Record<string, unknown>>;
    const row = rows[0];
    if (!row) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404, headers: CORS });
    return NextResponse.json({ ok: true, count: row }, { headers: CORS });
  }

  let q = `${url}/rest/v1/outlet_wastage_counts?select=id,outlet,dt_iso,filled_count,total_items,created_by,created_at,updated_at&order=updated_at.desc&limit=500`;
  if (outlet) q += `&outlet=eq.${encodeURIComponent(outlet)}`;
  const r = await fetch(q, { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" }, cache: "no-store" });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    return NextResponse.json({ ok: false, error: `List failed: ${r.status} ${t}`.slice(0, 200) }, { status: 502, headers: CORS });
  }
  const counts = await r.json();
  return NextResponse.json({ ok: true, counts }, { headers: CORS });
}

export async function DELETE(req: Request) {
  const { url, key } = sbEnv();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured" }, { status: 500, headers: CORS });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ ok: false, error: "id is required" }, { status: 400, headers: CORS });
  const r = await fetch(
    `${url}/rest/v1/outlet_wastage_counts?id=eq.${encodeURIComponent(id)}`,
    { method: "DELETE", headers: { apikey: key, Authorization: `Bearer ${key}` } }
  );
  if (!r.ok) return NextResponse.json({ ok: false, error: `Delete failed: ${r.status}` }, { status: 502, headers: CORS });
  return NextResponse.json({ ok: true, deleted: id }, { headers: CORS });
}
