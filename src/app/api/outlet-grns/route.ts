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
  const aggregate = (sp.get("aggregate") || "").toLowerCase().trim();

  try {
    // ------------------------------------------------------------------
    // Per-RM aggregate: sum outlet_qty across every line item for one
    // outlet × date window, grouped by rm_code. Used by the Ideal
    // Inventory tab to fill its Purchase (L1) column from GRNs that fall
    // between the latest Opening Inventory count and the end of the
    // selected window. PACT stores doc_date as a DATE (no time), so the
    // bounds are date-inclusive — a GRN posted on the same day as the
    // morning OI count is treated as a post-count purchase.
    //   GET /api/outlet-grns?aggregate=rm&outlet=<name>&from=YYYY-MM-DD&to=YYYY-MM-DD
    //   -> { ok, aggregates: [{ rm_code, product_name, unit, total_qty, line_count }],
    //        count, source, synced_at, filters }
    // Rows without an rm_code are grouped under rm_code=null so the
    // caller sees them (usually open-text items the scraper couldn't
    // resolve) and can decide what to do with them, rather than
    // silently dropping them.
    if (aggregate === "rm") {
      const to     = sp.get("to")   || istToday();
      const from   = sp.get("from") || istDaysAgo(30);
      const outletFilter = (sp.get("outlet") || "").trim();
      const parts: string[] = [
        "select=rm_code,product_name,unit,outlet_qty,outlet_name,transfer_location,doc_date",
        `doc_date=gte.${encodeURIComponent(from)}`,
        `doc_date=lte.${encodeURIComponent(to)}`,
        "limit=20000",
      ];
      if (outletFilter) parts.push(`outlet_name=ilike.${encodeURIComponent("%" + outletFilter + "%")}`);
      const r = await fetch(
        `${url}/rest/v1/pact_stock_outlet_outward?${parts.join("&")}`,
        { headers: h, cache: "no-store" }
      );
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        return NextResponse.json({ ok: false, error: `Supabase ${r.status}: ${t.slice(0, 200)}` }, { status: 500, headers: CORS });
      }
      const lines = (await r.json()) as Array<{
        rm_code: string | null; product_name: string | null; unit: string | null;
        outlet_qty: number | null; outlet_name: string | null;
        transfer_location: string | null; doc_date: string | null;
      }>;
      // Group by rm_code when it's populated; fall back to the product
      // name otherwise. The PACT scraper leaves rm_code empty on most
      // rows today (see pact_stock_outlet_outward sample), so without
      // the name fallback every distinct product collapses into one
      // "no-code" bucket and the Ideal Inventory Purchase column stays
      // empty. The frontend tries code first, then name.
      type Agg = { rm_code: string; product_name: string; unit: string; total_qty: number; line_count: number };
      const by = new Map<string, Agg>();
      for (const ln of lines) {
        const code = (ln.rm_code || "").trim();
        const nameLc = String(ln.product_name || "").trim().toLowerCase();
        const key = code ? ("code:" + code) : (nameLc ? ("nm:" + nameLc) : "__no_label__");
        let a = by.get(key);
        if (!a) {
          a = {
            rm_code:      code,
            product_name: ln.product_name || "",
            unit:         ln.unit || "",
            total_qty:    0,
            line_count:   0,
          };
          by.set(key, a);
        }
        a.total_qty  += Number(ln.outlet_qty || 0);
        a.line_count += 1;
      }
      const aggregates = [...by.values()].sort((a, b) => {
        const ka = a.rm_code || ("~" + (a.product_name || "zzzz"));
        const kb = b.rm_code || ("~" + (b.product_name || "zzzz"));
        return ka.localeCompare(kb);
      });
      return NextResponse.json({
        ok: true,
        aggregates,
        count: aggregates.length,
        line_rows_scanned: lines.length,
        source: "PACT Stock Outlet Outward (BI) — aggregated per RM",
        synced_at: new Date().toISOString(),
        filters: { from, to, outlet: outletFilter },
      }, { headers: CORS });
    }

    // Per-doc detail: all line items for one Doc No.
    if (docNo) {
      // 2026-10-30: same fallback as the list view — SELECT with doc_time
      // first; on a 42703 undefined_column retry without it so the detail
      // modal keeps opening during the migration.
      const buildDetailSelect = (includeDocTime: boolean) =>
        includeDocTime
          ? "select=doc_no,doc_date,doc_time,outlet_name,transfer_location,product_name,rm_code,unit,outlet_qty,batch_no,outlet_issue_type,narration"
          : "select=doc_no,doc_date,outlet_name,transfer_location,product_name,rm_code,unit,outlet_qty,batch_no,outlet_issue_type,narration";
      let r = await fetch(
        `${url}/rest/v1/pact_stock_outlet_outward?doc_no=eq.${encodeURIComponent(docNo)}&${buildDetailSelect(true)}&order=product_name.asc`,
        { headers: h, cache: "no-store" }
      );
      if (!r.ok && r.status === 400) {
        const peek = await r.clone().text().catch(() => "");
        if (peek.includes("42703") || peek.includes("doc_time")) {
          r = await fetch(
            `${url}/rest/v1/pact_stock_outlet_outward?doc_no=eq.${encodeURIComponent(docNo)}&${buildDetailSelect(false)}&order=product_name.asc`,
            { headers: h, cache: "no-store" }
          );
        }
      }
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        return NextResponse.json({ ok: false, error: `Supabase ${r.status}: ${t.slice(0, 200)}` }, { status: 500, headers: CORS });
      }
      const rows = (await r.json()) as Array<{
        doc_no: string; doc_date: string; doc_time?: string | null;
        outlet_name: string | null; transfer_location: string | null;
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
          doc_time: first.doc_time,
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

    // 2026-10-30 (hotfix for the broken Purchase tab): include doc_time
    // only when the view has that column. The 2026-10-30 migration adds
    // it, but if a prod DB hasn't been migrated yet the SELECT 400s with
    // "column does not exist" and the whole Purchase list disappears.
    // Try with doc_time first; on a 42703 (undefined_column) retry the
    // SELECT without it so the list keeps working during the migration.
    const buildFilters = (includeDocTime: boolean): string[] => {
      const selectCols = includeDocTime
        ? "select=doc_no,doc_date,doc_time,outlet_name,transfer_location,category,line_count,total_qty,scraped_at"
        : "select=doc_no,doc_date,outlet_name,transfer_location,category,line_count,total_qty,scraped_at";
      const f = [
        selectCols,
        `doc_date=gte.${encodeURIComponent(from)}`,
        `doc_date=lte.${encodeURIComponent(to)}`,
        `order=doc_date.desc,doc_no.desc`,
        `limit=${limit}`,
      ];
      if (outletFilter)   f.push(`outlet_name=ilike.${encodeURIComponent("%" + outletFilter + "%")}`);
      if (categoryFilter) f.push(`category=eq.${encodeURIComponent(categoryFilter)}`);
      return f;
    };

    let r = await fetch(
      `${url}/rest/v1/pact_stock_outlet_outward_docs?${buildFilters(true).join("&")}`,
      { headers: h, cache: "no-store" }
    );
    // Retry without doc_time when the column isn't there yet.
    if (!r.ok && r.status === 400) {
      const peek = await r.clone().text().catch(() => "");
      if (peek.includes("42703") || peek.includes("doc_time")) {
        r = await fetch(
          `${url}/rest/v1/pact_stock_outlet_outward_docs?${buildFilters(false).join("&")}`,
          { headers: h, cache: "no-store" }
        );
      }
    }
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `Supabase ${r.status}: ${t.slice(0, 200)}` }, { status: 500, headers: CORS });
    }
    const raw = (await r.json()) as Array<{
      doc_no: string; doc_date: string; doc_time?: string | null;
      outlet_name: string | null; transfer_location: string | null;
      category: string | null; line_count: number | null; total_qty: number | null; scraped_at: string | null;
    }>;
    const rows = raw.map((o) => ({
      // 2026-10-30 (Satvik's #1): date_time now carries PACT's doc_date
      // AND Created Time (doc_time) when the scraper has one. Falls back
      // to the bare date so historical rows still render.
      date_time:  o.doc_time ? `${o.doc_date}T${o.doc_time}` : o.doc_date,
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
