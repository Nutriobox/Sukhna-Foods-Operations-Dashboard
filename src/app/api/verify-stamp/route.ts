import { NextResponse } from "next/server";

/**
 * Stamp verification (Phase-2 vision helper) — Google Gemini.
 * POSTs { imageUrl } — the scanned bill image — and reports whether the inward
 * "Gate No." stamp and the "Store Checked" stamp are present. The UI uses this
 * to auto-tick the stamp gate.
 *
 * Resilient to transient model overload (HTTP 503 "high demand" / 429): it tries
 * several current flash models newest-first and retries with backoff, so a busy
 * model never silently fails the check.
 *
 * Requires GEMINI_API_KEY (or GOOGLE_API_KEY). Optional GEMINI_VISION_MODEL pins
 * a specific model.
 */

export const runtime = "nodejs";
export const maxDuration = 30;

let RESOLVED_MODELS: string[] | null = null;

function verOf(name: string): number {
  const m = (name || "").match(/gemini-(\d+(?:\.\d+)?)/i);
  return m ? parseFloat(m[1]) : 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Ordered candidate flash models (newest first) plus stable fallbacks, so a
// single overloaded model does not break the feature.
async function candidateModels(key: string): Promise<string[]> {
  if (process.env.GEMINI_VISION_MODEL) {
    return Array.from(new Set([process.env.GEMINI_VISION_MODEL, "gemini-flash-latest", "gemini-2.5-flash"]));
  }
  if (RESOLVED_MODELS) return RESOLVED_MODELS;
  let list: string[] = [];
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
      headers: { "x-goog-api-key": key },
    });
    if (r.ok) {
      const d = await r.json();
      const models: Array<{ name?: string; supportedGenerationMethods?: string[] }> = d?.models || [];
      list = models
        .filter(
          (m) =>
            (m.supportedGenerationMethods || []).includes("generateContent") &&
            /flash/i.test(m.name || "") &&
            !/lite|preview|exp|thinking|image|tts|audio|latest/i.test(m.name || "")
        )
        .map((m) => (m.name || "").replace(/^models\//, ""))
        .sort((a, b) => verOf(b) - verOf(a));
    }
  } catch {
    /* fall through to static fallbacks */
  }
  const picks = Array.from(new Set([...list.slice(0, 3), "gemini-flash-latest", "gemini-2.5-flash"]));
  RESOLVED_MODELS = picks.length ? picks : ["gemini-flash-latest"];
  return RESOLVED_MODELS;
}

// Call generateContent, trying each candidate model and retrying transient
// overload (429/5xx) with exponential backoff. Returns the first success.
async function generate(
  key: string,
  models: string[],
  parts: unknown[],
  generationConfig: Record<string, unknown>
): Promise<{ ok: boolean; data?: any; model?: string; detail?: string }> {
  let detail = "no_models";
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let r: Response;
      try {
        r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent", {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig }),
        });
      } catch (e) {
        detail = "fetch " + String(e).slice(0, 120);
        break;
      }
      if (r.ok) return { ok: true, data: await r.json(), model };
      const status = r.status;
      detail = "model=" + model + " HTTP " + status + " " + (await r.text().catch(() => "")).slice(0, 120);
      if (status === 429 || status >= 500) {
        await sleep(500 * Math.pow(2, attempt));
        continue;
      }
      break;
    }
  }
  return { ok: false, detail };
}

function mediaType(url: string, ct: string | null): string {
  if (ct && (ct.startsWith("image/") || ct === "application/pdf")) return ct.split(";")[0].trim();
  const u = url.toLowerCase().split("?")[0];
  if (u.endsWith(".pdf")) return "application/pdf";
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

  const models = await candidateModels(key);

  const prompt =
    'This is a scanned Indian purchase / tax invoice. It usually carries hand-applied rubber INK STAMPS — ' +
    'typically blue, sometimes faint, smudged, partial, tilted or diagonal, and frequently overlapping handwritten ' +
    'signatures, mostly in the lower half of the page. Stamps are often hard to read, so be GENEROUS: judge by the ' +
    'overall shape and any legible words, not perfect spelling.\n\n' +
    'Work step by step:\n' +
    '1. Look carefully across the WHOLE page, especially the lower half and the margins, and list every rubber-stamp ' +
    'impression you can see, transcribing whatever text you can make out inside each stamp (read rotated / faint / ' +
    'partial / overlapping text too — write what you can even if some letters are unclear).\n' +
    '2. Then decide (match loosely — accept close spellings, partial words, and abbreviations):\n' +
    '   - gateNo = true if ANY stamp looks like an inward gate-entry stamp. Treat it as present if the stamp contains ' +
    'ANY of these (you do NOT need all of them): "GATE NO" / "GATE NUMBER" / "GATE", or "INWARD" / "IN WARD", or a ' +
    'security/logistics company name such as "ALLSURE" / "ALLSURE SERVICES", especially when accompanied by ' +
    'Sr.No / S.No / Date / Sign / Time lines.\n' +
    '   - storeChecked = true if ANY stamp is a store-verification stamp. Treat it as present if the stamp contains ' +
    'ANY of "STORE CHECKED" / "STORE CHECK" / "STORE CHK" / "STORE CHEKD" / "STORE" combined with "CHECK", or the ' +
    'clearly-store-check stamp with S.No / Date / Sign lines.\n' +
    'Only mark a value false if that stamp is genuinely absent from the page — not merely because the text is faint ' +
    'or the spelling differs slightly.\n\n' +
    'After your reasoning, end your reply with a single final line in EXACTLY this form:\n' +
    'FINAL {"gateNo": true|false, "storeChecked": true|false}';

  const res = await generate(
    key,
    models,
    [{ inline_data: { mime_type: mt, data: b64 } }, { text: prompt }],
    { temperature: 0, maxOutputTokens: 1024 }
  );
  if (!res.ok) return NextResponse.json({ ok: false, reason: "vision_error", detail: (res.detail || "").slice(0, 300) });

  try {
    const data = res.data;
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text: string = parts.map((p: { text?: string }) => p?.text || "").join("");
    const idx = text.lastIndexOf("FINAL");
    const tail = idx >= 0 ? text.slice(idx) : text;
    const m = tail.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : {};
    const gateNo = !!parsed.gateNo;
    const storeChecked = !!parsed.storeChecked;
    return NextResponse.json({ ok: true, model: res.model, gateNo, storeChecked, verified: gateNo && storeChecked });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: "parse_failed", model: res.model, detail: String(e).slice(0, 300) });
  }
}
