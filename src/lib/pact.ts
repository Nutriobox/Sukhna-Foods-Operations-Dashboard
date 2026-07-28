// PACT item-master matching (offline simulation).
// This mirrors how a real PACT integration would resolve a bill line against
// the PACT product catalogue and unit master. Swap CATALOG / UNIT_MASTER for the
// live PACT API response when it's available — the matching logic stays the same.

export type PactProduct = { name: string; units: string[] };

// A representative slice of a PACT item master.
export const CATALOG: PactProduct[] = [
  { name: "Lime Seasoning 500 g", units: ["Pcs", "Pack"] },
  { name: "Alidada Mini Mogra Rice 30 Kg", units: ["Bag", "Qntl", "Kg"] },
  { name: "Alidada Tibar Rice 30 Kg", units: ["Bag", "Qntl", "Kg"] },
  { name: "Banana Yellow", units: ["Kg", "Pcs"] },
  { name: "Button Mushroom 200 g", units: ["Pack", "Pcs", "Kg"] },
  { name: "Heat Sealing Packing Roll 360 mm", units: ["Roll", "Pcs"] },
  { name: "Food Container 1200 ml White", units: ["Pcs", "Box", "Nos"] },
  { name: "Paper Flat Bowl 750 ml White", units: ["Pcs", "Box", "Nos"] },
  { name: "Paper Container 250 ml White", units: ["Pcs", "Box", "Nos"] },
  { name: "Cellulose Gel FP 90", units: ["Pcs", "Box"] },
  { name: "A4 Copier Paper 75 GSM", units: ["Ream", "Pack", "Box"] },
  { name: "Corrugated Box 5 Ply", units: ["Pcs", "Box", "Nos"] },
  { name: "Aluminium Foil Container", units: ["Pcs", "Box"] },
  { name: "Packaging Tape", units: ["Pcs", "Box"] },
  { name: "Tissue Paper Roll", units: ["Roll", "Pack"] },
  { name: "Cling Film Roll", units: ["Roll", "Pcs"] },
  { name: "Refined Oil 15 L", units: ["Tin", "Litre"] },
  { name: "Paneer", units: ["Kg", "Pcs"] },
  { name: "Basmati Rice", units: ["Kg", "Bag", "Qntl"] },
  { name: "Sugar", units: ["Kg", "Bag", "Qntl"] },
  { name: "Tomato", units: ["Kg", "Crate"] },
  { name: "Onion", units: ["Kg", "Bag"] },
  { name: "Green Chilli", units: ["Kg", "Pcs"] },
  { name: "DG Set Hire Charges", units: [] }, // a service line — no stockable unit
];

// The canonical PACT unit master. A bill unit only "matches" if it normalises
// into one of these.
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

// Best-matching PACT product for a bill line name (always returns something).
export function matchProduct(name: string): { name: string; score: number } {
  const q = tokenize(name);
  if (!q.length) return { name: CATALOG[0].name, score: 0 };
  let best = CATALOG[0].name;
  let bestScore = 0;
  for (const p of CATALOG) {
    const t = tokenize(p.name);
    const inter = q.filter((w) => t.includes(w)).length;
    const score = inter / Math.min(q.length, t.length || 1);
    if (score > bestScore) { bestScore = score; best = p.name; }
  }
  return { name: best, score: Math.max(0, Math.min(1, bestScore)) };
}

export type PactLine = {
  billName: string;
  product: string;      // PACT-matched product name
  confidence: number;   // 0..100
  unit: string | null;  // PACT purchase unit (null = not matched)
  uom: string | null;   // PACT stock UOM (same source/logic as unit)
  qty: number | null;   // purchase quantity (null when unit unmatched)
  rate: number | null;  // purchase rate from bill
  matched: boolean;     // unit & uom both resolved
};

// Resolve one bill item into its PACT entry shape.
export function resolveLine(it: { name: string; uom: string; qty: number; price: number | null }): PactLine {
  const p = matchProduct(it.name);
  const unit = matchUnit(it.uom);
  const matched = unit !== null;
  return {
    billName: it.name,
    product: p.name,
    confidence: Math.round(p.score * 100),
    unit,
    uom: unit,
    qty: matched ? it.qty : null,
    rate: it.price,
    matched,
  };
}
