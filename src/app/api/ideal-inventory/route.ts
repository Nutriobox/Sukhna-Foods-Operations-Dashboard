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
  wastage_l1: number; variance_l1: number; closing_l1: number;
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
    wastage_l1:     n(r.wastage_l1),       // 2026-10-24: measured wastage from each outlet's Submit-Wastage submissions
    variance_l1:    n(r.variance_l1),      // residual after wastage ("Adjusted Variance" in the UI)
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

    // 2026-10-30 (Satvik's #4): stamp the outlet's 2-hour submission
    // window at save time. The outlet-portal submit-on-hand / submit-
    // wastage routes gate on submission_window_closes_at > now(), so
    // this snapshot "opens" the portal for exactly 2 hours. Admin can
    // extend by saving a new snapshot; nothing in the UI lets the
    // outlet keep writing after the window closes.
    const nowIso = new Date().toISOString();
    const closesIso = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

    const payload = {
      outlet,
      order_number: orderNumber,
      window_from,
      window_to,
      total_items,
      opening_count,
      items,
      created_by,
      updated_at: nowIso,
      submission_window_opens_at:  nowIso,
      submission_window_closes_at: closesIso,
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
 *   body: { action: "approve",   approved_by?: string, item_updates?: {...} } -> stamp approved_at + merge updates
 *   body: { action: "unapprove"                                            } -> clear approved_at
 *
 * item_updates (optional, only honoured when action === "approve") lets the
 * client write per-RM wastage_l1 and adjusted_variance_l1 into the snapshot
 * atomically with the approval stamp. Shape:
 *   { "<rm_code>": { wastage_l1?: number, adjusted_variance_l1?: number }, ... }
 * The server fetches the snapshot's items array, overlays the two fields on
 * the matching rm_code rows (leaving every other item field intact), writes
 * the merged items array back, and stamps approved_at + approved_by in the
 * same PATCH call. RMs the map doesn't name are untouched.
 *
 * The complex packing_uom / loose-denomination math lives in the browser
 * (iiOpeningToL1 depends on ldLevelsFor which only loads on the client), so
 * the client is the single source of truth for the L1 figures; the server's
 * job here is just to persist what the client decided.
 *
 * Email-OTP integration is still a follow-up — for now the Variance tab
 * gates this behind the shared password used for Save/Delete.
 */
export async function PATCH(req: Request) {
  const { url, key } = sbEnv();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured." }, { status: 500, headers: CORS });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400, headers: CORS });

  type ItemUpdate  = { wastage_l1?: number; adjusted_variance_l1?: number };
  type SnapItem    = { rm_code?: string; wastage_l1?: number; adjusted_variance_l1?: number; [k: string]: unknown };
  type PatchBody   = { action?: unknown; approved_by?: unknown; item_updates?: Record<string, ItemUpdate> };

  let body: PatchBody;
  try { body = (await req.json()) as PatchBody; }
  catch { return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400, headers: CORS }); }

  const action = typeof body.action === "string" ? body.action.trim() : "";
  const approvedBy = typeof body.approved_by === "string" ? body.approved_by.slice(0, 120) : null;
  const itemUpdates: Record<string, ItemUpdate> = (action === "approve" && body.item_updates && typeof body.item_updates === "object")
    ? body.item_updates : {};
  const hasItemUpdates = Object.keys(itemUpdates).length > 0;

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (action === "approve")        { patch.approved_at = new Date().toISOString(); patch.approved_by = approvedBy; }
  else if (action === "unapprove") { patch.approved_at = null;                     patch.approved_by = null; }
  else return NextResponse.json({ ok: false, error: "action must be 'approve' or 'unapprove'" }, { status: 400, headers: CORS });

  try {
    // Fold item_updates into the snapshot's items array before PATCHing.
    // Done as a GET → merge → PATCH round-trip. Supabase's PostgREST
    // doesn't support partial jsonb-array edits per element, so we
    // overwrite the full items[] with the merged version. The window
    // between read and write is a few hundred ms — safe for an
    // admin-only approval flow where concurrent writes aren't expected.
    if (hasItemUpdates) {
      const gr = await fetch(
        `${url}/rest/v1/ideal_inventory_snapshots?select=items&id=eq.${encodeURIComponent(id)}`,
        { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" }, cache: "no-store" }
      );
      if (!gr.ok) {
        const t = await gr.text().catch(() => "");
        return NextResponse.json({ ok: false, error: `Supabase read ${gr.status}: ${t.slice(0, 200)}` }, { status: 500, headers: CORS });
      }
      const gRows = (await gr.json()) as Array<{ items: SnapItem[] | null }>;
      if (!gRows[0]) return NextResponse.json({ ok: false, error: "snapshot not found" }, { status: 404, headers: CORS });
      const items = Array.isArray(gRows[0].items) ? gRows[0].items : [];
      let touched = 0;
      const merged = items.map((it) => {
        const code = typeof it.rm_code === "string" ? it.rm_code : "";
        const upd = itemUpdates[code];
        if (!upd) return it;
        touched++;
        const next: SnapItem = { ...it };
        if (typeof upd.wastage_l1          === "number" && isFinite(upd.wastage_l1))          next.wastage_l1          = Number(upd.wastage_l1.toFixed(4));
        if (typeof upd.adjusted_variance_l1 === "number" && isFinite(upd.adjusted_variance_l1)) next.adjusted_variance_l1 = Number(upd.adjusted_variance_l1.toFixed(4));
        return next;
      });
      patch.items = merged;
      // Guard against malformed updates referencing RMs that aren't in
      // this snapshot — surface a warning header rather than failing the
      // whole approval, since the approval stamp itself is still correct.
      if (touched === 0) {
        return NextResponse.json({ ok: false, error: "item_updates referenced no rm_code present in this snapshot" }, { status: 400, headers: CORS });
      }
    }

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
    return NextResponse.json({
      ok: true,
      id: row.id,
      approved_at: row.approved_at,
      approved_by: row.approved_by,
      items_updated: hasItemUpdates ? Object.keys(itemUpdates).length : 0,
    }, { headers: CORS });
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
