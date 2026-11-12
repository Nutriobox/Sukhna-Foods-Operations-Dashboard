"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Row = { batch: string; warehouse: string; mfg: string; exp: string; qty: number };
type Source = { orderNo: string; postedAt: string; scanned: number };
type Item = {
  code: string; name: string; salesUnit: string; scale: number;
  system: number; actual: number; variance: number; klass: "Scrap" | "Excess" | "Match" | "Uncounted"; qty: number;
  coverage: number; warehouse: string; scrapRows: Row[]; excessRows: Row[]; flags: string[]; sources: Source[];
};
type Resp = { ok: boolean; date?: string; snapshotAt?: string | null; snapshotProducts?: number; generatedAt?: string; items?: Item[]; error?: string };

const C = { ink: "#0e2233", sub: "#64748b", line: "#e2e8f0", head: "#f1f5f9" };
const klassColor: Record<string, string> = { Scrap: "#dc2626", Excess: "#2563eb", Match: "#16a34a", Uncounted: "#94a3b8" };
const SCRAP = { sheet: "SCARP", prefix: "26-27/", location: "Factory", unit: "Gms", allocation: "Batch 1", damage: "Sorting" };
const EXCESS = { sheet: "Excess Stock", prefix: "AF/26-27/", credit: "Production Wip", location: "Factory", unit: "Gms" };
const REFRESH_MS = 25000;
const STATUSES = ["done", "counting", "open", "all"];

const nf = (n: number) => Math.round(n).toLocaleString("en-IN");
const todayIST = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const toDMY = (ymd: string) => { const m = /(\d{4})-(\d{2})-(\d{2})/.exec(ymd || ""); return m ? `${m[3]}-${m[2]}-${m[1]}` : ymd; };
const dateFromIso = (s: string): Date | "" => { const m = /(\d{4})-(\d{2})-(\d{2})/.exec(s || ""); return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : ""; };
function fmtTime(iso: string) { try { return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }); } catch { return ""; } }
function fmtClock(iso: string | null) { if (!iso) return "—"; try { return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Asia/Kolkata" }); } catch { return "—"; } }
function fmtSync(s: string | null | undefined) { if (!s) return "—"; try { return new Date(s).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }); } catch { return String(s).slice(0, 16); } }

type ExportKind = "scrap" | "excess";
type Line = { code: string; name: string; warehouse: string; batch: string; mfg: string; exp: string; qty: number; order: string };

