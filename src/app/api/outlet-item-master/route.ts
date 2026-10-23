import { NextResponse } from "next/server";

/**
 * Outlet Item Master — a joined view of PACT BOM items + PetPooja dishes.
 *
 * Groups PACT BOMs by their prefix convention
 *     DIN_BOM*     → Dine In items
 *     Dine_AddOn*  → Dine In add-ons
 *     BOM_O*       → Delivery items
 *     Del_AddOn*   → Delivery add-ons
 *
 * For each PACT item, resolves its PetPooja category by matching the dish
 * name (case-insensitive, stripped of FGO<code>_ prefix, parentheticals and
 * punctuation) against the AIFI dishes table. Items without a PetPooja
 * match land in a special "Uncategorised (no PetPooja match)" bucket and
 * are listed in the "Not Matching" report.
 *
 * Also emits the reverse report — PetPooja dishes that are not present in
 * the PACT BOM for the matching mode.
 *
 *   GET /api/outlet-item-master
 *     ?fresh=1   skip the 60s in-memory cache
 *
 * Response shape:
 *   {
 *     ok, synced_at, counts: { dine_in, delivery, dine_addons, del_addons, unmatched_pact, unmatched_petpooja },
 *     dine_in:  { categories: { [cat: string]: Item[] }, add_ons: Item[] },
 *     delivery: { categories: { [cat: string]: Item[] }, add_ons: Item[] },
 *     not_matching: {
 *       pact_only:     { bom_code, name, mode }[],
 *       petpooja_only: { dish_id, name, category, mode }[],
 *     }
 *   }
 *   Item = { bom_code, fg_code, name, petpooja_dish_id, petpooja_category, bom: BomLine[] }
 *   BomLine = { rm_name, product_code, unit, usage_qty, wastage_pct, raw_qty }
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS" };
const TTL_MS = 60 * 1000;

type BomLine = {
  rm_name: string;
  product_code: string;
  unit: string;
  usage_qty: number;
  wastage_pct: number;
  raw_qty: number;
};
type Item = {
  bom_code: string;
  fg_code: string;
  name: string;
  petpooja_dish_id: number | null;
  petpooja_category: string | null;
  bom: BomLine[];
};
type Section = {
  categories: Record<string, Item[]>;
  add_ons: Item[];
};
type Resp = {
  ok: boolean;
  synced_at: string | null;
  bom_rows: number;
  counts: {
    dine_in: number;
    delivery: number;
    dine_addons: number;
    del_addons: number;
    unmatched_pact: number;
    unmatched_petpooja: number;
  };
  dine_in: Section;
  delivery: Section;
  not_matching: {
    pact_only: { bom_code: string; name: string; mode: string }[];
    petpooja_only: { dish_id: number; name: string; category: string | null; mode: string }[];
  };
  warnings?: string[];
};

let cache: { at: number; payload: Resp } | null = null;

const num = (v: unknown): number => {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const n = parseFloat(String(v).replace(/,/g, ""));
  return isNaN(n) ? 0 : n;
};
const str = (v: unknown): string => (v == null ? "" : String(v).trim());

// Normalize a dish name for matching: lowercase, drop FGO<code>_ prefix,
// strip parentheticals like "(400 Gms)" or "(Veg)", collapse whitespace,
// drop surrounding punctuation.
function normName(s: string): string {
  if (!s) return "";
  let x = s.toLowerCase();
  // Drop the opening "FGO<digits>_" fg-code prefix if present
  x = x.replace(/^f[gh]o?\d+_\s*/, "");
  // Drop the (FP: ...) trailer PACT appends inside the BOM name column
  x = x.replace(/\s*\(fp:[^)]*\)\s*$/, "");
  // Drop parenthetical and bracketed qualifiers. The old regex only
  // caught "(...)" but PetPooja dish names overwhelmingly use "[...]" for
  // the same job — "[300 Ml]", "[6 Pcs]", "[SB]", "[SBN]", "[Combos]".
  // Leaving brackets in made ~96 PetPooja dishes land in the Not Matching
  // list even though PACT had a BOM for the base dish. Also strip some
  // common free-floating qualifier tokens that aren't wrapped — the old
  // regex handled "(Combos)" but PetPooja ships both bracketed AND bare
  // ("Butter(Less) Chicken (4 Pcs)" vs "Butter(Less) Chicken Combos").
  x = x.replace(/\s*[([][^)\]]*[)\]]\s*/g, " ");
  // Drop known qualifier words that appear bare (no brackets) at the end
  // of PetPooja dish names: "Combos", "Full", "Half", "Regular", meal-size
  // markers, and the PetPooja menu suffixes "SB" / "SBN". These are
  // variants of the same base dish; PACT keeps one BOM and leaves the
  // sizing to the operator. Deliberately short list — words like "new",
  // "special", "veg" are part of real dish names, so we leave them alone.
  x = x.replace(/\b(combos?|full|half|regular|large|small|medium|sbn?)\b/g, " ");
  // Normalise ampersands to the word "and" (PACT writes "Tofu AND Walnut",
  // PetPooja writes "Tofu & Walnut"). Do this before stripping punctuation.
  x = x.replace(/\s*&\s*/g, " and ");
  // Drop remaining punctuation (ampersand already handled above)
  x = x.replace(/[^a-z0-9\s]+/g, " ");
  // Collapse whitespace
  x = x.replace(/\s+/g, " ").trim();
  return x;
}

