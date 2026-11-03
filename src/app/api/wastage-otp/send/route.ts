import { NextResponse } from "next/server";
import { createHash, randomInt } from "node:crypto";

/**
 * POST /api/wastage-otp/send
 *   body: { snapshot_id }
 *
 * Generates a 6-digit OTP for approving this snapshot's wastage, stores it
 * hashed (one active OTP per snapshot, 10-minute expiry), and emails it via
 * Resend to the admin inbox (WASTAGE_OTP_TO, default mis@nutriobox.com).
 *
 * Verify step: PATCH /api/ideal-inventory (stage="wastage").
 * Requires env: RESEND_API_KEY, RESEND_FROM (a verified sender).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

function sbEnv() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return { url, key: key as string | undefined };
}

const OTP_TO = process.env.WASTAGE_OTP_TO || "mis@nutriobox.com";
const OTP_TTL_MS = 10 * 60 * 1000;

export async function POST(req: Request) {
  const { url, key } = sbEnv();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured." }, { status: 500, headers: CORS });

  const resendKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!resendKey || !from) {
    return NextResponse.json({ ok: false, error: "Email isn't configured yet (RESEND_API_KEY / RESEND_FROM). Ask the admin to set them in Vercel." }, { status: 500, headers: CORS });
  }

  let body: { snapshot_id?: string } = {};
  try { body = (await req.json()) as { snapshot_id?: string }; } catch { /* ignore */ }
  const snapshotId = String(body.snapshot_id || "").trim();
  if (!snapshotId) return NextResponse.json({ ok: false, error: "snapshot_id required" }, { status: 400, headers: CORS });

  let outlet = "", orderNo: number | null = null;
  try {
    const sr = await fetch(
      `${url}/rest/v1/ideal_inventory_snapshots?select=outlet,order_number&id=eq.${encodeURIComponent(snapshotId)}`,
      { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" }, cache: "no-store" }
    );
    if (sr.ok) { const rr = (await sr.json()) as Array<{ outlet: string; order_number: number | null }>; if (rr[0]) { outlet = rr[0].outlet || ""; orderNo = rr[0].order_number ?? null; } }
  } catch { /* best-effort */ }

  const code = String(randomInt(0, 1000000)).padStart(6, "0");
  const codeHash = createHash("sha256").update(code).digest("hex");
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();

  const up = await fetch(`${url}/rest/v1/wastage_approval_otps?on_conflict=snapshot_id`, {
    method: "POST",
    headers: {
      apikey: key, Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ snapshot_id: snapshotId, code_hash: codeHash, expires_at: expiresAt, attempts: 0, updated_at: new Date().toISOString() }),
  });
  if (!up.ok) {
    const t = await up.text().catch(() => "");
    return NextResponse.json({ ok: false, error: `Could not store OTP: ${up.status} ${t}`.slice(0, 200) }, { status: 502, headers: CORS });
  }

  const label = outlet ? `${outlet}${orderNo != null ? ` (IO ${orderNo})` : ""}` : "a snapshot";
  const subject = `Wastage approval OTP — ${label}`;
  const html =
    `<p>One-time code to approve wastage for <b>${label}</b>:</p>` +
    `<p style="font-size:28px;font-weight:700;letter-spacing:4px;font-family:monospace">${code}</p>` +
    `<p>It expires in 10 minutes and can be used once. If you didn't request this, ignore this email.</p>`;

  const er = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [OTP_TO], subject, html }),
  });
  if (!er.ok) {
    const t = await er.text().catch(() => "");
    return NextResponse.json({ ok: false, error: `Email send failed: ${er.status} ${t}`.slice(0, 200) }, { status: 502, headers: CORS });
  }

  return NextResponse.json({ ok: true, to: OTP_TO, expires_at: expiresAt }, { headers: CORS });
}
