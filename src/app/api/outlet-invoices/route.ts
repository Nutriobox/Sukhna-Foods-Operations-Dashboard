import { NextResponse } from "next/server";

/**
 * Row-level PetPooja sales — one row per order_item — for the Sales Data tab
 * in Outlet Consumption. Reads orders × order_items × dishes × restaurants
 * from the AI Food Inspector Supabase (project kneqaeuggiibhxiardef, the
 * webhook sink PetPooja and PACT push into) and returns a shape mirrored on
 * PetPooja's "POS Sale Invoice Report" Excel so the UI can show every real
 * webhook column exactly where the Excel puts it.
 *
 * NOTE: the webhook feed captures the KOT / order-placement signal only. The
 * billing-side columns (Doc No in NB01/60955 format, Unit MRP Price, Value,
 * DiscPer, DiscAmt, GST HSN/SAC, SGST / CGST / IGST amounts, Tax, Roff) live
 * in PetPooja's billing module and are NOT in the webhook payload we store.
 * This endpoint returns them as null; the UI surfaces that gap explicitly
 * ("— needs PetPooja Billing API") rather than hiding it. When Satvik lands
 * the Global Sales API feed, the fields slot in with no shape change.
 *
 *   GET /api/outlet-invoices
 *     ?from=YYYY-MM-DD      default: 7 days ago (IST)
 *     ?to=YYYY-MM-DD        default: today (IST, inclusive)
 *     ?outlet_id=<n>        restaurants.id (optional)
 *     ?channel=<...>        case-insensitive ilike match (optional)
 *     ?search=<text>        dish-name substring match (optional)
 *     ?limit_rows=N         row cap (default 2 000, max 10 000)
 *
 *   Response: { ok, from, to, outlets, rows: [...], totals, filters, warnings? }
 *   Each row:
 *     { doc_prefix, doc_no, doc_date, product_name, qty, units,
 *       unit_mrp_price, value, disc_per, disc_amt, gst_hsn, product_type,
 *       tax, sgst_pct, sgst_amt, cgst_pct, cgst_amt, igst_pct, igst_amt,
 *       roff, remarks, created_date,
 *       // Our-side extras not in the Excel but useful:
 *       outlet_id, outlet_name, channel, order_type, pp_order_code, dish_id, category }
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS" };
const PAGE_SIZE = 1_000;
const DEFAULT_LIMIT = 2_000;
const MAX_LIMIT = 10_000;

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

type Order = {
  id: number; code: string | null; restaurant_id: number; table_no: string | null;
  customer: string | null; channel: string | null; order_type: string | null;
  placed_at: string | null; status: string | null; kot: string | null;
  ext_id: string | null; notes: string | null;
};
type OrderItem = { order_id: number; dish_id: number; quantity: number | null };
type Dish = { id: number; name: string; category: string | null };
type Restaurant = { id: number; name: string; pp_rest_id: string | null };

async function sbGet<T>(url: string, key: string, path: string): Promise<T[]> {
  const r = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`AIFI ${path.split("?")[0]}: HTTP ${r.status}`);
  return (await r.json()) as T[];
}

async function sbGetPaged<T>(url: string, key: string, path: string, max: number): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  while (out.length < max) {
    const to = Math.min(from + PAGE_SIZE - 1, max - 1);
    const r = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${path}`, {
      headers: {
        apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json",
        Range: `${from}-${to}`, "Range-Unit": "items",
      },
      cache: "no-store",
    });
    if (!r.ok && r.status !== 206) {
      const t = await r.text().catch(() => "");
      throw new Error(`AIFI ${path.split("?")[0]}: HTTP ${r.status} ${t.slice(0, 200)}`);
    }
    const page = (await r.json()) as T[];
    out.push(...page);
    if (page.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return out;
}

async function fetchItemsFor(url: string, key: string, orderIds: number[]): Promise<OrderItem[]> {
  const out: OrderItem[] = [];
  const BATCH = 400;
  for (let i = 0; i < orderIds.length; i += BATCH) {
    const batch = orderIds.slice(i, i + BATCH);
    const rows = await sbGetPaged<OrderItem>(url, key,
      `order_items?select=order_id,dish_id,quantity&order_id=in.(${batch.join(",")})`, 20_000);
    out.push(...rows);
  }
  return out;
}

async function fetchDishes(url: string, key: string, dishIds: number[]): Promise<Map<number, Dish>> {
  const map = new Map<number, Dish>();
  if (!dishIds.length) return map;
  const BATCH = 400;
  for (let i = 0; i < dishIds.length; i += BATCH) {
    const batch = dishIds.slice(i, i + BATCH);
    const rows = await sbGet<Dish>(url, key, `dishes?select=id,name,category&id=in.(${batch.join(",")})`);
    for (const d of rows) map.set(d.id, d);
  }
  return map;
}

function istToday(): string {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
function istDaysAgo(n: number): string {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000 - n * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

/** Short NB-style outlet code from the restaurant row. Picks NB + two-digit id,
 *  mirroring the "NB01, NB02, …" convention the PetPooja billing Excel uses. */
function outletCode(r: Restaurant | undefined, id: number): string {
  if (!r) return `R${id}`;
  const n = String(id).padStart(2, "0");
  return `NB${n}`;
}