function parsePactBom(rows: unknown[][], headers: string[]) {
  const col = (name: string) => headers.findIndex((h) => String(h).toLowerCase() === name.toLowerCase());
  const iS = col("Section"), iSt = col("Stage"), iB = col("BOMCode"), iD = col("BOM"),
        iPC = col("Product Code"), iPN = col("Product Name"),
        iU = col("Unit"), iUs = col("Usage Qty"), iW = col("Wastage"), iRw = col("Raw Qty");

  // Group BOM lines by BOMCode
  const bomLines = new Map<string, BomLine[]>();
  const bomName = new Map<string, string>();
  for (const r of rows) {
    if (!r || !r.length) continue;
    const code = str(r[iB]);
    if (!code) continue;
    if (!bomName.has(code)) bomName.set(code, str(r[iD]));
    // Only keep INPUT section rows for the BOM-detail table
    if (str(r[iS]).toUpperCase() !== "INPUT") continue;
    const line: BomLine = {
      rm_name: str(r[iPN]),
      product_code: str(r[iPC]),
      unit: str(r[iU]),
      usage_qty: num(r[iUs]),
      wastage_pct: num(r[iW]),
      raw_qty: num(r[iRw]),
    };
    if (!line.rm_name) continue;
    if (!bomLines.has(code)) bomLines.set(code, []);
    bomLines.get(code)!.push(line);
  }

  // Classify by prefix and extract dish name + fg code
  type Raw = { bom_code: string; mode: "dine_in" | "delivery"; kind: "item" | "addon"; dish_name: string; fg_code: string; bom: BomLine[] };
  const raws: Raw[] = [];
  for (const [code, lines] of bomLines) {
    let mode: "dine_in" | "delivery", kind: "item" | "addon";
    if (code.startsWith("DIN_BOM"))        { mode = "dine_in";  kind = "item";  }
    else if (code.startsWith("Dine_AddOn")) { mode = "dine_in";  kind = "addon"; }
    else if (code.startsWith("BOM_O"))      { mode = "delivery"; kind = "item";  }
    else if (code.startsWith("Del_AddOn"))  { mode = "delivery"; kind = "addon"; }
    else continue;

    // BOM name format: "FGO<code>_<Dish Name>   (FP: … )" OR just "ALL CAPS NAME"
    const rawName = bomName.get(code) || "";
    // Strip trailing (FP: …) parenthetical
    let nm = rawName.replace(/\s*\(FP:[^)]*\).*$/i, "").trim();
    const fgMatch = nm.match(/^(F[GH]O?\d+)_\s*(.*)$/i);
    const fg_code = fgMatch ? fgMatch[1].toUpperCase() : "";
    const dish_name = fgMatch ? fgMatch[2].trim() : nm;

    raws.push({ bom_code: code, mode, kind, dish_name, fg_code, bom: lines });
  }
  return raws;
}

type Dish = { id: number; name: string; category: string | null; pp_item_id: string | null };

