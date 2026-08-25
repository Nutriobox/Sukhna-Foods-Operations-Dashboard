import { NextResponse } from "next/server";

/**
 * The shared sales-order lines. The website uses it as one live order; the app
 * scopes it to a specific sales order via the `so` / soNumber field so each PACT
 * sales order keeps its own scanned lines. Server-side (service key) — no keys
 * in the app.
 *
 *  GET    /api/order            -> all lines
 *  GET    /api/order?so=SO-1    -> lines for that sales order
 *  POST   /api/order  {line}    -> add a line (merges by so + product + batch)
 *  PATCH  /api/order  {id,...}  -> update quantity / batch of a line
 *  DELETE /api/order?id=NN      -> remove one line
 *  DELETE /api/order?all=1      -> clear all
 *  DELETE /api/order?so=SO-1    -> clear one sales order's lines
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

function creds() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return { url: url?.replace(/\/$/, ""), key };
}
const REST = (path: string) => `${creds().url}/rest/v1/sales_order_lines${path}`;
function headers(extra: Record<string, string> = {}) {
  const { key } = creds();
  return { apikey: key as string, Authorization: `Bearer ${key}`, "content-type": "application/json", ...extra };
}

type Line = {
  id?: number; productCode: string; productName?: string; hsn?: string; warehouse?: string;
  salesUnitLevel?: string; unit?: string; quantity?: number; unitPrice?: string; salesRate?: string;
  gstTaxType?: string; batchNumber?: string; mfgDate?: string; expiryDate?: string;
  soNumber?: string; vendor?: string; source?: string;
};
const toRow = (l: Line) => ({
  product_code: l.productCode, product_name: l.productName ?? null, hsn: l.hsn ?? null,
  warehouse: l.warehouse ?? null, sales_unit_level: l.salesUnitLevel ?? null, unit: l.unit ?? null,
  quantity: l.quantity ?? 1, unit_price: l.unitPrice ?? null, sales_rate: l.salesRate ?? null,
  gst_tax_type: l.gstTaxType ?? null, batch_number: l.batchNumber ?? null,
  mfg_date: l.mfgDate ?? null, expiry_date: l.expiryDate ?? null,
  so_number: l.soNumber ?? null, vendor: l.vendor ?? null, source: l.source ?? null,
});
const toLine = (r: Record<string, unknown>): Line => ({
  id: r.id as number, productCode: r.product_code as string, productName: (r.product_name as string) ?? "",
  hsn: (r.hsn as string) ?? "", warehouse: (r.warehouse as string) ?? "", salesUnitLevel: (r.sales_unit_level as string) ?? "",
  unit: (r.unit as string) ?? "", quantity: Number(r.quantity ?? 0), unitPrice: (r.unit_price as string) ?? "",
  salesRate: (r.sales_rate as string) ?? "", gstTaxType: (r.gst_tax_type as string) ?? "",
  batchNumber: (r.batch_number as string) ?? "", mfgDate: (r.mfg_date as string) ?? "",
  expiryDate: (r.expiry_date as string) ?? "", soNumber: (r.so_number as string) ?? "", vendor: (r.vendor as string) ?? "",
});

function guard() {
  const { url, key } = creds();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured." }, { status: 500, headers: CORS });
  return null;
}
const soFilter = (so: string | null) => (so ? `so_number=eq.${encodeURIComponent(so)}` : null);

export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

export async function GET(req: Request) {
  const bad = guard(); if (bad) return bad;
  const so = new URL(req.url).searchParams.get("so");
  const f = soFilter(so);
  try {
    const r = await fetch(REST(`?select=*&order=created_at.asc${f ? "&" + f : ""}`), { headers: headers(), cache: "no-store" });
    const rows = (await r.json()) as Record<string, unknown>[];
    return NextResponse.json({ ok: true, lines: Array.isArray(rows) ? rows.map(toLine) : [] }, { headers: CORS });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500, headers: CORS });
  }
}

export async function POST(req: Request) {
  const bad = guard(); if (bad) return bad;
  const l = (await req.json().catch(() => null)) as Line | null;
  if (!l?.productCode) return NextResponse.json({ ok: false, error: "productCode required" }, { status: 400, headers: CORS });
  const addQty = Number(l.quantity ?? 1) || 1;
  const bn = l.batchNumber ?? "";
  const soClause = l.soNumber ? `so_number=eq.${encodeURIComponent(l.soNumber)}` : "so_number=is.null";
  try {
    const q = `?product_code=eq.${encodeURIComponent(l.productCode)}&batch_number=eq.${encodeURIComponent(bn)}&${soClause}&select=*`;
    const existing = (await (await fetch(REST(q), { headers: headers(), cache: "no-store" })).json()) as Record<string, unknown>[];
    if (Array.isArray(existing) && existing.length) {
      const row = existing[0];
      const up = await fetch(REST(`?id=eq.${row.id}`), {
        method: "PATCH", headers: headers({ Prefer: "return=representation" }),
        body: JSON.stringify({ quantity: Number(row.quantity ?? 0) + addQty, updated_at: new Date().toISOString() }),
      });
      const rows = (await up.json()) as Record<string, unknown>[];
      return NextResponse.json({ ok: true, line: toLine(rows[0]) }, { headers: CORS });
    }
    const ins = await fetch(REST(""), {
      method: "POST", headers: headers({ Prefer: "return=representation" }),
      body: JSON.stringify({ ...toRow(l), quantity: addQty }),
    });
    const rows = (await ins.json()) as Record<string, unknown>[];
    if (!ins.ok) return NextResponse.json({ ok: false, error: JSON.stringify(rows).slice(0, 200) }, { status: 502, headers: CORS });
    return NextResponse.json({ ok: true, line: toLine(rows[0]) }, { headers: CORS });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500, headers: CORS });
  }
}

export async function PATCH(req: Request) {
  const bad = guard(); if (bad) return bad;
  const body = (await req.json().catch(() => null)) as (Partial<Line> & { id?: number }) | null;
  if (!body?.id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400, headers: CORS });
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.quantity != null) patch.quantity = body.quantity;
  if (body.batchNumber != null) patch.batch_number = body.batchNumber;
  if (body.warehouse != null) patch.warehouse = body.warehouse;
  if (body.unit != null) patch.unit = body.unit;
  if (body.unitPrice != null) patch.unit_price = body.unitPrice;
  if (body.mfgDate != null) patch.mfg_date = body.mfgDate;
  if (body.expiryDate != null) patch.expiry_date = body.expiryDate;
  try {
    const up = await fetch(REST(`?id=eq.${body.id}`), {
      method: "PATCH", headers: headers({ Prefer: "return=representation" }), body: JSON.stringify(patch),
    });
    const rows = (await up.json()) as Record<string, unknown>[];
    return NextResponse.json({ ok: true, line: rows[0] ? toLine(rows[0]) : null }, { headers: CORS });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500, headers: CORS });
  }
}

export async function DELETE(req: Request) {
  const bad = guard(); if (bad) return bad;
  const sp = new URL(req.url).searchParams;
  const id = sp.get("id"); const all = sp.get("all"); const so = sp.get("so");
  try {
    const q = id ? `?id=eq.${id}` : so ? `?${soFilter(so)}` : all ? `?id=gt.0` : null;
    if (!q) return NextResponse.json({ ok: false, error: "id, so or all=1 required" }, { status: 400, headers: CORS });
    await fetch(REST(q), { method: "DELETE", headers: headers({ Prefer: "return=minimal" }) });
    return NextResponse.json({ ok: true }, { headers: CORS });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500, headers: CORS });
  }
}