export default function StockReconciliationPage() {
  const [date, setDate] = useState(todayIST());
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [status, setStatus] = useState("done");
  const [wh, setWh] = useState("all");
  const [items, setItems] = useState<Item[]>([]);
  const [snapAt, setSnapAt] = useState<string | null>(null);
  const [genAt, setGenAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState("");

  const [dlg, setDlg] = useState<ExportKind | null>(null);
  const [docDate, setDocDate] = useState("");
  const [prefix, setPrefix] = useState("");
  const [startNo, setStartNo] = useState("");
  const [perProduct, setPerProduct] = useState(true);
  const [damage, setDamage] = useState(SCRAP.damage);

  const q = useMemo(() => `date=${date}&status=${status}${from ? `&from=${from}` : ""}${to ? `&to=${to}` : ""}`, [date, status, from, to]);
  const qRef = useRef(q); qRef.current = q;

  const load = useCallback(async (query: string, silent = false) => {
    if (!silent) setLoading(true); else setRefreshing(true);
    setErr("");
    try {
      const r = await fetch(`/api/stock-reconciliation?${query}`, { cache: "no-store" });
      const j: Resp = await r.json();
      if (!j.ok) throw new Error(j.error || "Failed to load");
      if (qRef.current !== query) return;
      setItems(j.items || []); setSnapAt(j.snapshotAt || null); setGenAt(j.generatedAt || new Date().toISOString());
    } catch (e) { if (!silent) { setErr(e instanceof Error ? e.message : String(e)); setItems([]); } }
    finally { if (!silent) setLoading(false); else setRefreshing(false); }
  }, []);

  useEffect(() => {
    load(q);
    const iv = setInterval(() => load(qRef.current, true), REFRESH_MS);
    const onFocus = () => load(qRef.current, true);
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(iv); window.removeEventListener("focus", onFocus); };
  }, [q, load]);

  const warehouses = useMemo(() => {
    const s = new Set<string>();
    items.forEach((it) => [...it.scrapRows, ...it.excessRows].forEach((r) => r.warehouse && s.add(r.warehouse)));
    return ["all", ...Array.from(s).sort()];
  }, [items]);

  const rowsOf = useCallback((it: Item) => {
    const rows = it.klass === "Scrap" ? it.scrapRows : it.klass === "Excess" ? it.excessRows : [];
    return wh === "all" ? rows : rows.filter((r) => r.warehouse === wh);
  }, [wh]);

  // items visible after the warehouse filter (an item with no rows left is dropped from scrap/excess views)
  const stats = useMemo(() => {
    let scrapN = 0, excessN = 0, matchN = 0, uncountedN = 0, scrapQ = 0, excessQ = 0;
    items.forEach((it) => {
      if (it.klass === "Scrap") { const q = rowsOf(it).reduce((t, r) => t + r.qty, 0); if (q > 0 || wh === "all") { scrapN++; scrapQ += q; } }
      else if (it.klass === "Excess") { const q = rowsOf(it).reduce((t, r) => t + r.qty, 0); if (q > 0 || wh === "all") { excessN++; excessQ += q; } }
      else if (it.klass === "Uncounted") uncountedN++;
      else matchN++;
    });
    return { items: items.length, scrapN, excessN, matchN, uncountedN, scrapQ, excessQ };
  }, [items, rowsOf, wh]);

  const flagged = useMemo(() => items.filter((it) => it.flags.length).map((it) => `${it.code} ${it.name}`), [items]);

  const linesFor = useCallback((kind: ExportKind): Line[] => {
    const out: Line[] = [];
    items.forEach((it) => { if ((kind === "scrap" ? "Scrap" : "Excess") === it.klass) rowsOf(it).forEach((r) => out.push({ code: it.code, name: it.name, warehouse: r.warehouse, batch: r.batch, mfg: r.mfg, exp: r.exp, qty: r.qty, order: it.sources.map((s) => s.orderNo).join(" + ") })); });
    return out;
  }, [items, rowsOf]);
  const scrapLines = useMemo(() => linesFor("scrap"), [linesFor]);
  const excessLines = useMemo(() => linesFor("excess"), [linesFor]);

  function docNos(lines: Line[], start: number, byProduct: boolean): number[] {
    if (!byProduct) return lines.map(() => start);
    const seen = new Map<string, number>(); let n = start;
    return lines.map((l) => { if (!seen.has(l.code)) seen.set(l.code, n++); return seen.get(l.code) as number; });
  }
  function openDialog(kind: ExportKind) { setDlg(kind); setDocDate(date); setPrefix(kind === "scrap" ? SCRAP.prefix : EXCESS.prefix); setStartNo(""); setPerProduct(true); setDamage(SCRAP.damage); }

  async function runExport() {
    if (!dlg) return;
    const kind = dlg, start = parseInt(startNo, 10);
    if (!isFinite(start)) { alert("Enter a starting voucher number."); return; }
    const lines = kind === "scrap" ? scrapLines : excessLines;
    if (!lines.length) { alert(`No ${kind} lines to export.`); return; }
    const nos = docNos(lines, start, perProduct);
    const dd = dateFromIso(docDate) || docDate;
    const XLSX = await import("xlsx");
    let aoa: (string | number | Date)[][];
    if (kind === "scrap") {
      aoa = [["Doc date ", "Doc prefix", "Doc no", "Location", "Warehouse", "Product name", "Unit", "Scrap qty", "Unit price", "Value", "Batch No", "Mfg date", "Exp date", "Batch Allocation", "Damage Type", "IMPORT_STATUS", "IMPORT_MESSAGE"]];
      lines.forEach((l, i) => aoa.push([dd, prefix, nos[i], SCRAP.location, l.warehouse, l.name, SCRAP.unit, l.qty, 0, 0, l.batch, dateFromIso(l.mfg), dateFromIso(l.exp), SCRAP.allocation, damage, "", ""]));
    } else {
      aoa = [["Doc date ", "Doc prefix", "Doc no", "Credit ", "Location", "Warehouse", "Product name", "Unit", "Qty", "Unit price", "Value", "Batch No", "Mfg date", "Exp date", "IMPORT_STATUS", "IMPORT_MESSAGE"]];
      lines.forEach((l, i) => aoa.push([dd, prefix, nos[i], EXCESS.credit, EXCESS.location, l.warehouse, l.name, EXCESS.unit, l.qty, 0, 0, l.batch, dateFromIso(l.mfg), dateFromIso(l.exp), "", ""]));
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true, dateNF: "dd-mm-yyyy" });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, kind === "scrap" ? SCRAP.sheet : EXCESS.sheet);
    XLSX.writeFile(wb, `${kind === "scrap" ? "SCARP" : "Excess Stock"}-${date}.xlsx`, { cellDates: true });
    setDlg(null);
  }

  async function exportMaster() {
    const XLSX = await import("xlsx");
    const summary: (string | number)[][] = [["Date", "Code", "Product", "Sales unit", "System (gms)", "Actual (gms)", "Variance (gms)", "Result", "Warehouse", "Counts", "Note"]];
    items.forEach((it) => summary.push([date, it.code, it.name, it.salesUnit, it.system, it.actual, it.variance, it.klass, it.warehouse, it.sources.map((s) => `${s.orderNo}@${fmtTime(s.postedAt)}=${Math.round(s.scanned)}`).join(" | "), it.flags.join("; ")]));
    const sD: (string | number)[][] = [["Code", "Product", "Warehouse", "Batch No", "Mfg date", "Scrap qty (Gms)", "From vouchers"]];
    scrapLines.forEach((l) => sD.push([l.code, l.name, l.warehouse, l.batch, toDMY(l.mfg), l.qty, l.order]));
    const eD: (string | number)[][] = [["Code", "Product", "Warehouse", "Batch No", "Mfg date", "Qty (Gms)", "From vouchers"]];
    excessLines.forEach((l) => eD.push([l.code, l.name, l.warehouse, l.batch, toDMY(l.mfg), l.qty, l.order]));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), "Summary");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sD), "Scrap detail");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(eD), "Excess detail");
    XLSX.writeFile(wb, `stock-recon-master-${date}.xlsx`);
  }

  const ctrl: React.CSSProperties = { font: "inherit", padding: "7px 10px", border: "1px solid #cbd5e1", borderRadius: 8, background: "#fff" };
  const btn: React.CSSProperties = { ...ctrl, cursor: "pointer", fontWeight: 600 };
  const cell: React.CSSProperties = { borderBottom: `1px solid ${C.line}`, padding: "6px 10px", fontSize: 13, textAlign: "left", whiteSpace: "nowrap" };
  const th: React.CSSProperties = { ...cell, background: C.head, fontWeight: 600 };
  const numCell: React.CSSProperties = { ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" };

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", color: C.ink, maxWidth: 1240, margin: "0 auto" }}>
      <a href="/dispatch-report" style={{ color: C.sub, fontSize: 13, textDecoration: "none" }}>&larr; Back to dispatch report</a>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 10, margin: "10px 0 4px" }}>
        <h1 style={{ fontSize: 24, margin: 0 }}>Stock Reconciliation</h1>
        <div style={{ color: C.sub, fontSize: 12.5 }}>Batch warehouses from PACT stock as of {fmtSync(snapAt)}</div>
      </div>
      <p style={{ color: C.sub, margin: "0 0 16px", fontSize: 14 }}>
        A product counted more than once in the window is consolidated (system = latest count, actual = sum). Only counted items (actual &gt; 0) are scrapped. Shortages become a <b style={{ color: klassColor.Scrap }}>Scrap</b> import; surpluses an <b style={{ color: klassColor.Excess }}>Excess&nbsp;Stock</b> import.
      </p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: 14 }}>
        <label style={{ fontSize: 13, color: C.sub, display: "flex", alignItems: "center", gap: 6 }}>Date <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={ctrl} /></label>
        <label style={{ fontSize: 13, color: C.sub, display: "flex", alignItems: "center", gap: 6 }}>From <input type="time" value={from} onChange={(e) => setFrom(e.target.value)} style={ctrl} /></label>
        <label style={{ fontSize: 13, color: C.sub, display: "flex", alignItems: "center", gap: 6 }}>To <input type="time" value={to} onChange={(e) => setTo(e.target.value)} style={ctrl} /></label>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={ctrl}>{STATUSES.map((s) => <option key={s} value={s}>{s === "all" ? "All statuses" : s[0].toUpperCase() + s.slice(1)}</option>)}</select>
        <select value={wh} onChange={(e) => setWh(e.target.value)} style={ctrl}>{warehouses.map((w) => <option key={w} value={w}>{w === "all" ? "All warehouses" : w}</option>)}</select>
        <button onClick={() => load(q, true)} style={btn}>{refreshing ? "Refreshing…" : "↻ Refresh"}</button>
        <span style={{ fontSize: 12, color: C.sub }}>Live · {fmtClock(genAt)}</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: 14 }}>
        {(from || to) && <span style={{ fontSize: 12, color: C.sub }}>Window {from || "00:00"}–{to || "23:59"}</span>}
        <div style={{ flex: 1 }} />
        <button onClick={exportMaster} style={btn} disabled={!items.length}>Master Excel</button>
        <button onClick={() => openDialog("scrap")} style={{ ...btn, background: klassColor.Scrap, color: "#fff", borderColor: klassColor.Scrap, opacity: scrapLines.length ? 1 : 0.5 }} disabled={!scrapLines.length}>Scrap import</button>
        <button onClick={() => openDialog("excess")} style={{ ...btn, background: klassColor.Excess, color: "#fff", borderColor: klassColor.Excess, opacity: excessLines.length ? 1 : 0.5 }} disabled={!excessLines.length}>Excess import</button>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
        {[
          ["Products", nf(stats.items), C.ink],
          ["Scrap", `${nf(stats.scrapN)} · ${nf(stats.scrapQ)} g`, klassColor.Scrap],
          ["Excess", `${nf(stats.excessN)} · ${nf(stats.excessQ)} g`, klassColor.Excess],
          ["Matched", nf(stats.matchN), klassColor.Match],
          ["Not counted", nf(stats.uncountedN), klassColor.Uncounted],
        ].map(([label, val, color]) => (
          <div key={label as string} style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: "8px 14px", minWidth: 110, background: "#fff" }}>
            <div style={{ fontSize: 11, color: C.sub, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: color as string }}>{val}</div>
          </div>
        ))}
      </div>

      {flagged.length > 0 && (
        <div style={{ background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 10, padding: "10px 14px", marginBottom: 14, fontSize: 13, color: "#92400e" }}>
          <b>{flagged.length} item(s) to check</b> — not in the latest PACT batch snapshot, so warehouse/batch may be blank. {flagged.slice(0, 6).join("; ")}{flagged.length > 6 ? "…" : ""}
        </div>
      )}

      {loading ? <p>Loading…</p>
        : err ? <p style={{ color: "#b91c1c" }}>Couldn&rsquo;t load: {err}</p>
        : !items.length ? <p style={{ color: C.sub }}>No counts on {toDMY(date)}{from || to ? ` in ${from || "00:00"}–${to || "23:59"}` : ""}.</p>
        : (
          <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 1000 }}>
                <thead><tr>
                  <th style={th}>Code</th><th style={th}>Product</th>
                  <th style={{ ...th, textAlign: "right" }}>System</th><th style={{ ...th, textAlign: "right" }}>Actual</th><th style={{ ...th, textAlign: "right" }}>Variance</th>
                  <th style={th}>Result</th><th style={th}>Warehouse</th><th style={th}>Counts (time)</th><th style={th}>Batches</th>
                </tr></thead>
                <tbody>
                  {items.map((it) => {
                    const rows = rowsOf(it);
                    const batchTxt = rows.length ? rows.map((r) => `${r.batch || "—"}${r.qty ? ` (${nf(r.qty)}g)` : ""}`).join(", ") : "—";
                    const counts = it.sources.map((s, k) => `${fmtTime(s.postedAt)} (${nf(s.scanned)}g)${k === it.sources.length - 1 && it.sources.length > 1 ? " ←sys" : ""}`).join(", ");
                    return (
                      <tr key={it.code}>
                        <td style={{ ...cell, fontVariantNumeric: "tabular-nums" }}>{it.code}</td>
                        <td style={{ ...cell, whiteSpace: "normal" }}>{it.name}{it.sources.length > 1 && <span style={{ color: "#7c3aed", fontSize: 11 }}> · {it.sources.length}× counted</span>}</td>
                        <td style={numCell}>{nf(it.system)}</td>
                        <td style={numCell}>{nf(it.actual)}</td>
                        <td style={{ ...numCell, color: klassColor[it.klass] || C.sub }}>{it.klass === "Uncounted" ? "—" : `${it.variance > 0 ? "+" : ""}${nf(it.variance)}`}</td>
                        <td style={cell}><span style={{ display: "inline-block", padding: "1px 8px", borderRadius: 999, fontSize: 11.5, fontWeight: 600, color: "#fff", background: klassColor[it.klass] }}>{it.klass}</span></td>
                        <td style={{ ...cell, whiteSpace: "normal" }}>{it.warehouse || <span style={{ color: "#b45309" }}>—</span>}</td>
                        <td style={{ ...cell, whiteSpace: "normal", color: C.sub, fontSize: 12 }}>{counts}</td>
                        <td style={{ ...cell, whiteSpace: "normal", color: C.sub, fontSize: 12 }}>{batchTxt}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

      {dlg && (
        <div onClick={() => setDlg(null)} style={{ position: "fixed", inset: 0, background: "rgba(15,34,51,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 14, padding: 22, width: 440, maxWidth: "92vw", boxShadow: "0 20px 60px rgba(0,0,0,.25)" }}>
            <h3 style={{ margin: "0 0 4px", fontSize: 18, color: dlg === "scrap" ? klassColor.Scrap : klassColor.Excess }}>{dlg === "scrap" ? "Scrap import" : "Excess Stock import"}</h3>
            <p style={{ margin: "0 0 16px", color: C.sub, fontSize: 13 }}>{(dlg === "scrap" ? scrapLines : excessLines).length} line(s) · {new Set((dlg === "scrap" ? scrapLines : excessLines).map((l) => l.code)).size} product(s){wh !== "all" ? ` · ${wh}` : ""}</p>
            <label style={{ display: "block", fontSize: 12, color: C.sub, marginBottom: 10 }}>Voucher no (Doc no)
              <input autoFocus value={startNo} onChange={(e) => setStartNo(e.target.value.replace(/[^0-9]/g, ""))} placeholder="e.g. 1338" style={{ ...ctrl, width: "100%", marginTop: 4 }} /></label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 14, cursor: "pointer" }}>
              <input type="checkbox" checked={perProduct} onChange={(e) => setPerProduct(e.target.checked)} /> New voucher no for each product (increment)</label>
            <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
              <label style={{ flex: 1, fontSize: 12, color: C.sub }}>Doc date <input type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} style={{ ...ctrl, width: "100%", marginTop: 4 }} /></label>
              <label style={{ flex: 1, fontSize: 12, color: C.sub }}>Doc prefix <input value={prefix} onChange={(e) => setPrefix(e.target.value)} style={{ ...ctrl, width: "100%", marginTop: 4 }} /></label>
              {dlg === "scrap" && <label style={{ flex: 1, fontSize: 12, color: C.sub }}>Damage type <input value={damage} onChange={(e) => setDamage(e.target.value)} style={{ ...ctrl, width: "100%", marginTop: 4 }} /></label>}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button onClick={() => setDlg(null)} style={btn}>Cancel</button>
              <button onClick={runExport} style={{ ...btn, background: dlg === "scrap" ? klassColor.Scrap : klassColor.Excess, color: "#fff", borderColor: dlg === "scrap" ? klassColor.Scrap : klassColor.Excess }}>Download .xlsx</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
