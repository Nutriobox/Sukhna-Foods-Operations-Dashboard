import { NextResponse } from "next/server";

/**
 * Per-dish, per-outlet, per-day sales for the Outlet Consumption dashboard's
 * Sales Reconciliation tab. Reads from the AI Food Inspector Supabase project
 * (kneqaeuggiibhxiardef) — the same database PetPooja's real-time webhooks
 * have been pushing into since mid-2026 — then joins the four tables we care
 * about and aggregates server-side so the browser receives a compact,
 * ready-to-render payload rather than megabytes of row-level JSON.
 *
 *   GET /api/outlet-sales
 *     ?from=YYYY-MM-DD        default: 7 days ago (IST)
 *     ?to=YYYY-MM-DD          default: today (IST, inclusive)
 *     ?outlet_id=<n>          restaurants.id (optional)
 *     ?channel=<zomato|swiggy|pos|...>  (optional, case-insensitive)
 *     ?limit_orders=N         pulled-order cap (default 50 000, max 100 000)
 *
 * Pagination: Supabase REST hard-caps a single response at ~1 000 rows
 * regardless of a `limit=…` query param. The fetcher below pages through
 * the result set with the `Range` header until either the data is exhausted
 * or `limit_orders` is reached, so one API call to this endpoint always
 * returns the complete window (short of the safety cap).
 *
 * Everything cross-project — the OPS DASHBOARD Supabase is not touched, nothing
 * is written to the AIFI side. 60 s in-memory cache per (from, to, outlet,
 * channel) tuple so a page refresh doesn't re-query AIFI.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS" };
const TTL_MS = 60 * 1000;
const MAX_LIMIT = 100_000;
const DEFAULT_LIMIT = 50_000;
const PAGE_SIZE = 1_000; // Supabase REST default max_rows

type CacheEntry = { at: number; body: unknown };
const CACHE = new Map<string, CacheEntry>();

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

type Order = {
  id: number;
  restaurant_id: number;
  channel: string | null;
  order_type: string | null;
  placed_at: string | null;
  status: string | null;
};
type OrderItem = { order_id: number; dish_id: number; quantity: number | null };
type Dish = { id: number; name: string; category: string | null; pp_item_id: string | null; expected_grams: number | null };
type Restaurant = { id: number; name: string; pp_rest_id: string | null };

/** Single-page REST GET to Supabase (no pagination). */
async function sbGet<T>(url: string, key: string, path: string): Promise<T[]> {
  const r = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`AIFI ${path.split("?")[0]}: HTTP ${r.status} ${t.slice(0, 200)}`);
  }
  return (await r.json()) as T[];
}

/** Paginated REST GET using the `Range` header. Pulls PAGE_SIZE rows per
 *  request until the result set is exhausted or `max` rows have been
 *  collected. Supabase sends a `Content-Range` header on each response, so
 *  we stop when the returned slice is shorter than the page size. */
