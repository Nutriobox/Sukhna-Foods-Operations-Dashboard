import { NextResponse } from "next/server";

/**
 * Ideal Inventory snapshots — persistent per-outlet saves of the Ideal
 * Inventory tab's full computed table.
 *
 *   GET /api/ideal-inventory
 *     -> { ok, snapshots: [{ id, outlet, order_number, window_from, window_to,
 *                            total_items, opening_count, created_at, updated_at }] }
 *     Lists every saved snapshot (latest created_at first) WITHOUT the items array.
 *
 *   GET /api/ideal-inventory?id=<uuid>
 *     -> { ok, snapshot: { ...full record including items[] } }
 *
 *   GET /api/ideal-inventory?outlet=<name>
 *     -> same list shape, filtered to that outlet
 *
 *   POST /api/ideal-inventory
 *     body: { outlet, window_from, window_to, total_items, opening_count, items[], created_by? }
 *     -> { ok, id, order_number, created_at }
 *     order_number is per-outlet auto-increment, assigned server-side.
 *
 *   DELETE /api/ideal-inventory?id=<uuid>
 *     -> { ok, deleted: id }
 *
 * See pact-worker/ideal-inventory-setup.sql for the table migration.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
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
  const id     = sp.get("id");
  const outlet = sp.get("outlet");
  const h = { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" };

  try {
    if (id) {
      const r = await fetch(`${url}/rest/v1/ideal_inventory_snapshots?id=eq.${encodeURIComponent(id)}&select=*`, { headers: h, cache: "no-store" });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        return NextResponse.json({ ok: false, error: `Supabase ${r.status}: ${t.slice(0, 200)}` }, { status: 500, headers: CORS });
      }
      const rows = (await r.json()) as unknown[];
      if (!rows.length) return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: CORS });
      return NextResponse.json({ ok: true, snapshot: rows[0] }, { headers: CORS });
    }

    // List view omits items[] (potentially large) so the list query stays small.
    const outletFilter = outlet ? `&outlet=eq.${encodeURIComponent(outlet)}` : "";
    const r = await fetch(
      `${url}/rest/v1/ideal_inventory_snapshots?select=id,outlet,order_number,window_from,window_to,total_items,opening_count,created_by,created_at,updated_at&order=created_at.desc${outletFilter}`,
      { headers: h, cache: "no-store" }
    );
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `Supabase ${r.status}: ${t.slice(0, 200)}` }, { status: 500, headers: CORS });
    }
    const snapshots = (await r.json()) as unknown[];
    return NextResponse.json({ ok: true, snapshots }, { headers: CORS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: CORS });
  }
}

type SnapshotItem = {
  rm_code: string; name: string; category: string;
  l1_unit: string; l2_unit?: string; l3_unit?: string;
  packing_uom?: string; packScale?: number; caseScale?: number;
  opening_l1: number; purchase_l1: number; consumption_l1: number;
  variance_l1: number; closing_l1: number;
  full_qty: number | null; full_unit: string;
  loose_qty: number | null; loose_unit: string;
};

function sanitiseItem(raw: unknown): SnapshotItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const n = (v: unknown, d = 0): number => {
    const x = Number(v);
    return Number.isFinite(x) ? x : d;
  };
  const nn = (v: unknown): number | null => {
    if (v == null || v === "") return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };
  const s = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
  const code = s(r.rm_code).trim();
  if (!code) return null;
  return {
    rm_code:        code,
    name:           s(r.name).slice(0, 240),
    category:       s(r.category).slice(0, 60),
    l1_unit:        s(r.l1_unit).slice(0, 24),
    l2_unit:        s(r.l2_unit).slice(0, 24),
    l3_unit:        s(r.l3_unit).slice(0, 24),
    packing_uom:    s(r.packing_uom).slice(0, 24),
    packScale:      n(r.packScale),
    caseScale:      n(r.caseScale),
    opening_l1:     n(r.opening_l1),
    purchase_l1:    n(r.purchase_l1),
    consumption_l1: n(r.consumption_l1),
    variance_l1:    n(r.variance_l1),
    closing_l1:     n(r.closing_l1),
    full_qty:       nn(r.full_qty),
    full_unit:      s(r.full_unit).slice(0, 24),
    loose_qty:      nn(r.loose_qty),
    loose_unit:     s(r.loose_unit).slice(0, 24),
  };
}

export async function POST(req: Request) {
  const { url, key } = sbEnv();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured." }, { status: 500, headers: CORS });

  let body: {
    outlet?: unknown; window_from?: unknown; window_to?: unknown;
    total_items?: unknown; opening_count?: unknown; items?: unknown;
    created_by?: unknown;
  };
  try { body = await req.json(); }
  catch { return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400, headers: CORS }); }

  const outlet = typeof body.outlet === "string" ? body.outlet.trim() : "";
  const window_from = typeof body.window_from === "string" ? body.window_from.trim() : "";
  const window_to   = typeof body.window_to   === "string" ? body.window_to.trim()   : "";
  if (!outlet)      return NextResponse.json({ ok: false, error: "outlet required" }, { status: 400, headers: CORS });
  if (!window_from) return NextResponse.json({ ok: false, error: "window_from required" }, { status: 400, headers: CORS });
  if (!window_to)   return NextResponse.json({ ok: false, error: "window_to required" }, { status: 400, headers: CORS });

  const rawItems: unknown[] = Array.isArray(body.items) ? body.items : [];
  const items: SnapshotItem[] = [];
  for (const raw of rawItems) {
    const it = sanitiseItem(raw);
    if (it) items.push(it);
  }
  const total_items = items.length;
  const opening_count = body.opening_count && typeof body.opening_count === "object" ? body.opening_count : null;
  const created_by = typeof body.created_by === "string" ? body.created_by.slice(0, 120) : null;

  const h = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

  try {
    // Pick the next per-outlet order_number.
    let orderNumber = 1;
    try {
      const maxR = await fetch(
        `${url}/rest/v1/ideal_inventory_snapshots?outlet=eq.${encodeURIComponent(outlet)}&select=order_number&order=order_number.desc.nullslast&limit=1`,
        { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" }, cache: "no-store" }
      );
      if (maxR.ok) {
        const rows = (await maxR.json()) as Array<{ order_number: number | null }>;
        const prev = rows[0] && rows[0].order_number != null ? Number(rows[0].order_number) : 0;
        if (Number.isFinite(prev) && prev > 0) orderNumber = prev + 1;
      }
    } catch { /* fall back to 1 */ }

    const payload = {
      outlet,
      order_number: orderNumber,
      window_from,
      window_to,
      total_items,
      opening_count,
      items,
      created_by,
      updated_at: new Date().toISOString(),
    };
    const r = await fetch(`${url}/rest/v1/ideal_inventory_snapshots`, {
      method: "POST",
      headers: { ...h, Prefer: "return=representation" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `Supabase ${r.status}: ${t.slice(0, 300)}` }, { status: 500, headers: CORS });
    }
    const rows = (await r.json()) as Array<{ id: string; order_number: number; created_at: string }>;
    const row = rows[0];
    return NextResponse.json({
      ok: true,
      id: row?.id,
      order_number: row?.order_number ?? orderNumber,
      created_at: row?.created_at ?? payload.updated_at,
      total_items,
    }, { headers: CORS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: CORS });
  }
}

