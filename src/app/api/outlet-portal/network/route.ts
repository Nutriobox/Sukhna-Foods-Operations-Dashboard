import { NextResponse } from "next/server";
import { readSessionFromRequest } from "@/lib/outlet-portal-session";
import { clientIpFromRequest, ipIsAllowed, fetchAllowedIps, normalizeIp } from "@/lib/outlet-portal-ip";

/**
 * Outlet portal network panel API.
 *
 *   GET  /api/outlet-portal/network
 *     Returns the caller's current IP, the outlet's stored allow list, and
 *     whether this IP is currently allowed. Used by the Network panel in the
 *     portal UI after login.
 *     -> { ok, ip, allowed, allowed_ips }
 *
 *   POST /api/outlet-portal/network         body: { action: "lock" }
 *     Appends the caller's current IP to the outlet's allowed_ip_cidr.
 *     Dedupes against the stored list. First lock on a previously-NULL list
 *     flips the outlet from "open" to "locked" — ALL future requests from
 *     any other network are refused.
 *     -> { ok, allowed_ips }
 *
 *   POST /api/outlet-portal/network         body: { action: "unlock", ip: "<ip>" }
 *     Removes an IP from the list. If the caller tries to remove the IP
 *     they're calling from AND it's the only remaining entry, the request
 *     is refused — would lock the outlet out of its own portal entirely.
 *     -> { ok, allowed_ips }
 *
 *   POST /api/outlet-portal/network         body: { action: "clear" }
 *     Clears the entire allow list, opening the portal back to any network.
 *     Useful for Satvik to seed from scratch; the UI gates this behind an
 *     "Open portal to any network" confirmation.
 *     -> { ok, allowed_ips: [] }
 *
 * All actions are session-gated. The outlet is taken from the session cookie
 * — the body cannot name a different outlet. The current IP must be in the
 * stored list for ANY of the write actions to succeed (defense in depth:
 * a leaked session cookie used from a wrong network cannot overwrite the
 * allow list). Exception: the FIRST lock on an open list is permitted from
 * any IP, so the manager can lock their own network on day one.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sbEnv() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return { url, key: key as string | undefined };
}

async function writeAllowList(url: string, key: string, slug: string, list: string[]) {
  const r = await fetch(
    `${url}/rest/v1/outlet_portal_access?outlet_slug=eq.${encodeURIComponent(slug)}`,
    {
      method: "PATCH",
      headers: {
        apikey: key, Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ allowed_ip_cidr: list.length ? list : null, updated_at: new Date().toISOString() }),
    }
  );
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Save failed: ${r.status} ${t}`.slice(0, 200));
  }
}

export async function GET(req: Request) {
  const sess = readSessionFromRequest(req);
  if (!sess) return NextResponse.json({ ok: false, error: "Not signed in" }, { status: 401 });
  const { url, key } = sbEnv();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured" }, { status: 500 });

  const list = await fetchAllowedIps(url, key, sess.slug);
  const ip = clientIpFromRequest(req);
  return NextResponse.json({
    ok: true,
    ip,
    allowed_ips: list,
    allowed: ipIsAllowed(ip, list),
    locked: list.length > 0,
  });
}

export async function POST(req: Request) {
  const sess = readSessionFromRequest(req);
  if (!sess) return NextResponse.json({ ok: false, error: "Not signed in" }, { status: 401 });
  const { url, key } = sbEnv();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured" }, { status: 500 });

  let body: { action?: string; ip?: string } = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const action = String(body.action || "").toLowerCase();

  const list = await fetchAllowedIps(url, key, sess.slug);
  const callerIp = clientIpFromRequest(req);
  const callerNorm = normalizeIp(callerIp);

  // First lock on an OPEN list is permitted from any IP — this is the only
  // way the first manager can set day-one network. Any other write requires
  // the caller to already be on the allow list.
  const firstLockOnOpen = action === "lock" && list.length === 0;
  if (!firstLockOnOpen && !ipIsAllowed(callerIp, list)) {
    return NextResponse.json({ ok: false, error: "This network is not authorized to edit the allow list." }, { status: 403 });
  }

  if (action === "lock") {
    if (!callerNorm) return NextResponse.json({ ok: false, error: "Could not detect your IP." }, { status: 400 });
    if (list.map(normalizeIp).includes(callerNorm)) {
      return NextResponse.json({ ok: true, allowed_ips: list, note: "already locked" });
    }
    const next = [...list, callerNorm];
    try { await writeAllowList(url, key, sess.slug, next); }
    catch (e) { return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 }); }
    return NextResponse.json({ ok: true, allowed_ips: next });
  }

  if (action === "unlock") {
    const target = normalizeIp(String(body.ip || ""));
    if (!target) return NextResponse.json({ ok: false, error: "ip is required" }, { status: 400 });
    const next = list.filter((e) => normalizeIp(e) !== target);
    if (next.length === list.length) {
      return NextResponse.json({ ok: true, allowed_ips: list, note: "not in list" });
    }
    // Refuse the self-lockout case: removing the caller's own IP when it's
    // the only remaining entry would lock the outlet out immediately.
    if (target === callerNorm && next.length === 0) {
      return NextResponse.json({ ok: false, error: "Cannot remove this network — it is the only authorized network. Use 'Open to any network' instead." }, { status: 400 });
    }
    try { await writeAllowList(url, key, sess.slug, next); }
    catch (e) { return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 }); }
    return NextResponse.json({ ok: true, allowed_ips: next });
  }

  if (action === "clear") {
    try { await writeAllowList(url, key, sess.slug, []); }
    catch (e) { return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 }); }
    return NextResponse.json({ ok: true, allowed_ips: [] });
  }

  return NextResponse.json({ ok: false, error: "unknown action" }, { status: 400 });
}
