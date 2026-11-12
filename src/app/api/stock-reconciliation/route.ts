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
 *   actual  = scan item `scanned`   (base gms)   — zero counts included
 *   required > scanned  -> SCRAP   (shortage = required - scanned)
 *   scanned  > required -> EXCESS  (surplus  = scanned - required)
 *
 * Warehouse + batch mfg/exp come from the latest PACT "BatchWise Stock Analysis"
 * snapshot (public.inventory_snapshots, status=ok).
 *
 * Server env: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_KEY.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS" };
export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

const SB_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const IST = "+05:30";

async function sb(path: string) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY as string, Authorization: `Bearer ${SB_KEY}` }, cache: "no-store",
  });
  if (!r.ok) throw new Error(`Supabase ${r.status} ${(await r.text().catch(() => "")).slice(0, 160)}`);
  return r.json();
}

const num = (v: unknown) => { const n = Number(String(v ?? "").replace(/,/g, "")); return isFinite(n) ? n : 0; };
const pad2 = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date | null) => (d ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` : "");
const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Parse a date from the snapshot's text ("14-Oct-2026", "14/10/2026", "2026-10-14", Excel serial…).
function parseAnyDate(v: unknown): Date | null {
  if (v == null || v === "") return null;
  if (typeof v === "number" && isFinite(v)) { const d = new Date(Date.UTC(1899, 11, 30) + v * 864e5); return isNaN(+d) ? null : d; }
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = /^(\d{1,2})[\/\-\s]([A-Za-z]{3,})[\/\-\s](\d{2,4})/.exec(s); // 14-Oct-2026
  if (m) { const mo = MON.indexOf(m[2].slice(0, 3).toLowerCase()); if (mo >= 0) { const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]); return new Date(y, mo, Number(m[1])); } }
  m = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/.exec(s); // 14-10-2026
  if (m) { const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]); return new Date(y, Number(m[2]) - 1, Number(m[1])); }
  return null;
}
// Fallback mfg from the batch-number tail (…/DDMMYYnn).
function mfgFromBatch(batch: string): Date | null {
  const tail = String(batch || "").split("/").pop() || "";
  const m = /(\d{2})(\d{2})(\d{2})\d{0,2}$/.exec(tail);
  if (!m) return null;
  const dd = Number(m[1]), mm = Number(m[2]), yy = Number(m[3]);
  if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return null;
  return new Date(2000 + yy, mm - 1, dd);
}
// PACT shelf life on these imports is one year less a day.
const expFromMfg = (mfg: Date | null): Date | null => (mfg ? new Date(mfg.getFullYear() + 1, mfg.getMonth(), mfg.getDate() - 1) : null);
const unitFactorToGms = (unit: string) => (/kg/i.test(unit) ? 1000 : 1);
const mfgKey = (d: Date | null) => (d ? d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate() : 99999999);

type SnapBatch = { batch: string; warehouse: string; mfg: Date | null; exp: Date | null; availGms: number };
type Row = { batch: string; warehouse: string; mfg: string; exp: string; qty: number };
type Item = {
  code: string; name: string; salesUnit: string; scale: number;
  system: number; actual: number; variance: number; klass: "Scrap" | "Excess" | "Match"; qty: number;
  coverage: number; warehouse: string; scrapRows: Row[]; excessRows: Row[]; flags: string[];
};
type Order = { id: string; orderNo: string; status: string; createdAt: string; items: Item[] };

function allocate(need: number, batches: Array<{ batch: string; warehouse: string; mfg: Date | null; exp: Date | null; cap: number }>): Row[] {
  const out: Row[] = [];
  let left = Math.round(need);
  for (const b of batches) {
    if (left <= 0) break;
    const take = b.cap > 0 ? Math.min(left, Math.round(b.cap)) : left;
    if (take <= 0) continue;
    out.push({ batch: b.batch, warehouse: b.warehouse, mfg: iso(b.mfg), exp: iso(b.exp || expFromMfg(b.mfg)), qty: take });
    left -= take;
  }
  if (left > 0) { if (out.length) out[0].qty += left; else out.push({ batch: "", warehouse: "", mfg: "", exp: "", qty: left }); }
  return out;
}

export async function GET(req: Request) {
  if (!SB_URL || !SB_KEY) return NextResponse.json({ ok: false, error: "Supabase not configured." }, { status: 500, headers: CORS });
  const u = new URL(req.url);
  const date = (u.searchParams.get("date") || "").slice(0, 10);
  const status = (u.searchParams.get("status") || "").trim().toLowerCase();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ ok: false, error: "Pass ?date=YYYY-MM-DD" }, { status: 400, headers: CORS });

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

    const snap = (Array.isArray(snapRaw) && snapRaw[0]) || null;
    const snapRows = (snap && Array.isArray(snap.data) ? snap.data : []) as Array<Record<string, unknown>>;
    const idx: Record<string, SnapBatch[]> = {};
    const byBatch: Record<string, SnapBatch> = {};
    for (const r of snapRows) {
      const code = String(r.code || "").trim();
      if (!code) continue;
      const batch = String(r.batch || "").trim();
      const mfg = parseAnyDate(r.mfg) || mfgFromBatch(batch);
      const b: SnapBatch = { batch, warehouse: String(r.warehouse || "").trim(), mfg, exp: parseAnyDate(r.exp) || expFromMfg(mfg), availGms: num(r.qty) * unitFactorToGms(String(r.unit || "")) };
      (idx[code] = idx[code] || []).push(b);
      if (batch) byBatch[`${code}|${batch}`] = b;
    }
    for (const k in idx) idx[k].sort((a, z) => mfgKey(a.mfg) - mfgKey(z.mfg)); // FEFO

    const orders: Order[] = (Array.isArray(ordersRaw) ? ordersRaw : []).map((o: Record<string, unknown>) => {
      const scans = (Array.isArray(o.scans) ? o.scans : []) as Array<Record<string, unknown>>;
      const items: Item[] = scans.map((s) => {
        const code = String(s.code || "").trim();
        const name = String(s.name || "");
        const system = num(s.required);
        const actual = num(s.scanned);
        const variance = actual - system;
        const klass: Item["klass"] = variance < 0 ? "Scrap" : variance > 0 ? "Excess" : "Match";
        const qty = Math.abs(variance);
        const coverage = system > 0 ? actual / system : actual > 0 ? 999 : 0;
        const flags: string[] = [];

        const packs = (Array.isArray(s.packs) ? s.packs : []) as Array<Record<string, unknown>>;
        const scannedAgg: Record<string, number> = {};
        for (const p of packs) { const b = String(p.batch || "").trim(); if (!b) continue; scannedAgg[b] = (scannedAgg[b] || 0) + num(p.qty); }
        const scannedBatches = Object.entries(scannedAgg).map(([batch, q]) => {
          const sn = byBatch[`${code}|${batch}`];
          const mfg = sn?.mfg || mfgFromBatch(batch);
          return { batch, qty: q, warehouse: sn?.warehouse || "", mfg, exp: sn?.exp || expFromMfg(mfg), cap: q };
        }).sort((a, z) => mfgKey(a.mfg) - mfgKey(z.mfg));

        const sysBatches = idx[code] || [];
        const warehouse = sysBatches[0]?.warehouse || scannedBatches[0]?.warehouse || "";
        if ((klass === "Scrap" && !sysBatches.length) || (klass === "Excess" && !scannedBatches.some((b) => b.warehouse)))
          flags.push("warehouse/batch not in latest PACT snapshot — fill before import");

        let scrapRows: Row[] = [], excessRows: Row[] = [];
        if (klass === "Scrap") scrapRows = allocate(qty, sysBatches.map((b) => ({ batch: b.batch, warehouse: b.warehouse, mfg: b.mfg, exp: b.exp, cap: b.availGms })));
        else if (klass === "Excess") excessRows = allocate(qty, scannedBatches.map((b) => ({ batch: b.batch, warehouse: b.warehouse, mfg: b.mfg, exp: b.exp, cap: b.cap })));

        return { code, name, salesUnit: String(s.salesUnit || ""), scale: num(s.scale) || 1, system, actual, variance, klass, qty, coverage, warehouse, scrapRows, excessRows, flags };
      });
      return { id: String(o.id || ""), orderNo: String(o.order_no || ""), status: String(o.status || ""), createdAt: String(o.created_at || ""), items };
    });

    return NextResponse.json({
      ok: true, date,
      snapshotAt: (snap as Record<string, unknown> | null)?.synced_at ?? null,
      snapshotProducts: Object.keys(idx).length,
      generatedAt: new Date().toISOString(),
      orders,
    }, { headers: CORS });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500, headers: CORS });
  }
}
