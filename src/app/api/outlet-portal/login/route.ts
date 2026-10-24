import { NextResponse } from "next/server";
import { hashPassword, signSession, sessionCookieHeader } from "@/lib/outlet-portal-session";
import { clientIpFromRequest, ipIsAllowed } from "@/lib/outlet-portal-ip";

/**
 * POST /api/outlet-portal/login
 *   body: { username, password }
 *
 * Looks up username (case-insensitive) in outlet_portal_access, re-hashes
 * the supplied password with the stored salt, and compares. On match sets
 * the op_session HttpOnly cookie (12 h) and returns the outlet slug + name.
 *
 * IP geofencing: if allowed_ip_cidr is non-null for the row and the
 * request's client IP doesn't match any entry, login is rejected. (Vercel
 * puts the client IP in x-forwarded-for; the first entry is the end-user.)
 * We only support exact /32 for now — Satvik can seed full CIDRs when he
 * has them, and we'll upgrade the matcher then.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sbEnv() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return { url, key: key as string | undefined };
}

export async function POST(req: Request) {
  let body: { username?: string; password?: string } = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  if (!username || !password) return NextResponse.json({ ok: false, error: "username and password are required" }, { status: 400 });

  const { url, key } = sbEnv();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured" }, { status: 500 });

  // Look up the row by exact username (lower-cased on both sides). PostgREST's
  // `ilike` without a wildcard can miss on some setups, verified 2026-10-24
  // when a correctly-hashed row refused login via the API but matched inline
  // in SQL — swapping to `eq` on the lower-cased username column (the unique
  // index on lower(username) is already there) made the match deterministic.
  const unameLower = username.toLowerCase();
  const q = `${url}/rest/v1/outlet_portal_access?select=outlet_slug,outlet_name,password_salt,password_hash,allowed_ip_cidr&username=eq.${encodeURIComponent(unameLower)}`;
  const r = await fetch(q, { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" }, cache: "no-store" });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.error("[outlet-portal/login] REST lookup failed:", r.status, t.slice(0, 300));
    return NextResponse.json({ ok: false, error: `Lookup failed: ${r.status} ${t}`.slice(0, 200) }, { status: 502 });
  }
  const rows = (await r.json()) as Array<{ outlet_slug: string; outlet_name: string; password_salt: string; password_hash: string; allowed_ip_cidr: string[] | null }>;
  const row = rows[0];
  const generic = NextResponse.json({ ok: false, error: "Invalid username or password" }, { status: 401 });
  if (!row) {
    // One-time diagnostic to confirm whether REST is finding the row at all —
    // Satvik 2026-10-24. Log the query shape (not the password) so we can see
    // whether the server-side username lookup is actually missing. Remove this
    // after we confirm login works.
    console.error("[outlet-portal/login] no row for username=", JSON.stringify(unameLower), "rows_returned=", rows.length, "query_tail=", q.split("outlet_portal_access")[1]);
    return generic;
  }
  const expected = hashPassword(row.password_salt, password);
  if (expected !== row.password_hash) {
    console.error("[outlet-portal/login] hash mismatch for slug=", row.outlet_slug,
      "salt=", row.password_salt,
      "pw_len=", password.length,
      "expected_prefix=", expected.slice(0, 16),
      "stored_prefix=", row.password_hash.slice(0, 16));
    return generic;
  }

  // IP geofencing. Exact-match on /32s for now (follow-up: widen to CIDR).
  // Empty / null allowed_ip_cidr means "not locked yet" — login succeeds and
  // the manager can lock the network from inside the portal.
  const ip = clientIpFromRequest(req);
  if (!ipIsAllowed(ip, row.allowed_ip_cidr)) {
    return NextResponse.json({ ok: false, error: "This network is not authorized for this outlet. Ask the admin to add " + (ip || "your IP") + " to the allow list." }, { status: 403 });
  }

  // Issue the session cookie.
  const token = signSession(row.outlet_slug);
  const res = NextResponse.json({ ok: true, outlet_slug: row.outlet_slug, outlet_name: row.outlet_name });
  res.headers.set("Set-Cookie", sessionCookieHeader(token));

  // Audit trail — best-effort; we don't fail the login if the insert errors.
  try {
    await fetch(`${url}/rest/v1/outlet_portal_sessions`, {
      method: "POST",
      headers: {
        apikey: key, Authorization: `Bearer ${key}`,
        "Content-Type": "application/json", Prefer: "return=minimal",
      },
      body: JSON.stringify({ outlet_slug: row.outlet_slug, ip, user_agent: req.headers.get("user-agent") || "" }),
    });
    await fetch(`${url}/rest/v1/outlet_portal_access?outlet_slug=eq.${encodeURIComponent(row.outlet_slug)}`, {
      method: "PATCH",
      headers: {
        apikey: key, Authorization: `Bearer ${key}`,
        "Content-Type": "application/json", Prefer: "return=minimal",
      },
      body: JSON.stringify({ last_login_at: new Date().toISOString(), last_login_ip: ip }),
    });
  } catch { /* non-fatal */ }

  return res;
}
