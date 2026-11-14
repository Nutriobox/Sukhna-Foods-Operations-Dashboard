export const dynamic = "force-dynamic";
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
}
export function OPTIONS() {
  return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST,OPTIONS", "access-control-allow-headers": "content-type" } });
}
function sb(path: string, init: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json", ...(init.headers || {}) } });
}
type Job = { bomCode: string; batches: number };
export async function POST(req: Request) {
  try {
    const b = (await req.json()) as { productionDate?: string; createdBy?: string; jobs?: Job[]; pmrs?: unknown[]; dedupeKey?: string; forced?: boolean };
    const { productionDate, createdBy = "app", jobs, pmrs, forced = false } = b;
    if (!productionDate || !Array.isArray(jobs) || !Array.isArray(pmrs) || jobs.length === 0) {
      return json({ ok: false, error: "productionDate, jobs and pmrs are required" }, 400);
    }
    const key = b.dedupeKey || `${productionDate}#${jobs.map((j) => `${j.bomCode}:${j.batches}`).sort().join("|")}`;
    if (!forced) {
      const ex = await sb(`production_jobs?dedupe_key=eq.${encodeURIComponent(key)}&select=id,status`).then((r) => r.json());
      if (Array.isArray(ex) && ex.length) return json({ ok: true, id: ex[0].id, status: ex[0].status, deduped: true, jobs: jobs.length, pmrs: pmrs.length });
    }
    const row = { production_date: productionDate, group_name: `Production ${productionDate}`, created_by: createdBy, payload: { group: { productionDate, createdBy }, jobs, pmrs }, status: "queued", dedupe_key: forced ? `${key}#${Date.now()}` : key, forced };
    const res = await sb("production_jobs", { method: "POST", headers: { prefer: "return=representation" }, body: JSON.stringify(row) });
    if (!res.ok) return json({ ok: false, error: `supabase ${res.status}: ${await res.text()}` }, 502);
    const [created] = await res.json();
    return json({ ok: true, id: created.id, status: "queued", jobs: jobs.length, pmrs: pmrs.length });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message) }, 500);
  }
}
