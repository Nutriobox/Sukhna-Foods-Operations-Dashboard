import { NextResponse } from "next/server";

/**
 * Persistent storage for the Allsure Salary Structure app (/salary).
 *
 *   GET  /api/salary-data?id=main
 *     -> { ok, data: <blob> | null, updated_at, updated_by }
 *     The whole app snapshot the salary HTML stores (schema:1, employees,
 *     cfg, sheet, slips, …). null the first time anyone opens it.
 *
 *   PATCH /api/salary-data?id=main
 *     body: { data: <blob>, updated_by?: string }
 *     -> { ok, id, updated_at }
 *     Replaces the row's data jsonb with the body. Mirrors the desktop
 *     DK.save(jsonStr) semantic: full-blob replace, no partial merge.
 *
 *   POST /api/salary-data?id=main&op=backup
 *     body: { note?: string, updated_by?: string }
 *     -> { ok, backup_id, name, size_bytes, created_at }
 *     Captures the current row's data into salary_data_backups. Called by
 *     the "Refresh data" button on the salary tool, which first saves,
 *     then backs up, then reloads.
 *
 *   GET  /api/salary-data?id=main&op=info
 *     -> { ok, file, exists, size, backups: [{ name, size, mtime }] }
 *     Lightweight metadata for the Settings tab's "Database file" card.
 *     Returns the latest 20 backups.
 *
 * The salary HTML's shim (public/salary/index.html) wraps these endpoints
 * as a window.allsureDesktop equivalent so the existing desktop code
 * paths (dkSave / dkLoad / dkBackup / dkInfo / dkRefresh) all work
 * unchanged against the server. See pact-worker/salary-data-setup.sql
 * for the table migrations — Satvik needs to run that in the Supabase
 * SQL editor once before this endpoint can write.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,PATCH,POST,OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

function sbEnv() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return { url, key: key as string | undefined };
}

function sanitiseId(raw: string | null): string {
  // Permit letters, digits, dash, underscore up to 48 chars. Default to 'main'.
  const s = (raw || "").trim();
  if (!s) return "main";
  return /^[A-Za-z0-9_-]{1,48}$/.test(s) ? s : "main";
}

function tableNotFound(status: number, text: string): boolean {
  return status === 404 || /relation .* does not exist/i.test(text);
}

export async function GET(req: Request) {
  const { url, key } = sbEnv();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured" }, { status: 500, headers: CORS });

  const u = new URL(req.url);
  const id = sanitiseId(u.searchParams.get("id"));
  const op = (u.searchParams.get("op") || "").toLowerCase();

  if (op === "info") return info(url, key, id);
  return load(url, key, id);
}

async function load(url: string, key: string, id: string) {
  try {
    const r = await fetch(
      `${url}/rest/v1/salary_data?select=data,updated_at,updated_by&id=eq.${encodeURIComponent(id)}`,
      { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" }, cache: "no-store" }
    );
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      if (tableNotFound(r.status, t)) {
        return NextResponse.json({
          ok: false,
          error: "salary_data table not found — run pact-worker/salary-data-setup.sql in Supabase first",
          data: null,
        }, { status: 200, headers: CORS });
      }
      return NextResponse.json({ ok: false, error: `Supabase ${r.status}: ${t.slice(0, 200)}` }, { status: 500, headers: CORS });
    }
    const rows = (await r.json()) as Array<{ data: unknown; updated_at: string; updated_by: string | null }>;
    const row = rows[0];
    if (!row) return NextResponse.json({ ok: true, data: null, updated_at: null, updated_by: null }, { headers: CORS });
    return NextResponse.json({ ok: true, data: row.data, updated_at: row.updated_at, updated_by: row.updated_by }, { headers: CORS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: CORS });
  }
}

async function info(url: string, key: string, id: string) {
  try {
    // Row size
    const [headR, backupsR] = await Promise.all([
      fetch(
        `${url}/rest/v1/salary_data?select=id,updated_at&id=eq.${encodeURIComponent(id)}`,
        { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" }, cache: "no-store" }
      ),
      fetch(
        `${url}/rest/v1/salary_data_backups?select=id,size_bytes,created_at,note&snapshot_id=eq.${encodeURIComponent(id)}&order=created_at.desc&limit=20`,
        { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" }, cache: "no-store" }
      ),
    ]);
    const headRows = (headR.ok ? await headR.json() : []) as Array<{ id: string; updated_at: string }>;
    const backups  = (backupsR.ok ? await backupsR.json() : []) as Array<{ id: number; size_bytes: number | null; created_at: string; note: string | null }>;

    return NextResponse.json({
      ok: true,
      file:   `salary_data[id=${id}]  (Supabase · lezcgmnmcpgbecqtuqsg)`,
      exists: headRows.length > 0,
      size:   backups[0]?.size_bytes || 0,
      exports: 0,
      backups: backups.map((b) => ({
        name:  `backup #${b.id}${b.note ? "  (" + b.note + ")" : ""}`,
        size:  b.size_bytes || 0,
        mtime: b.created_at,
      })),
    }, { headers: CORS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: CORS });
  }
}

export async function PATCH(req: Request) {
  const { url, key } = sbEnv();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured" }, { status: 500, headers: CORS });

  const u = new URL(req.url);
  const id = sanitiseId(u.searchParams.get("id"));

  type Body = { data?: unknown; updated_by?: unknown };
  let body: Body;
  try { body = (await req.json()) as Body; }
  catch { return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400, headers: CORS }); }
  if (!body.data || typeof body.data !== "object") {
    return NextResponse.json({ ok: false, error: "data must be a JSON object" }, { status: 400, headers: CORS });
  }
  const updatedBy = typeof body.updated_by === "string" ? body.updated_by.slice(0, 120) : null;

  // Guard against runaway payloads — the salary blob holds ~1000 employees
  // tops; 2 MiB is roomy.
  const estSize = JSON.stringify(body.data).length;
  if (estSize > 2_000_000) {
    return NextResponse.json({ ok: false, error: `data too large (${estSize} bytes; max 2000000)` }, { status: 413, headers: CORS });
  }

  try {
    const r = await fetch(
      `${url}/rest/v1/salary_data?on_conflict=id`,
      {
        method: "POST",
        headers: {
          apikey: key, Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=representation",
        },
        body: JSON.stringify({ id, data: body.data, updated_at: new Date().toISOString(), updated_by: updatedBy }),
        cache: "no-store",
      }
    );
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      if (tableNotFound(r.status, t)) {
        return NextResponse.json({ ok: false, error: "salary_data table not found — run pact-worker/salary-data-setup.sql in Supabase first" }, { status: 500, headers: CORS });
      }
      return NextResponse.json({ ok: false, error: `Supabase ${r.status}: ${t.slice(0, 200)}` }, { status: 500, headers: CORS });
    }
    const rows = (await r.json()) as Array<{ id: string; updated_at: string }>;
    const row = rows[0];
    return NextResponse.json({ ok: true, id, updated_at: row?.updated_at || null, size_bytes: estSize }, { headers: CORS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: CORS });
  }
}

export async function POST(req: Request) {
  // Only the backup op is served under POST — anything else is an error.
  const { url, key } = sbEnv();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured" }, { status: 500, headers: CORS });

  const u = new URL(req.url);
  const id = sanitiseId(u.searchParams.get("id"));
  const op = (u.searchParams.get("op") || "").toLowerCase();
  if (op !== "backup") {
    return NextResponse.json({ ok: false, error: "unknown POST op; expected ?op=backup" }, { status: 400, headers: CORS });
  }

  type Body = { note?: unknown; updated_by?: unknown };
  let body: Body = {};
  try { body = (await req.json()) as Body; } catch { /* body optional */ }
  const note = typeof body.note === "string" ? body.note.slice(0, 120) : "manual";

  try {
    // Read the current row.
    const gr = await fetch(
      `${url}/rest/v1/salary_data?select=data,updated_at&id=eq.${encodeURIComponent(id)}`,
      { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" }, cache: "no-store" }
    );
    if (!gr.ok) {
      const t = await gr.text().catch(() => "");
      if (tableNotFound(gr.status, t)) {
        return NextResponse.json({ ok: false, error: "salary_data table not found — run pact-worker/salary-data-setup.sql in Supabase first" }, { status: 500, headers: CORS });
      }
      return NextResponse.json({ ok: false, error: `Supabase read ${gr.status}: ${t.slice(0, 200)}` }, { status: 500, headers: CORS });
    }
    const gRows = (await gr.json()) as Array<{ data: unknown; updated_at: string }>;
    const row = gRows[0];
    if (!row) return NextResponse.json({ ok: false, error: "nothing to back up — no row yet for this id" }, { status: 404, headers: CORS });

    const size = JSON.stringify(row.data).length;
    const br = await fetch(
      `${url}/rest/v1/salary_data_backups`,
      {
        method: "POST",
        headers: {
          apikey: key, Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify({ snapshot_id: id, data: row.data, size_bytes: size, note }),
        cache: "no-store",
      }
    );
    if (!br.ok) {
      const t = await br.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `Supabase insert ${br.status}: ${t.slice(0, 200)}` }, { status: 500, headers: CORS });
    }
    const bRows = (await br.json()) as Array<{ id: number; created_at: string }>;
    const b = bRows[0];
    return NextResponse.json({
      ok: true,
      backup_id: b?.id || null,
      name: `backup #${b?.id || "?"}`,
      size_bytes: size,
      created_at: b?.created_at || null,
    }, { headers: CORS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: CORS });
  }
}
