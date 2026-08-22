import { NextResponse } from "next/server";

/**
 * Triggers the scheduled inventory sync on demand (the dashboard "Sync now"
 * button). Fires a GitHub Actions repository_dispatch(sync-inventory), which
 * runs scripts/sync-inventory.js and writes a fresh snapshot to Supabase.
 *
 * Server env required (same as push-to-pact):
 *   GH_DISPATCH_TOKEN — GitHub PAT with actions dispatch access
 *   GH_REPO           — "owner/name"
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const token = process.env.GH_DISPATCH_TOKEN;
  const repo = process.env.GH_REPO;
  if (!token || !repo) {
    return NextResponse.json(
      { ok: false, error: "GH_DISPATCH_TOKEN / GH_REPO not configured on the server." },
      { status: 500 }
    );
  }

  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "content-type": "application/json",
        "User-Agent": "sukhna-ops-dashboard",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ event_type: "sync-inventory" }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return NextResponse.json(
        { ok: false, error: `GitHub dispatch failed: ${r.status} ${t}`.slice(0, 300) },
        { status: 502 }
      );
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: "Dispatch error: " + msg }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
