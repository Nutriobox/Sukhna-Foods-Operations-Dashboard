import { NextResponse } from "next/server";

/**
 * Server-side store for Loose Denomination state so marks made on one device
 * appear on every other device opening the Outlet Consumption dashboard.
 * Replaces the per-browser localStorage persistence that used to leave marks
 * stranded on the device they were made on.
 *
 * Shape of denom:
 *   { "<rm_code>": { "L3": true, "L2": true, "L1": true }, ... }
 *
 *   GET /api/loose-denomination
 *     -> { ok, denom, updated_at, updated_by? }
 *
 *   PUT /api/loose-denomination
 *     body: { denom: {...}, updated_by?: "<name>" }
 *     -> { ok, denom, updated_at }
 *
 * See pact-worker/loose-denomination-setup.sql for the one-time table
 * migration this route expects.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,PUT,OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

function sbEnv() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return { url, key: key as string | undefined };
}

export async function GET() {
  const { url, key } = sbEnv();
  if (!url || !key) {
    return NextResponse.json({ ok: false, error: "Supabase not configured." }, { status: 500, headers: CORS });
  }
  try {
    const r = await fetch(
      `${url}/rest/v1/loose_denomination_state?id=eq.1&select=denom,updated_at,updated_by`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" }
    );
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `Supabase ${r.status}: ${t.slice(0, 200)}` }, { status: 500, headers: CORS });
    }
    const rows = (await r.json()) as Array<{ denom: Record<string, Record<string, boolean>>; updated_at: string; updated_by: string | null }>;
    const row = rows[0];
    if (!row) {
      return NextResponse.json({ ok: true, denom: {}, updated_at: null, updated_by: null }, { headers: CORS });
    }
    return NextResponse.json({ ok: true, denom: row.denom || {}, updated_at: row.updated_at, updated_by: row.updated_by }, { headers: CORS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: CORS });
  }
}

export async function PUT(req: Request) {
  const { url, key } = sbEnv();
  if (!url || !key) {
    return NextResponse.json({ ok: false, error: "Supabase not configured." }, { status: 500, headers: CORS });
  }
  let body: { denom?: unknown; updated_by?: unknown };
  try {
    body = (await req.json()) as { denom?: unknown; updated_by?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400, headers: CORS });
  }
  const denom = body?.denom;
  if (!denom || typeof denom !== "object" || Array.isArray(denom)) {
    return NextResponse.json({ ok: false, error: "denom must be an object" }, { status: 400, headers: CORS });
  }
  // Light shape validation — reject anything that's not { rm_code: { L1|L2|L3: true } }.
  // Keeps a bad client from writing arbitrary JSON into the shared state.
  for (const [code, levels] of Object.entries(denom as Record<string, unknown>)) {
    if (!levels || typeof levels !== "object" || Array.isArray(levels)) {
      return NextResponse.json({ ok: false, error: `invalid levels for ${code}` }, { status: 400, headers: CORS });
    }
    for (const [lvl, v] of Object.entries(levels as Record<string, unknown>)) {
      if (lvl !== "L1" && lvl !== "L2" && lvl !== "L3") {
        return NextResponse.json({ ok: false, error: `invalid level ${lvl} on ${code}` }, { status: 400, headers: CORS });
      }
      if (v !== true) {
        return NextResponse.json({ ok: false, error: `${code}.${lvl} must be true (omit to clear)` }, { status: 400, headers: CORS });
      }
    }
  }
  const updatedBy = typeof body?.updated_by === "string" ? body.updated_by.slice(0, 120) : null;

  try {
    const r = await fetch(
      `${url}/rest/v1/loose_denomination_state?id=eq.1`,
      {
        method: "PATCH",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify({ denom, updated_at: new Date().toISOString(), updated_by: updatedBy }),
        cache: "no-store",
      }
    );
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `Supabase ${r.status}: ${t.slice(0, 200)}` }, { status: 500, headers: CORS });
    }
    const rows = (await r.json()) as Array<{ denom: Record<string, Record<string, boolean>>; updated_at: string }>;
    const row = rows[0] || { denom, updated_at: new Date().toISOString() };
    return NextResponse.json({ ok: true, denom: row.denom, updated_at: row.updated_at }, { headers: CORS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: CORS });
  }
}
