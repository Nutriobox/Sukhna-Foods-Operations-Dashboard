"use client";
import { useEffect, useMemo, useState } from "react";

type Row = { batch: string; warehouse: string; mfg: string; qty: number };
type Item = {
  code: string; name: string; salesUnit: string; scale: number;
  system: number; actual: number; variance: number; klass: "Scrap" | "Excess" | "Match"; qty: number;
  warehouse: string; scrapRows: Row[]; excessRows: Row[]; flags: string[];
};
type Order = { id: string; orderNo: string; status: string; createdAt: string; items: Item[] };
type Resp = { ok: boolean; date?: string; snapshotAt?: string | null; snapshotProducts?: number; orders?: Order[]; error?: string };

const C = { ink: "#0e2233", sub: "#64748b", line: "#e2e8f0", head: "#f1f5f9" };
const klassColor: Record<string, string> = { Scrap: "#dc2626", Excess: "#2563eb", Match: "#16a34a" };

// Fixed PACT-import constants (editable in the export dialog).
const SCRAP_DEFAULTS = { prefix: "26-27/", location: "Factory", unit: "Gms" };
const EXCESS_DEFAULTS = { prefix: "AF/26-27/", credit: "Production Wip", location: "Factory", unit: "Gms" };

const nf = (n: number) => Math.round(n).toLocaleString("en-IN");
const todayIST = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD
const toDMY = (ymd: string) => { const m = /(\d{4})-(\d{2})-(\d{2})/.exec(ymd || ""); return m ? `${m[3]}-${m[2]}-${m[1]}` : ymd; };
function fmtTime(iso: string) { try { return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }); } catch { return ""; } }
function fmtSync(s: string | null | undefined) { if (!s) return "—"; try { return new Date(s).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }); } catch { return String(s).slice(0, 16); } }

type ExportKind = "scrap" | "excess";

