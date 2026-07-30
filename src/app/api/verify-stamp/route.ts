import { NextResponse } from "next/server";

/**
 * Stamp verification (Phase-2 vision helper) — Google Gemini.
 * POSTs { imageUrl } — the scanned bill image — to a Gemini vision model and
 * reports whether the inward "Gate No." stamp and the "MIS Entry" stamp are
 * present. The UI uses this to auto-tick the stamp gate.
 *
 * Requires GEMINI_API_KEY (or GOOGLE_API_KEY). Optional GEMINI_VISION_MODEL
 * pins a specific model; otherwise the route auto-discovers a current
 * vision-capable model from the account (so it survives model renames).
 */

export const runtime = "nodejs";
export const maxDuration = 30;

let RESOLVED_MODEL: string | null = null;

function verOf(name: string): number {
  const m = (name || "").match(/gemini-(\d+(?:\.\d+)?)/i);
  return m ? parseFloat(m[1]) : 0;
}

async function resolveModel(key: string): Promise<string> {
  if (process.env.GEMINI_VISION_MODEL) return process.env.GEMINI_VISION_MODEL;
  if (RESOLVED_MODEL) return RESOLVED_MODEL;
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
      headers: { "x-goog-api-key": key },
    });
    if (r.ok) {
      const d = await r.json();
      const models: Array<{ name?: string; supportedGenerationMethods?: string[] }> = d?.models || [];
      // Stable flash vision models only (exclude lite/preview/image/tts/etc.), newest version first.
      const flash = models
        .filter(
          (m) =>
            (m.supportedGenerationMethods || []).includes("generateContent") &&
            /flash/i.test(m.name || "") &&
            !/lite|preview|exp|thinking|image|tts|audio|latest/i.test(m.name || "")
        )
        .sort((a, b) => verOf(b.name || "") - verOf(a.name || ""));
      const pick = flash[0]?.name || "models/gemini-flash-latest";
      RESOLVED_MODEL = pick.replace(/^models\//, "");
      return RESOLVED_MODEL;
    }
  } catch {
    // fall through
  }
  return "gemini-flash-latest";
}

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

  const model = await resolveModel(key);

  const prompt =
    'This is a scanned Indian purchase / tax invoice. It usually carries hand-applied rubber INK STAMPS — ' +
    'typically blue, sometimes faint or smudged, often tilted or diagonal, and frequently overlapping handwritten signatures, ' +
    'mostly in the lower half of the page.\n\n' +
    'Work step by step:\n' +
    '1. Look carefully across the WHOLE page, especially the lower half, and list every rubber-stamp impression you can see, ' +
    'transcribing the text inside each stamp (read rotated / faint / overlapping text too).\n' +
    '2. Then decide:\n' +
    '   - gateNo = true if any stamp contains "GATE NO" together with "INWARD" (an inward gate-entry stamp, often with a ' +
    'company name/address like "ALLSURE SERVICES" and Sr.No / Date / Sign lines).\n' +
    '   - storeChecked = true if any stamp contains the words "STORE CHECKED" (with S.No / Date / Sign lines).\n\n' +
    'After your reasoning, end your reply with a single final line in EXACTLY this form:\n' +
    'FINAL {"gateNo": true|false, "storeChecked": true|false}';

  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [
          { role: "user", parts: [{ inline_data: { mime_type: mt, data: b64 } }, { text: prompt }] },
        ],
        generationConfig: { temperature: 0, maxOutputTokens: 1024 },
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return NextResponse.json({ ok: false, reason: "vision_error", model, detail: ("model=" + model + " HTTP " + r.status + " " + t).slice(0, 300) });
    }
    const data = await r.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text: string = parts.map((p: { text?: string }) => p?.text || "").join("");
    const idx = text.lastIndexOf("FINAL");
    const tail = idx >= 0 ? text.slice(idx) : text;
    const m = tail.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : {};
    const gateNo = !!parsed.gateNo;
    const storeChecked = !!parsed.storeChecked;
    return NextResponse.json({ ok: true, model, gateNo, storeChecked, verified: gateNo && storeChecked });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: "vision_error", model, detail: String(e).slice(0, 300) });
  }
}
