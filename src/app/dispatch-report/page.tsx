"use client";
import { useEffect, useMemo, useState } from "react";

type Row = { date: string; type: string; doc: string; party: string; items: number; status: string; source: string };
type Resp = { ok: boolean; synced?: { b2b: string | null; nb: string | null }; counts?: Record<string, number>; rows?: Row[]; error?: string };

const PAGE = 100;
const TYPES = ["All", "B2B", "Outlet (NB)", "Scan"];

const C = {
  ink: "#0e2233", sub: "#64748b", line: "#e2e8f0", head: "#f1f5f9", band: "#0e2233",
};
const typeColor: Record<string, string> = { "B2B": "#7c3aed", "Outlet (NB)": "#2563eb", "Scan": "#0d9488" };

function fmtDate(d: string) {
  if (!d) return "—";
  try { return new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }); }
  catch { return d; }
}
function fmtSync(s: string | null | undefined) {
  if (!s) return "—";
  try { return new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }); }
  catch { return String(s).slice(0, 10); }
}

export default function DispatchReportPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [synced, setSynced] = useState<{ b2b: string | null; nb: string | null }>({ b2b: null, nb: null });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  // filters
  const [type, setType] = useState("All");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [status, setStatus] = useState("All");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/dispatch-report", { cache: "no-store" });
        const j: Resp = await r.json();
        if (!j.ok) throw new Error(j.error || "Failed to load");
        setRows(j.rows || []);
        setSynced(j.synced || { b2b: null, nb: null });
      } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
      finally { setLoading(false); }
    })();
  }, []);

  const statuses = useMemo(() => {
    const s = new Set<string>();
    rows.forEach((r) => r.status && s.add(r.status));
    return ["All", ...Array.from(s).sort()];
  }, [rows]);

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (type !== "All" && r.type !== type) return false;
      if (status !== "All" && r.status !== status) return false;
      if (from && r.date && r.date < from) return false;   // undated rows always pass the date filter
      if (to && r.date && r.date > to) return false;
      if (ql && !(`${r.doc} ${r.party}`.toLowerCase().includes(ql))) return false;
      return true;
    });
  }, [rows, type, status, from, to, q]);

  useEffect(() => { setPage(1); }, [type, status, from, to, q]);

  const totalItems = useMemo(() => filtered.reduce((s, r) => s + (r.items || 0), 0), [filtered]);
  const byType = useMemo(() => {
    const m: Record<string, number> = {};
    filtered.forEach((r) => { m[r.type] = (m[r.type] || 0) + 1; });
    return m;
  }, [filtered]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const view = filtered.slice((page - 1) * PAGE, page * PAGE);

  function exportCsv() {
    const head = ["Date", "Type", "Doc / Order No", "Outlet / Customer", "Items", "Status"];
    const esc = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const body = filtered.map((r) => [r.date, r.type, r.doc, r.party, r.items, r.status].map(esc).join(","));
    const csv = [head.join(","), ...body].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `dispatch-report-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
  }
  async function exportXlsx() {
    const XLSX = await import("xlsx");
    const data = filtered.map((r) => ({
      Date: r.date, Type: r.type, "Doc / Order No": r.doc, "Outlet / Customer": r.party, Items: r.items, Status: r.status,
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    ws["!cols"] = [{ wch: 12 }, { wch: 12 }, { wch: 22 }, { wch: 34 }, { wch: 8 }, { wch: 12 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Dispatches");
    XLSX.writeFile(wb, `dispatch-report-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }
  function reset() { setType("All"); setFrom(""); setTo(""); setStatus("All"); setQ(""); }

  const cell: React.CSSProperties = { border: `1px solid ${C.line}`, padding: "7px 10px", fontSize: 13, textAlign: "left", whiteSpace: "nowrap" };
  const th: React.CSSProperties = { ...cell, background: C.head, fontWeight: 600, position: "sticky", top: 0 };
  const ctrl: React.CSSProperties = { font: "inherit", padding: "7px 10px", border: "1px solid #cbd5e1", borderRadius: 8, background: "#fff" };
  const btn: React.CSSProperties = { ...ctrl, cursor: "pointer", fontWeight: 600 };

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", color: C.ink, maxWidth: 1200, margin: "0 auto" }}>
      <a href="/" style={{ color: C.sub, fontSize: 13, textDecoration: "none" }}>&larr; Back to dashboard</a>

      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 10, margin: "10px 0 4px" }}>
        <h1 style={{ fontSize: 24, margin: 0 }}>Dispatch Report</h1>
        <div style={{ color: C.sub, fontSize: 12.5 }}>
          B2B &amp; outlet data as of {fmtSync(synced.b2b)} / {fmtSync(synced.nb)} (last PACT sync) · scans are live
        </div>
      </div>
      <p style={{ color: C.sub, margin: "0 0 16px", fontSize: 14 }}>
        Every dispatch in one place — B2B factory sales invoices, outlet stock-outward, and inventory-order scans.
      </p>

      {/* summary chips */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
        {[
          ["Dispatches", filtered.length.toLocaleString("en-IN"), C.ink],
          ["B2B", (byType["B2B"] || 0).toLocaleString("en-IN"), typeColor["B2B"]],
          ["Outlet (NB)", (byType["Outlet (NB)"] || 0).toLocaleString("en-IN"), typeColor["Outlet (NB)"]],
          ["Scans", (byType["Scan"] || 0).toLocaleString("en-IN"), typeColor["Scan"]],
          ["Items", totalItems.toLocaleString("en-IN"), C.sub],
        ].map(([label, val, color]) => (
          <div key={label as string} style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: "8px 14px", minWidth: 96, background: "#fff" }}>
            <div style={{ fontSize: 11, color: C.sub, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: color as string }}>{val}</div>
          </div>
        ))}
      </div>

      {/* filters */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: 12 }}>
        <select value={type} onChange={(e) => setType(e.target.value)} style={ctrl}>
          {TYPES.map((t) => <option key={t} value={t}>{t === "All" ? "All types" : t}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={ctrl}>
          {statuses.map((s) => <option key={s} value={s}>{s === "All" ? "All statuses" : s}</option>)}
        </select>
        <label style={{ fontSize: 13, color: C.sub, display: "flex", alignItems: "center", gap: 6 }}>
          From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={ctrl} />
        </label>
        <label style={{ fontSize: 13, color: C.sub, display: "flex", alignItems: "center", gap: 6 }}>
          To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={ctrl} />
        </label>
        <input placeholder="Search doc or outlet/customer…" value={q} onChange={(e) => setQ(e.target.value)} style={{ ...ctrl, minWidth: 240, flex: 1 }} />
        <button onClick={reset} style={btn}>Reset</button>
        <button onClick={exportCsv} style={{ ...btn, background: "#0e2233", color: "#fff", borderColor: "#0e2233" }}>Export CSV</button>
        <button onClick={exportXlsx} style={{ ...btn, background: "#15803d", color: "#fff", borderColor: "#15803d" }}>Export Excel</button>
      </div>

      {loading ? <p>Loading dispatches…</p>
        : err ? <p style={{ color: "#b91c1c" }}>Couldn&rsquo;t load: {err}</p>
        : filtered.length === 0 ? <p style={{ color: C.sub }}>No dispatches match these filters.</p>
        : (
          <>
            <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10 }}>
              <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 760 }}>
                <thead>
                  <tr>
                    <th style={th}>Date</th>
                    <th style={th}>Type</th>
                    <th style={th}>Doc / Order No</th>
                    <th style={th}>Outlet / Customer</th>
                    <th style={{ ...th, textAlign: "right" }}>Items</th>
                    <th style={th}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {view.map((r, i) => (
                    <tr key={i} style={{ background: i % 2 ? "#fafbfc" : "#fff" }}>
                      <td style={cell}>{fmtDate(r.date)}</td>
                      <td style={cell}>
                        <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 999, fontSize: 11.5, fontWeight: 600, color: "#fff", background: typeColor[r.type] || C.sub }}>{r.type}</span>
                      </td>
                      <td style={{ ...cell, fontVariantNumeric: "tabular-nums" }}>{r.doc}</td>
                      <td style={{ ...cell, whiteSpace: "normal" }}>{r.party || "—"}</td>
                      <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.items.toLocaleString("en-IN")}</td>
                      <td style={cell}>{r.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* pagination */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginTop: 12, color: C.sub, fontSize: 13 }}>
              <div>Showing {((page - 1) * PAGE + 1).toLocaleString("en-IN")}–{Math.min(page * PAGE, filtered.length).toLocaleString("en-IN")} of {filtered.length.toLocaleString("en-IN")}</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} style={{ ...btn, opacity: page <= 1 ? 0.5 : 1 }}>Prev</button>
                <span>Page {page} / {pages}</span>
                <button onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages} style={{ ...btn, opacity: page >= pages ? 0.5 : 1 }}>Next</button>
              </div>
            </div>
          </>
        )}
    </div>
  );
}
