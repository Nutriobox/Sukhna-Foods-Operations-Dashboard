import { NextResponse } from "next/server";
import { hashPassword } from "@/lib/outlet-portal-session";

/**
 * TEMPORARY diagnostic (added 2026-10-24, remove after login works):
 *   GET /api/outlet-portal/diag?username=rajinder-nagar&password=1122
 *   -> reports which failure path the login would hit — WITHOUT echoing any
 *      secrets (no salts, no hashes, no password). Only presence / absence
 *      of env vars and the branch name reached.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sbEnv() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return { url, key: key as string | undefined };
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const username = (u.searchParams.get("username") || "").toLowerCase().trim();
  const password = u.searchParams.get("password") || "";

  const env = {
    SUPABASE_URL_set:                  !!process.env.SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_URL_set:      !!process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_KEY_set:          !!process.env.SUPABASE_SERVICE_KEY,
    NEXT_PUBLIC_SUPABASE_ANON_KEY_set: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    OUTLET_PORTAL_SECRET_set:          !!process.env.OUTLET_PORTAL_SECRET,
    key_actually_used: process.env.SUPABASE_SERVICE_KEY ? "SUPABASE_SERVICE_KEY" :
                       process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? "NEXT_PUBLIC_SUPABASE_ANON_KEY" : "NONE",
  };

  const { url, key } = sbEnv();
  if (!url || !key) return NextResponse.json({ step: "env_missing", ok: false, env });

  if (!username) return NextResponse.json({ step: "ready", ok: true, env, hint: "Add ?username=rajinder-nagar&password=1122 to run the full flow" });

  const q = `${url}/rest/v1/outlet_portal_access?select=outlet_slug,password_salt,password_hash&username=eq.${encodeURIComponent(username)}`;
  const r = await fetch(q, { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" }, cache: "no-store" });
  if (!r.ok) {
    return NextResponse.json({ step: "rest_lookup_failed", ok: false, env, http_status: r.status });
  }
  const rows = (await r.json()) as Array<{ outlet_slug: string; password_salt: string; password_hash: string }>;
  if (!rows.length) {
    return NextResponse.json({ step: "no_row_for_username", ok: false, env, username_tried: username, rows_returned: 0 });
  }
  const row = rows[0];

  if (!password) return NextResponse.json({ step: "lookup_only", ok: true, env, outlet_slug_found: row.outlet_slug });

  const expected = hashPassword(row.password_salt, password);
  const match = expected === row.password_hash;
  // Only report boolean match + lengths. Do NOT include any part of the
  // actual salt or hash values.
  return NextResponse.json({
    step: "hash_check",
    ok: match,
    env,
    outlet_slug_found: row.outlet_slug,
    stored_salt_length: row.password_salt.length,
    stored_hash_length: row.password_hash.length,
    computed_hash_length: expected.length,
    password_length: password.length,
    match,
  });
}