async function aifiFetch(path: string): Promise<unknown[]> {
  const url = process.env.AIFI_SUPABASE_URL;
  const key = process.env.AIFI_SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("AIFI_SUPABASE_URL / AIFI_SUPABASE_SERVICE_KEY not configured");
  const r = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`AIFI ${path.split("?")[0]}: HTTP ${r.status}`);
  return (await r.json()) as unknown[];
}

async function fetchPetpoojaDishes(): Promise<Dish[]> {
  // Paginate — dishes table may exceed Supabase's 1000-row default limit
  const PAGE = 1000;
  const out: Dish[] = [];
  for (let from = 0; ; from += PAGE) {
    const to = from + PAGE - 1;
    const url = process.env.AIFI_SUPABASE_URL;
    const key = process.env.AIFI_SUPABASE_SERVICE_KEY;
    if (!url || !key) throw new Error("AIFI_SUPABASE_URL / AIFI_SUPABASE_SERVICE_KEY not configured");
    const r = await fetch(`${url.replace(/\/$/, "")}/rest/v1/dishes?select=id,name,category,pp_item_id&order=id.asc`, {
      headers: {
        apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json",
        Range: `${from}-${to}`, "Range-Unit": "items", Prefer: "count=exact",
      },
      cache: "no-store",
    });
    if (!r.ok) throw new Error(`AIFI dishes: HTTP ${r.status}`);
    const batch = (await r.json()) as Dish[];
    out.push(...batch);
    if (batch.length < PAGE) break;
  }
  return out;
}

export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

