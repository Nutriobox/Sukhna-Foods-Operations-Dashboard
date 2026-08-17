import SUPPLIERS from "./supplier-master.json";

/**
 * Supplier (vendor) master — the "Creditors" ledgers exported from PACT.
 * When a bill is pushed to PACT the party must match one of THESE records
 * (that is what PACT holds), not the free-text name printed on the bill.
 * Matching is by GSTIN first (unique + reliable), then a fuzzy name fallback.
 */
export type Supplier = {
  code: string;
  name: string;
  gstin: string;
  gstState: string;
  gstReg: string;
  city: string;
  addr: string;
  zip: string;
  phone: string;
  email: string;
};

const SUP = SUPPLIERS as Supplier[];
export const ALL_SUPPLIERS = SUP;

const normGst = (g: string) => (g || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

const BY_GST = new Map<string, Supplier>();
for (const s of SUP) {
  const g = normGst(s.gstin);
  if (g && !BY_GST.has(g)) BY_GST.set(g, s);
}

// Drop legal-form / filler words so "Asha Ram & Sons Pvt. Ltd." and
// "Asha Ram And Sons" still line up on their meaningful tokens.
const LEGAL = new Set(["pvt", "private", "ltd", "limited", "llp", "inc", "co", "company", "and", "the"]);
function tokens(s: string): string[] {
  return (s || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !LEGAL.has(w));
}

export type SupplierMatch = { supplier: Supplier | null; by: "gst" | "name" | null; score: number };

// Resolve a bill's vendor to a PACT supplier record. GSTIN wins; otherwise a
// token-overlap name match (>= 0.6) so near-identical names still resolve, but
// weak guesses fall through to "not found" (so the UI can flag + ask).
export function matchSupplier(gst: string, name: string): SupplierMatch {
  const g = normGst(gst);
  if (g && BY_GST.has(g)) return { supplier: BY_GST.get(g) as Supplier, by: "gst", score: 1 };
  const qt = tokens(name);
  if (!qt.length) return { supplier: null, by: null, score: 0 };
  const qset = new Set(qt);
  let best: Supplier | null = null;
  let bestScore = 0;
  for (const s of SUP) {
    const st = tokens(s.name);
    if (!st.length) continue;
    const inter = st.filter((w) => qset.has(w)).length;
    if (!inter) continue;
    const score = inter / Math.max(qt.length, st.length);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  if (best && bestScore >= 0.6) return { supplier: best, by: "name", score: bestScore };
  return { supplier: null, by: null, score: bestScore };
}
