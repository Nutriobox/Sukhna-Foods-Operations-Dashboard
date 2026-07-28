// PACT item-master matching (offline simulation).
// Mirrors how a real PACT integration resolves a bill line against the PACT
// product catalogue + unit master. Swap CATALOG / UNIT_MASTER for the live PACT
// API response when available — the matching logic stays the same.

export type PactProduct = {
  name: string;
  units: string[];
  printUom: string;  // Packaging size UOM (the "print"/packaging UOM)
  packSize: string;  // Packing size (e.g. "24 x 500 g")
  l1Uom: string;     // Level-1 UOM
};

// A representative slice of a PACT item master (with packaging attributes).
export const CATALOG: PactProduct[] = [
  { name: "Lime Seasoning 500 g", units: ["Pcs", "Pack"], printUom: "Box", packSize: "24 x 500 g", l1Uom: "Case" },
  { name: "Alidada Mini Mogra Rice 30 Kg", units: ["Bag", "Qntl", "Kg"], printUom: "Bag", packSize: "30 Kg", l1Uom: "Bag" },
  { name: "Alidada Tibar Rice 30 Kg", units: ["Bag", "Qntl", "Kg"], printUom: "Bag", packSize: "30 Kg", l1Uom: "Bag" },
  { name: "Banana Yellow", units: ["Kg", "Pcs"], printUom: "Crate", packSize: "1 Kg", l1Uom: "Crate" },
  { name: "Button Mushroom 200 g", units: ["Pack", "Pcs", "Kg"], printUom: "Box", packSize: "200 g x 24", l1Uom: "Case" },
  { name: "Heat Sealing Packing Roll 360 mm", units: ["Roll", "Pcs"], printUom: "Roll", packSize: "360 mm", l1Uom: "Carton" },
  { name: "Food Container 1200 ml White", units: ["Pcs", "Box", "Nos"], printUom: "Box", packSize: "300 pcs", l1Uom: "Case" },
  { name: "Paper Flat Bowl 750 ml White", units: ["Pcs", "Box", "Nos"], printUom: "Box", packSize: "500 pcs", l1Uom: "Case" },
  { name: "Paper Container 250 ml White", units: ["Pcs", "Box", "Nos"], printUom: "Box", packSize: "1000 pcs", l1Uom: "Case" },
  { name: "Cellulose Gel FP 90", units: ["Pcs", "Box"], printUom: "Box", packSize: "90 pcs", l1Uom: "Carton" },
  { name: "A4 Copier Paper 75 GSM", units: ["Ream", "Pack", "Box"], printUom: "Box", packSize: "500 sheets", l1Uom: "Carton" },
  { name: "Corrugated Box 5 Ply", units: ["Pcs", "Box", "Nos"], printUom: "Bundle", packSize: "5 Ply", l1Uom: "Bundle" },
  { name: "Aluminium Foil Container", units: ["Pcs", "Box"], printUom: "Box", packSize: "500 pcs", l1Uom: "Case" },
  { name: "Packaging Tape", units: ["Pcs", "Box"], printUom: "Box", packSize: "65 m", l1Uom: "Carton" },
  { name: "Tissue Paper Roll", units: ["Roll", "Pack"], printUom: "Pack", packSize: "100 pulls", l1Uom: "Carton" },
  { name: "Cling Film Roll", units: ["Roll", "Pcs"], printUom: "Box", packSize: "300 m", l1Uom: "Carton" },
  { name: "Refined Oil 15 L", units: ["Tin", "Litre"], printUom: "Tin", packSize: "15 L", l1Uom: "Tin" },
  { name: "Paneer", units: ["Kg", "Pcs"], printUom: "Pack", packSize: "1 Kg", l1Uom: "Crate" },
  { name: "Basmati Rice", units: ["Kg", "Bag", "Qntl"], printUom: "Bag", packSize: "25 Kg", l1Uom: "Bag" },
  { name: "Sugar", units: ["Kg", "Bag", "Qntl"], printUom: "Bag", packSize: "50 Kg", l1Uom: "Bag" },
  { name: "Tomato", units: ["Kg", "Crate"], printUom: "Crate", packSize: "10 Kg", l1Uom: "Crate" },
  { name: "Onion", units: ["Kg", "Bag"], printUom: "Bag", packSize: "25 Kg", l1Uom: "Bag" },
  { name: "Green Chilli", units: ["Kg", "Pcs"], printUom: "Bag", packSize: "5 Kg", l1Uom: "Bag" },
  { name: "DG Set Hire Charges", units: [], printUom: "—", packSize: "—", l1Uom: "—" }, // service line
];

// Canonical PACT unit master — a bill unit only "matches" if it normalises here.
export const UNIT_MASTER = ["Pcs", "Kg", "Qntl", "Nos", "Pack", "Box", "Bag", "Ream", "Roll", "Tin", "Litre", "Gram", "Crate"] as const;

const UNIT_ALIASES: Record<string, string> = {
  pcs: "Pcs", pc: "Pcs", piece: "Pcs", pieces: "Pcs", pces: "Pcs",
  kg: "Kg", kgs: "Kg", kilogram: "Kg", kgm: "Kg", kilo: "Kg",
  qntl: "Qntl", quintal: "Qntl", qtl: "Qntl",
  nos: "Nos", no: "Nos", number: "Nos", count: "Nos", unit: "Nos",
  pack: "Pack", packet: "Pack", pkt: "Pack", pkts: "Pack", packs: "Pack",
  box: "Box", boxes: "Box", ctn: "Box", carton: "Box", cartons: "Box",
  bag: "Bag", bags: "Bag", sack: "Bag",
  ream: "Ream", rim: "Ream", rm: "Ream", reams: "Ream",
  roll: "Roll", rolls: "Roll",
  tin: "Tin", tins: "Tin",
  litre: "Litre", liter: "Litre", ltr: "Litre", l: "Litre", lt: "Litre",
  gram: "Gram", g: "Gram", gm: "Gram", grams: "Gram", gms: "Gram",
  crate: "Crate", crates: "Crate",
};

// Normalise a bill's unit string to a PACT unit, or null if it can't be matched.
export function matchUnit(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase().replace(/[.\-\s]+/g, "");
  return UNIT_ALIASES[key] ?? null;
}

const tokenize = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((t) => t.length > 1);

// Best-matching PACT product for a bill line name (always returns one).
export function matchProduct(name: string): { product: PactProduct; score: number } {
  const q = tokenize(name);
  if (!q.length) return { product: CATALOG[0], score: 0 };
  let best = CATALOG[0];
  let bestScore = 0;
  for (const p of CATALOG) {
    const t = tokenize(p.name);
    const inter = q.filter((w) => t.includes(w)).length;
    const score = inter / Math.min(q.length, t.length || 1);
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return { product: best, score: Math.max(0, Math.min(1, bestScore)) };
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
