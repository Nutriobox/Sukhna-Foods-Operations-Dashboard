import { NextResponse } from "next/server";

/**
 * Status of the most recent inventory-sync GitHub Actions run, so the app can
 * wait for the real run to finish (green) instead of guessing from the snapshot.
 *
 * GET -> { ok, run: { id, status, conclusion, createdAt, url } | null }
 *   status:     "queued" | "in_progress" | "completed"
 *   conclusion: "success" | "failure" | "cancelled" | ... (only once completed)
 *
 * Server env required (same as sync-inventory):
 *   GH_DISPATCH_TOKEN — GitHub PAT with actions read access
 *   GH_REPO           — "owner/name"
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS" };

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET() {
  const token = process.env.GH_DISPATCH_TOKEN;
  const repo = process.env.GH_REPO;
  if (!token || !repo) {
    return NextResponse.json({ ok: false, error: "GH_DISPATCH_TOKEN / GH_REPO not configured on the server." }, { status: 500, headers: CORS });
  }
  try {
    // Latest run of the sync-inventory workflow (any trigger).
    const url = `https://api.github.com/repos/${repo}/actions/workflows/sync-inventory.yml/runs?per_page=1`;
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "sukhna-ops-dashboard",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `GitHub ${r.status} ${t}`.slice(0, 200) }, { status: 502, headers: CORS });
    }
    const j = (await r.json()) as { workflow_runs?: Array<{ id: number; status: string; conclusion: string | null; created_at: string; html_url: string }> };
    const run = Array.isArray(j.workflow_runs) && j.workflow_runs[0] ? j.workflow_runs[0] : null;
    return NextResponse.json(
      { ok: true, run: run ? { id: run.id, status: run.status, conclusion: run.conclusion, createdAt: run.created_at, url: run.html_url } : null },
      { headers: CORS }
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: CORS });
  }
}