export async function GET(req: Request) {
  const url = new URL(req.url);
  const fresh = url.searchParams.get("fresh") === "1";

  if (!fresh && cache && Date.now() - cache.at < TTL_MS) {
    return NextResponse.json(cache.payload, { headers: CORS });
  }

  const warnings: string[] = [];

  try {
    // 1) Fetch the latest PACT BOM snapshot
    const sbUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const sbKey = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!sbUrl || !sbKey) {
      return NextResponse.json({ ok: false, error: "Supabase not configured" }, { status: 500, headers: CORS });
    }
    const bomQ = `${sbUrl.replace(/\/$/, "")}/rest/v1/costing_snapshots?report=eq.bom&select=synced_at,data&order=synced_at.desc&limit=1`;
    const bomR = await fetch(bomQ, {
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, Accept: "application/json" },
      cache: "no-store",
    });
    if (!bomR.ok) throw new Error(`BOM snapshot: HTTP ${bomR.status}`);
    const bomRows = (await bomR.json()) as Array<{ synced_at: string; data: unknown[][] }>;
    if (!bomRows.length) {
      return NextResponse.json({ ok: false, error: "no BOM snapshot in Supabase yet" }, { status: 404, headers: CORS });
    }
    const snap = bomRows[0];
    const data = (snap.data || []) as unknown[][];
    if (!data.length) {
      return NextResponse.json({ ok: false, error: "BOM snapshot is empty" }, { status: 500, headers: CORS });
    }
    const headers = (data[0] as string[]).map((h) => String(h || ""));
    const dataRows = data.slice(1);
    const pactItems = parsePactBom(dataRows, headers);

    // 2) PetPooja dishes (all)
    const dishes = await fetchPetpoojaDishes();

    // Index dishes by both EXACT (lowercased, trimmed) name AND aggressive
    // normalized name. The aggressive normalizer strips bracketed qualifiers
    // like "[300 Ml]" so "Blueberry Chia [300 Ml]." matches PACT's
    // "Blueberry Chia (300ML)" — but it ALSO strips meaningful variant
    // qualifiers like "(Masala Veggie)" / "(Chicken Tikka)" / "(Egg White)",
    // which caused all three Hearty Omelettes dishes to collapse into one
    // key and get routed to whichever BOM arrived first. Fix: try an exact
    // (case-insensitive, trimmed) match first — this preserves variant
    // distinctions — and only fall through to the aggressive normalizer
    // when there's no exact hit, so the packaging-qualifier case still
    // works.
    const exactKey = (s: string) => String(s || "").toLowerCase().trim();
    const dishByExact = new Map<string, Dish>();
    const dishByNorm  = new Map<string, Dish>();
    for (const d of dishes) {
      const ek = exactKey(d.name);
      if (ek && !dishByExact.has(ek)) dishByExact.set(ek, d);
      const nk = normName(d.name);
      if (nk && !dishByNorm.has(nk)) dishByNorm.set(nk, d);
    }

    // 3) Build mode-split sections
    const dine_in: Section  = { categories: {}, add_ons: [] };
    const delivery: Section = { categories: {}, add_ons: [] };

    const pactMatchedDishIds = new Set<number>();
    const pactUnmatched: { bom_code: string; name: string; mode: string }[] = [];

    for (const p of pactItems) {
      // Exact match first (variant-safe), then normalised match (packaging-safe).
      const ek = exactKey(p.dish_name);
      const nk = normName(p.dish_name);
      const dish = (ek && dishByExact.get(ek)) || (nk ? dishByNorm.get(nk) : undefined);
      const item: Item = {
        bom_code:         p.bom_code,
        fg_code:          p.fg_code,
        name:             p.dish_name,
        petpooja_dish_id: dish ? dish.id : null,
        petpooja_category: dish ? (dish.category || null) : null,
        bom:              p.bom,
      };
      if (dish) pactMatchedDishIds.add(dish.id);
      else pactUnmatched.push({ bom_code: p.bom_code, name: p.dish_name, mode: p.mode === "dine_in" ? "Dine In" : "Delivery" });

      const section = p.mode === "dine_in" ? dine_in : delivery;
      if (p.kind === "addon") {
        section.add_ons.push(item);
      } else {
        const cat = dish?.category || "Uncategorised (no PetPooja match)";
        if (!section.categories[cat]) section.categories[cat] = [];
        section.categories[cat].push(item);
      }
    }

    // Sort inside each category by name, and sort add-ons too
    for (const sec of [dine_in, delivery]) {
      for (const cat of Object.keys(sec.categories)) {
        sec.categories[cat].sort((a, b) => a.name.localeCompare(b.name));
      }
      sec.add_ons.sort((a, b) => a.name.localeCompare(b.name));
    }

    // 4) Reverse report — PetPooja dishes with NO matching PACT item in either mode.
    //    (We don't try to filter PetPooja dishes by order history — that would need
    //    an expensive 400k-row scan of order_items. If a dish is on the menu but has
    //    no PACT BOM anywhere, that's a flag worth showing regardless of order volume.)
    const pactNamesDineIn   = new Set(pactItems.filter((p) => p.mode === "dine_in").map((p)  => normName(p.dish_name)));
    const pactNamesDelivery = new Set(pactItems.filter((p) => p.mode === "delivery").map((p) => normName(p.dish_name)));
    const petpoojaUnmatched: { dish_id: number; name: string; category: string | null; mode: string }[] = [];
    for (const d of dishes) {
      const nk = normName(d.name);
      if (!nk) continue;
      const inDineIn   = pactNamesDineIn.has(nk);
      const inDelivery = pactNamesDelivery.has(nk);
      if (inDineIn && inDelivery) continue;       // fully matched
      if (!inDineIn && !inDelivery) {
        // Not in PACT at all — report once as "Both"
        petpoojaUnmatched.push({ dish_id: d.id, name: d.name, category: d.category, mode: "Both" });
      } else if (!inDineIn) {
        petpoojaUnmatched.push({ dish_id: d.id, name: d.name, category: d.category, mode: "Dine In" });
      } else {
        petpoojaUnmatched.push({ dish_id: d.id, name: d.name, category: d.category, mode: "Delivery" });
      }
    }

    const payload: Resp = {
      ok: true,
      synced_at: snap.synced_at,
      bom_rows: dataRows.length,
      counts: {
        dine_in:  pactItems.filter((p) => p.mode === "dine_in" && p.kind === "item").length,
        delivery: pactItems.filter((p) => p.mode === "delivery" && p.kind === "item").length,
        dine_addons: dine_in.add_ons.length,
        del_addons: delivery.add_ons.length,
        unmatched_pact:     pactUnmatched.length,
        unmatched_petpooja: petpoojaUnmatched.length,
      },
      dine_in,
      delivery,
      not_matching: {
        pact_only:     pactUnmatched.sort((a, b) => a.name.localeCompare(b.name)),
        petpooja_only: petpoojaUnmatched.sort((a, b) => a.name.localeCompare(b.name)),
      },
      warnings: warnings.length ? warnings : undefined,
    };

    cache = { at: Date.now(), payload };
    return NextResponse.json(payload, { headers: CORS });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: CORS });
  }
}