async function sbGetPaged<T>(url: string, key: string, path: string, max: number): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  while (out.length < max) {
    const to = Math.min(from + PAGE_SIZE - 1, max - 1);
    const r = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${path}`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        Range: `${from}-${to}`,
        "Range-Unit": "items",
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

async function fetchOrderItemsForOrders(url: string, key: string, orderIds: number[]): Promise<OrderItem[]> {
  const out: OrderItem[] = [];
  const BATCH = 400; // keep the IN(…) clause reasonable
  for (let i = 0; i < orderIds.length; i += BATCH) {
    const batch = orderIds.slice(i, i + BATCH);
    const q = `order_items?select=order_id,dish_id,quantity&order_id=in.(${batch.join(",")})`;
    // order_items can also exceed 1 000 rows for a batch of 400 orders — paginate it too.
    const rows = await sbGetPaged<OrderItem>(url, key, q, 50_000);
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
    const q = `dishes?select=id,name,category,pp_item_id,expected_grams&id=in.(${batch.join(",")})`;
    const rows = await sbGet<Dish>(url, key, q);
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
  const limit = Math.min(Number(u.searchParams.get("limit_orders") || DEFAULT_LIMIT), MAX_LIMIT);
  const fresh = u.searchParams.get("fresh") === "1";

  const cacheKey = JSON.stringify({ from, to, outletFilter, channelFilter, limit });
  if (!fresh) {
    const hit = CACHE.get(cacheKey);
    if (hit && Date.now() - hit.at < TTL_MS) {
      return NextResponse.json(hit.body as Record<string, unknown>, { headers: CORS });
    }
  }

  try {
    const restaurants = await sbGet<Restaurant>(url, key, "restaurants?select=id,name,pp_rest_id&order=id.asc");
    const restByCode = new Map(restaurants.map((r) => [r.id, r]));

    // orders.placed_at is TEXT ("YYYY-MM-DD HH:MM:SS"), which sorts
    // lexicographically — a text-range filter is correct.
    const fromTs = `${from} 00:00:00`;
    const toTs   = `${to} 23:59:59`;
    const orderFilters = [
      "select=id,restaurant_id,channel,order_type,placed_at,status",
      `placed_at=gte.${encodeURIComponent(fromTs)}`,
      `placed_at=lte.${encodeURIComponent(toTs)}`,
      `order=placed_at.desc`,
    ];
    if (outletFilter) orderFilters.push(`restaurant_id=eq.${encodeURIComponent(outletFilter)}`);
    if (channelFilter) orderFilters.push(`channel=ilike.${encodeURIComponent(channelFilter)}`);
    const orders = await sbGetPaged<Order>(url, key, `orders?${orderFilters.join("&")}`, limit);

    if (!orders.length) {
      const empty = {
        ok: true, from, to,
        filters: { outlet_id: outletFilter, channel: channelFilter, limit_orders: limit },
        outlets: restaurants, categories: [], rows: [],
        totals: { orders: 0, line_items: 0, unique_dishes: 0, unique_outlets: 0 },
        warning: "no orders in this window",
      };
      CACHE.set(cacheKey, { at: Date.now(), body: empty });
      return NextResponse.json(empty, { headers: CORS });
    }

    const orderIds = orders.map((o) => o.id);
    const orderItems = await fetchOrderItemsForOrders(url, key, orderIds);
    const dishIds = Array.from(new Set(orderItems.map((oi) => oi.dish_id).filter((v) => v != null)));
    const dishMap = await fetchDishes(url, key, dishIds);

    const orderById = new Map(orders.map((o) => [o.id, o]));
    type Key = string;
    type AggRow = {
      dish_id: number;
      dish_name: string;
      category: string | null;
      pp_item_id: string | null;
      outlet_id: number;
      outlet_name: string;
      sold_qty: number;
      order_count: number;
      channels: Record<string, number>;
    };
    const agg = new Map<Key, AggRow>();
    const seenOrderPerDish = new Map<Key, Set<number>>();
    const categoryHits = new Map<string, number>();

    for (const oi of orderItems) {
      const o = orderById.get(oi.order_id);
      if (!o) continue;
      const d = dishMap.get(oi.dish_id);
      if (!d) continue;
      const outlet = restByCode.get(o.restaurant_id);
      const outletName = outlet?.name || `restaurant ${o.restaurant_id}`;
      const qty = Number(oi.quantity) || 0;
      const key: Key = `${d.id}|${o.restaurant_id}`;
      let row = agg.get(key);
      if (!row) {
        row = {
          dish_id: d.id, dish_name: d.name, category: d.category, pp_item_id: d.pp_item_id,
          outlet_id: o.restaurant_id, outlet_name: outletName,
          sold_qty: 0, order_count: 0, channels: {},
        };
        agg.set(key, row);
      }
      row.sold_qty += qty;
      const ch = (o.channel || "Unknown").trim() || "Unknown";
      row.channels[ch] = (row.channels[ch] || 0) + qty;
      let orderSet = seenOrderPerDish.get(key);
      if (!orderSet) { orderSet = new Set(); seenOrderPerDish.set(key, orderSet); }
      if (!orderSet.has(o.id)) { orderSet.add(o.id); row.order_count += 1; }
      if (d.category) categoryHits.set(d.category, (categoryHits.get(d.category) || 0) + qty);
    }

    const rows = [...agg.values()].sort((a, b) => b.sold_qty - a.sold_qty);
    const categories = [...categoryHits.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);

    const body = {
      ok: true,
      from, to,
      filters: { outlet_id: outletFilter, channel: channelFilter, limit_orders: limit },
      outlets: restaurants,
      categories,
      rows,
      totals: {
        orders: orders.length,
        line_items: orderItems.length,
        unique_dishes: new Set(rows.map((r) => r.dish_id)).size,
        unique_outlets: new Set(rows.map((r) => r.outlet_id)).size,
        limit_hit: orders.length >= limit,
      },
    };
    CACHE.set(cacheKey, { at: Date.now(), body });
    return NextResponse.json(body, { headers: CORS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: CORS });
  }
}
