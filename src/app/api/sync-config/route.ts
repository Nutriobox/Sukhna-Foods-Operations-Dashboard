import { NextResponse } from "next/server";

/**
 * Serves the browser the Supabase credentials needed to open a Realtime
 * channel to public.costing_snapshots.
 *
 *   GET /api/sync-config -> { url, anonKey }
 *
 * The anon key is safe to expose client-side — it's constrained by Row Level
 * Security on the database. costing_snapshots must have either RLS disabled
 * or a SELECT policy for the anon role for Realtime pushes to reach the
 * browser (Realtime respects RLS). See COSTING-LIVE-SYNC.md for the exact
 * SQL to run once per environment.
 *
 * Called by /public/js/sync-refresh.js on page load (once per tab).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

  if (!url || !anonKey) {
    return NextResponse.json(
      { ok: false, error: "Supabase realtime credentials not configured on the server." },
      { status: 500, headers: CORS }
    );
  }

  return NextResponse.json(
    {
      ok: true,
      url,
      anonKey,
      channel: "costing_snapshots",
    },
    {
      headers: {
        ...CORS,
        // Cache for 1 h — these values only change if env vars change.
        "Cache-Control": "public, max-age=3600, s-maxage=3600",
      },
    }
  );
}
