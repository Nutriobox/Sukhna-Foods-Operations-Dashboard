export const dynamic = "force-dynamic";
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
}
async function sb(path: string) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` }, cache: "no-store" });
}
export async function GET(req: Request) {
  try {
    const u = new URL(req.url);
    const id = u.searchParams.get("id");
    const date = u.searchParams.get("date");
    const cols = "id,production_date,group_name,status,result,note,attempts,created_at,payload";
    let q: string;
    if (id) q = `production_jobs?id=eq.${encodeURIComponent(id)}&select=${cols}`;
    else if (date) q = `production_jobs?production_date=eq.${encodeURIComponent(date)}&select=${cols}&order=created_at.desc`;
    else q = `production_jobs?select=${cols}&order=created_at.desc&limit=50`;
    const res = await sb(q);
    if (!res.ok) return json({ ok: false, error: `supabase ${res.status}` }, 502);
    return json({ ok: true, items: await res.json() });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message) }, 500);
  }
}
