import { NextResponse } from "next/server";

/**
 * Runs the PACT Playwright automation server-side for one bill.
 * POST { bill, dryRun? } where bill = {
 *   company, vendor, vendorSearch, billNo, billDate,
 *   items: [{ search, name, unitLevel, qty, baseQty?, batch?: { mfgDate?, expiryDate? } }]
 * }
 * Returns { ok, grn, error?, log }.
 *
 * Requires env: PACT_USER, PACT_PASS (or PACT_PASSWORD). Optional PACT_URL.
 */

export const runtime = "nodejs";
export const maxDuration = 300; // seconds (Vercel Pro). Bump with Fluid Compute if needed.
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = process.env.PACT_USER;
  const pass = process.env.PACT_PASS || process.env.PACT_PASSWORD;
  if (!user || !pass) {
    return NextResponse.json({ ok: false, error: "PACT_USER / PACT_PASS not configured on the server." }, { status: 500 });
  }

  const body = await req.json().catch(() => null);
  const bill = body?.bill;
  const dryRun = !!body?.dryRun;
  if (!bill || !Array.isArray(bill.items) || !bill.items.length) {
    return NextResponse.json({ ok: false, error: "Missing bill or bill.items." }, { status: 400 });
  }

  // login.js reads PACT_PASSWORD; mirror PACT_PASS into it for this invocation.
  if (!process.env.PACT_PASSWORD && process.env.PACT_PASS) process.env.PACT_PASSWORD = process.env.PACT_PASS;

  try {
    const { pushBillToPact } = await import("@/lib/pact/run");
    const result = await pushBillToPact(bill, { dryRun });
    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
