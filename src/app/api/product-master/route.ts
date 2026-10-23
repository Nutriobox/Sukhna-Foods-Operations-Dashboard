import { NextResponse } from "next/server";
import catalog from "@/lib/pact-catalog.json";
import idealItems from "@/lib/outlet-ideal-items.json";

/**
 * Unified Product Master — single source of truth for every tool
 * (main dashboard, costing dashboard, outlet dispatch, Sales-Order scanner app).
 *
 * Primary source: the LIVE PACT snapshot that the EC2 worker writes nightly +
 * hourly to Supabase (`costing_snapshots` row with report='pm'), the same
 * snapshot the Costing dashboard serves at /api/costing/pm. On any request
 * this route reshapes that header-plus-rows array into the per-product shape
 * every consumer already uses:
 *
 *   { code, name, printLevel, unit, scale, levels: {L1,L2,L3}, idealWarehouse,
 *     scanBatches, group }
 *
 * Fields PACT doesn't carry in that report (idealWarehouse, scanBatches) are
 * merged in from the local pact-catalog.json fallback by product code so no
 * tool loses info; if the Supabase fetch fails for any reason, the whole
 * static JSON is served — every tool keeps working.
 *
 * The response is cached in-memory for TTL_MS so a page-load storm doesn't
 * hammer Supabase. Any manual sync (POST /api/sync-costing?report=pm) will,
 * once the worker completes, bust that cache naturally within TTL_MS.
 *
 *   GET /api/product-master
 *     ?fresh=1   bypass the in-memory cache
 *     ?all=1     include every PACT column by its raw name under `raw`
 *
 *   Response: { ok, count, synced_at, source, products: [...] }
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS" };
const TTL_MS = 60 * 1000; // 60s in-memory cache

type Level = { u?: string; s?: number | null };
type StaticEntry = { name?: string; code?: string; printLevel?: string | null; units?: string[]; levels?: Record<string, Level>; idealWarehouse?: string; scanBatches?: boolean; group?: string };
type Product = {
  code: string;
  name: string;
  printLevel: string | null;
  unit: string | null;
  scale: number | null;
  levels: Record<string, Level>;
  idealWarehouse: string;
  scanBatches: boolean | null;
  group: string;
  idealStorage: string | null;   // Frozen | Chiller | Vegetable | Dry Store | Packaging | On-Demand | null
  idealUom: string | null;       // UOM the Excel ideal quantities are expressed in (e.g. "Bag", "Kg", "Pkt")
  idealQty: Record<string, number> | null;   // per-outlet ideal inventory, e.g. { SHIVALIK: 2, KKD: 3, ... }
  isGhost?: boolean;             // true when this row came ONLY from the Ideal Inventory sheet (no matching PACT product)
  raw?: Record<string, unknown>;
};

const STATIC = catalog as StaticEntry[];
const STATIC_BY_CODE = new Map<string, StaticEntry>();
for (const p of STATIC) if (p && p.code) STATIC_BY_CODE.set(String(p.code).trim().toUpperCase(), p);

// Outlet Ideal Inventory lookup — built once at module load, used to tag each
// product with its storage category (Frozen/Chiller/Vegetable/Dry Store/
// Packaging/On-Demand) when it appears on the team's "ideal items" sheet.
type IdealItem = {
  name: string;
  norm: string;
  storage: string;
  uom: string | null;
  ideals: Record<string, number>;
};
type IdealFile = { outlets: string[]; items: IdealItem[] };
const IDEAL_FILE = idealItems as IdealFile;
const IDEAL_OUTLETS = IDEAL_FILE.outlets || [];
const IDEAL_BY_EXACT = new Map<string, IdealItem>();
for (const it of IDEAL_FILE.items || []) {
  if (!it || !it.name) continue;
  const k = it.name.toLowerCase().trim();
  if (!IDEAL_BY_EXACT.has(k)) IDEAL_BY_EXACT.set(k, it);
}
function idealStorageFor(name: string): string | null {
  if (!name) return null;
  const hit = IDEAL_BY_EXACT.get(name.toLowerCase().trim());
  return hit ? hit.storage : null;
}
function idealEntryFor(name: string): IdealItem | null {
  if (!name) return null;
  return IDEAL_BY_EXACT.get(name.toLowerCase().trim()) || null;
}

// Return "ghost" Product rows for every Ideal Inventory item that has NO
// matching PACT product (case-insensitive exact name match). These are
// surfaced in the Raw Material Master so the ops team can see which items
// on the physical ideal-stock list still need to be created in PACT.
function ghostIdealProducts(matchedNames: Set<string>): Product[] {
  const ghosts: Product[] = [];
  for (const it of IDEAL_FILE.items || []) {
    if (!it || !it.name) continue;
    if (matchedNames.has(it.name.toLowerCase().trim())) continue;
    ghosts.push({
      code: "",
      name: it.name,
      printLevel: null,
      unit: null,
      scale: null,
      levels: {},
      idealWarehouse: "",
      scanBatches: null,
      group: "",
      idealStorage: it.storage || null,
      idealUom: it.uom || null,
      idealQty: it.ideals || null,
      isGhost: true,
    });
  }
  return ghosts;
}

function staticProducts(): Product[] {
  const base: Product[] = STATIC.map((p) => {
    const levels = (p.levels || {}) as Record<string, Level>;
    const pl = p.printLevel || "";
    const lv: Level = (pl && levels[pl]) || {};
    return {
      code: (p.code || "").trim(),
      name: p.name || "",
      printLevel: pl || null,
      unit: lv.u || null,
      scale: typeof lv.s === "number" ? lv.s : null,
      levels,
      idealWarehouse: (p.idealWarehouse || "").trim(),
      scanBatches: p.scanBatches ?? null,
      group: (p.group || "").trim(),
      idealStorage: idealStorageFor(p.name || ""),
      idealUom: (idealEntryFor(p.name || "")?.uom) ?? null,
      idealQty: (idealEntryFor(p.name || "")?.ideals) ?? null,
    };
  });
  // Append ghost entries for ideal items not present in PACT catalog
  const matched = new Set(base.filter((p) => p.idealStorage).map((p) => p.name.toLowerCase().trim()));
  return base.concat(ghostIdealProducts(matched));
}

// in-memory cache (per Node process)
let CACHE: { at: number; body: Product[]; synced_at: string | null; source: string } | null = null;

export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

type SnapRow = { data?: unknown; synced_at?: string | null };

export async function GET(req: Request) {
  const url = new URL(req.url);
  const fresh = url.searchParams.get("fresh") === "1";
  const includeRaw = url.searchParams.get("all") === "1";

  // Serve from in-memory cache when fresh enough
  if (!fresh && CACHE && Date.now() - CACHE.at < TTL_MS) {
    return respond(CACHE.body, CACHE.synced_at, CACHE.source, includeRaw);
  }

  const sbUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!sbUrl || !sbKey) {
    const body = staticProducts();
    CACHE = { at: Date.now(), body, synced_at: null, source: "static-fallback" };
    return respond(body, null, "static-fallback", includeRaw, "Supabase not configured on the server; serving static pact-catalog.json");
  }

  try {
    const q = `${sbUrl.replace(/\/$/, "")}/rest/v1/costing_snapshots`
      + `?report=eq.pm`
      + `&select=data,synced_at`
      + `&order=synced_at.desc&limit=1`;
    const r = await fetch(q, {
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, Accept: "application/json" },
      cache: "no-store",
    });
    if (!r.ok) throw new Error(`Supabase ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
    const rows = (await r.json()) as SnapRow[];
    const snap = rows && rows[0];
    const aoa = (snap && Array.isArray(snap.data) ? snap.data : null) as (string | number | null)[][] | null;

    if (!aoa || aoa.length < 2) {
      const body = staticProducts();
      CACHE = { at: Date.now(), body, synced_at: snap?.synced_at ?? null, source: "static-fallback" };
      return respond(body, snap?.synced_at ?? null, "static-fallback", includeRaw, "PACT PM snapshot empty; serving static pact-catalog.json");
    }

    // Reshape rows into per-product objects, enriching with static JSON for
    // fields PACT doesn't carry (idealWarehouse / scanBatches).
    const header = aoa[0].map((h) => String(h || "").trim());
    const idx = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
    const iCode = idx("Product Code");
    const iName = idx("Product Name");
    const iL1   = idx("L1Unit");
    const iL2   = idx("L2Unit");
    const iL2c  = idx("L2ConversionRate");
    const iL3   = idx("L3Unit");
    const iL3c  = idx("L3ConversionRate");
    const iGrp  = idx("Inventory Category");
    const iDPU  = idx("DefaultBarcodePrintUOM");

    const num = (v: unknown): number | null => {
      if (v == null || v === "") return null;
      const n = Number(String(v).replace(/,/g, ""));
      return isFinite(n) ? n : null;
    };
    const str = (v: unknown): string => (v == null ? "" : String(v)).trim();

    const products: Product[] = [];
    const seen = new Set<string>();
    for (let i = 1; i < aoa.length; i++) {
      const row = aoa[i] || [];
      const code = str(row[iCode]);
      if (!code || code === "DynamicSet" || code === "-") continue; // PACT emits a header/footer sentinel
      const upper = code.toUpperCase();
      if (seen.has(upper)) continue;
      seen.add(upper);

      const l1u = str(row[iL1]);
      const l2u = str(row[iL2]);
      const l3u = str(row[iL3]);
      const l2s = num(row[iL2c]);
      const l3s = num(row[iL3c]);
      const levels: Record<string, Level> = {};
      if (l1u) levels.L1 = { u: l1u, s: 1 };
      if (l2u && l2s != null && l2s > 0) levels.L2 = { u: l2u, s: l2s };
      if (l3u && l3s != null && l3s > 0) levels.L3 = { u: l3u, s: l3s };

      // Determine printLevel: PACT's DefaultBarcodePrintUOM is a unit name — match it to L1/L2/L3.
      const dpu = str(row[iDPU]).toLowerCase();
      let printLevel: string | null = null;
      for (const k of ["L1", "L2", "L3"] as const) {
        if (levels[k] && String(levels[k].u || "").toLowerCase() === dpu) { printLevel = k; break; }
      }
      const lv = (printLevel && levels[printLevel]) || {};

      const stat = STATIC_BY_CODE.get(upper);
      // Fallbacks: carry printLevel/idealWarehouse/scanBatches from the static JSON
      // when PACT doesn't give us something clean.
      if (!printLevel && stat?.printLevel) printLevel = stat.printLevel;
      const idealWarehouse = (stat?.idealWarehouse || "").trim();
      const scanBatches = stat?.scanBatches ?? null;

      const name = str(row[iName]) || stat?.name || "";
      const out: Product = {
        code,
        name,
        printLevel: printLevel || null,
        unit: lv.u || null,
        scale: typeof lv.s === "number" ? lv.s : null,
        levels,
        idealWarehouse,
        scanBatches,
        group: str(row[iGrp]) || (stat?.group || ""),
        idealStorage: idealStorageFor(name),
        // PACT's DefaultBarcodePrintUOM is the operator-preferred counting
        // unit (parsed above into printLevel → lv). It's the correct source
        // for Packing UOM — e.g. Blueberry Filling: L2=Kg, L3=Carton,
        // DefaultBarcodePrintUOM=Kg, which is how the kitchen counts it.
        // The static JSON's uom field (idealEntryFor().uom) only wins
        // when PACT didn't set DefaultBarcodePrintUOM for that product.
        // Fixed 16 items on the Ideal Inventory list in one pass
        // (Blueberry Filling, Tata Salt, Quinoa, Ginger, Sweet Corn, …).
        idealUom: (lv.u ? String(lv.u) : null) ?? idealEntryFor(name)?.uom ?? null,
        idealQty: idealEntryFor(name)?.ideals ?? null,
      };
      if (includeRaw) {
        const raw: Record<string, unknown> = {};
        for (let j = 0; j < header.length; j++) raw[header[j]] = row[j] ?? null;
        out.raw = raw;
      }
      products.push(out);
    }

    // Append ghost entries for ideal items not present in PACT catalog
    const matchedLive = new Set(products.filter((p) => p.idealStorage).map((p) => p.name.toLowerCase().trim()));
    const withGhosts = products.concat(ghostIdealProducts(matchedLive));
    CACHE = { at: Date.now(), body: withGhosts, synced_at: snap?.synced_at ?? null, source: "pact-live" };
    return respond(withGhosts, snap?.synced_at ?? null, "pact-live", includeRaw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const body = staticProducts();
    CACHE = { at: Date.now(), body, synced_at: null, source: "static-fallback" };
    return respond(body, null, "static-fallback", includeRaw, `Live PACT fetch failed: ${msg}; serving static pact-catalog.json`);
  }
}

function respond(products: Product[], synced_at: string | null, source: string, includeRaw: boolean, warning?: string) {
  return NextResponse.json({
    ok: true,
    count: products.length,
    synced_at,
    source,                 // 'pact-live' or 'static-fallback'
    cached_for_ms: TTL_MS,
    warning,
    outlets: IDEAL_OUTLETS,
    products: includeRaw ? products : products.map(({ raw, ...rest }) => rest),
  }, { headers: CORS });
}