export async function GET(req: Request) {
  const url = process.env.AIFI_SUPABASE_URL;
  const key = process.env.AIFI_SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    return NextResponse.json({ ok: false, error: "AIFI_SUPABASE_URL / AIFI_SUPABASE_SERVICE_KEY not configured" }, { status: 500, headers: CORS });
  }

  const u = new URL(req.url);
  const to = u.searchParams.get("to") || istToday();
  const from = u.searchParams.get("from") || istDaysAgo(7);
  const outletFilter = u.searchParams.get("outlet_id");
  const channelFilter = u.searchParams.get("channel");
  const search = (u.searchParams.get("search") || "").trim().toLowerCase();
  const limit = Math.min(Number(u.searchParams.get("limit_rows") || DEFAULT_LIMIT), MAX_LIMIT);

  try {
    const restaurants = await sbGet<Restaurant>(url, key, "restaurants?select=id,name,pp_rest_id&order=id.asc");
    const restByCode = new Map(restaurants.map((r) => [r.id, r]));

    // Date range on placed_at (text column, YYYY-MM-DD HH:MM:SS, lexicographic sort works)
    const fromTs = `${from} 00:00:00`;
    const toTs   = `${to} 23:59:59`;
    const orderFilters = [
      "select=id,code,restaurant_id,table_no,customer,channel,order_type,placed_at,status,kot,ext_id,notes",
      `placed_at=gte.${encodeURIComponent(fromTs)}`,
      `placed_at=lte.${encodeURIComponent(toTs)}`,
      `order=placed_at.desc`,
    ];
    if (outletFilter) orderFilters.push(`restaurant_id=eq.${encodeURIComponent(outletFilter)}`);
    if (channelFilter) orderFilters.push(`channel=ilike.${encodeURIComponent(channelFilter)}`);

    // Pull orders — cap at a generous multiple of limit_rows so we don't miss recent
    // orders when a line-item filter is applied. Each order averages ~2 line items.
    const orderCap = Math.min(limit * 3, 30_000);
    const orders = await sbGetPaged<Order>(url, key, `orders?${orderFilters.join("&")}`, orderCap);

    if (!orders.length) {
      return NextResponse.json({
        ok: true, from, to,
        filters: { outlet_id: outletFilter, channel: channelFilter, search, limit_rows: limit },
        outlets: restaurants, rows: [], totals: { rows: 0, orders: 0, unique_products: 0 },
        warnings: ["No orders in this window."],
      }, { headers: CORS });
    }

    const orderIds = orders.map((o) => o.id);
    const items = await fetchItemsFor(url, key, orderIds);
    const dishIds = Array.from(new Set(items.map((i) => i.dish_id).filter((v) => v != null)));
    const dishMap = await fetchDishes(url, key, dishIds);
    const orderById = new Map(orders.map((o) => [o.id, o]));

    // Build row-level view (one row per order_item), sorted by created-date desc
    type Row = {
      doc_prefix: string; doc_no: string | null; doc_date: string; product_name: string;
      qty: number; units: null; unit_mrp_price: null; value: null;
      disc_per: null; disc_amt: null; gst_hsn: null; product_type: null;
      tax: null; sgst_pct: null; sgst_amt: null; cgst_pct: null; cgst_amt: null;
      igst_pct: null; igst_amt: null; roff: null; remarks: string | null;
      created_date: string | null;
      outlet_id: number; outlet_name: string; channel: string | null; order_type: string | null;
      pp_order_code: string | null; dish_id: number; category: string | null;
    };
    const rows: Row[] = [];
    for (const it of items) {
      const o = orderById.get(it.order_id); if (!o) continue;
      const d = dishMap.get(it.dish_id); if (!d) continue;
      if (search && !d.name.toLowerCase().includes(search)) continue;
      const rest = restByCode.get(o.restaurant_id);
      const prefix = outletCode(rest, o.restaurant_id);
      const dateOnly = (o.placed_at || "").slice(0, 10);
      // Doc Date in dd/mm/yyyy (PetPooja billing style)
      const dmy = dateOnly.length === 10 ? `${dateOnly.slice(8,10)}/${dateOnly.slice(5,7)}/${dateOnly.slice(0,4)}` : dateOnly;
      // Doc No: proxy with PetPooja order code (the real NB01/60955 billing number isn't in the webhook)
      rows.push({
        doc_prefix: `${prefix}/`,
        doc_no: o.code ? `I-${prefix}/${o.code.replace(/^PP-/, "")}` : null,
        doc_date: dmy,
        product_name: d.name,
        qty: Number(it.quantity) || 0,
        units: null,
        unit_mrp_price: null,
        value: null,
        disc_per: null,
        disc_amt: null,
        gst_hsn: null,
        product_type: null,
        tax: null, sgst_pct: null, sgst_amt: null, cgst_pct: null, cgst_amt: null,
        igst_pct: null, igst_amt: null, roff: null,
        remarks: o.notes,
        created_date: o.placed_at,
        outlet_id: o.restaurant_id,
        outlet_name: rest?.name || `restaurant ${o.restaurant_id}`,
        channel: o.channel,
        order_type: o.order_type,
        pp_order_code: o.code,
        dish_id: d.id,
        category: d.category,
      });
    }
    // Already in order-desc because orders were fetched in placed_at desc; keep natural order.
    const clipped = rows.slice(0, limit);

    return NextResponse.json({
      ok: true, from, to,
      filters: { outlet_id: outletFilter, channel: channelFilter, search, limit_rows: limit },
      outlets: restaurants,
      rows: clipped,
      totals: {
        rows: clipped.length,
        rows_total: rows.length,
        orders: orders.length,
        unique_products: new Set(clipped.map((r) => r.dish_id)).size,
        limit_hit: rows.length > limit,
      },
      warnings: [
        "Price, Value, Discount, GST / HSN / Tax columns are null — they live in PetPooja's billing module (Global Sales API) which is not in the webhook feed. The UI shows these as '— needs PetPooja Billing API' until that feed is wired up.",
      ],
    }, { headers: CORS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: CORS });
  }
}
