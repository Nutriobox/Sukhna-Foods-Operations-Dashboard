import { NextResponse } from "next/server";

/**
 * The shared live sales order. Both the website and the native app go through
 * this route (server-side, service-role key) so they read and write the same
 * `sales_order_lines` rows — a scan on one shows up on the other.
 *
 *  GET    /api/order            -> { ok, lines: [...] }
 *  POST   /api/order  {line}    -> add a line (merges by product_code + batch)
 *  PATCH  /api/order  {id,...}  -> update quantity / selected batch of a line
 *  DELETE /api/order?id=NN      -> remove one line
 *  DELETE /api/order?all=1      -> clear the whole order
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

const REST = (path: string) => {
  const { url } = creds();
  return `${url}/rest/v1/sales_order_lines${path}`;
};

function headers(extra: Record<string, string> = {}) {
  const { key } = creds();
  return { apikey: key as string, Authorization: `Bearer ${key}`, "content-type": "application/json", ...extra };
}

/* DB (snake_case) <-> API (camelCase) */
type Line = {
  id?: number; productCode: string; productName?: string; hsn?: string; warehouse?: string;
  salesUnitLevel?: string; unit?: string; quantity?: number; unitPrice?: string; salesRate?: string;
  gstTaxType?: string; batchNumber?: string; mfgDate?: string; expiryDate?: string; source?: string;
};
const toRow = (l: Line) => ({
  product_code: l.productCode, product_name: l.productName ?? null, hsn: l.hsn ?? null,
  warehouse: l.warehouse ?? null, sales_unit_level: l.salesUnitLevel ?? null, unit: l.unit ?? null,
  quantity: l.quantity ?? 1, unit_price: l.unitPrice ?? null, sales_rate: l.salesRate ?? null,
  gst_tax_type: l.gstTaxType ?? null, batch_number: l.batchNumber ?? null,
  mfg_date: l.mfgDate ?? null, expiry_date: l.expiryDate ?? null, source: l.source ?? null,
});
const toLine = (r: Record<string, unknown>): Line => ({
  id: r.id as number, productCode: r.product_code as string, productName: (r.product_name as string) ?? "",
  hsn: (r.hsn as string) ?? "", warehouse: (r.warehouse as string) ?? "", salesUnitLevel: (r.sales_unit_level as string) ?? "",
  unit: (r.unit as string) ?? "", quantity: Number(r.quantity ?? 0), unitPrice: (r.unit_price as string) ?? "",
  salesRate: (r.sales_rate as string) ?? "", gstTaxType: (r.gst_tax_type as string) ?? "",
  batchNumber: (r.batch_number as string) ?? "", mfgDate: (r.mfg_date as string) ?? "",
  expiryDate: (r.expiry_date as string) ?? "", source: (r.source as string) ?? "",
});

function guard() {
  const { url, key } = creds();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured." }, { status: 500, headers: CORS });
  return null;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET() {
  const bad = guard(); if (bad) return bad;
  try {
    const r = await fetch(REST("?select=*&order=created_at.asc"), { headers: headers(), cache: "no-store" });
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
  try {
    // Merge by product_code + batch_number (re-scan bumps the quantity).
    const bn = l.batchNumber ?? "";
    const q = `?product_code=eq.${encodeURIComponent(l.productCode)}&batch_number=eq.${encodeURIComponent(bn)}&select=*`;
    const existing = (await (await fetch(REST(q), { headers: headers(), cache: "no-store" })).json()) as Record<string, unknown>[];
    if (Array.isArray(existing) && existing.length) {
      const row = existing[0];
      const newQty = Number(row.quantity ?? 0) + addQty;
      const up = await fetch(REST(`?id=eq.${row.id}`), {
        method: "PATCH", headers: headers({ Prefer: "return=representation" }),
        body: JSON.stringify({ quantity: newQty, updated_at: new Date().toISOString() }),
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
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  const all = searchParams.get("all");
  try {
    const q = id ? `?id=eq.${id}` : all ? `?id=gt.0` : null;
    if (!q) return NextResponse.json({ ok: false, error: "id or all=1 required" }, { status: 400, headers: CORS });
    await fetch(REST(q), { method: "DELETE", headers: headers({ Prefer: "return=minimal" }) });
    return NextResponse.json({ ok: true }, { headers: CORS });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500, headers: CORS });
  }
}
