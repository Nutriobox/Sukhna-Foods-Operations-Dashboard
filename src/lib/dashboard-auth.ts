import { NextResponse } from "next/server";

/**
 * Server-side auth guard for the dashboard's /api routes.
 *
 * Flag-gated by design: until DASHBOARD_AUTH_ENFORCED === "true" nothing is
 * enforced, so this deploys with zero risk of locking anyone out. Flip the env
 * var on only after confirming an admin can sign in. When off, requireAdmin
 * returns { ok:true, authed:false } (a bypass) and requireServiceSecret passes.
 *
 * Admin identity comes from Supabase Auth: the browser signs in and sends the
 * access token (Authorization: Bearer, or an sb-access-token cookie). We verify
 * it against Supabase's /auth/v1/user endpoint and check the email is on the
 * admin allow-list (DASHBOARD_ADMIN_EMAILS, default mis@nutriobox.com).
 */

function adminEmails(): string[] {
  return (process.env.DASHBOARD_ADMIN_EMAILS || "mis@nutriobox.com")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function authEnforced(): boolean {
  return process.env.DASHBOARD_AUTH_ENFORCED === "true";
}

function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  const cookie = req.headers.get("cookie") || "";
  const cm = cookie.match(/(?:^|;\s*)sb-access-token=([^;]+)/);
  return cm ? decodeURIComponent(cm[1]) : null;
}

export type AdminGate =
  | { ok: true; authed: boolean; email?: string }
  | { ok: false; status: number; error: string };

export async function requireAdmin(req: Request): Promise<AdminGate> {
  if (!authEnforced()) return { ok: true, authed: false };
  const token = bearerToken(req);
  if (!token) return { ok: false, status: 401, error: "Not signed in" };
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  if (!url || !anon) return { ok: false, status: 500, error: "Auth is not configured on the server" };
  try {
    const r = await fetch(url.replace(/\/$/, "") + "/auth/v1/user", {
      headers: { apikey: anon, authorization: "Bearer " + token },
    });
    if (!r.ok) return { ok: false, status: 401, error: "Session expired — sign in again" };
    const u: any = await r.json();
    const email = String(u?.email || "").toLowerCase();
    const allow = adminEmails();
    if (!email || (allow.length && !allow.includes(email))) {
      return { ok: false, status: 403, error: "Not authorised for this dashboard" };
    }
    return { ok: true, authed: true, email };
  } catch {
    return { ok: false, status: 401, error: "Could not verify session" };
  }
}

/** For automation routes (sync-*, pact-job, push-*): a shared service secret
 *  in the x-cron-secret header. Bypassed when auth is off, and also when
 *  CRON_SECRET is unset, so the scheduled jobs never break unexpectedly. */
export function requireServiceSecret(req: Request): { ok: true } | { ok: false; status: number; error: string } {
  if (!authEnforced()) return { ok: true };
  const secret = process.env.CRON_SECRET || "";
  if (!secret) return { ok: true };
  const got = req.headers.get("x-cron-secret") || "";
  if (got && got === secret) return { ok: true };
  return { ok: false, status: 401, error: "Service auth required" };
}

/** Convenience: turn a failed gate into a NextResponse. */
export function gateDenied(g: { status: number; error: string }) {
  return NextResponse.json({ ok: false, error: g.error }, { status: g.status });
}
