import { NextResponse } from "next/server";

/**
 * Shared storage for the Outlet Dispatch tool's reference data (Product Master
 * export, Ideal / Schedule / etc.) and the PLINK product-to-master routing
 * overrides. Backed by one singleton row in Supabase so the Product Master is
 * no longer lost when the browser cache is cleared or a different device is
 * used, and so the whole team sees the same latest file.
 *
 *   GET  /api/dispatch-ref         -> { ok, payload, updated_at }
 *   POST /api/dispatch-ref  body=payload JSON  -> { ok, updated_at }
 *   OPTIONS                        -> 204 (CORS pre-flight)
 *
 * Payload shape (owned by the HTML, not interpreted here):
 *   { ref: { master?: {name,b64,when}, ideal?: {...}, schedule?: {...}, ... },
 *     plink: { "<product key>": "<master row key>", ... } }
 *
 * One-time Supabase setup (SQL editor):
 *   create table if not exists dispatch_ref (
 *     id          text primary key,
 *     payload     jsonb not null,
 *     updated_at  timestamptz not null default now()
 *   );
 *   -- optional: let anon read/write via RLS; service-role from this server
 *   -- bypasses RLS anyway.
 *
 * The route is tolerant: if the table does not exist, GET returns an empty
 * payload so the UI falls back to localStorage silently.
 *
 * Server env: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)
 *           + SUPABASE_SERVICE_KEY
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};
const ROW_ID = "master"; // singleton key — one row per deployment is enough

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

function sbCreds() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return { url, key };
}

type Row = { payload?: unknown; updated_at?: string };

export async function GET() {
  const { url, key } = sbCreds();
  if (!url || !key) {
    return NextResponse.json(
      { ok: false, error: "Supabase not configured on the server." },
      { status: 500, headers: CORS },
    );
  }
  try {
    const q =
      `${url.replace(/\/$/, "")}/rest/v1/dispatch_ref` +
      `?id=eq.${encodeURIComponent(ROW_ID)}` +
      `&select=payload,updated_at&limit=1`;
    const r = await fetch(q, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" },
      cache: "no-store",
    });
    if (!r.ok) {
      // Treat "table missing" as "no payload yet" so the UI still works until
      // the DDL is run — error text is included for the first-time setup.
      const t = await r.text().catch(() => "");
      if (/relation .* does not exist|dispatch_ref/i.test(t) && r.status >= 400) {
        return NextResponse.json(
          { ok: true, payload: {}, updated_at: null, note: "dispatch_ref table not yet created" },
          { headers: CORS },
        );
      }
      return NextResponse.json(
        { ok: false, error: `Supabase ${r.status} ${t}`.slice(0, 400) },
        { status: 502, headers: CORS },
      );
    }
    const rows = (await r.json()) as Row[];
    const row = rows && rows[0];
    return NextResponse.json(
      { ok: true, payload: row?.payload ?? {}, updated_at: row?.updated_at ?? null },
      { headers: CORS },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: CORS });
  }
}

export async function POST(req: Request) {
  const { url, key } = sbCreds();
  if (!url || !key) {
    return NextResponse.json(
      { ok: false, error: "Supabase not configured on the server." },
      { status: 500, headers: CORS },
    );
  }
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400, headers: CORS });
  }
  // Light size guard: a Product Master .xlsx base64 is usually well under 1 MB,
  // but refuse anything implausible to protect the row.
  try {
    const bytes = JSON.stringify(payload).length;
    if (bytes > 8 * 1024 * 1024) {
      return NextResponse.json(
        { ok: false, error: `payload too large (${bytes} bytes, max 8 MB)` },
        { status: 413, headers: CORS },
      );
    }
  } catch {
    return NextResponse.json({ ok: false, error: "payload not serializable" }, { status: 400, headers: CORS });
  }

  const now = new Date().toISOString();
  const body = JSON.stringify([{ id: ROW_ID, payload, updated_at: now }]);
  try {
    const q = `${url.replace(/\/$/, "")}/rest/v1/dispatch_ref?on_conflict=id`;
    const r = await fetch(q, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body,
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return NextResponse.json(
        { ok: false, error: `Supabase ${r.status} ${t}`.slice(0, 400) },
        { status: 502, headers: CORS },
      );
    }
    return NextResponse.json({ ok: true, updated_at: now }, { headers: CORS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: CORS });
  }
}
