/**
 * Outlet-portal session helpers.
 *
 * Session tokens are HMAC-SHA256 signed cookies carrying { slug, exp }. We
 * don't ship a full JWT library — the payload is tiny and the signature
 * check is three lines of crypto. HttpOnly + Secure + SameSite=Lax so a
 * foreign site can't lift the cookie or send cross-site POSTs.
 *
 * Env var: OUTLET_PORTAL_SECRET (any random string >= 32 chars). Set in
 * Vercel; if it's missing we fall back to SUPABASE_SERVICE_KEY so dev
 * still works, but Satvik should set a dedicated secret before the first
 * real outlet logs in.
 */

import { createHmac, timingSafeEqual, randomBytes, createHash } from "node:crypto";

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12; // 12h

function secret(): string {
  const s = process.env.OUTLET_PORTAL_SECRET || process.env.SUPABASE_SERVICE_KEY || "";
  if (s.length < 16) {
    throw new Error("OUTLET_PORTAL_SECRET not configured (set on Vercel)");
  }
  return s;
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export type SessionPayload = { slug: string; exp: number };

export function signSession(slug: string): string {
  const payload: SessionPayload = { slug, exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS };
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload)));
  const sig  = b64urlEncode(createHmac("sha256", secret()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifySession(token: string | undefined | null): SessionPayload | null {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = createHmac("sha256", secret()).update(body).digest();
  let provided: Buffer;
  try { provided = b64urlDecode(sig); } catch { return null; }
  if (expected.length !== provided.length) return null;
  if (!timingSafeEqual(expected, provided)) return null;
  let payload: SessionPayload;
  try { payload = JSON.parse(b64urlDecode(body).toString("utf8")); } catch { return null; }
  if (!payload || typeof payload.slug !== "string" || typeof payload.exp !== "number") return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

export function sessionCookieHeader(token: string): string {
  const attrs = [
    `op_session=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    "Secure",
  ];
  return attrs.join("; ");
}

export function clearSessionCookieHeader(): string {
  return "op_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure";
}

export function readSessionFromRequest(req: Request): SessionPayload | null {
  const cookieHeader = req.headers.get("cookie") || "";
  const match = cookieHeader.split(/;\s*/).find((p) => p.startsWith("op_session="));
  if (!match) return null;
  return verifySession(match.slice("op_session=".length));
}

// --- password hashing (SHA-256(salt || password)) --------------------------

export function hashPassword(salt: string, password: string): string {
  return createHash("sha256").update(salt + password).digest("hex");
}

export function newSalt(): string {
  return randomBytes(16).toString("hex");
}
