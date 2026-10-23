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
 *     ?from=YYYY-MM-DD[THH:mm[:ss]]  default: 7 days ago (IST). Date-only -> 00:00:00 of that day.
 *     ?to=YYYY-MM-DD[THH:mm[:ss]]    default: today (IST). Date-only -> 23:59:59 of that day.
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
export const maxDuration = 60;  // seconds — needed because 7-day windows can hit 25k+ rows

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
  // Billing fields — populated from PetPooja webhook payload
  invoice_no: string | null; payment_type: string | null; customer_phone: string | null; customer_address: string | null; biller: string | null;
  order_total: number | null; core_total: number | null; tax_total: number | null; discount_total: number | null;
  round_off: number | null; service_charge: number | null; delivery_charges: number | null; packaging_charge: number | null;
  // Extended Order Summary Item Report fields
  pp_status: string | null; sub_order_type: string | null; group_name: string | null;
  assignee: string | null; no_of_persons: number | null;
  additional_charge: number | null; deduction_charge: number | null; waived_off: number | null;
  order_cancel_reason: string | null; transaction_id: string | null;
};
type OrderItem = {
  order_id: number; dish_id: number; quantity: number | null;
  unit_price: number | null; item_total: number | null; item_tax: number | null; item_discount: number | null;
  item_code: string | null; sap_code: string | null;
  pp_category_name: string | null; specialnotes: string | null;
};
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
  // Parallelize the batches so a 25k-order window doesn't block for 40+ s
  // sequentially. CONCURRENCY picked conservatively — Supabase REST handles
  // bursts fine but we're sharing a free-tier project.
  const BATCH = 400;
  const CONCURRENCY = 6;
  const batches: number[][] = [];
  for (let i = 0; i < orderIds.length; i += BATCH) batches.push(orderIds.slice(i, i + BATCH));
  const out: OrderItem[] = [];
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const slice = batches.slice(i, i + CONCURRENCY);
    const results = await Promise.all(slice.map((b) =>
      sbGetPaged<OrderItem>(url, key,
        `order_items?select=order_id,dish_id,quantity,unit_price,item_total,item_tax,item_discount,item_code,sap_code,pp_category_name,specialnotes&order_id=in.(${b.join(",")})`, 20_000)
    ));
    for (const rows of results) out.push(...rows);
  }
  return out;
}

