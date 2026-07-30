import { NextResponse } from "next/server";

/**
 * Stamp verification (Phase-2 vision helper) — Google Gemini.
 * POSTs { imageUrl } — the scanned bill image — to a Gemini vision model and
 * reports whether the inward "Gate No." stamp and the "MIS Entry" stamp are
 * present. The UI uses this to auto-tick the stamp gate.
 *
 * Requires GEMINI_API_KEY (or GOOGLE_API_KEY) in the environment — set it in
 * Vercel -> Settings -> Environment Variables. Optional GEMINI_VISION_MODEL
 * overrides the model (default "gemini-2.0-flash"). When the key is absent the
 * route returns { ok:false, reason:"not_configured" } and the dashboard falls
 * back to the manual checkbox.
 */

export const runtime = "nodejs";
export const maxDuration = 30;

const MODEL = process.env.GEMINI_VISION_MODEL || "gemini-2.0-flash";

function mediaType(url: string, ct: string | null): string {
  if (ct && ct.startsWith("image/")) return ct.split(";")[0].trim();
  const u = url.toLowerCase();
  if (u.endsWith(".png")) return "image/png";
  if (u.endsWith(".webp")) return "image/webp";
  if (u.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

export async function POST(req: Request) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
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
    if (!imgRes.ok) return NextResponse.json({ ok: false, reason: "scan_fetch_failed", detail: "HTTP " + imgRes.status + " for " + abs });
    const buf = Buffer.from(await imgRes.arrayBuffer());
    b64 = buf.toString("base64");
    mt = mediaType(abs, imgRes.headers.get("content-type"));
  } catch (e) {
    return NextResponse.json({ ok: false, reason: "scan_fetch_failed", detail: String(e).slice(0, 200) });
  }

  const prompt =
    'You are verifying a scanned purchase invoice for an inward-goods gate check. ' +
    'Examine the ink stamps on the page and report whether each of these is present:\n' +
    '1. "gateNo": an inward gate-entry stamp containing the words "GATE NO" and "INWARD" ' +
    '(often diagonal, with Sr. No / Date / Sign lines and a company address).\n' +
    '2. "misEntry": an "MIS ENTRY" stamp (with S.No / Date / Sign lines) — the store/MIS received stamp.\n' +
    'A printed table header or the invoice body text does NOT count — only an actual rubber-stamp impression counts. ' +
    'Respond with STRICT JSON only: {"gateNo": true|false, "misEntry": true|false}';

  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { inline_data: { mime_type: mt, data: b64 } },
              { text: prompt },
            ],
          },
        ],
        generationConfig: { temperature: 0, maxOutputTokens: 200, responseMimeType: "application/json" },
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return NextResponse.json({ ok: false, reason: "vision_error", detail: ("HTTP " + r.status + " " + t).slice(0, 300) });
    }
    const data = await r.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text: string = parts.map((p: { text?: string }) => p?.text || "").join("");
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : {};
    const gateNo = !!parsed.gateNo;
    const misEntry = !!parsed.misEntry;
    return NextResponse.json({ ok: true, gateNo, misEntry, verified: gateNo && misEntry });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: "vision_error", detail: String(e).slice(0, 300) });
  }
}
