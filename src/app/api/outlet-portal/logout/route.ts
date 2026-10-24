import { NextResponse } from "next/server";
import { clearSessionCookieHeader } from "@/lib/outlet-portal-session";

/**
 * POST /api/outlet-portal/logout
 *   Clears the op_session cookie. The browser handles the redirect
 *   back to the login form on the next page load.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.headers.set("Set-Cookie", clearSessionCookieHeader());
  return res;
}
