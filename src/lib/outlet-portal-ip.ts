/**
 * Client-IP helpers for the outlet portal.
 *
 * Vercel's edge sets `x-forwarded-for` with the real client IP as the FIRST
 * comma-separated entry. We trust that header because requests only reach
 * Next.js via Vercel's own proxy chain; a request made directly to our origin
 * (bypassing Vercel) cannot — there is no public origin, only vercel.app.
 *
 * The outlet_portal_access.allowed_ip_cidr column is a TEXT[]:
 *   - NULL or empty  -> permissive (first-time setup / network not locked yet).
 *   - Non-empty      -> request IP must exactly match one entry.
 *
 * We store exact IPs here (strip any "/32" suffix a manager might paste in).
 * Real CIDR matching is a follow-up — the entries are typed as "_cidr" so we
 * can widen the matcher without changing the schema.
 */

export function clientIpFromRequest(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") || "";
  const first = xff.split(",")[0]?.trim();
  if (first) return first;
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "";
}

/** Normalize a raw entry for storage or comparison. Strips /32, trims. */
export function normalizeIp(entry: string): string {
  if (!entry) return "";
  const s = String(entry).trim();
  if (!s) return "";
  const slash = s.indexOf("/");
  return (slash >= 0 ? s.slice(0, slash) : s).trim();
}

/**
 * True if an empty allowlist (open), or if the client IP matches an entry.
 * Called at login AND at each write endpoint (defense in depth: the submit
 * routes must not trust that login already checked, in case the allowlist
 * was updated between login and submit).
 */
export function ipIsAllowed(clientIp: string, allowedIpCidr: string[] | null | undefined): boolean {
  if (!Array.isArray(allowedIpCidr) || allowedIpCidr.length === 0) return true;
  if (!clientIp) return false;
  const needle = normalizeIp(clientIp);
  for (const raw of allowedIpCidr) {
    if (!raw) continue;
    if (normalizeIp(raw) === needle) return true;
  }
  return false;
}

/**
 * Fetch allowed_ip_cidr for a slug from Supabase REST. Returns [] when the
 * column is NULL so callers can treat empty-and-null uniformly.
 */
export async function fetchAllowedIps(
  url: string,
  key: string,
  slug: string
): Promise<string[]> {
  const r = await fetch(
    `${url.replace(/\/$/, "")}/rest/v1/outlet_portal_access?select=allowed_ip_cidr&outlet_slug=eq.${encodeURIComponent(slug)}`,
    { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" }, cache: "no-store" }
  );
  if (!r.ok) return [];
  const rows = (await r.json()) as Array<{ allowed_ip_cidr: string[] | null }>;
  const list = rows[0]?.allowed_ip_cidr;
  return Array.isArray(list) ? list : [];
}
