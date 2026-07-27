import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

/**
 * Ingestion endpoint for the email → extraction pipeline (Phase 2).
 * The extractor POSTs one bill (or an array of bills) here; we upsert into
 * Supabase using the service-role key. Protect it with INGEST_SECRET.
 *
 * Expected JSON body matches the Supabase `bills` row shape (see supabase/schema.sql).
 */
export async function POST(req: Request) {
  const secret = req.headers.get("x-ingest-secret");
  if (process.env.INGEST_SECRET && secret !== process.env.INGEST_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !service) {
    return NextResponse.json({ error: "Supabase not configured on the server" }, { status: 500 });
  }

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });

  const rows = Array.isArray(body) ? body : [body];
  const supabase = createClient(url, service);
  const { error } = await supabase.from("bills").upsert(rows);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, count: rows.length });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    info: "POST extracted bills here from the email pipeline (header x-ingest-secret).",
  });
}
