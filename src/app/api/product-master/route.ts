import { NextResponse } from "next/server";
import catalog from "@/lib/pact-catalog.json";

/**
 * PACT product master — the packaging levels the whole system converts with.
 *
 * Each product carries L1/L2/L3 levels ({u: unit name, s: size in base units})
 * and a printLevel naming the level sales orders are written in. The Android
 * app reads this to turn base-unit stock (Gms/ML/Pcs) into the order's UOM:
 *
 *   stock in printLevel units = base quantity / levels[printLevel].s
 *
 * e.g. FGO698 Crispy Chilli Paneer Momos: printLevel L3 = Carton (4080 Gms),
 *      so 391,680 Gms of stock is 96 Cartons.
 *
 * GET /api/product-master -> { ok, count, products: [{code,name,printLevel,unit,scale,levels}] }
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS" };

type Level = { u?: string; s?: number };
type Entry = { name?: string; code?: string; printLevel?: string | null; units?: string[]; levels?: Record<string, Level> };

export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

export async function GET() {
  const list = catalog as Entry[];
  const products = list.map((p) => {
    const levels = p.levels || {};
    const pl = p.printLevel || "";
    const lv: Level = (pl && levels[pl]) || {};
    return {
      code: (p.code || "").trim(),
      name: p.name || "",
      printLevel: pl || null,
      unit: lv.u || null,                 // the UOM a sales order is written in
      scale: typeof lv.s === "number" ? lv.s : null,  // base units per printLevel unit
      levels,                             // full L1/L2/L3 for reference
    };
  });
  return NextResponse.json({ ok: true, count: products.length, products }, { headers: CORS });
}
