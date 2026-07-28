// PACT item-master matching against the REAL product master
// (src/lib/pact-catalog.json, generated from Product Master Report.xlsx).
// Each product carries its packaging levels: L1 (base) unit, the Default Print
// UOM (packaging size UOM), a packing size, and its allowed units.

import catalog from "./pact-catalog.json";

export type PactProduct = {
  name: string;
  units: string[];   // allowed units (L1/L2/L3) from the master
  printUom: string;  // Packaging size UOM (Default Barcode Print UOM)
  packSize: string;  // Packing size (base qty per print unit)
  l1Uom: string;     // Level-1 (base) UOM
};

export const CATALOG = catalog as PactProduct[];

const tokenize = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((t) => t.length > 1);

// Precompute tokens once for fast fuzzy matching over the whole master.
const CAT_TOKENS: string[][] = CATALOG.map((p) => tokenize(p.name));

// Bill-unit → canonical PACT unit. null means "not a recognised PACT unit".
const UNIT_ALIASES: Record<string, string> = {
  gms: "Gram", gm: "Gram", gram: "Gram", grams: "Gram", gs: "Gram",
  kg: "Kg", kgs: "Kg", kilogram: "Kg", kgm: "Kg", kilo: "Kg",
  qntl: "Qntl", quintal: "Qntl", qtl: "Qntl",
  nos: "Nos", no: "Nos", number: "Nos", count: "Nos", unit: "Nos", pair: "Pair",
  pcs: "Pcs", pc: "Pcs", piece: "Pcs", pieces: "Pcs", pces: "Pcs",
  ml: "ML", mls: "ML",
  ltr: "Litre", ltrs: "Litre", litre: "Litre", liter: "Litre", l: "Litre", lt: "Litre", lts: "Litre",
  pkt: "Pack", pkts: "Pack", packet: "Pack", pack: "Pack", packs: "Pack",
  box: "Box", boxes: "Box",
  carton: "Carton", cartons: "Carton", ctn: "Carton",
  container: "Container", cont: "Container",
  bottle: "Bottle", btl: "Bottle",
  can: "Can", cans: "Can",
  tin: "Tin", tins: "Tin",
  bundle: "Bundle", bdl: "Bundle",
  bunch: "Bunch", bunches: "Bunch",
  roll: "Roll", rolls: "Roll",
  crate: "Crate", crates: "Crate",
  bag: "Bag", bags: "Bag", sack: "Bag",
  ream: "Ream", rim: "Ream", rm: "Ream", reams: "Ream",
  jar: "Jar", jars: "Jar",
  dozen: "Dozen", dzn: "Dozen",
};

// The canonical PACT unit master (what a bill unit must resolve into).
export const UNIT_MASTER = Array.from(new Set(Object.values(UNIT_ALIASES)));

// Normalise a bill's unit string to a PACT unit, or null if it can't be matched.
export function matchUnit(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase().replace(/[.\-\s]+/g, "");
  return UNIT_ALIASES[key] ?? null;
}

// Best-matching PACT product for a bill line name (always returns one).
export function matchProduct(name: string): { product: PactProduct; score: number } {
  const q = tokenize(name);
  if (!q.length || !CATALOG.length) return { product: CATALOG[0], score: 0 };
  let bestIdx = 0;
  let bestScore = 0;
  for (let i = 0; i < CATALOG.length; i++) {
    const t = CAT_TOKENS[i];
    if (!t.length) continue;
    let inter = 0;
    for (const w of q) if (t.includes(w)) inter++;
    const score = inter / Math.min(q.length, t.length);
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  return { product: CATALOG[bestIdx], score: Math.max(0, Math.min(1, bestScore)) };
}

export type PactLine = {
  billName: string;
  product: string;      // PACT-matched product name
  confidence: number;   // 0..100
  unit: string | null;  // PACT purchase unit (null = not matched)
  uom: string | null;   // PACT stock UOM (same source/logic as unit)
  qty: number | null;   // purchase quantity (null when unit unmatched)
  rate: number | null;  // purchase rate from bill
  printUom: string;     // Packaging size UOM (from product master)
  packSize: string;     // Packing size (from product master, editable)
  l1Uom: string;        // L1 UOM (from product master)
  matched: boolean;     // unit & uom both resolved
};

// Resolve one bill item into its PACT entry shape.
export function resolveLine(it: { name: string; uom: string; qty: number; price: number | null }): PactLine {
  const { product, score } = matchProduct(it.name);
  const unit = matchUnit(it.uom);
  const matched = unit !== null;
  return {
    billName: it.name,
    product: product.name,
    confidence: Math.round(score * 100),
    unit,
    uom: unit,
    qty: matched ? it.qty : null,
    rate: it.price,
    printUom: product.printUom,
    packSize: product.packSize,
    l1Uom: product.l1Uom,
    matched,
  };
}