async function fetchDishes(url: string, key: string, dishIds: number[]): Promise<Map<number, Dish>> {
  const map = new Map<number, Dish>();
  if (!dishIds.length) return map;
  const BATCH = 400;
  const batches: number[][] = [];
  for (let i = 0; i < dishIds.length; i += BATCH) batches.push(dishIds.slice(i, i + BATCH));
  const results = await Promise.all(batches.map((b) =>
    sbGet<Dish>(url, key, `dishes?select=id,name,category&id=in.(${b.join(",")})`)
  ));
  for (const rows of results) for (const d of rows) map.set(d.id, d);
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
  let outletFilter = u.searchParams.get("outlet_id");
  const outletNameFilter = u.searchParams.get("outlet_name");
  const channelFilter = u.searchParams.get("channel");
  const orderTypeFilter = u.searchParams.get("order_type");
  const search = (u.searchParams.get("search") || "").trim().toLowerCase();
  const limit = Math.min(Number(u.searchParams.get("limit_rows") || DEFAULT_LIMIT), MAX_LIMIT);

  try {
    const restaurants = await sbGet<Restaurant>(url, key, "restaurants?select=id,name,pp_rest_id&order=id.asc");
    const restByCode = new Map(restaurants.map((r) => [r.id, r]));

    // outlet_name=... resolves to outlet_id by matching restaurants.name on
    // the server side. Keeps the Supabase orders query filtered to one outlet
    // so a wide window doesn't need a 50k-row cap just to get one outlet's
    // rows through. Dashboard uses outlet_name (short branch label like
    // 'DLF Phase 2'); internal callers can still pass outlet_id directly.
    //
    // Resolution order — this matters when branch labels share a substring
    // (e.g. "Noida" is contained in both "NutrioBox (Noida)" and "NutrioBox
    // (Sector 63 Noida)"). A plain .includes() would silently pick whichever
    // row appears first in id order, routing "Noida" requests to Sector 63
    // Noida (id=3 vs id=7). Match in this priority instead:
    //   1. Exact match on the branch label inside the parens
    //      ("noida" == "noida" ✓; "sector 63 noida" ≠ "noida")
    //   2. Exact match on the full name (case-insensitive)
    //   3. Substring match on the full name — pick the row whose branch
    //      label is shortest among the hits (shortest = most specific)
    if (!outletFilter && outletNameFilter) {
      const needle = outletNameFilter.toLowerCase().trim();
      const label = (r: Restaurant) => {
        const m = (r.name || "").match(/\(([^)]+)\)/);
        return (m ? m[1] : (r.name || "")).toLowerCase().trim();
      };
      let match = restaurants.find((r) => label(r) === needle);
      if (!match) match = restaurants.find((r) => (r.name || "").toLowerCase().trim() === needle);
      if (!match) {
        const hits = restaurants.filter((r) => (r.name || "").toLowerCase().includes(needle));
        hits.sort((a, b) => label(a).length - label(b).length);
        match = hits[0];
      }
      if (match) outletFilter = String(match.id);
    }

    // Date range on placed_at (text column, YYYY-MM-DD HH:MM:SS, lexicographic sort works).
    // Dashboard sends either 'YYYY-MM-DD' (date-only) OR 'YYYY-MM-DDTHH:mm[:ss]' (datetime-local)
    // — the dashboard swapped date inputs for datetime-local on 2026-10-19 so the user
    // can filter by time of day, not just date. Normalise either shape to Postgres text
    // timestamp: date-only gets padded to 00:00:00 (from) / 23:59:59 (to) as before.
    const normTs = (s: string, boundary: "from" | "to"): string => {
      const raw = String(s || "").trim();
      // Already has time (has 'T' or a space between date and digits)
      if (/T\d/.test(raw) || /\s\d/.test(raw)) {
        // Replace T with space and pad seconds if missing: '2026-10-19T14:30' -> '2026-10-19 14:30:00'
        const spaced = raw.replace("T", " ");
        return /:\d{2}:\d{2}$/.test(spaced) ? spaced : spaced + ":00";
      }
      // Plain date -> start/end of day
      return boundary === "from" ? `${raw} 00:00:00` : `${raw} 23:59:59`;
    };
    const fromTs = normTs(from, "from");
    const toTs   = normTs(to, "to");
    const orderFilters = [
      "select=id,code,restaurant_id,table_no,customer,channel,order_type,placed_at,status,kot,ext_id,notes,invoice_no,payment_type,customer_phone,customer_address,order_total,core_total,tax_total,discount_total,round_off,service_charge,delivery_charges,packaging_charge,biller,pp_status,sub_order_type,group_name,assignee,no_of_persons,additional_charge,deduction_charge,waived_off,order_cancel_reason,transaction_id",
      `placed_at=gte.${encodeURIComponent(fromTs)}`,
      `placed_at=lte.${encodeURIComponent(toTs)}`,
      `order=placed_at.desc`,
    ];
    if (outletFilter) orderFilters.push(`restaurant_id=eq.${encodeURIComponent(outletFilter)}`);
    if (channelFilter) orderFilters.push(`channel=ilike.${encodeURIComponent(channelFilter)}`);
    if (orderTypeFilter) orderFilters.push(`order_type=ilike.${encodeURIComponent(orderTypeFilter)}`);

    // Pull orders — cap at a generous multiple of limit_rows so we don't miss recent
    // orders when a line-item filter is applied. Each order averages ~2 line items.
    const orderCap = Math.min(limit * 3, 30_000);
    const orders = await sbGetPaged<Order>(url, key, `orders?${orderFilters.join("&")}`, orderCap);

    if (!orders.length) {
      return NextResponse.json({
        ok: true, from, to,
        filters: { outlet_id: outletFilter, channel: channelFilter, order_type: orderTypeFilter, search, limit_rows: limit },
        outlets: restaurants, rows: [], totals: { rows: 0, orders: 0, unique_products: 0 },
        warnings: ["No orders in this window."],
      }, { headers: CORS });
    }

    const orderIds = orders.map((o) => o.id);
    const items = await fetchItemsFor(url, key, orderIds);
    const dishIds = Array.from(new Set(items.map((i) => i.dish_id).filter((v) => v != null)));
    const dishMap = await fetchDishes(url, key, dishIds);
    const orderById = new Map(orders.map((o) => [o.id, o]));

    // Build row-level view (one row per order_item) using the real billing fields
    // from the PetPooja webhook payload (backfilled into orders + order_items on
    // 2026-10-17 from petpooja_events.raw). Field names match what the dashboard's
    // Sales Data renderer looks for.
    // Row shape mirrors PetPooja's "Order Summary Item Report" CSV column-for-column
    // (plus a few join-side fields like outlet_id for filtering). The dashboard
    // renders these in the same order the CSV uses so Satvik's team sees the
    // familiar layout.
    type Row = {
      // 32 CSV columns in CSV order
      restaurant_name: string;
      invoice_no: string | null;
      date: string | null;
      payment_type: string | null;
      order_type: string | null;
      status: string | null;
      area: string | null;
      virtual_brand_name: string | null;
      brand_grouping: string | null;
      assign_to: string | null;
      customer_phone: string | null;
      customer_name: string | null;
      customer_address: string | null;
      persons: number | null;
      order_cancel_reason: string | null;
      my_amount: number | null;
      total_tax: number | null;
      discount: number | null;
      delivery_charge: number | null;
      container_charge: number | null;
      service_charge: number | null;
      additional_charge: number | null;
      deduction_charge: number | null;
      waived_off: number | null;
      round_off: number | null;
      total: number | null;
      item_name: string;
      category_name: string | null;
      sap_code: string | null;
      item_price: number | null;
      item_quantity: number | null;
      item_total: number | null;
      // Join-side fields the dashboard uses but aren't CSV columns
      outlet_id: number; dish_id: number; biller: string | null;
      pp_order_code: string | null; transaction_id: string | null;
    };
    const rows: Row[] = [];
    for (const it of items) {
      const o = orderById.get(it.order_id); if (!o) continue;
      const d = dishMap.get(it.dish_id); if (!d) continue;
      if (search && !d.name.toLowerCase().includes(search)) continue;
      const rest = restByCode.get(o.restaurant_id);
      const prefix = outletCode(rest, o.restaurant_id);
      const dateOnly = (o.placed_at || "").slice(0, 10);
      // Prefer the real PetPooja invoice_no when present (backfilled); fall back to the PP order code otherwise.
      const invoice = o.invoice_no || (o.code ? o.code.replace(/^PP-\d*-?/, "") : null);
      // Derive the dashboard status from every cancellation signal AIFI
      // carries, not just pp_status. In production (verified 2026-10-23) the
      // webhook sink was dropping cancelled orders from pp_status while
      // still writing order_cancel_reason, so the dashboard was showing
      // "Success" for them (and status filter couldn't isolate them). Order:
      //   1. order_cancel_reason set → "Cancelled" (unambiguous)
      //   2. status column ~ "cancel" → "Cancelled"
      //   3. pp_status as-is (usually "Success")
      let statusOut: string | null = o.pp_status;
      const stLow = String(o.status || "").toLowerCase();
      if (o.order_cancel_reason && String(o.order_cancel_reason).trim()) {
        statusOut = "Cancelled";
      } else if (stLow.includes("cancel")) {
        statusOut = "Cancelled";
      }
      rows.push({
        restaurant_name:     rest?.name || `restaurant ${o.restaurant_id}`,
        invoice_no:          invoice,
        date:                o.placed_at,
        payment_type:        o.payment_type,
        order_type:          o.order_type,
        status:              statusOut,
        area:                o.channel,
        virtual_brand_name:  o.sub_order_type,
        brand_grouping:      o.group_name,
        assign_to:           o.assignee,
        customer_phone:      o.customer_phone,
        customer_name:       o.customer,
        customer_address:    o.customer_address,
        persons:             o.no_of_persons,
        order_cancel_reason: o.order_cancel_reason,
        my_amount:           o.core_total       != null ? Number(o.core_total)        : null,
        total_tax:           o.tax_total        != null ? Number(o.tax_total)         : null,
        discount:            o.discount_total   != null ? Number(o.discount_total)    : null,
        delivery_charge:     o.delivery_charges != null ? Number(o.delivery_charges)  : null,
        container_charge:    o.packaging_charge != null ? Number(o.packaging_charge)  : null,
        service_charge:      o.service_charge   != null ? Number(o.service_charge)    : null,
        additional_charge:   o.additional_charge!= null ? Number(o.additional_charge) : null,
        deduction_charge:    o.deduction_charge != null ? Number(o.deduction_charge)  : null,
        waived_off:          o.waived_off       != null ? Number(o.waived_off)        : null,
        round_off:           o.round_off        != null ? Number(o.round_off)         : null,
        total:               o.order_total      != null ? Number(o.order_total)       : null,
        item_name:           d.name,
        category_name:       it.pp_category_name || d.category,
        sap_code:            it.sap_code,
        item_price:          it.unit_price      != null ? Number(it.unit_price)       : null,
        item_quantity:       Number(it.quantity) || 0,
        item_total:          it.item_total      != null ? Number(it.item_total)       : null,
        // Join-side (not in CSV):
        outlet_id:     o.restaurant_id,
        dish_id:       d.id,
        biller:        o.biller,
        pp_order_code: o.code,
        transaction_id: o.transaction_id,
      });
    }
    // Cancelled-order synthesis (2026-10-23). AIFI's orders table does NOT
    // contain cancelled orders — verified live: PetPooja sends the cancel as
    // another "orderdetails" webhook with properties.Order.status="Cancelled",
    // and AIFI's materialiser never creates a row for it (mapped_order_id =
    // NULL). The 15 auto-rejected orders in a 40-hour window landed in
    // petpooja_events.raw with the full OrderItem array still intact, so we
    // can build Sales API rows straight from the webhook payload.
    //
    // Field mapping (petpooja_events.raw.properties ...)
    //   Order.status           -> "Cancelled" (always)
    //   Order.reason           -> order_cancel_reason
    //   Order.created_on       -> date (falls back to received_at)
    //   Order.customer_invoice_id | Order.orderID | pp_order_id -> invoice_no
    //   Order.payment_type/order_type/order_from/sub_order_type/GroupName/assignee
    //   Order.{core_total,tax_total,discount_total,delivery_charges,
    //          packaging_charge,service_charge,round_off,total,no_of_persons}
    //   Restaurant.restID -> restaurants.pp_rest_id -> local restaurant_id/name
    //   OrderItem[].{name,category_name,sap_code,price,quantity,total}
    try {
      const restByPpId = new Map<string, Restaurant>();
      for (const r of restaurants) {
        if (r.pp_rest_id != null) restByPpId.set(String(r.pp_rest_id), r);
      }
      // PostgREST supports chained -> / ->> in filters; status lives at
      // properties.Order.status, exactly where the schema probe placed it.
      const cancelPath =
        "petpooja_events?select=pp_order_id,received_at,raw" +
        `&received_at=gte.${encodeURIComponent(fromTs)}` +
        `&received_at=lte.${encodeURIComponent(toTs)}` +
        `&raw->properties->Order->>status=eq.Cancelled`;
      const cancelEvents = await sbGetPaged<{ pp_order_id: string; received_at: string; raw: Record<string, unknown> }>(
        url, key, cancelPath, 5_000
      );
      const normDate = (s: string | null | undefined): string => {
        const raw = String(s || "").trim();
        if (!raw) return "";
        // PetPooja uses "YYYY-MM-DD HH:MM:SS"; strip anything timezone-ish.
        return raw.replace("T", " ").slice(0, 19);
      };
      const n = (v: unknown): number | null => {
        if (v == null || v === "") return null;
        const x = Number(String(v).replace(/,/g, ""));
        return isFinite(x) ? x : null;
      };
      const s = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
      type J = Record<string, unknown>;
      for (const ev of cancelEvents) {
        const props = ((ev.raw as J)?.properties ?? {}) as J;
        const ord  = (props.Order      ?? {}) as J;
        const rest = (props.Restaurant ?? {}) as J;
        const cust = (props.Customer   ?? {}) as J;
        const itemsArr = Array.isArray(props.OrderItem) ? (props.OrderItem as J[]) : [];
        const ppRestId = s(rest.restID);
        const matchedRest = ppRestId ? restByPpId.get(ppRestId) : undefined;
        const restaurant_id = matchedRest ? matchedRest.id : 0;
        // Honour the outlet filter the dashboard sent — otherwise a cancel at
        // Shivalik would show up when the user asked for Dwarka.
        if (outletFilter && String(restaurant_id) !== outletFilter) continue;
        if (channelFilter && String(ord.order_from || "").toLowerCase() !== channelFilter.toLowerCase()) continue;
        if (orderTypeFilter && String(ord.order_type || "").toLowerCase() !== orderTypeFilter.toLowerCase()) continue;
        const invoice =
          s(ord.customer_invoice_id) ||
          s(ord.orderID) ||
          s(ev.pp_order_id);
        const base = {
          restaurant_name:     matchedRest?.name || s(rest.res_name) || `restaurant ${ppRestId || "?"}`,
          invoice_no:          invoice,
          date:                normDate((ord.created_on as string) || ev.received_at),
          payment_type:        s(ord.payment_type),
          order_type:          s(ord.order_type),
          status:              "Cancelled",
          area:                s(ord.order_from),
          virtual_brand_name:  s(ord.sub_order_type),
          brand_grouping:      s(ord.GroupName),
          assign_to:           s(ord.assignee),
          customer_phone:      s(cust.phone) || s(cust.customer_phone),
          customer_name:       s(cust.name)  || s(cust.customer_name),
          customer_address:    s(cust.address) || s(cust.customer_address),
          persons:             n(ord.no_of_persons),
          order_cancel_reason: s(ord.reason),
          my_amount:           n(ord.core_total),
          total_tax:           n(ord.tax_total),
          discount:            n(ord.discount_total),
          delivery_charge:     n(ord.delivery_charges),
          container_charge:    n(ord.packaging_charge),
          service_charge:      n(ord.service_charge),
          additional_charge:   null,
          deduction_charge:    null,
          waived_off:          null,
          round_off:           n(ord.round_off),
          total:               n(ord.total),
          outlet_id:           restaurant_id,
          biller:              s(ord.biller),
          pp_order_code:       s(ev.pp_order_id),
          transaction_id:      s(ord.transaction_id),
        };
        // One Sales API row per OrderItem (same shape as the live-orders path).
        // If the payload has no items (shouldn't happen in practice but be safe),
        // emit a single order-level row so the cancellation still surfaces.
        if (!itemsArr.length) {
          rows.push({
            ...base,
            item_name:     "(no items)",
            category_name: null,
            sap_code:      null,
            item_price:    null,
            item_quantity: 0,
            item_total:    null,
            dish_id:       0,
          });
          continue;
        }
        for (const it of itemsArr) {
          const nm = String(it.name || "");
          if (search && !nm.toLowerCase().includes(search)) continue;
          rows.push({
            ...base,
            item_name:     nm,
            category_name: s(it.category_name),
            sap_code:      s(it.sap_code),
            item_price:    n(it.price),
            item_quantity: n(it.quantity) ?? 0,
            item_total:    n(it.total),
            dish_id:       0,
          });
        }
      }
    } catch (ce) {
      // Non-fatal: Sales API still returns live orders if the cancel-events
      // merge errors (bad PostgREST syntax on an older Supabase, missing
      // petpooja_events, etc.). Log so Vercel surfaces it.
      // eslint-disable-next-line no-console
      console.error("[outlet-invoices] cancel merge failed:", ce);
    }

    // The row-build loop iterates `items` which comes back from fetchItemsFor
    // in Supabase's default order (order_items.id ASC within each 400-order
    // batch), NOT in orders DESC. So the "natural order" was wrong: the top
    // of the dashboard showed the OLDEST item in the newest 400-order batch
    // (verified 2026-10-23 by Satvik — filter 10/22 00:00 → 10/23 01:59,
    // ~3700 rows, top row was 10/22 21:18 instead of the latest 10/23
    // early-morning rows). Sort explicitly by placed_at DESC before clipping
    // so (a) newest is on top where the user expects it and (b) if we DO hit
    // limit_rows, the trim keeps the newest rows, not a random band.
    rows.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    const clipped = rows.slice(0, limit);

    return NextResponse.json({
      ok: true, from, to,
      filters: { outlet_id: outletFilter, channel: channelFilter, order_type: orderTypeFilter, search, limit_rows: limit },
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
        "Billing columns are populated from the PetPooja webhook payload (added 2026-10-17). Historical data backfilled from petpooja_events.raw.",
      ],
    }, { headers: CORS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: CORS });
  }
}
