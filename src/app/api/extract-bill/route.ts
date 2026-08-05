import { NextResponse } from "next/server";

/**
 * Bill extraction (Phase-2 vision helper) — Google Gemini.
 * POST { fileUrl } — a public URL of the uploaded scanned bill (PDF or image).
 * Returns structured bill fields so the "Add a bill" form can be auto-filled.
 * Uses the same GEMINI_API_KEY (or GOOGLE_API_KEY) as the stamp checker.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

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
    /* fall through */
  }
  return "gemini-flash-latest";
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
  const fileUrl: string | undefined = body?.fileUrl;
  if (!fileUrl) return NextResponse.json({ ok: false, reason: "no_file" });

  let abs = fileUrl;
  if (!/^https?:\/\//i.test(abs)) {
    const origin = process.env.NEXT_PUBLIC_SITE_URL || new URL(req.url).origin;
    abs = origin.replace(/\/$/, "") + (abs.startsWith("/") ? abs : "/" + abs);
  }

  let b64: string;
  let mt: string;
  try {
    const res = await fetch(abs);
    if (!res.ok) return NextResponse.json({ ok: false, reason: "fetch_failed", detail: "HTTP " + res.status });
    const buf = Buffer.from(await res.arrayBuffer());
    b64 = buf.toString("base64");
    mt = mediaType(abs, res.headers.get("content-type"));
  } catch (e) {
    return NextResponse.json({ ok: false, reason: "fetch_failed", detail: String(e).slice(0, 200) });
  }

  const model = await resolveModel(key);

  const prompt =
    "You are reading a scanned Indian purchase / tax (GST) invoice. Extract its contents into JSON.\n\n" +
    "Read carefully, including rotated, faint or handwritten text. Numbers may use Indian formatting (e.g. 1,23,456.00) — " +
    "return them as plain numbers with no commas or currency symbols.\n\n" +
    "Return ONLY a single JSON object (no markdown, no commentary) in EXACTLY this shape:\n" +
    "{\n" +
    '  "vendor": string,            // seller / supplier name\n' +
    '  "vendorGst": string,         // seller GSTIN (15 chars) or ""\n' +
    '  "invoice": string,           // invoice number exactly as printed\n' +
    '  "invoiceDate": string,       // ISO date yyyy-mm-dd\n' +
    '  "buyer": string,             // billed-to / consignee name\n' +
    '  "buyerGst": string,          // billed-to GSTIN or ""\n' +
    '  "roundOff": number,          // rounding adjustment, 0 if none\n' +
    '  "items": [\n' +
    '    { "name": string, "hsn": string, "qty": number, "uom": string, "price": number, "rate": number }\n' +
    "    // one per line item. price = per-unit rate. rate = GST % as a number (e.g. 5, 12, 18).\n" +
    "  ],\n" +
    '  "otherCharges": [ { "label": string, "amount": number } ]  // freight/packing/etc., [] if none\n' +
    "}\n\n" +
    "If a field is not present, use \"\" for strings, 0 for numbers, or [] for arrays. Do not invent values.";

  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ inline_data: { mime_type: mt, data: b64 } }, { text: prompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 4096, responseMimeType: "application/json" },
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return NextResponse.json({ ok: false, reason: "vision_error", model, detail: ("HTTP " + r.status + " " + t).slice(0, 300) });
    }
    const data = await r.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text: string = parts.map((p: { text?: string }) => p?.text || "").join("");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return NextResponse.json({ ok: false, reason: "parse_failed", model, detail: text.slice(0, 300) });
    const parsed = JSON.parse(m[0]);
    return NextResponse.json({ ok: true, model, bill: parsed });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: "vision_error", model, detail: String(e).slice(0, 300) });
  }
}
