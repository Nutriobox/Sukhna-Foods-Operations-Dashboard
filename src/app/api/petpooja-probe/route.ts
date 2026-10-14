import { NextResponse } from "next/server";

/**
 * Probe endpoint for the AI Food Inspector Supabase (the project PetPooja and
 * PACT push their webhooks into). Verifies the AIFI_* env vars are configured
 * on this deployment, confirms we can read the orders / order_items tables
 * cross-project, and returns the column shape of order_items so the real
 * /api/outlet-sales endpoint can be built against the actual schema.
 *
 * GET /api/petpooja-probe
 *   -> {
 *        ok, env, orders: {count, latest, sample}, order_items: {count, columns, sample},
 *        pp_menu_events: {count, latest}, restaurants: {rows}, errors: {...}
 *      }
 *
 * Server env (added separately from the main Supabase):
 *   AIFI_SUPABASE_URL           e.g. https://kneqaeuggiibhxiardef.supabase.co
 *   AIFI_SUPABASE_SERVICE_KEY   service_role secret (bypasses RLS)
 *
 * Read-only. Nothing is written to AIFI; nothing is cached on this side.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS" };

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

type Row = Record<string, unknown>;

async function sb(path: string, url: string, key: string): Promise<{ status: number; body: unknown; text?: string }> {
  const r = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${path}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "Accept-Profile": "public",
      Prefer: "count=exact",
    },
    cache: "no-store",
  });
  const text = await r.text().catch(() => "");
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body, text };
}

async function count(path: string, url: string, key: string): Promise<{ count: number | null; error?: string }> {
  const r = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${path}?select=id&limit=1`, {
    method: "HEAD",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: "count=exact",
    },
    cache: "no-store",
  });
  if (!r.ok) return { count: null, error: `HTTP ${r.status}` };
  const cr = r.headers.get("content-range") || ""; // "0-0/1234"
  const m = cr.match(/\/(\d+|\*)$/);
  const n = m && m[1] !== "*" ? Number(m[1]) : null;
  return { count: n };
}

export async function GET() {
  const url = process.env.AIFI_SUPABASE_URL;
  const key = process.env.AIFI_SUPABASE_SERVICE_KEY;
  const env = {
    AIFI_SUPABASE_URL: url ? `${url.replace(/https?:\/\//, "").slice(0, 24)}...` : null,
    AIFI_SUPABASE_SERVICE_KEY: key ? `${key.slice(0, 10)}... (${key.length} chars)` : null,
  };
  if (!url || !key) {
    return NextResponse.json({
      ok: false,
      env,
      error: "AIFI_SUPABASE_URL and/or AIFI_SUPABASE_SERVICE_KEY not set in this environment.",
      hint: "Add both as env vars in Vercel and redeploy. See /areas/ai-food-inspector memory.",
    }, { status: 500, headers: CORS });
  }

  const errors: Record<string, string> = {};
  const out: Record<string, unknown> = { ok: true, env };

  // orders — count + latest row (sorted by id desc as a stable proxy for recency)
  try {
    const c = await count("orders", url, key);
    if (c.error) errors["orders.count"] = c.error;
    const latest = await sb("orders?select=*&order=id.desc&limit=1", url, key);
    if (latest.status !== 200) errors["orders.latest"] = `HTTP ${latest.status}: ${latest.text?.slice(0, 200)}`;
    out.orders = {
      count: c.count,
      latest: Array.isArray(latest.body) ? (latest.body as Row[])[0] ?? null : null,
    };
  } catch (e) { errors["orders"] = e instanceof Error ? e.message : String(e); }

  // order_items — count + 2 rows so we can see the shape
  try {
    const c = await count("order_items", url, key);
    if (c.error) errors["order_items.count"] = c.error;
    const sample = await sb("order_items?select=*&order=id.desc&limit=2", url, key);
    if (sample.status !== 200) errors["order_items.sample"] = `HTTP ${sample.status}: ${sample.text?.slice(0, 200)}`;
    const rows = (Array.isArray(sample.body) ? sample.body : []) as Row[];
    out.order_items = {
      count: c.count,
      columns: rows[0] ? Object.keys(rows[0]) : [],
      sample: rows,
    };
  } catch (e) { errors["order_items"] = e instanceof Error ? e.message : String(e); }

  // pp_menu_events — count + latest timestamp
  try {
    const c = await count("pp_menu_events", url, key);
    if (c.error) errors["pp_menu_events.count"] = c.error;
    const latest = await sb("pp_menu_events?select=id,received_at&order=received_at.desc&limit=1", url, key);
    const row = (Array.isArray(latest.body) ? (latest.body as Row[])[0] : null) ?? null;
    out.pp_menu_events = { count: c.count, latest: row };
  } catch (e) { errors["pp_menu_events"] = e instanceof Error ? e.message : String(e); }

  // restaurants — all of them (small table), so the Sales Reconciliation tab's outlet filter populates
  try {
    const list = await sb("restaurants?select=*&order=id.asc&limit=50", url, key);
    if (list.status !== 200) errors["restaurants"] = `HTTP ${list.status}: ${list.text?.slice(0, 200)}`;
    out.restaurants = {
      count: Array.isArray(list.body) ? (list.body as Row[]).length : 0,
      rows: Array.isArray(list.body) ? list.body : [],
    };
  } catch (e) { errors["restaurants"] = e instanceof Error ? e.message : String(e); }

  // petpooja_events / pact_events — just activity timestamps so we know the webhooks are still firing
  for (const t of ["petpooja_events", "pact_events"]) {
    try {
      const c = await count(t, url, key);
      const latest = await sb(`${t}?select=id,received_at&order=received_at.desc&limit=1`, url, key);
      const row = (Array.isArray(latest.body) ? (latest.body as Row[])[0] : null) ?? null;
      out[t] = { count: c.count, latest: row };
    } catch (e) { errors[t] = e instanceof Error ? e.message : String(e); }
  }

  if (Object.keys(errors).length) out.errors = errors;
  return NextResponse.json(out, { headers: CORS });
}