/**
 * PATCH /api/ideal-inventory?id=<uuid>
 *   body: { action: "approve", approved_by?: string }  -> stamp approved_at
 *   body: { action: "unapprove" }                       -> clear approved_at
 * Email-OTP integration is a follow-up — for now the Variance tab gates
 * this behind the same shared password it uses for Save/Delete. Keeping
 * approved_at + approved_by on the snapshot row means approvals survive
 * dashboard restarts and show up on the Variance tab's Status column.
 */
export async function PATCH(req: Request) {
  const { url, key } = sbEnv();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured." }, { status: 500, headers: CORS });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400, headers: CORS });

  let body: { action?: unknown; approved_by?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400, headers: CORS }); }

  const action = typeof body.action === "string" ? body.action.trim() : "";
  const approvedBy = typeof body.approved_by === "string" ? body.approved_by.slice(0, 120) : null;

  const patch: Record<string, string | null> = { updated_at: new Date().toISOString() };
  if (action === "approve")        { patch.approved_at = new Date().toISOString(); patch.approved_by = approvedBy; }
  else if (action === "unapprove") { patch.approved_at = null;                     patch.approved_by = null; }
  else return NextResponse.json({ ok: false, error: "action must be 'approve' or 'unapprove'" }, { status: 400, headers: CORS });

  try {
    const r = await fetch(
      `${url}/rest/v1/ideal_inventory_snapshots?id=eq.${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: {
          apikey: key, Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify(patch),
        cache: "no-store",
      }
    );
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `Supabase ${r.status}: ${t.slice(0, 200)}` }, { status: 500, headers: CORS });
    }
    const rows = (await r.json()) as Array<{ id: string; approved_at: string | null; approved_by: string | null }>;
    const row = rows[0];
    if (!row) return NextResponse.json({ ok: false, error: "snapshot not found" }, { status: 404, headers: CORS });
    return NextResponse.json({ ok: true, id: row.id, approved_at: row.approved_at, approved_by: row.approved_by }, { headers: CORS });
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
      `${url}/rest/v1/ideal_inventory_snapshots?id=eq.${encodeURIComponent(id)}`,
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
