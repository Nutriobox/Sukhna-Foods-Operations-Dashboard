import { NextResponse } from "next/server";

/**
 * Stock Reconciliation — for a chosen day, compare the physical count captured
 * by the scanner (inventory_orders) against the system stock, and produce the
 * variance that feeds PACT's Scrap and Excess-Stock imports.
 *
 *   GET /api/stock-reconciliation?date=YYYY-MM-DD[&status=done]
 *
 * Variance is taken "from the count itself":
 *   system  = scan item `required`  (base gms)
 *   actual  = scan item `scanned`   (base gms)
 *   required > scanned  -> SCRAP   (shortage = required - scanned)
 *   scanned  > required -> EXCESS  (surplus  = scanned - required)
 *
 * Warehouse + batch detail come from the latest PACT "BatchWise Stock Analysis"
 * snapshot (public.inventory_snapshots, status=ok), the same source the scanner
 * screen already uses.
 *
 * Server env: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_KEY.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS" };
export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

const SB_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const IST = "+05:30"; // orders are named / counted in India time

async function sb(path: string) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY as string, Authorization: `Bearer ${SB_KEY}` }, cache: "no-store",
  });
  if (!r.ok) throw new Error(`Supabase ${r.status} ${(await r.text().catch(() => "")).slice(0, 160)}`);
  return r.json();
}

const num = (v: unknown) => { const n = Number(String(v ?? "").replace(/,/g, "")); return isFinite(n) ? n : 0; };
const pad2 = (n: number) => String(n).padStart(2, "0");

// Manufacture date from the batch-number tail (…/DDMMYYnn) -> "DD-MM-YYYY".
function mfgFromBatch(batch: string): string {
  const tail = String(batch || "").split("/").pop() || "";
  const m = /(\d{2})(\d{2})(\d{2})\d{0,2}$/.exec(tail);
  if (!m) return "";
  const dd = Number(m[1]), mm = Number(m[2]), yy = Number(m[3]);
  if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return "";
  return `${pad2(dd)}-${pad2(mm)}-${2000 + yy}`;
}
// Sort key (YYYYMMDD) from a "DD-MM-YYYY" mfg; "" sinks to the end.
const mfgKey = (d: string) => { const m = /(\d{2})-(\d{2})-(\d{4})/.exec(d || ""); return m ? Number(m[3] + m[2] + m[1]) : 99999999; };

const unitFactorToGms = (unit: string) => (/kg/i.test(unit) ? 1000 : 1);

type SnapBatch = { batch: string; warehouse: string; mfg: string; availGms: number; exp: string };
type Row = { batch: string; warehouse: string; mfg: string; qty: number };
type Item = {
  code: string; name: string; salesUnit: string; scale: number;
  system: number; actual: number; variance: number; klass: "Scrap" | "Excess" | "Match" | "Uncounted"; qty: number;
  coverage: number; warehouse: string; scrapRows: Row[]; excessRows: Row[]; flags: string[];
};
type Order = { id: string; orderNo: string; status: string; createdAt: string; items: Item[] };

// Allocate `need` gms across batches in order, capping each at its availGms when
// a cap is known (cap<=0 means "no cap" — take the remainder here).
function allocate(need: number, batches: Array<{ batch: string; warehouse: string; mfg: string; cap: number }>): Row[] {
  const out: Row[] = [];
  let left = Math.round(need);
  for (const b of batches) {
    if (left <= 0) break;
    const take = b.cap > 0 ? Math.min(left, Math.round(b.cap)) : left;
    if (take <= 0) continue;
    out.push({ batch: b.batch, warehouse: b.warehouse, mfg: b.mfg, qty: take });
    left -= take;
  }
  if (left > 0) {
    // remainder didn't fit the known batches — append it to the first batch, or a blank row
    if (out.length) out[0].qty += left;
    else out.push({ batch: "", warehouse: "", mfg: "", qty: left });
  }
  return out;
}

export async function GET(req: Request) {
  if (!SB_URL || !SB_KEY) return NextResponse.json({ ok: false, error: "Supabase not configured." }, { status: 500, headers: CORS });
  const u = new URL(req.url);
  const date = (u.searchParams.get("date") || "").slice(0, 10);
  const status = (u.searchParams.get("status") || "").trim().toLowerCase(); // "", "all" or a specific status
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ ok: false, error: "Pass ?date=YYYY-MM-DD" }, { status: 400, headers: CORS });

  // IST day window
  const next = new Date(date + "T00:00:00Z"); next.setUTCDate(next.getUTCDate() + 1);
  const nextDate = next.toISOString().slice(0, 10);
  const from = encodeURIComponent(`${date}T00:00:00${IST}`);
  const to = encodeURIComponent(`${nextDate}T00:00:00${IST}`);

  try {
    let q = `inventory_orders?select=id,order_no,status,created_at,scans&created_at=gte.${from}&created_at=lt.${to}&order=created_at.asc`;
    if (status && status !== "all") q += `&status=eq.${encodeURIComponent(status)}`;
    const [ordersRaw, snapRaw] = await Promise.all([
      sb(q).catch(() => []),
      sb("inventory_snapshots?status=eq.ok&select=synced_at,data&order=synced_at.desc&limit=1").catch(() => []),
    ]);

    // Build the batch index from the snapshot (code -> FEFO batches with warehouse/mfg/avail).
    const snap = (Array.isArray(snapRaw) && snapRaw[0]) || null;
    const snapRows = (snap && Array.isArray(snap.data) ? snap.data : []) as Array<Record<string, unknown>>;
    const idx: Record<string, SnapBatch[]> = {};
    const whByBatch: Record<string, string> = {};
    for (const r of snapRows) {
      const code = String(r.code || "").trim();
      if (!code) continue;
      const batch = String(r.batch || "").trim();
      const warehouse = String(r.warehouse || "").trim();
      const b: SnapBatch = {
        batch, warehouse,
        mfg: mfgFromBatch(batch) || String(r.mfg || ""),
        availGms: num(r.qty) * unitFactorToGms(String(r.unit || "")),
        exp: String(r.exp || ""),
      };
      (idx[code] = idx[code] || []).push(b);
      if (batch) whByBatch[`${code}|${batch}`] = warehouse;
    }
    // FEFO: earliest mfg first (proxy for first-expiry on same product).
    for (const k in idx) idx[k].sort((a, z) => mfgKey(a.mfg) - mfgKey(z.mfg));

    const orders: Order[] = (Array.isArray(ordersRaw) ? ordersRaw : []).map((o: Record<string, unknown>) => {
      const scans = (Array.isArray(o.scans) ? o.scans : []) as Array<Record<string, unknown>>;
      const items: Item[] = scans.map((s) => {
        const code = String(s.code || "").trim();
        const name = String(s.name || "");
        const system = num(s.required);
        const actual = num(s.scanned);
        const variance = actual - system;
        const flags: string[] = [];

        // physical batches actually scanned, aggregated
        const packs = (Array.isArray(s.packs) ? s.packs : []) as Array<Record<string, unknown>>;
        const counted = packs.length > 0 || actual > 0;
        // An item listed in the order but never physically scanned is NOT scrap — it was simply
        // not counted. Only compare items that were actually counted.
        const klass: Item["klass"] = !counted ? "Uncounted" : variance < 0 ? "Scrap" : variance > 0 ? "Excess" : "Match";
        const qty = klass === "Uncounted" ? 0 : Math.abs(variance);
        const coverage = system > 0 ? actual / system : actual > 0 ? 999 : 1;
        if (!counted) flags.push("not counted in this order — excluded from scrap");
        else if (klass === "Scrap" && coverage < 0.5) flags.push(`counted only ${Math.round(coverage * 100)}% of system stock — likely a partial count, review before scrapping`);
        const scannedAgg: Record<string, number> = {};
        for (const p of packs) { const b = String(p.batch || "").trim(); if (!b) continue; scannedAgg[b] = (scannedAgg[b] || 0) + num(p.qty); }
        const scannedBatches = Object.entries(scannedAgg)
          .map(([batch, q]) => ({ batch, qty: q, mfg: mfgFromBatch(batch), warehouse: whByBatch[`${code}|${batch}`] || "" }))
          .sort((a, z) => mfgKey(a.mfg) - mfgKey(z.mfg));

        const sysBatches = idx[code] || [];
        const warehouse = (sysBatches[0]?.warehouse) || (scannedBatches[0]?.warehouse) || "";

        let scrapRows: Row[] = [], excessRows: Row[] = [];
        if (klass === "Scrap") {
          if (!sysBatches.length) { flags.push("no system batches in snapshot — warehouse/batch blank"); }
          scrapRows = allocate(qty, sysBatches.map((b) => ({ batch: b.batch, warehouse: b.warehouse, mfg: b.mfg, cap: b.availGms })));
        } else if (klass === "Excess") {
          if (!scannedBatches.some((b) => b.warehouse)) flags.push("warehouse not in snapshot for scanned batch(es)");
          excessRows = allocate(qty, scannedBatches.map((b) => ({ batch: b.batch, warehouse: b.warehouse, mfg: b.mfg, cap: b.qty })));
        }

        return { code, name, salesUnit: String(s.salesUnit || ""), scale: num(s.scale) || 1, system, actual, variance, klass, qty, coverage, warehouse, scrapRows, excessRows, flags };
      });
      return { id: String(o.id || ""), orderNo: String(o.order_no || ""), status: String(o.status || ""), createdAt: String(o.created_at || ""), items };
    });

    return NextResponse.json({
      ok: true,
      date,
      snapshotAt: (snap as Record<string, unknown> | null)?.synced_at ?? null,
      snapshotProducts: Object.keys(idx).length,
      orders,
    }, { headers: CORS });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500, headers: CORS });
  }
}