export default function StockReconciliationPage() {
  const [date, setDate] = useState(todayIST());
  const [orders, setOrders] = useState<Order[]>([]);
  const [snapAt, setSnapAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [status, setStatus] = useState("done");

  // export dialog
  const [dlg, setDlg] = useState<ExportKind | null>(null);
  const [docDate, setDocDate] = useState("");
  const [prefix, setPrefix] = useState("");
  const [startNo, setStartNo] = useState("");
  const [perProduct, setPerProduct] = useState(true);

  async function load(d: string) {
    setLoading(true); setErr("");
    try {
      const r = await fetch(`/api/stock-reconciliation?date=${d}&status=all`, { cache: "no-store" });
      const j: Resp = await r.json();
      if (!j.ok) throw new Error(j.error || "Failed to load");
      setOrders(j.orders || []); setSnapAt(j.snapshotAt || null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setOrders([]); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(date); }, [date]);

  const statuses = useMemo(() => {
    const s = new Set<string>(); orders.forEach((o) => o.status && s.add(o.status));
    return ["all", ...Array.from(s).sort()];
  }, [orders]);

  const visible = useMemo(() => orders.filter((o) => status === "all" || o.status === status), [orders, status]);

  const stats = useMemo(() => {
    let items = 0, scrapN = 0, excessN = 0, matchN = 0, scrapQ = 0, excessQ = 0;
    visible.forEach((o) => o.items.forEach((it) => {
      items++;
      if (it.klass === "Scrap") { scrapN++; scrapQ += it.qty; }
      else if (it.klass === "Excess") { excessN++; excessQ += it.qty; }
      else matchN++;
    }));
    return { vouchers: visible.length, items, scrapN, excessN, matchN, scrapQ, excessQ };
  }, [visible]);

  const flagged = useMemo(() => {
    const out: { order: string; item: string; flags: string[] }[] = [];
    visible.forEach((o) => o.items.forEach((it) => { if (it.flags.length) out.push({ order: o.orderNo, item: `${it.code} ${it.name}`, flags: it.flags }); }));
    return out;
  }, [visible]);

  // ---- flatten batch rows for exports (across all visible vouchers) ----
  type Line = { code: string; name: string; warehouse: string; batch: string; mfg: string; qty: number; order: string };
  const scrapLines = useMemo<Line[]>(() => {
    const out: Line[] = [];
    visible.forEach((o) => o.items.forEach((it) => { if (it.klass === "Scrap") it.scrapRows.forEach((r) => out.push({ code: it.code, name: it.name, warehouse: r.warehouse, batch: r.batch, mfg: r.mfg, qty: r.qty, order: o.orderNo })); }));
    return out;
  }, [visible]);
  const excessLines = useMemo<Line[]>(() => {
    const out: Line[] = [];
    visible.forEach((o) => o.items.forEach((it) => { if (it.klass === "Excess") it.excessRows.forEach((r) => out.push({ code: it.code, name: it.name, warehouse: r.warehouse, batch: r.batch, mfg: r.mfg, qty: r.qty, order: o.orderNo })); }));
    return out;
  }, [visible]);

  // Doc no per line: one number for the whole file, or a new number per product (grouped by code, in order of appearance).
  function docNos(lines: Line[], start: number, byProduct: boolean): number[] {
    if (!byProduct) return lines.map(() => start);
    const seen = new Map<string, number>(); let n = start;
    return lines.map((l) => { if (!seen.has(l.code)) seen.set(l.code, n++); return seen.get(l.code) as number; });
  }

  function openDialog(kind: ExportKind) {
    setDlg(kind);
    setDocDate(toDMY(date));
    setPrefix(kind === "scrap" ? SCRAP_DEFAULTS.prefix : EXCESS_DEFAULTS.prefix);
    setStartNo("");
    setPerProduct(true);
  }

  async function runExport() {
    if (!dlg) return;
    const kind = dlg;
    const start = parseInt(startNo, 10);
    if (!isFinite(start)) { alert("Enter a starting voucher number."); return; }
    const lines = kind === "scrap" ? scrapLines : excessLines;
    if (!lines.length) { alert(`No ${kind} lines to export for this day.`); return; }
    const nos = docNos(lines, start, perProduct);
    const XLSX = await import("xlsx");

    let aoa: (string | number)[][];
    if (kind === "scrap") {
      aoa = [["Doc date", "Doc prefix", "Doc no", "Location", "Warehouse", "Product name", "Unit", "Scrap qty", "Unit price", "Value", "Batch No", "Mfg date"]];
      lines.forEach((l, i) => aoa.push([docDate, prefix, nos[i], SCRAP_DEFAULTS.location, l.warehouse, l.name, SCRAP_DEFAULTS.unit, l.qty, 0, 0, l.batch, l.mfg]));
    } else {
      aoa = [["Doc date", "Doc prefix", "Doc no", "Credit", "Location", "Warehouse", "Product name", "Unit", "Qty", "Unit price", "Value", "Batch No"]];
      lines.forEach((l, i) => aoa.push([docDate, prefix, nos[i], EXCESS_DEFAULTS.credit, EXCESS_DEFAULTS.location, l.warehouse, l.name, EXCESS_DEFAULTS.unit, l.qty, 0, 0, l.batch]));
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, kind === "scrap" ? "SCARP" : "Excess Stock");
    XLSX.writeFile(wb, `${kind}-import-${date}.xlsx`);
    setDlg(null);
  }

  async function exportMaster() {
    const XLSX = await import("xlsx");
    const summary: (string | number)[][] = [["Date", "Voucher (order)", "Status", "Code", "Product", "Sales unit", "System (gms)", "Actual (gms)", "Variance (gms)", "Result", "Warehouse"]];
    visible.forEach((o) => o.items.forEach((it) => summary.push([date, o.orderNo, o.status, it.code, it.name, it.salesUnit, it.system, it.actual, it.variance, it.klass, it.warehouse])));
    const scrapD: (string | number)[][] = [["Code", "Product", "Warehouse", "Batch No", "Mfg date", "Scrap qty (Gms)", "From voucher"]];
    scrapLines.forEach((l) => scrapD.push([l.code, l.name, l.warehouse, l.batch, l.mfg, l.qty, l.order]));
    const excessD: (string | number)[][] = [["Code", "Product", "Warehouse", "Batch No", "Mfg date", "Qty (Gms)", "From voucher"]];
    excessLines.forEach((l) => excessD.push([l.code, l.name, l.warehouse, l.batch, l.mfg, l.qty, l.order]));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), "Summary");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(scrapD), "Scrap detail");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(excessD), "Excess detail");
    XLSX.writeFile(wb, `stock-recon-master-${date}.xlsx`);
  }

  const ctrl: React.CSSProperties = { font: "inherit", padding: "7px 10px", border: "1px solid #cbd5e1", borderRadius: 8, background: "#fff" };
  const btn: React.CSSProperties = { ...ctrl, cursor: "pointer", fontWeight: 600 };
  const cell: React.CSSProperties = { borderBottom: `1px solid ${C.line}`, padding: "6px 10px", fontSize: 13, textAlign: "left", whiteSpace: "nowrap" };
  const th: React.CSSProperties = { ...cell, background: C.head, fontWeight: 600, borderBottom: `1px solid ${C.line}` };
  const numCell: React.CSSProperties = { ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" };

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", color: C.ink, maxWidth: 1200, margin: "0 auto" }}>
      <a href="/dispatch-report" style={{ color: C.sub, fontSize: 13, textDecoration: "none" }}>&larr; Back to dispatch report</a>

      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 10, margin: "10px 0 4px" }}>
        <h1 style={{ fontSize: 24, margin: 0 }}>Stock Reconciliation</h1>
        <div style={{ color: C.sub, fontSize: 12.5 }}>Batch warehouses from PACT stock as of {fmtSync(snapAt)}</div>
      </div>
      <p style={{ color: C.sub, margin: "0 0 16px", fontSize: 14 }}>
        Pick a day to compare the physical count against system stock. Shortages become a <b style={{ color: klassColor.Scrap }}>Scrap</b> import; surpluses become an <b style={{ color: klassColor.Excess }}>Excess&nbsp;Stock</b> import.
      </p>

      {/* controls */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: 14 }}>
        <label style={{ fontSize: 13, color: C.sub, display: "flex", alignItems: "center", gap: 6 }}>
          Date <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={ctrl} />
        </label>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={ctrl}>
          {statuses.map((s) => <option key={s} value={s}>{s === "all" ? "All statuses" : s[0].toUpperCase() + s.slice(1)}</option>)}
        </select>
        <div style={{ flex: 1 }} />
        <button onClick={exportMaster} style={btn} disabled={!visible.length}>Master Excel</button>
        <button onClick={() => openDialog("scrap")} style={{ ...btn, background: klassColor.Scrap, color: "#fff", borderColor: klassColor.Scrap, opacity: scrapLines.length ? 1 : 0.5 }} disabled={!scrapLines.length}>Scrap import</button>
        <button onClick={() => openDialog("excess")} style={{ ...btn, background: klassColor.Excess, color: "#fff", borderColor: klassColor.Excess, opacity: excessLines.length ? 1 : 0.5 }} disabled={!excessLines.length}>Excess import</button>
      </div>

      {/* summary chips */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
        {[
          ["Vouchers", nf(stats.vouchers), C.ink],
          ["Items", nf(stats.items), C.sub],
          ["Scrap items", `${nf(stats.scrapN)}  ·  ${nf(stats.scrapQ)} g`, klassColor.Scrap],
          ["Excess items", `${nf(stats.excessN)}  ·  ${nf(stats.excessQ)} g`, klassColor.Excess],
          ["Matched", nf(stats.matchN), klassColor.Match],
        ].map(([label, val, color]) => (
          <div key={label as string} style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: "8px 14px", minWidth: 110, background: "#fff" }}>
            <div style={{ fontSize: 11, color: C.sub, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: color as string }}>{val}</div>
          </div>
        ))}
      </div>

      {flagged.length > 0 && (
        <div style={{ background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 10, padding: "10px 14px", marginBottom: 14, fontSize: 13, color: "#92400e" }}>
          <b>{flagged.length} item(s) need a warehouse check</b> — not found in the latest PACT batch snapshot; their warehouse/batch may be blank in the import. {flagged.slice(0, 6).map((f) => f.item).join("; ")}{flagged.length > 6 ? "…" : ""}
        </div>
      )}

      {loading ? <p>Loading…</p>
        : err ? <p style={{ color: "#b91c1c" }}>Couldn&rsquo;t load: {err}</p>
        : !visible.length ? <p style={{ color: C.sub }}>No {status === "all" ? "" : status + " "}vouchers on {toDMY(date)}.</p>
        : (
          <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 900 }}>
                <thead>
                  <tr>
                    <th style={th}>Code</th>
                    <th style={th}>Product</th>
                    <th style={{ ...th, textAlign: "right" }}>System</th>
                    <th style={{ ...th, textAlign: "right" }}>Actual</th>
                    <th style={{ ...th, textAlign: "right" }}>Variance</th>
                    <th style={th}>Result</th>
                    <th style={th}>Warehouse</th>
                    <th style={th}>Batches</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((o) => (
                    <FragmentOrder key={o.id} o={o} cell={cell} numCell={numCell} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

      {/* export dialog */}
      {dlg && (
        <div onClick={() => setDlg(null)} style={{ position: "fixed", inset: 0, background: "rgba(15,34,51,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 14, padding: 22, width: 420, maxWidth: "92vw", boxShadow: "0 20px 60px rgba(0,0,0,.25)" }}>
            <h3 style={{ margin: "0 0 4px", fontSize: 18, color: dlg === "scrap" ? klassColor.Scrap : klassColor.Excess }}>{dlg === "scrap" ? "Scrap import" : "Excess Stock import"}</h3>
            <p style={{ margin: "0 0 16px", color: C.sub, fontSize: 13 }}>{(dlg === "scrap" ? scrapLines : excessLines).length} line(s) · {new Set((dlg === "scrap" ? scrapLines : excessLines).map((l) => l.code)).size} product(s)</p>
            <label style={{ display: "block", fontSize: 12, color: C.sub, marginBottom: 10 }}>Voucher no (Doc no)
              <input autoFocus value={startNo} onChange={(e) => setStartNo(e.target.value.replace(/[^0-9]/g, ""))} placeholder="e.g. 42" style={{ ...ctrl, width: "100%", marginTop: 4 }} />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 14, cursor: "pointer" }}>
              <input type="checkbox" checked={perProduct} onChange={(e) => setPerProduct(e.target.checked)} />
              New voucher no for each product (increment)
            </label>
            <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
              <label style={{ flex: 1, fontSize: 12, color: C.sub }}>Doc date
                <input value={docDate} onChange={(e) => setDocDate(e.target.value)} style={{ ...ctrl, width: "100%", marginTop: 4 }} />
              </label>
              <label style={{ flex: 1, fontSize: 12, color: C.sub }}>Doc prefix
                <input value={prefix} onChange={(e) => setPrefix(e.target.value)} style={{ ...ctrl, width: "100%", marginTop: 4 }} />
              </label>
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

function FragmentOrder({ o, cell, numCell }: { o: Order; cell: React.CSSProperties; numCell: React.CSSProperties }) {
  const head: React.CSSProperties = { ...cell, background: "#f8fafc", fontWeight: 600, fontSize: 12.5, color: "#334155" };
  return (
    <>
      <tr>
        <td colSpan={8} style={head}>{o.orderNo} · <span style={{ color: "#64748b", fontWeight: 500 }}>{o.status} · {fmtTime(o.createdAt)} · {o.items.length} item(s)</span></td>
      </tr>
      {o.items.map((it, i) => {
        const rows = it.klass === "Scrap" ? it.scrapRows : it.klass === "Excess" ? it.excessRows : [];
        const batchTxt = rows.length ? rows.map((r) => `${r.batch || "—"}${r.qty ? ` (${nf(r.qty)}g)` : ""}`).join(", ") : "—";
        return (
          <tr key={i}>
            <td style={{ ...cell, fontVariantNumeric: "tabular-nums" }}>{it.code}</td>
            <td style={{ ...cell, whiteSpace: "normal" }}>{it.name}</td>
            <td style={numCell}>{nf(it.system)}</td>
            <td style={numCell}>{nf(it.actual)}</td>
            <td style={{ ...numCell, color: it.klass === "Scrap" ? klassColor.Scrap : it.klass === "Excess" ? klassColor.Excess : C.sub }}>{it.variance > 0 ? "+" : ""}{nf(it.variance)}</td>
            <td style={cell}><span style={{ display: "inline-block", padding: "1px 8px", borderRadius: 999, fontSize: 11.5, fontWeight: 600, color: "#fff", background: klassColor[it.klass] }}>{it.klass}</span></td>
            <td style={{ ...cell, whiteSpace: "normal" }}>{it.warehouse || <span style={{ color: "#b45309" }}>—</span>}</td>
            <td style={{ ...cell, whiteSpace: "normal", color: C.sub, fontSize: 12 }}>{batchTxt}</td>
          </tr>
        );
      })}
    </>
  );
}
