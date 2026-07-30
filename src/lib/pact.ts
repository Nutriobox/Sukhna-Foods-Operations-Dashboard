// PACT item-master matching against the real product master
// (src/lib/pact-catalog.json, from the Product Master Report).
// Each product carries its packaging levels (L1 base / L2 / L3) with the unit
// and the base-qty size at each level.

import catalog from "./pact-catalog.json";

export type Level = { u: string; s: number | null };
export type PactProduct = {
  name: string;
  units: string[];                 // purchase units (L1/L2/L3)
  levels: Record<string, Level>;   // { L1?, L2?, L3? }
  printLevel: string | null;       // default packaging level
};

export const CATALOG = catalog as PactProduct[];
const BY_NAME = new Map(CATALOG.map((p) => [p.name, p]));
export const productByName = (name: string) => BY_NAME.get(name);

// Every distinct purchase unit that appears in the master (for the unit picker).
export const ALL_UNITS: string[] = Array.from(
  new Set(CATALOG.flatMap((p) => p.units))
).sort((a, b) => a.localeCompare(b));

const tokenize = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((t) => t.length > 1);
const CAT_TOKENS: string[][] = CATALOG.map((p) => tokenize(p.name));

function score(qTokens: string[], t: string[]): number {
  if (!qTokens.length || !t.length) return 0;
  let inter = 0;
  for (const w of qTokens) if (t.includes(w)) inter++;
  return inter / Math.min(qTokens.length, t.length);
}

// Best-matching product for a bill line name (always returns one).
export function matchProduct(name: string): { product: PactProduct; score: number } {
  const q = tokenize(name);
  let bi = 0, bs = 0;
  for (let i = 0; i < CATALOG.length; i++) {
    const s = score(q, CAT_TOKENS[i]);
    if (s > bs) { bs = s; bi = i; }
  }
  return { product: CATALOG[bi], score: Math.max(0, Math.min(1, bs)) };
}

// Product-master names matching >= `min` similarity (for the default picker).
// Always includes the single best match so the dropdown is never empty.
export function candidates(name: string, min = 0.75, cap = 60): { name: string; score: number }[] {
  const q = tokenize(name);
  const scored: { name: string; score: number }[] = [];
  let best = { name: CATALOG[0]?.name || "", score: 0 };
  for (let i = 0; i < CATALOG.length; i++) {
    const s = score(q, CAT_TOKENS[i]);
    if (s > best.score) best = { name: CATALOG[i].name, score: s };
    if (s >= min) scored.push({ name: CATALOG[i].name, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  if (!scored.some((c) => c.name === best.name)) scored.unshift(best);
  return scored.slice(0, cap);
}

const UNIT_ALIASES: Record<string, string> = {
  gms: "Gms", gm: "Gms", gram: "Gms", grams: "Gms",
  kg: "Kg", kgs: "Kg", kilogram: "Kg", kgm: "Kg", kilo: "Kg",
  qntl: "Qntl", quintal: "Qntl", qtl: "Qntl",
  nos: "Nos", no: "Nos", number: "Nos", count: "Nos", unit: "Nos", pair: "Pair",
  pcs: "Pcs", pc: "Pcs", piece: "Pcs", pieces: "Pcs", pces: "Pcs",
  ml: "ML", mls: "ML",
  ltr: "Ltr", ltrs: "Ltr", litre: "Ltr", liter: "Ltr", l: "Ltr", lt: "Ltr", lts: "Ltr",
  pkt: "Pkt", pkts: "Pkt", packet: "Pkt", pack: "Pkt", packs: "Pkt",
  box: "Box", boxes: "Box",
  carton: "Carton", cartons: "Carton", ctn: "Carton", cartoon: "Carton",
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
};

// Normalise a bill's unit to a PACT unit, or null if it can't be matched.
export function matchUnit(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase().replace(/[.\-\s]+/g, "");
  return UNIT_ALIASES[key] ?? null;
}

// Canonical unit token for equivalence checks (e.g. GMS/Gm/gram -> "gm",
// Bags/bag/sack -> "bag"). Used to test whether a bill unit equals a product's
// PACT unit despite spelling/case/plural differences.
export function canonUnit(u: string | null | undefined): string {
  const k = String(u || "").trim().toLowerCase().replace(/[.\-\s]+/g, "");
  const groups: Record<string, string[]> = {
    gm: ["gm", "gms", "gram", "grams", "g"],
    kg: ["kg", "kgs", "kilogram", "kilograms", "kilo", "kgm"],
    qntl: ["qntl", "quintal", "qtl"],
    ton: ["ton", "tonne", "tonnes", "mt"],
    mg: ["mg"],
    ml: ["ml", "mls"],
    ltr: ["ltr", "ltrs", "litre", "liter", "litres", "liters", "l", "lt", "lts"],
    pkt: ["pkt", "pkts", "packet", "packets", "pack", "packs"],
    bag: ["bag", "bags", "sack", "sacks"],
    box: ["box", "boxes"],
    pcs: ["pcs", "pc", "piece", "pieces", "pces", "nos", "no", "number", "unit", "units"],
    carton: ["carton", "cartons", "ctn", "cartoon"],
    bottle: ["bottle", "bottles", "btl"],
    can: ["can", "cans"],
    tin: ["tin", "tins"],
    roll: ["roll", "rolls"],
    crate: ["crate", "crates"],
    bundle: ["bundle", "bundles", "bdl"],
    bunch: ["bunch", "bunches"],
    ream: ["ream", "reams", "rim", "rm"],
  };
  for (const canon in groups) if (groups[canon].includes(k)) return canon;
  return k;
}

export type PactLine = {
  billName: string;
  product: string;      // PACT-matched product name (default)
  confidence: number;   // 0..100
  unit: string | null;  // PACT purchase unit (null = not matched)
  qty: number | null;   // purchase quantity from bill
  rate: number | null;  // purchase rate from bill
  printLevel: string | null;
  matched: boolean;     // bill unit resolved
};

export function resolveLine(it: { name: string; uom: string; qty: number; price: number | null }): PactLine {
  const { product, score } = matchProduct(it.name);
  const unit = matchUnit(it.uom);
  const matched = unit !== null;
  return {
    billName: it.name,
    product: product.name,
    confidence: Math.round(score * 100),
    unit,
    qty: matched ? it.qty : null,
    rate: it.price,
    printLevel: product.printLevel,
    matched,
  };
}
