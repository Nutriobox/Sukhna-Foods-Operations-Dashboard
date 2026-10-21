import { NextResponse } from "next/server";

/**
 * Stock Outlet Outward (SOT) docs from PACT, surfaced as the Purchase tab's
 * GRN list on the dashboard. Backed by pact_stock_outlet_outward (one row
 * per line item) and pact_stock_outlet_outward_docs (one row per Doc No).
 *
 *   GET /api/outlet-grns
 *     ?from=YYYY-MM-DD   default: 30 days ago (IST)
 *     ?to=YYYY-MM-DD     default: today (IST)
 *     ?outlet=<name>     substring, case-insensitive on outlet_name
 *     ?category=<name>   exact on outlet_issue_type
 *     ?limit=N           row cap (default 500, max 5000)
 *   -> { ok, rows: [{ date_time, doc_no, outlet, category, line_count, total_qty }],
 *        source, synced_at, count }
 *
 *   GET /api/outlet-grns?doc_no=SOT-AF/26-27/3151
 *   -> { ok, detail: { doc_no, doc_date, outlet, category, lines: [
 *          { item_name, rm_code, uom, qty, batch_no, narration }
 *      ]} }
 *
 * See pact-worker/outlet-grn-setup.sql for the table + view migration.
 * The Playwright scraper (next pass) will upsert into pact_stock_outlet_outward.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

function sbEnv() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return { url, key: key as string | undefined };
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
  const { url, key } = sbEnv();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured." }, { status: 500, headers: CORS });
  const sp = new URL(req.url).searchParams;
  const h = { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" };

  const docNo = sp.get("doc_no");

  try {
    // Per-doc detail: all line items for one Doc No.
    if (docNo) {
      const r = await fetch(
        `${url}/rest/v1/pact_stock_outlet_outward?doc_no=eq.${encodeURIComponent(docNo)}&select=doc_no,doc_date,outlet_name,transfer_location,product_name,rm_code,unit,outlet_qty,batch_no,outlet_issue_type,narration&order=product_name.asc`,
        { headers: h, cache: "no-store" }
      );
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        return NextResponse.json({ ok: false, error: `Supabase ${r.status}: ${t.slice(0, 200)}` }, { status: 500, headers: CORS });
      }
      const rows = (await r.json()) as Array<{
        doc_no: string; doc_date: string; outlet_name: string | null; transfer_location: string | null;
        product_name: string; rm_code: string | null; unit: string | null; outlet_qty: number | null;
        batch_no: string | null; outlet_issue_type: string | null; narration: string | null;
      }>;
      if (!rows.length) return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: CORS });
      const first = rows[0];
      const lines = rows.map((row) => ({
        item_name: row.product_name,
        rm_code:   row.rm_code,
        uom:       row.unit,
        qty:       row.outlet_qty,
        batch_no:  row.batch_no,
        narration: row.narration,
      }));
      return NextResponse.json({
        ok: true,
        detail: {
          doc_no:   first.doc_no,
          doc_date: first.doc_date,
          outlet:   first.outlet_name || first.transfer_location || "",
          transfer_location: first.transfer_location,
          category: first.outlet_issue_type,
          lines,
        },
      }, { headers: CORS });
    }

    // List view: one row per doc, from the view.
    const to     = sp.get("to")   || istToday();
    const from   = sp.get("from") || istDaysAgo(30);
    const outletFilter   = (sp.get("outlet") || "").trim();
    const categoryFilter = (sp.get("category") || "").trim();
    const limit = Math.min(Math.max(1, Number(sp.get("limit") || 500)), 5000);

    const filters: string[] = [
      "select=doc_no,doc_date,outlet_name,transfer_location,category,line_count,total_qty,scraped_at",
      `doc_date=gte.${encodeURIComponent(from)}`,
      `doc_date=lte.${encodeURIComponent(to)}`,
      `order=doc_date.desc,doc_no.desc`,
      `limit=${limit}`,
    ];
    if (outletFilter)   filters.push(`outlet_name=ilike.${encodeURIComponent("%" + outletFilter + "%")}`);
    if (categoryFilter) filters.push(`category=eq.${encodeURIComponent(categoryFilter)}`);

    const r = await fetch(
      `${url}/rest/v1/pact_stock_outlet_outward_docs?${filters.join("&")}`,
      { headers: h, cache: "no-store" }
    );
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `Supabase ${r.status}: ${t.slice(0, 200)}` }, { status: 500, headers: CORS });
    }
    const raw = (await r.json()) as Array<{
      doc_no: string; doc_date: string; outlet_name: string | null; transfer_location: string | null;
      category: string | null; line_count: number | null; total_qty: number | null; scraped_at: string | null;
    }>;
    const rows = raw.map((o) => ({
      date_time:  o.doc_date,                                 // no time in the PACT report; frontend formats it
      doc_no:     o.doc_no,
      outlet:     o.outlet_name || o.transfer_location || "",
      category:   o.category || "",
      line_count: o.line_count || 0,
      total_qty:  o.total_qty  || 0,
    }));
    const latestScraped = raw.reduce<string | null>((acc, o) => {
      if (!o.scraped_at) return acc;
      if (!acc || o.scraped_at > acc) return o.scraped_at;
      return acc;
    }, null);
    return NextResponse.json({
      ok: true,
      rows,
      count: rows.length,
      source: "PACT Stock Outlet Outward (BI)",
      synced_at: latestScraped,
      filters: { from, to, outlet: outletFilter, category: categoryFilter, limit },
    }, { headers: CORS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: CORS });
  }
}
