import { NextResponse } from "next/server";

/**
 * Stamp verification (Phase-2 vision helper).
 * POSTs { imageUrl } — the scanned bill image — to an AI vision model and
 * reports whether the inward "Gate No." stamp and the "MIS Entry" stamp are
 * present on the page. The UI uses this to auto-tick the stamp gate.
 *
 * Requires ANTHROPIC_API_KEY in the environment (set it in Vercel -> Settings ->
 * Environment Variables). Optional STAMP_VISION_MODEL overrides the model.
 * When the key is absent the route returns { ok:false, reason:"not_configured" }
 * and the dashboard falls back to the manual checkbox.
 */

export const runtime = "nodejs";
export const maxDuration = 30;

const MODEL = process.env.STAMP_VISION_MODEL || "claude-3-5-sonnet-20241022";

function mediaType(url: string, ct: string | null): string {
  if (ct && ct.startsWith("image/")) return ct.split(";")[0].trim();
  const u = url.toLowerCase();
  if (u.endsWith(".png")) return "image/png";
  if (u.endsWith(".webp")) return "image/webp";
  if (u.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

export async function POST(req: Request) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return NextResponse.json({ ok: false, reason: "not_configured" });

  const body = await req.json().catch(() => null);
  const imageUrl: string | undefined = body?.imageUrl;
  if (!imageUrl) return NextResponse.json({ ok: false, reason: "no_scan" });

  // Resolve to an absolute URL the server can fetch.
  let abs = imageUrl;
  if (!/^https?:\/\//i.test(abs)) {
    const origin = process.env.NEXT_PUBLIC_SITE_URL || new URL(req.url).origin;
    abs = origin.replace(/\/$/, "") + (abs.startsWith("/") ? abs : "/" + abs);
  }

  let b64: string;
  let mt: string;
  try {
    const imgRes = await fetch(abs);
    if (!imgRes.ok) return NextResponse.json({ ok: false, reason: "scan_fetch_failed" });
    const buf = Buffer.from(await imgRes.arrayBuffer());
    b64 = buf.toString("base64");
    mt = mediaType(abs, imgRes.headers.get("content-type"));
  } catch {
    return NextResponse.json({ ok: false, reason: "scan_fetch_failed" });
  }

  const prompt =
    'You are verifying a scanned purchase invoice for an inward-goods gate check. ' +
    'Examine the ink stamps on the page and report whether each of these is present:\n' +
    '1. "gateNo": an inward gate-entry stamp containing the words "GATE NO" and "INWARD" ' +
    '(often diagonal, with Sr. No / Date / Sign lines and a company address).\n' +
    '2. "misEntry": an "MIS ENTRY" stamp (with S.No / Date / Sign lines) — the store/MIS received stamp.\n' +
    'A printed table header or the invoice body text does NOT count — only an actual rubber-stamp impression counts. ' +
    'Respond with STRICT JSON only and nothing else: {"gateNo": true|false, "misEntry": true|false}';

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 200,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mt, data: b64 } },
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return NextResponse.json({ ok: false, reason: "vision_error", detail: t.slice(0, 300) });
    }
    const data = await r.json();
    const text: string = (data?.content || []).map((c: { text?: string }) => c?.text || "").join("");
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : {};
    const gateNo = !!parsed.gateNo;
    const misEntry = !!parsed.misEntry;
    return NextResponse.json({ ok: true, gateNo, misEntry, verified: gateNo && misEntry });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: "vision_error", detail: String(e).slice(0, 300) });
  }
}
