import { NextResponse } from "next/server";

/**
 * Status of a Factory Sales Invoice push (see /api/push-fsi). The device polls
 * this to show the operator whether PACT filled the invoice. It reads pact_jobs
 * with the service key server-side, so no database keys live in the app.
 *
 * GET /api/pact-job?id=<jobId>  ->  { ok, status, message, invoice, updatedAt }
 *   status  = queued | processing | done | failed
 *   message = short human summary on done, or the error on failed
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ ok: false, error: "Missing id." }, { status: 400 });

  const sbUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  if (!sbUrl || !sbKey) {
    return NextResponse.json({ ok: false, error: "Supabase not configured on the server." }, { status: 500 });
  }

  try {
    const r = await fetch(
      `${sbUrl.replace(/\/$/, "")}/rest/v1/pact_jobs?id=eq.${encodeURIComponent(id)}&select=status,error,invoice,updated_at`,
      { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, Accept: "application/json" }, cache: "no-store" }
    );
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `Lookup failed: ${r.status} ${t}`.slice(0, 200) }, { status: 502 });
    }
    const rows = (await r.json()) as Array<{ status?: string; error?: string; invoice?: string; updated_at?: string }>;
    const row = Array.isArray(rows) && rows.length ? rows[0] : null;
    if (!row) {
      // Not visible yet (dispatch just fired) — treat as still queued.
      return NextResponse.json({ ok: true, status: "queued", message: "", invoice: null, updatedAt: null });
    }
    return NextResponse.json({
      ok: true,
      status: row.status ?? "queued",
      message: row.error ?? "",
      invoice: row.invoice ?? null,
      updatedAt: row.updated_at ?? null,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: "Status error: " + msg }, { status: 500 });
  }
}
