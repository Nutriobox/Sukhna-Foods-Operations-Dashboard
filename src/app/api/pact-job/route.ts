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
    // pact_jobs.error is the FSI push's dedicated error column (push-fsi only
    // writes failures there). The sync worker (pact-worker/worker.js) writes
    // its captured script log — including the error tail of a failed sync —
    // to pact_jobs.run_log instead, and NEVER touches error. Reading error
    // alone was why every failed sync-costing run showed "(no reason returned
    // by worker)": the real error was already in run_log, just not fetched.
    // Fix: select both; message = error ?? run_log ?? "" (prefer error for the
    // push path, fall back to run_log for the sync path).
    const r = await fetch(
      `${sbUrl.replace(/\/$/, "")}/rest/v1/pact_jobs?id=eq.${encodeURIComponent(id)}&select=status,error,run_log,invoice,updated_at`,
      { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, Accept: "application/json" }, cache: "no-store" }
    );
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      // run_log is best-effort server-side — some deployments haven't added the
      // column yet. If the select failed BECAUSE of that, retry without it so
      // the status check keeps working (push-fsi callers still get what they
      // need from error alone).
      if (/run_log/.test(t)) {
        const r2 = await fetch(
          `${sbUrl.replace(/\/$/, "")}/rest/v1/pact_jobs?id=eq.${encodeURIComponent(id)}&select=status,error,invoice,updated_at`,
          { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, Accept: "application/json" }, cache: "no-store" }
        );
        if (r2.ok) {
          const rows2 = (await r2.json()) as Array<{ status?: string; error?: string; invoice?: string; updated_at?: string }>;
          const row2 = Array.isArray(rows2) && rows2.length ? rows2[0] : null;
          if (!row2) return NextResponse.json({ ok: true, status: "queued", message: "", invoice: null, updatedAt: null });
          return NextResponse.json({
            ok: true,
            status: row2.status ?? "queued",
            message: row2.error ?? "",
            invoice: row2.invoice ?? null,
            updatedAt: row2.updated_at ?? null,
          });
        }
      }
      return NextResponse.json({ ok: false, error: `Lookup failed: ${r.status} ${t}`.slice(0, 200) }, { status: 502 });
    }
    const rows = (await r.json()) as Array<{ status?: string; error?: string; run_log?: string; invoice?: string; updated_at?: string }>;
    const row = Array.isArray(rows) && rows.length ? rows[0] : null;
    if (!row) {
      // Not visible yet (dispatch just fired) — treat as still queued.
      return NextResponse.json({ ok: true, status: "queued", message: "", invoice: null, updatedAt: null });
    }
    // Prefer the FSI error field, fall back to the sync worker's run_log so
    // failed sync-costing runs finally surface their actual reason instead of
    // the stock "(no reason returned by worker)". The costing scraper prints
    // "SYNC FAILED: <msg>" right before exiting, so pull that one line out of
    // run_log for the dashboard toast; the full tail stays available in
    // Supabase for anyone who opens the row.
    const err = (row.error ?? "").toString();
    const logT = (row.run_log ?? "").toString();
    let message = err;
    if (!message && logT) {
      const m = logT.match(/SYNC FAILED:\s*(.+)/);
      if (m) {
        message = m[1].trim().slice(0, 400);
      } else {
        // No marker line — grab the last non-empty line (usually the throw).
        const lines = logT.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        if (lines.length) message = lines[lines.length - 1].slice(0, 400);
      }
    }
    return NextResponse.json({
      ok: true,
      status: row.status ?? "queued",
      message,
      invoice: row.invoice ?? null,
      updatedAt: row.updated_at ?? null,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: "Status error: " + msg }, { status: 500 });
  }
}
