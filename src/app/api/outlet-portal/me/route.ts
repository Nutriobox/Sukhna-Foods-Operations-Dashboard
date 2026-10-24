import { NextResponse } from "next/server";
import { readSessionFromRequest } from "@/lib/outlet-portal-session";

/**
 * GET /api/outlet-portal/me
 *   -> { ok, outlet_slug, outlet_name }
 *      Returns the signed-in outlet based on the op_session cookie. If the
 *      cookie is missing / expired / tampered, returns 401 so the portal
 *      page can bounce back to the login form.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sbEnv() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return { url, key: key as string | undefined };
}

export async function GET(req: Request) {
  const sess = readSessionFromRequest(req);
  if (!sess) return NextResponse.json({ ok: false, error: "Not signed in" }, { status: 401 });
  const { url, key } = sbEnv();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured" }, { status: 500 });

  const r = await fetch(
    `${url}/rest/v1/outlet_portal_access?select=outlet_slug,outlet_name&outlet_slug=eq.${encodeURIComponent(sess.slug)}`,
    { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" }, cache: "no-store" }
  );
  if (!r.ok) return NextResponse.json({ ok: false, error: `Lookup failed: ${r.status}` }, { status: 502 });
  const rows = (await r.json()) as Array<{ outlet_slug: string; outlet_name: string }>;
  const row = rows[0];
  if (!row) return NextResponse.json({ ok: false, error: "Account not found" }, { status: 404 });
  return NextResponse.json({ ok: true, outlet_slug: row.outlet_slug, outlet_name: row.outlet_name });
}
