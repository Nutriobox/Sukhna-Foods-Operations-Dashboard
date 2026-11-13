import { NextResponse } from "next/server";

/**
 * Stock Reconciliation — for a chosen day (and optional time window), compare the
 * physical count captured by the scanner against system stock, consolidating a
 * product that was counted more than once, and produce the Scrap / Excess imports.
 *
 *   GET /api/stock-reconciliation?date=YYYY-MM-DD[&status=done][&from=HH:MM&to=HH:MM]
 *
 * Rules:
 *   system  = scan item `required` (base gms); when a product is counted more than
 *             once in the window, system = the LATEST count's required.
 *   actual  = SUM of `scanned` across every count of that product in the window.
 *   Only items that were actually counted (actual > 0) are marked Scrap/Excess;
 *   an item never scanned stays actual 0 and is left as "Not counted".
 *     required > actual  -> SCRAP   (required - actual)
 *     actual  > required -> EXCESS  (actual - required)
 *
 * Warehouse + batch mfg/exp come from the latest PACT "BatchWise Stock Analysis"
 * snapshot (public.inventory_snapshots, status=ok). That report is factory-scoped;
 * the client can still filter by individual warehouse.
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
const IST_MIN = 330; // +05:30 in minutes

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

function parseAnyDate(v: unknown): Date | null {
  if (v == null || v === "") return null;
  if (typeof v === "number" && isFinite(v)) { const d = new Date(Date.UTC(1899, 11, 30) + v * 864e5); return isNaN(+d) ? null : d; }
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = /^(\d{1,2})[\/\-\s]([A-Za-z]{3,})[\/\-\s](\d{2,4})/.exec(s);
  if (m) { const mo = MON.indexOf(m[2].slice(0, 3).toLowerCase()); if (mo >= 0) { const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]); return new Date(y, mo, Number(m[1])); } }
  m = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/.exec(s);
  if (m) { const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]); return new Date(y, Number(m[2]) - 1, Number(m[1])); }
  return null;
}
function mfgFromBatch(batch: string): Date | null {
  const tail = String(batch || "").split("/").pop() || "";
  const m = /(\d{2})(\d{2})(\d{2})\d{0,2}$/.exec(tail);
  if (!m) return null;
  const dd = Number(m[1]), mm = Number(m[2]), yy = Number(m[3]);
  if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return null;
  return new Date(2000 + yy, mm - 1, dd);
}
const expFromMfg = (mfg: Date | null): Date | null => (mfg ? new Date(mfg.getFullYear() + 1, mfg.getMonth(), mfg.getDate() - 1) : null);
const unitFactorToGms = (unit: string) => (/kg/i.test(unit) ? 1000 : 1);
const mfgKey = (d: Date | null) => (d ? d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate() : 99999999);
// minutes-of-day in IST for a UTC timestamp
const istMinutes = (isoTs: string) => { const t = Date.parse(isoTs); if (isNaN(t)) return -1; const m = Math.floor(t / 60000) + IST_MIN; return ((m % 1440) + 1440) % 1440; };
const hhmmToMin = (s: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ""); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

type SnapBatch = { batch: string; warehouse: string; mfg: Date | null; exp: Date | null; availGms: number };
type Row = { batch: string; warehouse: string; mfg: string; exp: string; qty: number };
type Source = { orderNo: string; postedAt: string; scanned: number };
type Item = {
  code: string; name: string; salesUnit: string; scale: number;
  system: number; actual: number; variance: number; klass: "Scrap" | "Excess" | "Match" | "Uncounted"; qty: number;
  coverage: number; warehouse: string; scrapRows: Row[]; excessRows: Row[]; flags: string[]; sources: Source[];
};

function allocate(need: number, batches: Array<{ batch: string; warehouse: string; mfg: Date | null; exp: Date | null; cap: number }>): Row[] {
  const out: Row[] = [];
  let left = Math.floor(need); // all batch inventory quantities are rounded DOWN (50.91 -> 50)
  for (const b of batches) {
    if (left <= 0) break;
    const take = b.cap > 0 ? Math.min(left, Math.floor(b.cap)) : left;
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
  const fromMin = hhmmToMin(u.searchParams.get("from") || "");
  const toMin = hhmmToMin(u.searchParams.get("to") || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ ok: false, error: "Pass ?date=YYYY-MM-DD" }, { status: 400, headers: CORS });

  const next = new Date(date + "T00:00:00Z"); next.setUTCDate(next.getUTCDate() + 1);
  const nextDate = next.toISOString().slice(0, 10);
  const from = encodeURIComponent(`${date}T00:00:00${IST}`);
  const to = encodeURIComponent(`${nextDate}T00:00:00${IST}`);

  try {
    let q = `inventory_orders?select=id,order_no,status,created_at,scanned_at,scans&created_at=gte.${from}&created_at=lt.${to}&order=created_at.asc`;
    if (status && status !== "all") q += `&status=eq.${encodeURIComponent(status)}`;
    const [ordersRaw, snapRaw] = await Promise.all([
      sb(q).catch(() => []),
      sb("inventory_snapshots?status=eq.ok&select=synced_at,data&order=synced_at.desc&limit=1").catch(() => []),
    ]);

    // snapshot batch index
    const snap = (Array.isArray(snapRaw) && snapRaw[0]) || null;
    const snapRows = (snap && Array.isArray(snap.data) ? snap.data : []) as Array<Record<string, unknown>>;
    const idx: Record<string, SnapBatch[]> = {};
    const byBatch: Record<string, SnapBatch> = {};
    for (const r of snapRows) {
      const code = String(r.code || "").trim(); if (!code) continue;
      const warehouse = String(r.warehouse || "").trim();
      // System inventory = Factory location only. The BatchWise sync is already
      // locked to the factory's 16 warehouses; drop rows with no real warehouse
      // (blank "-") so nothing outside a Factory warehouse is ever used.
      if (!warehouse || warehouse === "-") continue;
      const batch = String(r.batch || "").trim();
      const mfg = parseAnyDate(r.mfg) || mfgFromBatch(batch);
      const b: SnapBatch = { batch, warehouse, mfg, exp: parseAnyDate(r.exp) || expFromMfg(mfg), availGms: num(r.qty) * unitFactorToGms(String(r.unit || "")) };
      (idx[code] = idx[code] || []).push(b);
      if (batch) byBatch[`${code}|${batch}`] = b;
    }
    for (const k in idx) idx[k].sort((a, z) => mfgKey(a.mfg) - mfgKey(z.mfg));

    // flatten + time-filter order-item occurrences, keyed by product code
    type Occ = { postedAt: string; minute: number; orderNo: string; required: number; scanned: number; packs: Array<Record<string, unknown>>; name: string; salesUnit: string; scale: number };
    const byCode: Record<string, Occ[]> = {};
    for (const o of (Array.isArray(ordersRaw) ? ordersRaw : []) as Array<Record<string, unknown>>) {
      const postedAt = String(o.scanned_at || o.created_at || "");
      const minute = istMinutes(postedAt);
      if (fromMin != null && minute >= 0 && minute < fromMin) continue;
      if (toMin != null && minute >= 0 && minute > toMin) continue;
      const orderNo = String(o.order_no || "");
      for (const s of (Array.isArray(o.scans) ? o.scans : []) as Array<Record<string, unknown>>) {
        const code = String(s.code || "").trim(); if (!code) continue;
        (byCode[code] = byCode[code] || []).push({
          postedAt, minute, orderNo, required: num(s.required), scanned: num(s.scanned),
          packs: (Array.isArray(s.packs) ? s.packs : []) as Array<Record<string, unknown>>,
          name: String(s.name || ""), salesUnit: String(s.salesUnit || ""), scale: num(s.scale) || 1,
        });
      }
    }

    const items: Item[] = Object.entries(byCode).map(([code, occs]) => {
      occs.sort((a, z) => a.postedAt.localeCompare(z.postedAt)); // earliest first
      const latest = occs[occs.length - 1];
      const system = latest.required;                       // latest count's system qty
      const actual = occs.reduce((t, o) => t + o.scanned, 0); // sum of all counts
      const name = latest.name, salesUnit = latest.salesUnit, scale = latest.scale;
      const variance = actual - system;
      const klass: Item["klass"] = actual <= 0 ? "Uncounted" : variance < 0 ? "Scrap" : variance > 0 ? "Excess" : "Match";
      const qty = klass === "Uncounted" ? 0 : Math.floor(Math.abs(variance));
      const coverage = system > 0 ? actual / system : actual > 0 ? 999 : 0;
      const flags: string[] = [];
      const sources: Source[] = occs.map((o) => ({ orderNo: o.orderNo, postedAt: o.postedAt, scanned: o.scanned }));

      // scanned batches across all occurrences
      const scannedAgg: Record<string, number> = {};
      for (const o of occs) for (const p of o.packs) { const b = String(p.batch || "").trim(); if (!b) continue; scannedAgg[b] = (scannedAgg[b] || 0) + num(p.qty); }
      const scannedBatches = Object.entries(scannedAgg).map(([batch, q]) => {
        const sn = byBatch[`${code}|${batch}`]; const mfg = sn?.mfg || mfgFromBatch(batch);
        return { batch, warehouse: sn?.warehouse || "", mfg, exp: sn?.exp || expFromMfg(mfg), cap: q };
      }).sort((a, z) => mfgKey(a.mfg) - mfgKey(z.mfg));

      const sysBatches = idx[code] || [];
      const warehouse = sysBatches[0]?.warehouse || scannedBatches[0]?.warehouse || "";
      if ((klass === "Scrap" && !sysBatches.length) || (klass === "Excess" && !scannedBatches.some((b) => b.warehouse)))
        flags.push("warehouse/batch not in latest PACT snapshot — fill before import");

      let scrapRows: Row[] = [], excessRows: Row[] = [];
      if (klass === "Scrap") scrapRows = allocate(qty, sysBatches.map((b) => ({ batch: b.batch, warehouse: b.warehouse, mfg: b.mfg, exp: b.exp, cap: b.availGms })));
      else if (klass === "Excess") excessRows = allocate(qty, scannedBatches.map((b) => ({ batch: b.batch, warehouse: b.warehouse, mfg: b.mfg, exp: b.exp, cap: b.cap })));

      return { code, name, salesUnit, scale, system, actual, variance, klass, qty, coverage, warehouse, scrapRows, excessRows, flags, sources };
    }).sort((a, z) => a.name.localeCompare(z.name));

    return NextResponse.json({
      ok: true, date,
      window: { from: u.searchParams.get("from") || "", to: u.searchParams.get("to") || "" },
      snapshotAt: (snap as Record<string, unknown> | null)?.synced_at ?? null,
      snapshotProducts: Object.keys(idx).length,
      generatedAt: new Date().toISOString(),
      items,
    }, { headers: CORS });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500, headers: CORS });
  }
}
