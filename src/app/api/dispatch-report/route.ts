// FILE: src/app/api/dispatch-report/route.ts
import { NextResponse } from "next/server";

/**
 * Unified Dispatch Report — every dispatch the dashboard holds, across the three
 * sources, in one list:
 *   - B2B  : detail_fsi_snapshot      (PACT "Detail Factory Sales Invoices")
 *   - NB   : outlet_dispatch_snapshot (PACT outlet Stock-Outward invoices)
 *   - Scan : inventory_orders         (gun scan-to-dispatch orders)
 *
 * GET /api/dispatch-report
 *   -> { ok, synced:{b2b,nb}, counts:{b2b,nb,scan,total}, rows:[
 *          { date, type, doc, party, items, status, source } ] }
 *
 * Server env: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_KEY
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS" };
export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

const SB_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

type Row = { date: string; type: string; doc: string; party: string; items: number; status: string; source: string };

const idx = (cols: string[], name: string) => cols.findIndex((c) => String(c || "").trim().toLowerCase() === name.toLowerCase());
const num = (v: unknown) => { const n = Number(String(v ?? "").replace(/,/g, "")); return isFinite(n) ? n : 0; };
const dateOnly = (v: unknown) => { const s = String(v ?? "").trim(); return s ? s.slice(0, 10) : ""; };

async function sb(path: string) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY as string, Authorization: `Bearer ${SB_KEY}` }, cache: "no-store",
  });
  if (!r.ok) throw new Error(`Supabase ${r.status} ${(await r.text().catch(() => "")).slice(0, 160)}`);
  return r.json();
}

// detail_fsi_snapshot & outlet_dispatch_snapshot share the same shape:
// columns = ["Doc No","Account Name","Doc Date","Items"], rows = [[...], ...]
function mapSnapshot(snap: Record<string, unknown> | null, type: string, source: string): Row[] {
  if (!snap) return [];
  const cols = (Array.isArray(snap.columns) ? snap.columns : []) as string[];
  const rows = (Array.isArray(snap.rows) ? snap.rows : []) as unknown[][];
  const iDoc = idx(cols, "Doc No"), iAcc = idx(cols, "Account Name"), iDate = idx(cols, "Doc Date"), iItems = idx(cols, "Items");
  return rows.map((r) => ({
    date: iDate >= 0 ? dateOnly(r[iDate]) : "",
    type,
    doc: iDoc >= 0 ? String(r[iDoc] ?? "") : "",
    party: iAcc >= 0 ? String(r[iAcc] ?? "") : "",
    items: iItems >= 0 ? num(r[iItems]) : 0,
    status: "Posted",
    source,
  }));
}

export async function GET() {
  if (!SB_URL || !SB_KEY) return NextResponse.json({ ok: false, error: "Supabase not configured." }, { status: 500, headers: CORS });
  try {
    const [b2bArr, nbArr, scans] = await Promise.all([
      sb("detail_fsi_snapshot?id=eq.1&select=*").catch(() => []),
      sb("outlet_dispatch_snapshot?id=eq.1&select=*").catch(() => []),
      sb("inventory_orders?select=order_no,item_count,status,created_at&order=created_at.desc").catch(() => []),
    ]);
    const b2bSnap = (Array.isArray(b2bArr) && b2bArr[0]) || null;
    const nbSnap = (Array.isArray(nbArr) && nbArr[0]) || null;

    const b2bRows = mapSnapshot(b2bSnap, "B2B", "detail_fsi_snapshot");
    const nbRows = mapSnapshot(nbSnap, "Outlet (NB)", "outlet_dispatch_snapshot");
    const scanRows: Row[] = (Array.isArray(scans) ? scans : []).map((o: Record<string, unknown>) => ({
      date: dateOnly(o.created_at),
      type: "Scan",
      doc: String(o.order_no ?? ""),
      party: "",
      items: num(o.item_count),
      status: String(o.status ?? ""),
      source: "inventory_orders",
    }));

    const rows = [...b2bRows, ...nbRows, ...scanRows].sort((a, b) => (b.date || "").localeCompare(a.date || ""));

    return NextResponse.json({
      ok: true,
      synced: { b2b: (b2bSnap as Record<string, unknown> | null)?.synced_at ?? null, nb: (nbSnap as Record<string, unknown> | null)?.synced_at ?? null },
      counts: { b2b: b2bRows.length, nb: nbRows.length, scan: scanRows.length, total: rows.length },
      rows,
    }, { headers: CORS });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500, headers: CORS });
  }
}
