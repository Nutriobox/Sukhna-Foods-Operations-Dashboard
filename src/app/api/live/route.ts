import { NextResponse } from "next/server";

/**
 * Real-time LIVE dispatch coordination (gun <-> worker <-> PACT).
 *
 * The gun opens a live session when the operator opens an order, streams each
 * scan as it happens, and flips the session to 'submit' on the final button.
 * The EC2 live-worker holds a PACT "Stock Outward to Outlet" draft open, feeds
 * each barcode into it as it arrives, and clicks Post once -> ONE voucher.
 * Server-side only (service key) — no DB keys ship in the app.
 *
 *  POST /api/live  { action:'open',   omr, outlet, category? }
 *  POST /api/live  { action:'scan',   omr, barcode }
 *  POST /api/live  { action:'submit', omr }
 *  POST /api/live  { action:'cancel', omr }
 *  GET  /api/live?omr=OMR-AF/26-27/1234   ->  { ok, status, voucherNo, error }
 *    status = none | open | submit | posting | done | error | cancelled
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

function creds() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_KEY;
  return { url, key };
}
function sb(target: string, init: RequestInit, key: string) {
  const h = (init.headers || {}) as Record<string, string>;
  return fetch(target, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...h },
    cache: "no-store",
  });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: Request) {
  const { url, key } = creds();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured." }, { status: 500, headers: CORS });

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const action = String(body.action || "");
  const omr = String(body.omr || "").trim();
  if (!omr) return NextResponse.json({ ok: false, error: "Missing omr." }, { status: 400, headers: CORS });

  try {
    if (action === "open") {
      const row = {
        omr,
        outlet: String(body.outlet || ""),
        category: String(body.category || "Frozen"),
        status: "open", voucher_no: "", error: "",
        opened_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      const r = await sb(`${url}/rest/v1/pact_live_sessions`, {
        method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(row),
      }, key);
      if (!r.ok) return NextResponse.json({ ok: false, error: (await r.text()).slice(0, 200) }, { status: 502, headers: CORS });
      // start clean: drop any leftover scans from a previous open of the same order
      await sb(`${url}/rest/v1/pact_live_scans?omr=eq.${encodeURIComponent(omr)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }, key).catch(() => {});
      return NextResponse.json({ ok: true }, { headers: CORS });
    }

    if (action === "scan") {
      const barcode = String(body.barcode || "").trim();
      if (!barcode) return NextResponse.json({ ok: false, error: "Missing barcode." }, { status: 400, headers: CORS });
      const r = await sb(`${url}/rest/v1/pact_live_scans`, {
        method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ omr, barcode }),
      }, key);
      if (!r.ok) return NextResponse.json({ ok: false, error: (await r.text()).slice(0, 200) }, { status: 502, headers: CORS });
      return NextResponse.json({ ok: true }, { headers: CORS });
    }

    if (action === "submit" || action === "cancel") {
      const status = action === "submit" ? "submit" : "cancelled";
      const r = await sb(`${url}/rest/v1/pact_live_sessions?omr=eq.${encodeURIComponent(omr)}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
      }, key);
      if (!r.ok) return NextResponse.json({ ok: false, error: (await r.text()).slice(0, 200) }, { status: 502, headers: CORS });
      return NextResponse.json({ ok: true }, { headers: CORS });
    }

    return NextResponse.json({ ok: false, error: "Unknown action." }, { status: 400, headers: CORS });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg.slice(0, 200) }, { status: 500, headers: CORS });
  }
}

export async function GET(req: Request) {
  const { url, key } = creds();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured." }, { status: 500, headers: CORS });
  const omr = new URL(req.url).searchParams.get("omr");
  if (!omr) return NextResponse.json({ ok: false, error: "Missing omr." }, { status: 400, headers: CORS });
  try {
    const r = await sb(`${url}/rest/v1/pact_live_sessions?omr=eq.${encodeURIComponent(omr)}&select=status,voucher_no,error&order=opened_at.desc&limit=1`, {}, key);
    const rows = (await r.json()) as Array<{ status?: string; voucher_no?: string; error?: string }>;
    const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
    if (!row) return NextResponse.json({ ok: true, status: "none", voucherNo: "", error: "" }, { headers: CORS });
    return NextResponse.json({ ok: true, status: row.status || "", voucherNo: row.voucher_no || "", error: row.error || "" }, { headers: CORS });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg.slice(0, 200) }, { status: 500, headers: CORS });
  }
}
