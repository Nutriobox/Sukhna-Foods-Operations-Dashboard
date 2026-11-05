import { NextResponse } from "next/server";
import { requireAdmin, gateDenied } from "@/lib/dashboard-auth";

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
  { const _g = await requireAdmin(req); if (!_g.ok) return gateDenied(_g); }
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

/**
 * DELETE /api/opening-inventory?id=<uuid>[&preview=1]
 *
 * Deleting an admin Opening Inventory count also deletes everything that was
 * built on it for that outlet — the opening's PERIOD runs from its dt_iso up
 * to the outlet's next admin opening (or open-ended if it is the latest):
 *   - Ideal Inventory snapshots (IOs) tied to this opening (opening_count.id),
 *     or — for legacy snapshots saved without that link — whose window starts
 *     inside the period; plus their pending wastage-approval OTPs
 *   - Wastage submissions (outlet_wastage_counts) dated inside the period
 *   - On-hand submissions (portal rows in opening_inventory_counts) tagged to
 *     a deleted IO, or untagged and dated inside the period
 * Approved variance/wastage lives inside the snapshot rows, so it goes too.
 *
 * preview=1 returns the counts that WOULD be deleted without touching data,
 * so the UI can show the operator exactly what goes before confirming.
 * Deleting a portal on-hand row directly removes just that row.
 */
type CountRow = { id: string; outlet: string; dt_iso: string | null; created_by: string | null; snapshot_id?: string | null };
type SnapRow  = { id: string; window_from: string | null; opening_count: { id?: string } | null };
type WasteRow = { id: string; dt_iso: string | null };

export async function DELETE(req: Request) {
  { const _g = await requireAdmin(req); if (!_g.ok) return gateDenied(_g); }
  const { url, key } = sbEnv();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured." }, { status: 500, headers: CORS });
  const sp = new URL(req.url).searchParams;
  const id = sp.get("id");
  const preview = sp.get("preview") === "1";
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400, headers: CORS });

  const rh = { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" };
  // Paged read: PostgREST caps a response at 1000 rows by default. A truncated
  // read here could miss the outlet's next opening and widen the period, so
  // every cascade read pages through to the end (stable order by id).
  const get = async <T,>(path: string): Promise<T[]> => {
    const PAGE = 1000;
    const out: T[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const sep = path.includes("?") ? "&" : "?";
      const r = await fetch(`${url}/rest/v1/${path}${sep}order=id.asc&limit=${PAGE}&offset=${offset}`, { headers: rh, cache: "no-store" });
      if (!r.ok) throw new Error(`Supabase read ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
      const rows = (await r.json()) as T[];
      out.push(...rows);
      if (rows.length < PAGE) return out;
      if (offset > 200_000) throw new Error("cascade read too large; aborting before deleting anything");
    }
  };
  const del = async (table: string, filter: string) => {
    const r = await fetch(`${url}/rest/v1/${table}?${filter}`, {
      method: "DELETE",
      headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "return=minimal" },
      cache: "no-store",
    });
    if (!r.ok && r.status !== 204) throw new Error(`Supabase delete ${table} ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  };
  const inList = (ids: string[]) => `in.(${ids.map(encodeURIComponent).join(",")})`;
  const isPortal = (c: { created_by: string | null }) => typeof c.created_by === "string" && c.created_by.startsWith("portal:");
  const m16 = (s: string | null | undefined) => String(s || "").slice(0, 16);

  try {
    const target = (await get<CountRow>(`opening_inventory_counts?id=eq.${encodeURIComponent(id)}&select=id,outlet,dt_iso,created_by`))[0];
    if (!target) return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: CORS });

    let snapIds: string[] = [], wasteIds: string[] = [], onhandIds: string[] = [];
    let periodFrom = m16(target.dt_iso), periodTo: string | null = null;

    if (!isPortal(target) && periodFrom) {
      const outletQ = `outlet=eq.${encodeURIComponent(target.outlet)}`;
      const counts = await get<CountRow>(`opening_inventory_counts?${outletQ}&select=id,dt_iso,created_by,snapshot_id`);
      const next = counts
        .filter((c) => c.id !== id && !isPortal(c) && m16(c.dt_iso) > periodFrom)
        .map((c) => m16(c.dt_iso)).sort()[0];
      periodTo = next || null;
      const inPeriod = (d: string | null) => { const x = m16(d); return !!x && x >= periodFrom && (periodTo == null || x < periodTo); };

      const snaps = await get<SnapRow>(`ideal_inventory_snapshots?${outletQ}&select=id,window_from,opening_count`);
      snapIds = snaps.filter((s) => {
        const linked = s.opening_count && typeof s.opening_count === "object" ? s.opening_count.id : undefined;
        // A snapshot linked to this opening still has to sit before the next
        // opening — guards an IO that was linked to an older opening but whose
        // window actually belongs to a later period.
        if (linked) return linked === id && (periodTo == null || !m16(s.window_from) || m16(s.window_from) < periodTo);
        return inPeriod(s.window_from);
      }).map((s) => s.id);
      const snapSet = new Set(snapIds);

      const waste = await get<WasteRow>(`outlet_wastage_counts?${outletQ}&select=id,dt_iso`);
      wasteIds = waste.filter((w) => inPeriod(w.dt_iso)).map((w) => w.id);

      onhandIds = counts
        .filter((c) => isPortal(c) && (c.snapshot_id ? snapSet.has(c.snapshot_id) : inPeriod(c.dt_iso)))
        .map((c) => c.id);
    }

    const cascade = { snapshots: snapIds.length, wastage: wasteIds.length, onhand: onhandIds.length };
    const period = { from: periodFrom, to: periodTo };
    if (preview) {
      return NextResponse.json({ ok: true, preview: true, outlet: target.outlet, dt_iso: target.dt_iso, portal: isPortal(target), period, cascade }, { headers: CORS });
    }

    // Children first, so a mid-way failure never leaves an IO pointing at a
    // deleted opening with its submissions still attached.
    if (snapIds.length)   await del("wastage_approval_otps", `snapshot_id=${inList(snapIds)}`).catch(() => undefined);
    if (wasteIds.length)  await del("outlet_wastage_counts", `id=${inList(wasteIds)}`);
    if (onhandIds.length) await del("opening_inventory_counts", `id=${inList(onhandIds)}`);
    if (snapIds.length)   await del("ideal_inventory_snapshots", `id=${inList(snapIds)}`);
    await del("opening_inventory_counts", `id=eq.${encodeURIComponent(id)}`);

    return NextResponse.json({ ok: true, deleted: id, outlet: target.outlet, period, cascade }, { headers: CORS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: CORS });
  }
}
