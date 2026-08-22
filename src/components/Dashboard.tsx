"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Bill, Item } from "@/lib/types";
import { validate, allUploaded, canUpload, BUYER_GST, BUYER_NAME } from "@/lib/validate";
import { resolveLine, productByName, productCode, matchProduct, canonUnit, ALL_UNITS, CATALOG, type PactLine } from "@/lib/pact";
import { inr, inrShort } from "@/lib/format";
import { supabase } from "@/lib/supabaseClient";
import { rowToBill, billToRow } from "@/lib/data";
import { Icon } from "./icons";
import { createPortal } from "react-dom";
import PRICE_CHART from "@/lib/price-chart.json";
import { matchSupplier, ALL_SUPPLIERS } from "@/lib/suppliers";

type SalesOrder = { id: string; name: string; at: number; sheets: { name: string; rows: (string | number | null)[][] }[] };

const MC = ["#0ea5a3", "#6366f1", "#0284c7", "#d97706", "#e11d48", "#7c3aed", "#059669", "#db2777", "#0891b2", "#4f46e5"];
const initials = (n: string) =>
  (n.replace(/\b(pvt|ltd|private|limited|&|\.|-|enterprises|packaging|packagings|india|p)\b/gi, "").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || n.slice(0, 2).toUpperCase());

function billText(b: Bill): string {
  const v = validate(b);
  const L: string[] = [];
  L.push("=".repeat(57), "INVOICE — " + b.vendor, "=".repeat(57));
  L.push("Invoice Number : " + b.invoice);
  L.push("Invoice Date   : " + b.dateFull);
  L.push("Vendor GSTIN   : " + b.vendorGst);
  L.push("Billed To      : " + b.buyer + " · " + b.buyerGst, "");
  L.push("LINE ITEMS", "-".repeat(57));
  b.items.forEach((it, i) => {
    L.push("Item #" + (i + 1));
    L.push("  Item          : " + it.name);
    L.push("  HSN           : " + it.hsn);
    L.push("  Quantity      : " + it.qty + " " + it.uom);
    L.push("  Price         : " + (it.price ?? "—"));
    L.push("  Net Amount    : " + inr(it.net));
    L.push("  Tax Rate      : " + it.taxRate);
    L.push("  GST Amount    : " + inr(it.gst));
    L.push("  Gross Amount  : " + inr(it.gross), "");
  });
  L.push("Taxable Value  : " + inr(b.taxable));
  L.push("GST Amount     : " + inr(b.gstTotal));
  L.push("Round Off      : " + b.roundOff);
  L.push("Grand Total    : " + inr(b.grandTotal), "");
  L.push("VALIDATION (3 checks)", "-".repeat(57));
  v.checks.forEach((c) => L.push(`[${c.status === "pass" ? "OK " : c.status === "fail" ? "ERR" : "N/A"}] ${c.label} — ${c.detail}`));
  L.push("", "STATUS: " + (v.status === "OK" ? "OK" : "ERROR — needs review"));
  return L.join("\n");
}

export default function Dashboard({ initialBills }: { initialBills: Bill[] }) {
  const [bills, setBills] = useState<Bill[]>(initialBills);
  const [filter, setFilter] = useState<"all" | "ok" | "err" | "up">("all");
  const [search, setSearch] = useState("");
  const [modalId, setModalId] = useState<number | null>(null);
  const [pactId, setPactId] = useState<number | null>(null);
  const [pmOpen, setPmOpen] = useState(false);
  const [smOpen, setSmOpen] = useState(false);
  const [billOpen, setBillOpen] = useState(false);
  const [flowOpen, setFlowOpen] = useState(false);
  const [soCreateOpen, setSoCreateOpen] = useState(false);
  const [priceOpen, setPriceOpen] = useState(false);
  const [exportedSO, setExportedSO] = useState<Set<string>>(new Set());
  const [priceVer, setPriceVer] = useState(0);
  const [printedIds, setPrintedIds] = useState<Set<number>>(new Set());
  const [printId, setPrintId] = useState<number | null>(null);
  const [view, setView] = useState<"home" | "stock" | "sales" | "salesorder">("home");
  const [salesOrders, setSalesOrders] = useState<SalesOrder[]>([]);
  const [soActive, setSoActive] = useState<string | null>(null);
  const soInputRef = useRef<HTMLInputElement | null>(null);
  const persistSO = (list: SalesOrder[]) => { try { window.localStorage.setItem("sf_sales_orders", JSON.stringify(list)); } catch { /* ignore */ } };
  useEffect(() => {
    try { const raw = window.localStorage.getItem("sf_so_exported"); if (raw) setExportedSO(new Set(JSON.parse(raw))); } catch { /* ignore */ }
    if (loadStoredPrices()) setPriceVer((v) => v + 1);
    try { const raw = window.localStorage.getItem("sf_sales_orders"); if (raw) { const c = dedupeSO(JSON.parse(raw) as SalesOrder[]); setSalesOrders(c); persistSO(c); setSoActive((a) => a ?? c[0]?.id ?? null); } } catch { /* ignore */ }
    if (!supabase) return;
    (async () => {
      try {
        const { data, error } = await supabase.from("sales_orders").select("id,name,created_at,sheets").order("created_at", { ascending: false });
        if (!error && data) {
          const list: SalesOrder[] = data.map((r: any) => ({ id: String(r.id), name: r.name, at: new Date(r.created_at).getTime(), sheets: (r.sheets as SalesOrder["sheets"]) || [] }));
          const dl = dedupeSO(list); setSalesOrders(dl); persistSO(dl); setSoActive((a) => a ?? dl[0]?.id ?? null);
        }
      } catch { /* table not set up yet */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function markExported(o: SalesOrder) {
    downloadOrderXlsx(o);
    setExportedSO((prev) => { const n = new Set(prev); n.add(o.id); try { window.localStorage.setItem("sf_so_exported", JSON.stringify(Array.from(n))); } catch { /* ignore */ } return n; });
    ping(`"${o.name}" exported — an Excel was downloaded. Upload it to PACT, then run Status check.`);
  }
  async function addSalesOrder(name: string, sheets: SalesOrder["sheets"]) {
    if (salesOrders.some((o) => (o.name || "").trim().toLowerCase() === name.trim().toLowerCase())) {
      ping(`A sales order named "${name}" is already added — duplicates aren't allowed.`);
      return;
    }
    const tmp: SalesOrder = { id: "local-" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36), name, at: Date.now(), sheets };
    setSalesOrders((prev) => { const n = [tmp, ...prev]; persistSO(n); return n; });
    setSoActive(tmp.id);
    if (!supabase) return;
    try {
      const { data, error } = await supabase.from("sales_orders").insert({ name, sheets }).select("id,created_at").single();
      if (!error && data) {
        const rid = String((data as any).id);
        setSalesOrders((prev) => { const n = prev.map((o) => (o.id === tmp.id ? { ...o, id: rid, at: new Date((data as any).created_at).getTime() } : o)); persistSO(n); return n; });
        setSoActive(rid);
      } else {
        ping("Saved on this device. Run the one-time sales_orders table setup to sync to Supabase.");
      }
    } catch { ping("Saved on this device (Supabase sales_orders table not set up yet)."); }
  }
  async function removeSalesOrder(id: string) {
    setSalesOrders((prev) => { const next = prev.filter((x) => x.id !== id); persistSO(next); setSoActive((a) => (a === id ? (next[0]?.id ?? null) : a)); return next; });
    ping("Sales order removed.");
    if (supabase && /^\d+$/.test(id)) { try { await supabase.from("sales_orders").delete().eq("id", Number(id)); } catch { /* ignore */ } }
  }
  const [stampVer, setStampVer] = useState<Record<string, StampCheck & { status: "checking" | "done" }>>({});
  const [modalTab, setModalTab] = useState<"scan" | "data">("scan");
  const [toast, setToast] = useState<{ msg: string; show: boolean }>({ msg: "", show: false });

  // Pull live data from Supabase if configured; otherwise stay on seed data.
  useEffect(() => {
    if (!supabase) return;
    (async () => {
      const { data, error } = await supabase.from("bills").select("*").order("id", { ascending: false });
      if (!error && data && data.length) setBills(data.map(rowToBill));
    })();
  }, []);

  function ping(msg: string) {
    setToast({ msg, show: true });
    window.setTimeout(() => setToast((t) => ({ ...t, show: false })), 2300);
  }

  // Read an uploaded Sales Order spreadsheet (xlsx/xls/csv) fully in the browser
  // and show every column and row exactly as in the file.
  async function onSalesOrderFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const XLSX = await import("xlsx");
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheets = wb.SheetNames.map((sn) => ({
        name: sn,
        rows: XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: "", raw: false, blankrows: false }) as (string | number | null)[][],
      }));
      await addSalesOrder(file.name, sheets);
      setView("sales");
      ping(`Sales order "${file.name}" saved — ${sheets[0]?.rows.length ?? 0} rows.`);
    } catch (err) {
      ping("Couldn't read that file — upload a valid Excel (.xlsx / .xls) or CSV.");
    } finally {
      e.target.value = "";
    }
  }

  // Manually add a bill to the dashboard (same shape as the seed bills), so it
  // lands in the Invoice Inbox and flows through verify -> Upload to PACT -> Print.
  async function addBill(nb: Bill) {
    setBills((prev) => [nb, ...prev]);
    setBillOpen(false);
    ping(`Bill added — ${nb.vendor} · ${nb.invoice}.`);
    if (!supabase) return;
    try {
      const { error } = await supabase.from("bills").upsert(billToRow(nb));
      if (error) ping("Saved on this device only \u2014 database rejected it: " + error.message);
    } catch { ping("Added on this device (couldn't reach Supabase)."); }
  }

  async function persist(b: Bill) {
    if (!supabase) return;
    try {
      await supabase.from("bills").upsert(billToRow(b));
    } catch (e) {
      /* best-effort in the prototype */
    }
  }

  // Save the product/unit fix (chosen in the Upload-to-PACT modal) onto the item
  // so the Print popup and future re-opens reflect it, and it persists to Supabase.
  function patchItem(id: number, idx: number, patch: Partial<Item>) {
    setBills((prev) =>
      prev.map((b) => {
        if (b.id !== id) return b;
        const items = b.items.map((it, i) => (i === idx ? { ...it, ...patch } : it));
        const nb: Bill = { ...b, items };
        persist(nb);
        return nb;
      })
    );
  }

  function uploadItem(id: number, idx: number) {
    setBills((prev) =>
      prev.map((b) => {
        if (b.id !== id) return b;
        if (validate(b).status !== "OK" || b.voided || b.items[idx].uploaded) return b;
        const items = b.items.map((it, i) => (i === idx ? { ...it, uploaded: true } : it));
        const nb: Bill = { ...b, items, voided: items.every((x) => x.uploaded) ? true : b.voided };
        persist(nb);
        ping(nb.voided ? `${b.vendor} — all items uploaded, entry voided` : `${b.vendor} · item ${idx + 1} uploaded to Pact`);
        return nb;
      })
    );
  }

  function uploadAll(id: number) {
    setBills((prev) =>
      prev.map((b) => {
        if (b.id !== id) return b;
        if (validate(b).status !== "OK" || b.voided) return b;
        const nb: Bill = { ...b, items: b.items.map((it) => ({ ...it, uploaded: true })), voided: true };
        persist(nb);
        ping(`${b.vendor} · ${b.invoice} — all items uploaded to Pact, entry voided`);
        return nb;
      })
    );
  }

  function voidBill(id: number) {
    setBills((prev) =>
      prev.map((b) => {
        if (b.id !== id || b.voided) return b;
        const nb: Bill = { ...b, voided: true };
        persist(nb);
        ping(`${b.vendor} · ${b.invoice} voided & frozen`);
        return nb;
      })
    );
  }

  function downloadTxt(id: number) {
    const b = bills.find((x) => x.id === id);
    if (!b) return;
    const blob = new Blob([billText(b)], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = b.invoice.replace(/[^A-Za-z0-9]+/g, "_") + ".txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    ping("Downloaded " + a.download);
  }

  // derived
  const kpis = useMemo(() => {
    let ok = 0, err = 0, total = 0;
    bills.forEach((b) => {
      total += b.grandTotal;
      validate(b).status === "OK" ? ok++ : err++;
    });
    return { total: bills.length, ok, err, value: total, up: bills.filter(allUploaded).length };
  }, [bills]);

  const q = search.toLowerCase();
  const visible = bills.filter((b) => {
    const st = validate(b).status;
    if (filter === "ok" && st !== "OK") return false;
    if (filter === "err" && st !== "ERROR") return false;
    if (filter === "up" && !allUploaded(b)) return false;
    if (q && !(b.vendor.toLowerCase().includes(q) || b.invoice.toLowerCase().includes(q))) return false;
    return true;
  }).sort((a, b) => b.id - a.id);

  // 5-check gate: run the stamp vision check only on bills that already pass the 3 offline checks.
  useEffect(() => {
    visible.forEach((b) => {
      const scan = (b as unknown as { scanUrl?: string }).scanUrl;
      if (!scan || b.voided) return;
      if (validate(b).status !== "OK") return;
      if (stampVer[scan]) return;
      setStampVer((m) => ({ ...m, [scan]: { status: "checking", ok: false, verified: false, gateNo: false, storeChecked: false } }));
      fetchStamp(scan).then((res) => setStampVer((m) => ({ ...m, [scan]: { ...res, status: "done" } })));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Overall status across all 5 checks (3 offline + Gate + Store Checked stamps).
  function fiveStatus(b: Bill): "OK" | "REVIEW" | "CHECKING" | "VOID" {
    if (b.voided) return "VOID";
    if (validate(b).status !== "OK") return "REVIEW";
    const scan = (b as unknown as { scanUrl?: string }).scanUrl;
    if (!scan) return "REVIEW";
    const sv = stampVer[scan];
    if (!sv || sv.status === "checking") return "CHECKING";
    // "Auto-check unavailable" (sv.ok === false — the vision call could not run)
    // is a transient hiccup, NOT a missing stamp: only a definitive "stamp absent"
    // (vision ran and did not find it) is a real review. Otherwise the 3 hard
    // checks already passed, so the bill is clear.
    return sv.ok && !sv.verified ? "REVIEW" : "OK";
  }

  const active = modalId != null ? bills.find((b) => b.id === modalId) || null : null;
  const pactActive = pactId != null ? bills.find((b) => b.id === pactId) || null : null;
  const printActive = printId != null ? bills.find((b) => b.id === printId) || null : null;

  if (view === "home" || view === "salesorder") {
    return (
      <div className="app">
        <HomeScreen onOpen={setView} counts={{ bills: kpis.total, so: salesOrders.length }} />
        {view === "salesorder" && (
          <div className="so-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setView("home"); }}>
            <div className="so-panel">
              <SalesOrderScan onClose={() => setView("home")} />
            </div>
          </div>
        )}
        <div className={"toast" + (toast.show ? " show" : "")}><Icon n="check" size={16} /><span>{toast.msg}</span></div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="main">
        {/* Top bar */}
        <div className="topbar">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="brandlogo" src="/logo.png" alt="Sukhna Foods" />
          <button className="homebtn" onClick={() => setView("home")}><Icon n="home" size={15} />Home</button>
          <span className="brand-div">{view === "sales" ? "Sales Order Creation" : view === "salesorder" ? "Sales Order \u2014 Scan & Inventory" : "Stock Inward & Bill Uploader"}</span>
          {view === "stock" && (
            <div className="search">
              <Icon n="search" />
              <input placeholder="Search vendor or invoice number…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          )}
          <div className="spacer" />
          {view === "stock" && <>
            <button className="pmbtn guide" onClick={() => setFlowOpen(true)} title="Step-by-step: how the dashboard maps to PACT"><Icon n="file" size={14} />PACT flow guide</button>
            <button className="pmbtn" onClick={() => setPmOpen(true)}><Icon n="file" size={14} />View product master</button>
            <button className="pmbtn" onClick={() => setSmOpen(true)}><Icon n="mail" size={14} />View supplier master</button>
            <button className="pmbtn ghost" onClick={() => ping("Product master re-upload — connect the source/server to enable live sync.")}><Icon n="refresh" size={14} />Reupload product master</button>
            <button className="pmbtn add" onClick={() => setBillOpen(true)}><Icon n="plus" size={14} />Bill Upload</button>
          </>}
          {view === "sales" && <>
            <button className="pmbtn so" onClick={() => soInputRef.current?.click()}><Icon n="upload" size={14} />Upload Sales Order</button>
            <button className="pmbtn add" onClick={() => setSoCreateOpen(true)}><Icon n="plus" size={14} />Create Sales Order</button>
            <button className="pmbtn" onClick={() => setPriceOpen(true)}><Icon n="rupee" size={14} />Price Chart</button>
          </>}
          <input ref={soInputRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }} onChange={onSalesOrderFile} />
          <div className="spacer" />
          <div className="mailpill"><Icon n="mail" size={15} /> mis@nutriobox.com</div>
          <div className="sync"><span className="pulse" /> Synced just now</div>
          <button className="iconbtn"><span className="badge">{kpis.err}</span><Icon n="bell" size={17} /></button>
          <div className="tb-av" title={`${BUYER_NAME}`}>S</div>
        </div>

        {view === "sales"
          ? <SalesPage key={"so" + priceVer} orders={salesOrders} onUpload={() => soInputRef.current?.click()} supaOk={!!supabase} exportedIds={exportedSO} onExport={markExported} />
          : (
        <div className="content">
          {/* KPIs */}
          <div className="kpis">
            <div className="kpi">
              <div className="top"><span className="lbl">Bills received</span><span className="ic ic-sky"><Icon n="inbox" size={17} /></span></div>
              <div className="val">{kpis.total}</div><div className="sub">this period</div>
            </div>
            <div className="kpi ok">
              <div className="top"><span className="lbl">Verified · OK</span><span className="ic ic-ok"><Icon n="checkCircle" size={17} /></span></div>
              <div className="val">{kpis.ok}</div><div className="sub">passed all 3 checks</div>
            </div>
            <div className="kpi err">
              <div className="top"><span className="lbl">Needs review</span><span className="ic ic-err"><Icon n="alert" size={17} /></span></div>
              <div className="val">{kpis.err}</div><div className="sub">a check failed</div>
            </div>
            <div className="kpi">
              <div className="top"><span className="lbl">Total Uploaded</span><span className="ic ic-brand"><Icon n="upload" size={17} /></span></div>
              <div className="val">{kpis.up}</div><div className="sub">of {kpis.total} bills to Pact</div>
            </div>
          </div>

          {/* Inbox */}
          <div className="panel">
            <div className="panelbar">
              <h2>Invoice Inbox</h2>
              <div className="tabs">
                {([["all", "All", kpis.total], ["ok", "Verified", kpis.ok], ["err", "Needs review", kpis.err], ["up", "Uploaded", kpis.up]] as const).map(([f, label, c]) => (
                  <button key={f} className={"tab" + (filter === f ? " active" : "")} onClick={() => setFilter(f as any)}>
                    {label} <span className="b">{c}</span>
                  </button>
                ))}
              </div>
              <div className="ghost" onClick={() => ping("Mailbox synced — no new bills")}><Icon n="refresh" size={15} /> Refresh</div>
            </div>
            <div className="thead">
              <span className="c-date">Date</span>
              <span className="c-v">Vendor</span>
              <span className="c-inv">Invoice</span>
              <span className="c-items">Number of items</span>
              <span className="c-verify">Bill uploaded verification</span>
              <span className="c-amt">Amount</span>
              <span className="c-act">Actions</span>
            </div>
            <div id="list">
              {visible.length === 0 && <div className="empty">No bills in this view.</div>}
              {visible.map((b) => {
                const v = validate(b);
                const up = allUploaded(b);
                const upCount = b.items.filter((i) => i.uploaded).length;
                return (
                  <div key={b.id} className={"row" + (up ? " up" : b.voided ? " voided" : "")} onClick={(e) => { if (!(e.target as HTMLElement).closest("button")) openModal(b.id); }}>
                    <span className="c-date">{b.date}</span>
                    <span className="c-v">
                      <span className="mono" style={{ background: MC[(b.id - 1) % MC.length] }}>{initials(b.vendor)}</span>
                      <span className="vmeta">
                        <span className="vname">{b.vendor}</span>
                        <span className="vsub">{b.items[0]?.name ?? "No line items"}{b.items.length > 1 ? ` · +${b.items.length - 1} more` : ""}</span>
                      </span>
                    </span>
                    <span className="c-inv">{b.invoice}</span>
                    <span className="c-items"><span className="itcount">{b.items.length}</span></span>
                    <span className="c-verify">
                      {(() => {
                        const st = fiveStatus(b);
                        if (st === "VOID") return <span className="pill void"><Icon n="lock" size={12} />{up ? "Uploaded" : "Voided"}</span>;
                        if (st === "OK") return <span className="pill ok"><Icon n="check" size={12} />OK</span>;
                        if (st === "CHECKING") return <span className="pill chk"><Icon n="refresh" size={12} />Checking…</span>;
                        return <span className="pill err"><Icon n="alert" size={12} />Review</span>;
                      })()}
                    </span>
                    <span className="c-amt tnum">₹{inr(b.grandTotal)}</span>
                    <span className="c-act">
                      {up
                        ? <span className="upcol">
                            <button className="btn btn-done" onClick={(e) => { e.stopPropagation(); setPactId(b.id); }} title="View what was uploaded to PACT (read-only)"><Icon n="eye" size={14} />Uploaded to Pact · View</button>
                            <span className="upfrac">{upCount}/{b.items.length} items to Pact</span>
                          </span>
                        : b.voided
                          ? <button className="btn btn-done"><Icon n="ban" size={14} />Voided</button>
                          : <span className="upcol">
                              {(() => {
                                const st = fiveStatus(b);
                                if (st === "OK") return <button className="btn btn-primary" onClick={(e) => { e.stopPropagation(); setPactId(b.id); }}><Icon n="upload" size={14} />Upload to Pact</button>;
                                return <button className="btn btn-primary" disabled title={st === "CHECKING" ? "Verifying bill stamps…" : "All 5 checks must pass before upload"}><Icon n="upload" size={14} />Upload to Pact</button>;
                              })()}
                              <span className="upfrac">{upCount}/{b.items.length} items to Pact</span>
                            </span>}
                      {(up || !b.voided) && (printedIds.has(b.id)
                        ? <button className="btn btn-printed" onClick={(e) => { e.stopPropagation(); setPrintId(b.id); }} title="View the labels printed for this bill"><Icon n="check" size={14} />Printed</button>
                        : <button className="btn btn-print" onClick={(e) => { e.stopPropagation(); setPrintId(b.id); }} title="Print PACT stickers"><Icon n="printer" size={14} />Print</button>)}
                      <button className="btn btn-ghost" onClick={(e) => { e.stopPropagation(); openModal(b.id); }}><Icon n="eye" size={14} />View</button>
                      <button className="btn btn-void" disabled={b.voided} onClick={(e) => { e.stopPropagation(); voidBill(b.id); }}><Icon n="ban" size={14} />Void</button>
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="foot-note">
              <Icon n="alert" size={14} />
              Live console · validation runs offline (no AI, no internet) · {supabase ? "connected to Supabase" : "running on seed data — add Supabase keys to go live"}.
            </div>
          </div>
        </div>
        )}
      </div>

      {/* Modal */}
      {active && <BillDetail b={active} tab={modalTab} setTab={setModalTab} onClose={() => setModalId(null)} uploadItem={uploadItem} openPact={(id) => { setModalId(null); setPactId(id); }} voidBill={voidBill} downloadTxt={downloadTxt} />}

      {/* PACT upload form */}
      {pactActive && <PactUpload b={pactActive} onClose={() => setPactId(null)} uploadItem={uploadItem} patchItem={patchItem} onConfirm={() => { uploadAll(pactActive.id); setPactId(null); }} />}

      {/* Product master list */}
      {/* Print labels popup */}
      {printActive && <PrintLabel b={printActive} printed={printedIds.has(printActive.id)} onClose={() => setPrintId(null)} onPrinted={(id) => { setPrintedIds((prev) => new Set(prev).add(id)); setPrintId(null); ping("Labels sent to print — the Print button is now locked for this bill."); }} />}

      {pmOpen && <ProductMaster onClose={() => setPmOpen(false)} />}
      {smOpen && <SupplierMaster onClose={() => setSmOpen(false)} />}

      {/* Manual bill entry */}
      {billOpen && <BillEntry nextId={(bills.reduce((m, b) => Math.max(m, b.id), 0) || 0) + 1} onClose={() => setBillOpen(false)} onSave={addBill} />}
      {flowOpen && <PactFlowDoc onClose={() => setFlowOpen(false)} />}

      {/* Manual sales order entry */}
      {soCreateOpen && <SalesOrderCreate nextDocNo={(() => { let mx = 0; salesOrders.forEach((o) => analyzeSO(o).docs.forEach((d) => { const n = parseInt(String(d).replace(/[^0-9]/g, ""), 10); if (isFinite(n) && n > mx) mx = n; })); return mx > 0 ? String(mx + 1) : ""; })()} onClose={() => setSoCreateOpen(false)} onSave={async (name, sheets) => { await addSalesOrder(name, sheets); setSoCreateOpen(false); }} />}

      {/* Sales price chart reference */}
      {priceOpen && <PriceChartModal onClose={() => setPriceOpen(false)} onUpdated={() => setPriceVer((v) => v + 1)} />}

      {/* Toast */}
      <div className={"toast" + (toast.show ? " show" : "")}><Icon n="check" size={16} /><span>{toast.msg}</span></div>
    </div>
  );

  function openModal(id: number) { setModalTab("scan"); setModalId(id); }
}

function BillDetail({ b, tab, setTab, onClose, uploadItem, openPact, voidBill, downloadTxt }: {
  b: Bill; tab: "scan" | "data"; setTab: (t: "scan" | "data") => void; onClose: () => void;
  uploadItem: (id: number, i: number) => void; openPact: (id: number) => void; voidBill: (id: number) => void; downloadTxt: (id: number) => void;
}) {
  const v = validate(b);
  const up = allUploaded(b);
  const upDone = b.items.filter((i) => i.uploaded).length;
  const scanUrl = (b as unknown as { scanUrl?: string }).scanUrl;
  const isPdf = /\.pdf(\?|$)/i.test(scanUrl || "");
  const [scanBroken, setScanBroken] = useState(false);
  const [dstamp, setDstamp] = useState<(StampCheck & { status: "checking" | "done" }) | null>(null);
  useEffect(() => {
    if (!scanUrl || b.voided) return; // run stamp detection regardless of the 3-check result
    setDstamp({ status: "checking", ok: false, verified: false, gateNo: false, storeChecked: false });
    fetchStamp(scanUrl).then((res) => setDstamp({ ...res, status: "done" }));
  }, [scanUrl, b]);
  const stampDone = !!dstamp && dstamp.status === "done";
  const stampAbsent = stampDone && dstamp!.ok && !dstamp!.verified;   // vision ran, a stamp is missing
  const stampUnavailable = stampDone && !dstamp!.ok;                  // vision could not run (transient)
  // Cleared to push once the 3 hard checks pass and stamps are done AND not
  // definitively absent — a transient auto-check failure never blocks (the
  // operator verifies the scan manually in that case).
  const fiveOkLocal = v.status === "OK" && stampDone && !stampAbsent;

  const itemUpBtn = (i: number) => {
    const it = b.items[i];
    if (it.uploaded) return <span className="up-done"><Icon n="check" size={12} />Uploaded</span>;
    if (b.voided) return <span className="up-dash">—</span>;
    if (!fiveOkLocal) return <button className="mini" disabled title="All 5 checks must pass (open Upload to PACT to verify or override the stamp)"><Icon n="upload" size={11} />Upload</button>;
    return <button className="mini" onClick={() => uploadItem(b.id, i)}><Icon n="upload" size={11} />Upload</button>;
  };

  return (
    <div className="overlay show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="mhead">
          <span className="mono" style={{ background: MC[(b.id - 1) % MC.length] }}>{initials(b.vendor)}</span>
          <div><h2>{b.vendor}</h2><div className="sub">Invoice {b.invoice} · {b.dateFull} · GSTIN {b.vendorGst}</div></div>
          {b.voided
            ? <span className="pill void" style={{ marginLeft: "auto", fontSize: 11.5, padding: "5px 11px" }}><Icon n="lock" size={12} />{up ? "Uploaded" : "Voided"}</span>
            : <span className={"pill " + (v.status === "OK" ? "ok" : "err")} style={{ marginLeft: "auto", fontSize: 11.5, padding: "5px 11px" }}>{v.status === "OK" ? <><Icon n="check" size={12} />Verified</> : <><Icon n="alert" size={12} />Needs review</>}</span>}
          <button className="mclose" onClick={onClose}><Icon n="x" size={16} /></button>
        </div>

        <div className="mtabs">
          <button className={"mtab" + (tab === "scan" ? " active" : "")} onClick={() => setTab("scan")}><Icon n="image" size={15} />Scanned Bill</button>
          <button className={"mtab" + (tab === "data" ? " active" : "")} onClick={() => setTab("data")}><Icon n="file" size={15} />Extracted Data</button>
        </div>

        <div className="mbody">
          {tab === "scan" ? (
            <>
              <div className="scanwrap">
                {scanUrl && !scanBroken ? (
                  isPdf ? (
                    <iframe className="scanpdf" src={scanUrl} title={`Scanned bill — ${b.vendor}`} />
                  ) : (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img className="scanimg" src={scanUrl} alt={`Scanned bill — ${b.vendor}`} onError={() => setScanBroken(true)} />
                  )
                ) : (
                  <div className="scannone"><Icon n="image" size={30} /><span>No scanned bill on file for this invoice</span><small>The bill was added without an image. Everything else (line items, totals, checks) is still available on the Extracted Data tab.</small></div>
                )}
              </div>
              {scanUrl && !scanBroken && <div className="scancap"><Icon n="image" size={15} /><span>Original scanned bill · {b.vendor} · {b.invoice}</span></div>}
            </>
          ) : (
            <>
              <div className="facts">
                <div className="fact"><div className="k">Invoice Number</div><div className="v">{b.invoice}</div></div>
                <div className="fact"><div className="k">Invoice Date</div><div className="v">{b.dateFull}</div></div>
                <div className="fact"><div className="k">Vendor GSTIN</div><div className="v tnum">{b.vendorGst}</div></div>
                <div className="fact"><div className="k">Billed To</div><div className="v">{b.buyer} · {b.buyerGst}</div></div>
              </div>
              {b.note && <div className="noteban"><Icon n="alert" size={16} /><div>{b.note}</div></div>}
              <div className="tblhead"><span>Line items · upload to Pact item-by-item</span><span className="prog">{upDone}/{b.items.length} uploaded</span></div>
              <table className="items">
                <thead><tr><th>#</th><th>Item</th><th>HSN</th><th>Qty</th><th>UoM</th><th>Price</th><th>Net</th><th>Tax</th><th>GST</th><th>Gross</th><th>To Pact</th></tr></thead>
                <tbody>
                  {b.items.map((it, i) => (
                    <tr key={i}>
                      <td className="n">{i + 1}</td><td className="name">{it.name}</td><td>{it.hsn}</td>
                      <td className="n">{it.qty}</td><td>{it.uom}</td><td className="n">{it.price ?? "—"}</td>
                      <td className="n">{inr(it.net)}</td><td>{it.taxRate}</td><td className="n">{inr(it.gst)}</td><td className="n">{inr(it.gross)}</td>
                      <td className="up">{itemUpBtn(i)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="totgrid">
                <div className="tr"><span className="l">Taxable Value</span><span className="a tnum">₹{inr(b.taxable)}</span></div>
                <div className="tr"><span className="l">GST Amount</span><span className="a tnum">₹{inr(b.gstTotal)}</span></div>
                <div className="tr"><span className="l">Round Off</span><span className="a tnum">{b.roundOff}</span></div>
                {b.otherCharges && b.otherCharges.map((c, ci) => (
                  <div key={ci} className="tr"><span className="l">{c.label}</span><span className="a tnum">₹{inr(c.amount)}</span></div>
                ))}
                <div className="tr grand"><span className="l">Grand Total</span><span className="a tnum">₹{inr(b.grandTotal)}</span></div>
              </div>
              <div className="checks">
                <h3>Validation — 5 checks</h3>
                {v.checks.map((c, i) => (
                  <div key={i} className={"chk " + c.status}>
                    <span className="ico"><Icon n={c.status === "pass" ? "check" : c.status === "fail" ? "x" : "dash"} size={13} /></span>
                    <div><div className="t">{c.label}</div><div className="d">{c.detail}</div></div>
                  </div>
                ))}
                {(["gateNo", "storeChecked"] as const).map((keyName) => {
                  const label = keyName === "gateNo" ? "Gate No. stamp" : "Store Checked stamp";
                  let cls = "na", icon = "dash", detail = "Auto-detecting on the scanned bill…";
                  if (!scanUrl) { cls = "na"; icon = "dash"; detail = "No scan on file to verify."; }
                  else if (!stampDone) { cls = "na"; icon = "refresh"; detail = "Auto-detecting the stamp on the scanned bill…"; }
                  else if (!dstamp!.ok) { cls = "na"; icon = "dash"; detail = "Auto-check unavailable — verify manually in Upload to PACT."; }
                  else { const okk = keyName === "gateNo" ? dstamp!.gateNo : dstamp!.storeChecked; cls = okk ? "pass" : "fail"; icon = okk ? "check" : "x"; detail = okk ? "Stamp detected on the scanned bill." : "Stamp not found on the scan — verify manually if it is actually stamped."; }
                  return (
                    <div key={keyName} className={"chk " + cls}>
                      <span className="ico"><Icon n={icon} size={13} /></span>
                      <div><div className="t">{label}</div><div className="d">{detail}</div></div>
                    </div>
                  );
                })}
              </div>
              <button className="btn btn-ghost" style={{ marginTop: 14 }} onClick={() => downloadTxt(b.id)}><Icon n="download" size={14} />Download extracted .txt</button>
            </>
          )}
        </div>

        <div className="mfoot">
          <span className={"status-big " + (b.voided ? "void" : v.status !== "OK" ? "err" : !stampDone ? "warn" : stampAbsent ? "err" : stampUnavailable ? "warn" : "ok")}>
            {b.voided ? <><Icon n="lock" size={17} />{up ? "Uploaded to Pact · frozen" : "Voided · frozen"}</> : v.status !== "OK" ? <><Icon n="alert" size={17} />1 check failed — review needed</> : !stampDone ? <><Icon n="shield" size={17} />Verifying bill stamps…</> : stampAbsent ? <><Icon n="alert" size={17} />Stamp check failed — review needed</> : stampUnavailable ? <><Icon n="shield" size={17} />3 checks passed · stamps couldn't be auto-checked — verify the scan, then upload</> : <><Icon n="shield" size={17} />All 5 checks passed</>}
          </span>
          <button className="btn btn-void" style={{ padding: "10px 15px" }} disabled={b.voided} onClick={() => voidBill(b.id)}><Icon n="ban" size={14} />Void</button>
          {b.voided
            ? <button className="btn btn-done" style={{ padding: "10px 15px" }}><Icon n="check" size={14} />{up ? "Uploaded" : "Voided"}</button>
            : !fiveOkLocal
              ? <button className="btn btn-primary" disabled style={{ padding: "10px 15px" }} title="All 5 checks must pass"><Icon n="upload" size={14} />Upload all to Pact</button>
              : <button className="btn btn-primary" style={{ padding: "10px 15px" }} onClick={() => openPact(b.id)}><Icon n="upload" size={14} />Upload all to Pact</button>}
          <button className="btn btn-ghost" style={{ padding: "10px 15px" }} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

type Batch = { id: number; mfg: string; qty: number | "" };

// Exact unit conversion (not ML) within a single measurement family.
const WEIGHT_G: Record<string, number> = { mg: 0.001, g: 1, gm: 1, gms: 1, gram: 1, grams: 1, kg: 1000, kgs: 1000, kilogram: 1000, kilograms: 1000, qtl: 100000, qntl: 100000, quintal: 100000, quintals: 100000, ton: 1000000, tonne: 1000000, tonnes: 1000000, mt: 1000000 };
const VOLUME_ML: Record<string, number> = { ml: 1, l: 1000, ltr: 1000, ltrs: 1000, litre: 1000, liter: 1000, litres: 1000, liters: 1000, kl: 1000000 };
function normU(u: string): string {
  return (u || "").toLowerCase().trim().replace(/\.$/, "");
}
function stdGrams(u: string): { g: number; fam: string } | null {
  const n = normU(u);
  if (WEIGHT_G[n] != null) return { g: WEIGHT_G[n], fam: "w" };
  if (VOLUME_ML[n] != null) return { g: VOLUME_ML[n], fam: "v" };
  return null;
}
type LevelMap = Record<string, { u: string; s: number | null }>;
// Size of one `unit` in the product's base measure (grams/ml). Standard units resolve
// directly; product-specific packaging units (e.g. "Bags") resolve via the master's
// packaging level size — e.g. L3 Bags = 30000 base units.
function unitGrams(prod: { levels: LevelMap }, u: string): { g: number; fam: string } | null {
  const std = stdGrams(u);
  if (std) return std;
  const l1 = prod.levels?.L1;
  const baseStd = l1 ? stdGrams(l1.u) : null;
  if (!baseStd) return null;
  const n = normU(u);
  for (const k of ["L1", "L2", "L3"]) {
    const lv = prod.levels?.[k];
    if (lv && normU(lv.u) === n && lv.s != null) return { g: lv.s * baseStd.g, fam: baseStd.fam };
  }
  return null;
}
// Generic count-unit synonyms (a single countable item). Used to bridge a bill's
// count UOM (e.g. "Pcs.", "Nos") to a count-based product's base packaging level.
// Multipack names (Carton/Box/Bag/Roll) are deliberately excluded — those must come
// from a named packaging level so their pack size is respected.
const COUNT_UNITS = new Set(["pc", "pcs", "piece", "pieces", "no", "nos", "number", "numbers", "unit", "units", "ea", "each", "pkt", "pkts", "packet", "packets", "qty", "quantity"]);
// Size of `u` in the product's L1 base units, via the master's packaging levels
// (L1/L2/L3). Works for count-based products (no weight/volume). A generic count unit
// maps to the L1 base only when the product itself is count-based (its L1 is not a
// weight/volume unit), so pieces never get misread on a Kg/Gms product.
function levelInBase(prod: { levels: LevelMap }, u: string): number | null {
  const n = normU(u);
  const lv = prod.levels || {};
  for (const k of ["L1", "L2", "L3"]) {
    const L = lv[k];
    if (L && normU(L.u) === n) return L.s != null ? L.s : 1;
  }
  const L1 = lv.L1;
  if (L1 && COUNT_UNITS.has(n) && COUNT_UNITS.has(normU(L1.u)) && !stdGrams(L1.u)) return L1.s != null ? L1.s : 1;
  return null;
}
// Multiply an invoice quantity in `from` units by this to get `to` units (rate divides).
function convFactor(prod: { levels: LevelMap }, from: string, to: string): number | null {
  const nf = normU(from);
  const nt = normU(to);
  if (!nf || !nt) return null;
  if (nf === nt) return 1;
  // Weight / volume conversion (standard units) — unchanged.
  const a = unitGrams(prod, from);
  const b = unitGrams(prod, to);
  if (a && b && a.fam === b.fam && b.g) return a.g / b.g;
  // Count / packaging-level conversion via the product's own pack sizes
  // (e.g. Pcs. -> Carton where 1 Carton = 1000 Pkt).
  const la = levelInBase(prod, from);
  const lb = levelInBase(prod, to);
  if (la != null && lb != null && lb) return la / lb;
  return null;
}
const fmtQty = (n: number) => Number(n.toFixed(3)).toLocaleString("en-IN");

// Session cache so re-opening the same bill does not re-run the (paid) vision call.
type StampResult = { gateNo: boolean; storeChecked: boolean; verified: boolean };
const STAMP_CACHE: Record<string, StampResult> = {};
type StampCheck = { ok: boolean; verified: boolean; gateNo: boolean; storeChecked: boolean; reason?: string };
const STAMP_INFLIGHT: Record<string, Promise<StampCheck>> = {};
// Shared stamp verifier — dedups in-flight calls and caches successful results
// so the inbox, the detail modal and the PACT modal never re-charge for the same scan.
async function fetchStamp(scan: string): Promise<StampCheck> {
  const c = STAMP_CACHE[scan];
  if (c) return { ok: true, verified: c.verified, gateNo: c.gateNo, storeChecked: c.storeChecked };
  if (STAMP_INFLIGHT[scan]) return STAMP_INFLIGHT[scan];
  const pr = (async (): Promise<StampCheck> => {
    try {
      const r = await fetch("/api/verify-stamp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ imageUrl: scan }) });
      const d = await r.json();
      if (d?.ok) {
        STAMP_CACHE[scan] = { gateNo: !!d.gateNo, storeChecked: !!d.storeChecked, verified: !!d.verified };
        return { ok: true, verified: !!d.verified, gateNo: !!d.gateNo, storeChecked: !!d.storeChecked };
      }
      return { ok: false, verified: false, gateNo: false, storeChecked: false, reason: d?.reason };
    } catch {
      return { ok: false, verified: false, gateNo: false, storeChecked: false, reason: "error" };
    } finally {
      delete STAMP_INFLIGHT[scan];
    }
  })();
  STAMP_INFLIGHT[scan] = pr;
  return pr;
}

// Searchable, alphabetically-sorted dropdown that always opens DOWNWARD.
// Rendered into a body portal (position:fixed) so it is never clipped by the
// scrolling modal, unlike a native <select> whose direction the browser picks.
function Combobox({ value, options, onChange, disabled, placeholder, codeFor }: { value: string; options: string[]; onChange: (v: string) => void; disabled?: boolean; placeholder?: string; codeFor?: (o: string) => string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const sorted = useMemo(() => [...options].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })), [options]);
  // Google-style: when typing, show only matches (name OR code), ranked so the
  // closest matches are at the top (starts-with > word-start > contains).
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return sorted;
    const rank = (o: string) => {
      const name = o.toLowerCase();
      const code = (codeFor ? codeFor(o) : "").toLowerCase();
      if (name.startsWith(t) || (code && code.startsWith(t))) return 0;
      if (name.split(/[^a-z0-9]+/).some((w) => w && w.startsWith(t))) return 1; // word-start match (no dynamic RegExp)
      if (name.includes(t) || (code && code.includes(t))) return 2;
      return 99;
    };
    return sorted
      .map((o) => ({ o, r: rank(o) }))
      .filter((x) => x.r < 99)
      .sort((a, b) => a.r - b.r || a.o.localeCompare(b.o, "en", { sensitivity: "base" }))
      .map((x) => x.o);
  }, [sorted, q, codeFor]);
  const place = () => { const r = btnRef.current?.getBoundingClientRect(); if (r) setRect({ left: r.left, top: r.bottom + 4, width: r.width }); };
  const openIt = () => { if (disabled) return; place(); setQ(""); setOpen(true); };
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!popRef.current?.contains(e.target as Node) && !btnRef.current?.contains(e.target as Node)) setOpen(false); };
    const onMove = () => place();
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => { document.removeEventListener("mousedown", onDoc); window.removeEventListener("scroll", onMove, true); window.removeEventListener("resize", onMove); };
  }, [open]);
  return (
    <>
      <button type="button" ref={btnRef} className={"psel cbx-val" + (disabled ? " disabled" : "")} disabled={disabled} onClick={() => (open ? setOpen(false) : openIt())}>
        <span className={value ? "cbx-txt" : "cbx-txt ph"}>{value ? (value + (codeFor && codeFor(value) ? ` (${codeFor(value)})` : "")) : (placeholder || "— select —")}</span>
        <span className="cbx-caret">▾</span>
      </button>
      {open && rect && createPortal(
        <div className="cbx-pop" ref={popRef} style={{ position: "fixed", left: rect.left, top: rect.top, width: rect.width }}>
          <div className="cbx-search"><Icon n="search" size={14} /><input autoFocus placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <div className="cbx-list">
            {filtered.length === 0 && <div className="cbx-empty">No matches</div>}
            {filtered.slice(0, 400).map((o) => (
              <button type="button" key={o} className={"cbx-opt" + (o === value ? " sel" : "")} onClick={() => { onChange(o); setOpen(false); }}>{o}{codeFor && codeFor(o) ? <span className="cbx-code"> ({codeFor(o)})</span> : null}</button>
            ))}
            {filtered.length > 400 && <div className="cbx-empty">Showing first 400 — keep typing to narrow.</div>}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

function PactUpload({ b, onClose, onConfirm, uploadItem, patchItem }: { b: Bill; onClose: () => void; onConfirm: () => void; uploadItem: (id: number, i: number) => void; patchItem: (id: number, idx: number, patch: Partial<Item>) => void }) {
  const lines: PactLine[] = useMemo(() => b.items.map((it) => resolveLine(it)), [b]);
  const sup = useMemo(() => matchSupplier(b.vendorGst, b.vendor), [b]);
  const [ackNoSupplier, setAckNoSupplier] = useState(false);
  const [selSupplierName, setSelSupplierName] = useState<string>(sup.supplier ? sup.supplier.name : "");
  const supplierNames = useMemo(() => ALL_SUPPLIERS.map((sp) => sp.name), []);
  const chosenSup = useMemo(() => ALL_SUPPLIERS.find((sp) => sp.name === selSupplierName) || null, [selSupplierName]);
  const allNames = useMemo(() => CATALOG.map((p) => p.name), []);
  const today = new Date().toISOString().slice(0, 10);

  const [batches, setBatches] = useState<Record<number, Batch[]>>(() =>
    Object.fromEntries(b.items.map((_, i) => [i, [{ id: 0, mfg: today, qty: 0 }]]))
  );
  const [editing, setEditing] = useState<Record<number, boolean>>({});
  const [selProduct, setSelProduct] = useState<Record<number, string>>(() =>
    Object.fromEntries(b.items.map((it, i) => [i, it.pactProduct || lines[i].product])));
  const [selUnit, setSelUnit] = useState<Record<number, string>>(() =>
    Object.fromEntries(b.items.map((it, i) => [i, it.pactUnit ?? (lines[i].unit || "")])));
  // Packaging level + manual packing size are per batch row, keyed `${i}:${batchId}`.
  const [selLevel, setSelLevel] = useState<Record<string, string>>({});
  const [packEdit, setPackEdit] = useState<Record<string, string | undefined>>({});
  const [pushing, setPushing] = useState(false);
  const [pushErr, setPushErr] = useState<string>("");

  const setBatch = (i: number, bi: number, patch: Partial<Batch>) =>
    setBatches((m) => ({ ...m, [i]: m[i].map((x, k) => (k === bi ? { ...x, ...patch } : x)) }));
  const split = (i: number) => {
    const cur = batches[i] || [];
    if (!cur.length) return;
    const nid = Math.max(-1, ...cur.map((x) => x.id)) + 1;
    const lastId = cur[cur.length - 1].id;
    // New row inherits the source row's per-row packaging selections.
    setSelLevel((s) => (s[`${i}:${lastId}`] !== undefined ? { ...s, [`${i}:${nid}`]: s[`${i}:${lastId}`] } : s));
    setPackEdit((s) => (s[`${i}:${lastId}`] !== undefined ? { ...s, [`${i}:${nid}`]: s[`${i}:${lastId}`] } : s));
    setBatches((m) => {
      const c = m[i];
      // First split (1 -> 2) zeroes the original row too, so all rows start at 0 for manual entry.
      const base = c.length === 1 ? c.map((x) => ({ ...x, qty: 0 as number | "" })) : c;
      return { ...m, [i]: [...base, { ...c[c.length - 1], id: nid, qty: 0 }] };
    });
  };
  const removeBatch = (i: number, bi: number) =>
    setBatches((m) => ({ ...m, [i]: m[i].filter((_, k) => k !== bi) }));
  const pickProduct = (i: number, name: string) => {
    setSelProduct((s) => ({ ...s, [i]: name }));
    patchItem(b.id, i, { pactProduct: name });
    // Reset this item's per-row packaging so it re-derives from the new product.
    setSelLevel((s) => { const c = { ...s }; Object.keys(c).forEach((k) => { if (k.startsWith(`${i}:`)) delete c[k]; }); return c; });
    setPackEdit((s) => { const c = { ...s }; Object.keys(c).forEach((k) => { if (k.startsWith(`${i}:`)) delete c[k]; }); return c; });
  };

  const unmatched = b.items.filter((_, i) => !selUnit[i]).length;
  const datesReady = Object.values(batches).every((arr) => arr.every((bt) => !!bt.mfg));
  const allUp = b.items.every((it) => it.uploaded);
  const qtyAllOK = b.items.every((itm, i2) => {
    const bs2 = batches[i2] || [];
    if (bs2.length <= 1) return true;
    const q = lines[i2].qty;
    const prod2 = productByName(selProduct[i2]) || matchProduct(lines[i2].billName).product;
    const f2 = convFactor(prod2, itm.uom, selUnit[i2] || "");
    const dq = q != null ? q * (f2 ?? 1) : null;
    const sum2 = bs2.reduce((a, x) => a + (typeof x.qty === "number" ? x.qty : 0), 0);
    return dq != null && Math.abs(sum2 - dq) < 0.0001;
  });
  const supplierOk = chosenSup != null || ackNoSupplier;
  const canConfirm = unmatched === 0 && datesReady && !allUp && qtyAllOK && supplierOk;

  async function doPush() {
    if (!canConfirm || pushing) return;
    setPushErr(""); setPushing(true);
    const toDMY = (v: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || ""); return m ? `${m[3]}/${m[2]}/${m[1]}` : ""; };
    const items = lines.map((l, i) => {
      const prod = productByName(selProduct[i]) || matchProduct(l.billName).product;
      const unit = selUnit[i] || "";
      const l1u = prod.levels.L1 ? prod.levels.L1.u : (prod.units[0] || unit);
      // Push everything at L1 (base) level. Receipt Qty = Packing Size x Purchase Qty.
      const purchaseQty = l.qty != null ? l.qty * (convFactor(prod, b.items[i].uom, unit) ?? 1) : 0;
      const packSize = convFactor(prod, unit, l1u);
      const receiptQty = purchaseQty * (packSize ?? 1);
      const mfg = toDMY(batches[i]?.[0]?.mfg || "");
      return { search: prod.name, name: prod.name, code: prod.code || productCode(prod.name), unit: l1u, unitLevel: "L1", printLevel: "L1", qty: receiptQty, batch: mfg ? { mfgDate: mfg } : undefined };
    });
    const payload = {
      dryRun: false,
      bill: {
        company: "Factory",
        billId: b.id,
        vendor: chosenSup ? chosenSup.name : b.vendor,
        vendorSearch: ((chosenSup ? chosenSup.name : b.vendor) || "").replace(/[^A-Za-z0-9 ]/g, "").trim().slice(0, 4),
        vendorCode: chosenSup ? chosenSup.code : undefined,
        vendorGst: chosenSup ? chosenSup.gstin : b.vendorGst,
        billNo: b.invoice,
        billDate: b.dateFull,
        items,
      },
    };
    try {
      const res = await fetch("/api/push-to-pact", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({ ok: false, error: "Server returned a non-JSON response." }));
      if (!data.ok || !data.jobId) { setPushErr(data.error || "Could not start the PACT push."); setPushing(false); return; }

      // The push runs in a GitHub Actions job; poll pact_jobs for its status.
      const jobId = data.jobId as string;
      if (!supabase) { setPushErr("Push started (job " + jobId.slice(0, 8) + "). Status tracking needs Supabase — check PACT in ~2 min."); setPushing(false); return; }
      const started = Date.now();
      const poll = async (): Promise<void> => {
        if (Date.now() - started > 12 * 60 * 1000) { setPushErr("Still running after 12 min — check the PACT screen / GitHub Actions."); setPushing(false); return; }
        const { data: row } = await supabase.from("pact_jobs").select("status,grn,error").eq("id", jobId).maybeSingle();
        const st = row?.status;
        if (st === "done") { onConfirm(); return; }
        if (st === "failed") { setPushErr("PACT push failed: " + (row?.error || "unknown error")); setPushing(false); return; }
        setTimeout(poll, 5000);
      };
      poll();
    } catch (e) {
      setPushErr(e instanceof Error ? e.message : String(e));
      setPushing(false);
    }
  }

  return (
    <div className="overlay show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pmodal">
        <div className="phead">
          <span className="pbadge"><Icon n="upload" size={15} /></span>
          <div className="pttl">
            <h2>Upload to PACT</h2>
            <div className="sub">{lines.length} line item{lines.length > 1 ? "s" : ""} matched against PACT item master</div>
          </div>
          <button className="mclose" onClick={onClose}><Icon n="x" size={16} /></button>
        </div>

        <div className="pmeta">
          <div className="pmi"><span className="pmk">Party name{chosenSup ? <span className="pedit"> · PACT master</span> : <span className="ureview" title="Pick the PACT supplier this bill belongs to."><Icon n="alert" size={11} />select supplier</span>}</span>
            <Combobox value={selSupplierName} options={supplierNames} disabled={allUp} onChange={(v) => setSelSupplierName(v)} placeholder="Search supplier…" />
            <span className="pfrom">from bill: {b.vendor}</span>
          </div>
          <div className="pmi"><span className="pmk">Party GST</span><span className="pmv tnum">{chosenSup ? chosenSup.gstin : (b.vendorGst || "—")}</span></div>
          <div className="pmi"><span className="pmk">Bill number</span><span className="pmv">{b.invoice}</span></div>
          <div className="pmi"><span className="pmk">Bill date</span><span className="pmv">{b.dateFull}</span></div>
          <div className="pmi"><span className="pmk">Delivery date</span><span className="pmv">{(b as any).deliveryDate || "—"}</span></div>
        </div>


        <div className="pbody">
          {lines.map((l, i) => {
            const it = b.items[i];
            const done = it.uploaded;
            const ed = !!editing[i] && !done;
            const bs = batches[i] || [];
            const prod = productByName(selProduct[i]) || matchProduct(l.billName).product;
            const levelKeys = Object.keys(prod.levels);
            const l1Uom = prod.levels.L1 ? prod.levels.L1.u : (prod.units[0] || "—");
            const unit = selUnit[i] || "";
            const matched = !!unit;
            const unitInMaster = !!unit && prod.units.some((u) => canonUnit(u) === canonUnit(unit));
            const factor = convFactor(prod, it.uom, unit);
            const dispQty = l.qty != null ? l.qty * (factor ?? 1) : null;
            const packSize = convFactor(prod, unit, l1Uom);            // L1 base units per purchase unit
            const receiptQty = dispQty != null ? dispQty * (packSize ?? 1) : null;  // Packing Size x Purchase Qty (L1)
            const effQty = dispQty;
            const dispRate = l.rate != null ? l.rate / (factor ?? 1) : null;
            const splitMode = bs.length > 1;
            const batchSum = bs.reduce((a, x) => a + (typeof x.qty === "number" ? x.qty : 0), 0);
            const qtyOK = !splitMode || (effQty != null && Math.abs(batchSum - effQty) < 0.0001);
            const prodOpts = allNames; // always search the full PACT product master
            return (
              <div key={i} className={"pcard" + (matched ? "" : " err") + (done ? " done" : "")}>
                <div className="pcard-top">
                  <span className="pnum">{i + 1}</span>
                  <div className="pprod">
                    <div className="pname">{selProduct[i]}
                      {done
                        ? <span className="pmatch ok"><Icon n="check" size={11} />Uploaded to PACT</span>
                        : matched
                          ? <span className="pmatch ok"><Icon n="check" size={11} />PACT match{l.confidence ? ` · ${l.confidence}%` : ""}</span>
                          : <span className="pmatch bad"><Icon n="alert" size={11} />Unit not matched</span>}
                    </div>
                    <div className="pfrom">from bill: {l.billName}</div>
                  </div>
                </div>

                {/* Product line — purchase fields */}
                <div className="pgrid">
                  <div className="pf"><span className="pk">Product Name{ed ? <span className="pedit"> · full master</span> : ""}</span>
                    <Combobox value={selProduct[i]} options={prodOpts} disabled={done} onChange={(v) => pickProduct(i, v)} placeholder="Search product or code…" codeFor={productCode} />
                  </div>
                  <div className="pf"><span className="pk">Purchase Unit{unit && !unitInMaster ? <span className="ureview" title="This unit is not one of the product's PACT units (e.g. Gms / Kg / Bags). Click Edit to pick a PACT unit."><Icon n="alert" size={11} />review</span> : ""}</span>
                    {ed
                      ? <select className={"psel" + (unit && !unitInMaster ? " warn" : "")} value={unit} onChange={(e) => { const v = e.target.value; setSelUnit((s) => ({ ...s, [i]: v })); patchItem(b.id, i, { pactUnit: v }); }}>
                          <option value="">— select —</option>
                          {prod.units.map((u) => <option key={u} value={u}>{u}</option>)}
                        </select>
                      : unit
                        ? <span className="pv">{unit}</span>
                        : <span className="pv bad"><Icon n="alert" size={11} />Not matched</span>}
                  </div>
                  <div className="pf"><span className="pk">Purchase Quantity{factor != null && factor !== 1 ? <span className="pedit"> · {it.uom}→{unit}</span> : ""}</span>{dispQty != null ? <span className="pv tnum">{fmtQty(dispQty)}</span> : <span className="pv bad">Requires unit</span>}</div>
                  <div className="pf"><span className="pk">Receipt Quantity{packSize != null && packSize !== 1 ? <span className="pedit"> · {fmtQty(packSize)}×qty (L1)</span> : <span className="pedit"> · L1</span>}</span>{receiptQty != null ? <span className="pv tnum">{fmtQty(receiptQty)} {l1Uom}</span> : <span className="pv bad">Requires unit</span>}</div>
                  <div className="pf"><span className="pk">Purchase Rate</span><span className="pv tnum">{dispRate != null ? "₹" + inr(dispRate) : "—"}</span></div>
                  <div className="pf"><span className="pk">GST Rate</span><span className="pv">{it.taxRate || "—"}</span></div>
                  <div className="pf"><span className="pk">GST Amount</span><span className="pv tnum">{it.gst != null ? "₹" + inr(it.gst) : "—"}</span></div>
                </div>

                {/* Manufacturing batches (Split on the right) */}
                <div className="pbatchbar">
                  <span className="pbl">Manufacturing batch{bs.length > 1 ? "es" : ""}</span>
                  <button className="psplit" disabled={done || !matched} onClick={() => split(i)} title={matched ? "Duplicate this batch row" : "Pick a purchase unit first"}><Icon n="copy" size={12} />Split</button>
                </div>
                {bs.map((bt, bi) => {
                  const qtyEditable = splitMode && !done;
                  const rk = `${i}:${bt.id}`;
                  const rLevel = prod.levels[selLevel[rk]] ? selLevel[rk] : (prod.printLevel && prod.levels[prod.printLevel] ? prod.printLevel : (levelKeys[0] || ""));
                  const rLvl = prod.levels[rLevel];
                  const rPrintUom = rLvl ? rLvl.u : "—";
                  const rPackNum = rLvl && rLvl.s != null ? String(rLvl.s) : "—";
                  const rPackVal = packEdit[rk] !== undefined ? (packEdit[rk] || "—") : rPackNum;
                  return (
                    <div className="pbatch6" key={bt.id}>
                      <div className="pf"><span className="pk">Manufactured Date</span>
                        <input type="date" className="pdate" value={bt.mfg} disabled={done} onChange={(e) => setBatch(i, bi, { mfg: e.target.value })} />
                      </div>
                      <div className="pf"><span className="pk">Quantity / Mfg Date</span>
                        {qtyEditable
                          ? <input type="number" min={0} className="pnuminp tnum" value={bt.qty} onChange={(e) => setBatch(i, bi, { qty: e.target.value === "" ? "" : Number(e.target.value) })} />
                          : <span className="pv tnum">{splitMode ? bt.qty : fmtQty(effQty ?? 0)}</span>}
                      </div>
                      <div className="pf"><span className="pk">UOM</span>{unit ? <span className="pv">{unit}</span> : <span className="pv bad"><Icon n="alert" size={11} />—</span>}</div>
                      <div className="pf"><span className="pk">Packaging size UOM{ed ? <span className="pedit"> · level</span> : ""}</span>
                        {ed
                          ? <select className="psel" value={rLevel} onChange={(e) => { const v = e.target.value; setSelLevel((s) => ({ ...s, [rk]: v })); setPackEdit((s) => ({ ...s, [rk]: undefined })); }}>
                              {levelKeys.map((k) => <option key={k} value={k}>{k} · {prod.levels[k].u}</option>)}
                            </select>
                          : <span className="pv">{rPrintUom}</span>}
                      </div>
                      <div className="pf"><span className="pk">Packing size{ed ? <span className="pedit"> · manual</span> : ""}</span>
                        {ed
                          ? <input type="number" min={0} className="pnuminp tnum" value={packEdit[rk] !== undefined ? packEdit[rk] : rPackNum} onChange={(e) => { const v = e.target.value; setPackEdit((s) => ({ ...s, [rk]: v })); }} />
                          : <span className="pv tnum">{rPackVal}</span>}
                      </div>
                      <div className="pf"><span className="pk">L1 UOM</span><span className="pv">{l1Uom}</span></div>
                      <div className="pf pbrm">{splitMode && !done && <button className="pxbtn" title="Remove this batch" onClick={() => removeBatch(i, bi)}><Icon n="x" size={12} /></button>}</div>
                    </div>
                  );
                })}
                {splitMode && !qtyOK && <div className="perr"><Icon n="alert" size={14} />Batch quantities add up to {fmtQty(batchSum)} {unit}, but purchase quantity is {fmtQty(effQty ?? 0)} {unit}. They must match before upload.</div>}

                {!matched && <div className="perr"><Icon n="alert" size={14} />No purchase unit matched for "{b.items[i].uom}" — click Edit to pick one from the master. Upload is blocked until then.</div>}

                {/* Per-item action — Edit (centred) */}
                <div className="pcard-foot center">
                  <button className="pmini" disabled={done} onClick={() => setEditing((s) => ({ ...s, [i]: !s[i] }))}><Icon n="edit" size={12} />{editing[i] ? "Done" : "Edit"}</button>
                  {done && <span className="up-done"><Icon n="check" size={12} />Uploaded</span>}
                </div>
              </div>
            );
          })}

          <div className="pchg">
            <span className="pchg-h">Cumulative charges</span>
            {b.otherCharges && b.otherCharges.length
              ? <>{b.otherCharges.map((c, ci) => <span key={ci} className="pchg-i">{c.label}<b>₹{inr(c.amount)}</b></span>)}<span className="pchg-i tot">Total<b>₹{inr(b.otherCharges.reduce((a, c) => a + c.amount, 0))}</b></span></>
              : <span className="pchg-none">No additional charges on this bill</span>}
          </div>
        </div>

        <div className="pfoot">
          <span className={"pstatus " + (unmatched > 0 || !qtyAllOK ? "bad" : allUp ? "ok" : !datesReady ? "warn" : !supplierOk ? "warn" : "ok")}>
            {unmatched > 0
              ? <><Icon n="alert" size={16} />{unmatched} item{unmatched > 1 ? "s" : ""} not matched — upload blocked</>
              : allUp
                ? <><Icon n="check" size={16} />All items uploaded</>
                : !datesReady
                  ? <><Icon n="alert" size={16} />Select a manufactured date for every batch</>
                  : !qtyAllOK
                    ? <><Icon n="alert" size={16} />Split quantities must equal the purchase quantity</>
                    : !supplierOk
                      ? <><Icon n="alert" size={16} />Supplier not in PACT master — confirm below to push</>
                      : <><Icon n="shield" size={16} />All items matched · ready to push</>}
          </span>
          {!sup.supplier && (
            <label className="pstatus warn" style={{ maxWidth: 470, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={ackNoSupplier} onChange={(e) => setAckNoSupplier(e.target.checked)} />
              <Icon n="alert" size={16} />Supplier not in your PACT master — add it in PACT, or tick to push anyway.
            </label>
          )}
          {pushErr && <span className="pstatus bad" style={{ maxWidth: 420 }}><Icon n="alert" size={16} />{pushErr}</span>}
          <button className="btn btn-ghost" style={{ padding: "10px 15px" }} onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" style={{ padding: "10px 15px" }} disabled={!canConfirm || pushing}
            title={canConfirm ? "" : "Every item must have a purchase unit and a manufactured date"}
            onClick={doPush}>
            <Icon n="upload" size={14} />{pushing ? "Pushing to PACT\u2026" : "Confirm & Push to PACT"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PrintLabel({ b, printed, onClose, onPrinted }: { b: Bill; printed?: boolean; onClose: () => void; onPrinted: (id: number) => void }) {
  // Per-item label data, with the invoice qty auto-converted into the PACT
  // packaging unit (same convFactor logic as the Upload to PACT modal).
  const rows = useMemo(() => b.items.map((it) => {
    const l = resolveLine(it);
    // Use the product / purchase unit the user fixed in the Upload-to-PACT modal
    // (saved on the item), falling back to the auto-match.
    const prod = (it.pactProduct ? productByName(it.pactProduct) : null) || productByName(l.product) || matchProduct(l.billName).product;
    const levelKeys = Object.keys(prod.levels);
    const level = prod.printLevel && prod.levels[prod.printLevel] ? prod.printLevel : (levelKeys[0] || "");
    const lvl = prod.levels[level];
    const pkgUom = lvl ? lvl.u : "";
    const packYnum = lvl && lvl.s != null ? lvl.s : null;
    const l1 = prod.levels.L1 ? prod.levels.L1.u : (prod.units[0] || "");
    // A row is printable only when its Purchase Unit is an actual PACT master unit
    // (same REVIEW test as the modal). If in review the whole row is blanked out.
    const unit = it.pactUnit || l.unit;
    const masterUnit = unit ? prod.units.find((u) => canonUnit(u) === canonUnit(unit)) : undefined;
    // Blank the row ONLY when the purchase unit isn't a PACT master unit — the exact
    // same REVIEW test the Upload-to-PACT modal uses (no extra conversion conditions).
    const ok = !!masterUnit && packYnum != null && packYnum > 0;
    // Purchase qty in the chosen unit (mirror the modal: fall back to x1 when the bill
    // unit can't be converted, e.g. Pcs -> Pkt).
    const qtyInUnit = ok ? it.qty * (convFactor(prod, it.uom, masterUnit as string) ?? 1) : null;
    // Size (in L1 base) of the chosen purchase unit, from its packaging level.
    const unitLvl = masterUnit ? Object.values(prod.levels).find((L) => canonUnit(L.u) === canonUnit(masterUnit as string)) : undefined;
    const unitS = unitLvl && unitLvl.s != null ? unitLvl.s : null;
    const convToL1 = masterUnit ? convFactor(prod, it.uom, l1) : null;
    // X = total material in L1 = qty-in-unit x unit-size (or bill qty x bill->L1).
    const totalL1 = ok
      ? (qtyInUnit != null && unitS != null ? qtyInUnit * unitS : (convToL1 != null ? it.qty * convToL1 : null))
      : null;
    // Y = packing size; No. of labels = ceil(X / Y). Falls back to 1 label per purchase
    // unit when the L1 material can't be derived, so a matched row is never blank.
    const labels = ok
      ? (totalL1 != null && packYnum ? Math.ceil(totalL1 / (packYnum as number)) : Math.ceil(qtyInUnit as number))
      : null;
    const purchaseQty = ok ? qtyInUnit : null;
    return { product: prod.name, ok, purchaseUnit: ok ? (masterUnit as string) : "", purchaseQty, pkgUom, pkgSize: packYnum != null ? String(packYnum) : "", l1, labels };
  }), [b]);
  const anyReview = rows.some((r) => !r.ok);
  const [counts, setCounts] = useState<Record<number, number | "">>(() =>
    Object.fromEntries(rows.map((r, i) => [i, r.ok ? (r.labels as number) : ""])));
  const totalLabels = rows.reduce((a, _r, i) => a + (typeof counts[i] === "number" ? (counts[i] as number) : 0), 0);
  return (
    <div className="overlay show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pmodal" style={{ maxWidth: 960 }}>
        <div className="phead">
          <span className="pbadge" style={{ background: "#3b82f6", boxShadow: "0 6px 16px rgba(59,130,246,.4)" }}><Icon n="printer" size={15} /></span>
          <div className="pttl">
            <h2>Print PACT labels</h2>
            <div className="sub">{b.vendor} · Invoice {b.invoice} · {b.items.length} product{b.items.length > 1 ? "s" : ""}</div>
          </div>
          <button className="mclose" onClick={onClose}><Icon n="x" size={16} /></button>
        </div>
        <div className="pbody">
          <table className="lbltbl">
            <thead><tr><th className="div">Product Name</th><th>Purchase Unit</th><th className="div">Purchase Qty</th><th>Packaging Size UOM</th><th>Packaging Size</th><th className="div">L1 UOM</th><th>No. of Labels</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                r.ok
                  ? <tr key={i}>
                      <td className="nm div">{r.product}</td>
                      <td>{r.purchaseUnit}</td>
                      <td className="tnum div">{fmtQty(r.purchaseQty as number)}</td>
                      <td>{r.pkgUom}</td>
                      <td className="tnum">{r.pkgSize}</td>
                      <td className="div">{r.l1}</td>
                      <td><input type="number" min={0} className="pnuminp tnum" style={{ width: 84 }} value={counts[i]} onChange={(e) => setCounts((c) => ({ ...c, [i]: e.target.value === "" ? "" : Number(e.target.value) }))} /></td>
                    </tr>
                  : <tr key={i} className="lblrev">
                      <td className="nm div">{r.product} <span className="ureview"><Icon n="alert" size={10} />unit in review</span></td>
                      <td></td><td className="div"></td><td></td><td className="tnum"></td><td className="div"></td><td></td>
                    </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="pfoot">
          <span className={"pstatus " + (anyReview ? "bad" : "ok")}>{anyReview ? <><Icon n="alert" size={16} />A product's purchase unit is in review — fix it in Upload to PACT before printing</> : printed ? <><Icon n="check" size={16} />Already printed · {totalLabels} label{totalLabels === 1 ? "" : "s"} across {b.items.length} product{b.items.length > 1 ? "s" : ""}</> : <><Icon n="printer" size={16} />{totalLabels} label{totalLabels === 1 ? "" : "s"} across {b.items.length} product{b.items.length > 1 ? "s" : ""}</>}</span>
          <button className="btn btn-ghost" style={{ padding: "10px 15px" }} onClick={onClose}>Close</button>
          {printed
            ? <button className="btn btn-printed" style={{ padding: "10px 15px" }} disabled title="These labels have already been printed"><Icon n="check" size={14} />Printed</button>
            : <button className="btn btn-print" style={{ padding: "10px 15px" }} disabled={anyReview} title={anyReview ? "Resolve the purchase unit(s) in review first" : ""} onClick={() => { if (!anyReview) onPrinted(b.id); }}><Icon n="printer" size={14} />Print labels</button>}
        </div>
      </div>
    </div>
  );
}

// ---- Batchwise report (real-time PACT inventory) types & parser ----
type SoBatch = {
  batchNumber: string; warehouse: string; unit: string;
  available: number; rate: string; exp: string; mfg: string; expTs: number; name: string;
};
type SoIndex = Record<string, SoBatch[]>;

function soParseDmy(s: string): number {
  const m = /(\d{1,2})[\/\-]([A-Za-z]{3,})[\/\-](\d{2,4})/.exec(s || "");
  if (!m) return 8.64e15;
  const mon = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m[2].slice(0, 3).toLowerCase());
  if (mon < 0) return 8.64e15;
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return new Date(y, mon, Number(m[1])).getTime();
}

// Parse a PACT "BatchWise Stock Analysis" export (HTML table saved as .xls).
function soParseReport(html: string): { idx: SoIndex; products: number; batches: number } {
  const idx: SoIndex = {};
  let batches = 0;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const tables = Array.from(doc.querySelectorAll("table"));
  let best: HTMLTableElement | null = null; let bestRows = 0;
  for (const tb of tables) { const n = tb.querySelectorAll("tr").length; if (n > bestRows) { bestRows = n; best = tb as HTMLTableElement; } }
  if (!best) return { idx, products: 0, batches: 0 };
  const trs = Array.from(best.querySelectorAll("tr"));
  let hi = -1; let cols: string[] = [];
  for (let i = 0; i < trs.length; i++) {
    const cells = Array.from(trs[i].querySelectorAll("th,td")).map((c) => (c.textContent || "").trim());
    if (cells.some((c) => /product\s*code/i.test(c))) { hi = i; cols = cells; break; }
  }
  if (hi < 0) return { idx, products: 0, batches: 0 };
  const col = (re: RegExp) => cols.findIndex((c) => re.test(c));
  const cCode = col(/product\s*code/i), cName = col(/product\s*name/i), cBatch = col(/batch/i),
    cWh = col(/warehouse/i), cUnit = col(/unit/i), cQty = col(/quantity/i), cRate = col(/^\s*rate/i),
    cExp = col(/exp/i), cMfg = col(/mfg/i);
  for (let i = hi + 1; i < trs.length; i++) {
    const cells = Array.from(trs[i].querySelectorAll("td")).map((c) => (c.textContent || "").trim());
    const code = (cells[cCode] || "").trim();
    if (!/^[A-Za-z]{2}\d/.test(code)) continue;
    const qty = parseFloat((cells[cQty] || "0").replace(/,/g, "")) || 0;
    const exp = cells[cExp] || "—";
    const b: SoBatch = {
      batchNumber: cells[cBatch] || "—",
      warehouse: cells[cWh] || "—",
      unit: cells[cUnit] || "—",
      available: qty,
      rate: (cells[cRate] || "").trim(),
      exp,
      mfg: cells[cMfg] || "—",
      expTs: soParseDmy(exp),
      name: cells[cName] || "",
    };
    (idx[code] = idx[code] || []).push(b);
    batches++;
  }
  const now = Date.now();
  for (const k in idx) idx[k].sort((a, z) => {
    // Non-expired first (FEFO), expired batches sink to the bottom.
    const ae = a.expTs < now ? 1 : 0, ze = z.expTs < now ? 1 : 0;
    return ae - ze || a.expTs - z.expTs;
  });
  return { idx, products: Object.keys(idx).length, batches };
}

// Build the same batch index from already-parsed snapshot rows
// ({ code, name, batch, warehouse, unit, qty, rate, exp, mfg }) fetched from
// Supabase (public.inventory_snapshots.data).
function soIndexFromRows(rows: Array<Record<string, unknown>>): { idx: SoIndex; products: number; batches: number } {
  const idx: SoIndex = {};
  let batches = 0;
  for (const r of rows || []) {
    const code = String(r.code || "").trim();
    if (!code) continue;
    const exp = String(r.exp || "—");
    const b: SoBatch = {
      batchNumber: String(r.batch || "—"), warehouse: String(r.warehouse || "—"),
      unit: String(r.unit || "—"), available: Number(r.qty) || 0, rate: String(r.rate || ""),
      exp, mfg: String(r.mfg || "—"), expTs: soParseDmy(exp), name: String(r.name || ""),
    };
    (idx[code] = idx[code] || []).push(b);
    batches++;
  }
  const now = Date.now();
  for (const k in idx) idx[k].sort((a, z) => { const ae = a.expTs < now ? 1 : 0, ze = z.expTs < now ? 1 : 0; return ae - ze || a.expTs - z.expTs; });
  return { idx, products: Object.keys(idx).length, batches };
}

function SalesOrderScan({ onClose }: { onClose: () => void }) {
  type Row = {
    id: string; productCode: string; productName: string; hsn: string;
    salesUnitLevel: string; gstTaxType: string; salesRate: string;
    dispatchQty: number; batches: SoBatch[]; sel: number; found: boolean;
  };

  const DASH = "—";
  const COLS = [
    "Product code", "Product name", "GST HSN", "Warehouse", "Sales unit level",
    "Unit", "Quantity", "Unit price", "Sales rate", "GST tax type",
    "Batch number", "Manufacture date", "Expiry date",
  ];

  // Parse a GS1-128 barcode into fields; fall back to a plain product code / name.
  const parseScan = (raw: string) => {
    const s = (raw || "").trim();
    const out: { code?: string; batch?: string; mfg?: string; exp?: string; qty?: number } = {};
    if (!s) return out;
    const ymd = (d: string) => (d && d.length === 6 ? "20" + d.slice(0, 2) + "-" + d.slice(2, 4) + "-" + d.slice(4, 6) : "");
    const GS = String.fromCharCode(29);
    const looksGs1 = /^(01)\d{14}/.test(s) || s.indexOf(GS) >= 0;
    if (looksGs1) {
      for (let seg of s.split(GS)) {
        while (seg.length) {
          if (seg.startsWith("01") && seg.length >= 16) { out.code = seg.slice(2, 16); seg = seg.slice(16); }
          else if (seg.startsWith("11") && seg.length >= 8) { out.mfg = ymd(seg.slice(2, 8)); seg = seg.slice(8); }
          else if (seg.startsWith("17") && seg.length >= 8) { out.exp = ymd(seg.slice(2, 8)); seg = seg.slice(8); }
          else if (seg.startsWith("10")) { out.batch = seg.slice(2); seg = ""; }
          else if (seg.startsWith("30") || seg.startsWith("37")) { out.qty = parseInt(seg.slice(2), 10) || undefined; seg = ""; }
          else { break; }
        }
      }
    } else {
      out.code = s;
    }
    return out;
  };

  const [rows, setRows] = useState<Row[]>([]);
  const [scan, setScan] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showInv, setShowInv] = useState(false);
  const [invQuery, setInvQuery] = useState("");
  const [note, setNote] = useState("");
  const [inv, setInv] = useState<SoIndex>({});
  const [invMeta, setInvMeta] = useState<{ file: string; products: number; batches: number } | null>(null);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); if (!invMeta && supabase) fetchLatest(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const uid = () => Math.random().toString(36).slice(2, 9);
  const nf = (n: number) => n.toLocaleString("en-IN");

  const onImport = (file: File) => {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const { idx, products, batches } = soParseReport(String(rd.result || ""));
        if (!products) { setNote("Could not read any batches from that file. Export the BatchWise Stock Analysis from PACT (Excel) and import that .xls."); return; }
        setInv(idx);
        setInvMeta({ file: file.name, products, batches });
        setNote("");
      } catch {
        setNote("That file could not be parsed. Please import the BatchWise Stock Analysis .xls exported from PACT.");
      }
    };
    rd.readAsText(file);
  };

  const fmtSynced = (iso: string | null) => {
    if (!iso) return "";
    const d = new Date(iso);
    const mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins <= 0) return "just now";
    if (mins === 1) return "1 min ago";
    if (mins < 60) return mins + " min ago";
    return d.toLocaleString("en-IN");
  };

  // Load the latest PACT inventory snapshot from Supabase.
  const fetchLatest = async () => {
    if (!supabase) { setNote("Live inventory isn't configured for this dashboard yet — import the exported .xls instead."); return; }
    setNote("Loading latest inventory from PACT…");
    try {
      const { data, error } = await supabase.from("inventory_snapshots")
        .select("synced_at,products,batches,data").eq("status", "ok")
        .order("synced_at", { ascending: false }).limit(1).maybeSingle();
      if (error || !data) { setNote("No inventory snapshot yet. Click Sync now from PACT (or import a file)."); return; }
      const { idx, products, batches } = soIndexFromRows((data.data as Array<Record<string, unknown>>) || []);
      setInv(idx); setInvMeta({ file: "PACT live sync", products, batches }); setSyncedAt(data.synced_at); setNote("");
    } catch { setNote("Could not load inventory from Supabase."); }
  };

  // Trigger a fresh PACT export (GitHub Actions), then poll for the new snapshot.
  const syncNow = async () => {
    setSyncing(true);
    setNote("Sync requested — pulling the batchwise report from PACT (about 1–2 min). It will refresh here automatically.");
    try {
      const r = await fetch("/api/sync-inventory", { method: "POST" });
      const j = await r.json().catch(() => ({} as { ok?: boolean; error?: string }));
      if (!r.ok || !j.ok) { setNote("Couldn't start the sync: " + (j.error || r.status) + ". Check GH_DISPATCH_TOKEN / GH_REPO on the server."); setSyncing(false); return; }
      const from = syncedAt;
      let tries = 0;
      const iv = setInterval(async () => {
        tries++;
        if (!supabase) { setSyncing(false); clearInterval(iv); return; }
        const { data } = await supabase.from("inventory_snapshots")
          .select("synced_at,products,batches,data").eq("status", "ok")
          .order("synced_at", { ascending: false }).limit(1).maybeSingle();
        if (data && data.synced_at !== from) {
          const { idx, products, batches } = soIndexFromRows((data.data as Array<Record<string, unknown>>) || []);
          setInv(idx); setInvMeta({ file: "PACT live sync", products, batches }); setSyncedAt(data.synced_at);
          setNote(""); setSyncing(false); clearInterval(iv);
        } else if (tries > 50) { setSyncing(false); setNote("Sync is taking longer than usual — click Fetch latest inventory in a moment."); clearInterval(iv); }
      }, 3000);
    } catch { setSyncing(false); setNote("Sync trigger failed."); }
  };

  const onScan = (raw: string) => {
    const p = parseScan(raw);
    const key = (p.code || "").trim();
    if (!key) return;
    if (!invMeta) { setNote("No inventory loaded yet — click Fetch latest inventory (or Sync now from PACT), then scan again."); return; }
    // Match the scanned code against the product master (for name / HSN / level)…
    const prod = CATALOG.find((x) => (x.code || "").toLowerCase() === key.toLowerCase())
      || CATALOG.find((x) => x.name.toLowerCase().includes(key.toLowerCase()));
    const pcode = prod ? (prod.code || key) : key;
    // …and pull its live batches from the imported batchwise report.
    const batches = inv[pcode] || inv[key] || [];
    const found = batches.length > 0;
    const level = (prod && prod.printLevel) || "L1";
    let sel = 0;
    if (p.batch && found) { const j = batches.findIndex((b) => b.batchNumber === p.batch); if (j >= 0) sel = j; }
    const name = (prod && prod.name) || (found && batches[0].name) || ("Unknown item (" + key + ")");
    const addQty = p.qty && p.qty > 0 ? p.qty : 1;

    setRows((prev) => {
      const i = prev.findIndex((r) => r.productCode === pcode && r.sel === sel);
      if (i >= 0) { const c = prev.slice(); c[i] = { ...c[i], dispatchQty: c[i].dispatchQty + addQty }; return c; }
      const row: Row = {
        id: uid(), productCode: pcode, productName: name, hsn: DASH,
        salesUnitLevel: level, gstTaxType: "GST", salesRate: DASH,
        dispatchQty: addQty, batches, sel, found,
      };
      return [...prev, row];
    });
    setScan("");
  };

  const setSel = (id: string, sel: number) => setRows((prev) => prev.map((r) => r.id === id ? { ...r, sel } : r));
  const setQty = (id: string, q: number) => setRows((prev) => prev.map((r) => r.id === id ? { ...r, dispatchQty: q } : r));
  const removeRow = (id: string) => setRows((prev) => prev.filter((r) => r.id !== id));

  const totalQty = rows.reduce((a, r) => a + (r.dispatchQty || 0), 0);

  const invList = useMemo(() => {
    const out: Array<{ code: string } & SoBatch> = [];
    for (const code in inv) for (const b of inv[code]) out.push({ code, ...b });
    return out;
  }, [inv]);
  const invFiltered = useMemo(() => {
    const q = invQuery.trim().toLowerCase();
    if (!q) return invList;
    return invList.filter((r) => r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q) || r.batchNumber.toLowerCase().includes(q) || r.warehouse.toLowerCase().includes(q));
  }, [invList, invQuery]);

  return (
    <div className="soscan sopanel">
      <div className="sopanel-head">
        <div>
          <h2>Sales Order</h2>
          <p>Sync live PACT stock, then scan food-item barcodes (Honeywell) — each scan is matched batch-by-batch against that inventory.</p>
        </div>
        <button className="so-close" title="Close" onClick={onClose}><Icon n="x" size={18} /></button>
      </div>

      <div className="soscan-bar">
        <input ref={fileRef} type="file" accept=".xls,.xlsx,.html,.htm" style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files && e.target.files[0]; if (f) onImport(f); e.currentTarget.value = ""; }} />
        <button className="btn btn-primary" onClick={syncNow} disabled={syncing}><Icon n="refresh" size={15} />{syncing ? "Syncing from PACT…" : "Sync inventory from PACT"}</button>
        <button className="btn btn-ghost" onClick={fetchLatest}>Load last synced</button>
        <button className="btn btn-ghost" onClick={() => setShowInv(true)} disabled={!invMeta} title={invMeta ? "View the full synced inventory" : "Sync inventory first"}><Icon n="eye" size={15} />View inventory</button>
        <button className="btn btn-ghost" onClick={() => fileRef.current?.click()}>Import file</button>
        {invMeta && <span className="so-invchip"><Icon n="check" size={13} />Live inventory: <b>{nf(invMeta.products)}</b> products · <b>{nf(invMeta.batches)}</b> batches{syncedAt ? <span className="so-invfile">synced {fmtSynced(syncedAt)}</span> : <span className="so-invfile">{invMeta.file}</span>}</span>}
      </div>

          <div className="soscan-bar">
            <div className="scanbox">
              <Icon n="search" size={16} />
              <input ref={inputRef} value={scan} placeholder="Scan a barcode, or type a product code / name, then press Enter…"
                onChange={(e) => setScan(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") onScan(scan); }} />
              <button className="btn btn-ghost" style={{ padding: "8px 14px" }} onClick={() => onScan(scan)}>Add</button>
            </div>
            <div className="keybox" title="Only needed for Honeywell's cloud SDK; keyboard-wedge scanning works without it.">
              <Icon n="lock" size={14} />
              <input value={apiKey} placeholder="Honeywell API key (optional — cloud SDK)" onChange={(e) => setApiKey(e.target.value)} />
            </div>
          </div>

          {note && <div className="soscan-note"><Icon n="alert" size={15} /><span>{note}</span></div>}

      <div className="so-gridwrap sopanel-grid">
            <table className="so-grid">
              <thead>
                <tr>
                  <th className="so-rownum">#</th>
                  {COLS.map((c) => <th key={c}>{c}</th>)}
                  <th aria-label="Remove"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const b = r.batches[r.sel];
                  const over = b ? r.dispatchQty > b.available : false;
                  return (
                    <tr key={r.id} className={!r.found ? "so-unknown" : ""}>
                      <td className="so-rownum">{i + 1}</td>
                      <td className="so-mono">{r.productCode}</td>
                      <td className="so-name">{r.productName}</td>
                      <td>{r.hsn}</td>
                      <td>{b ? b.warehouse : DASH}</td>
                      <td>{r.salesUnitLevel}</td>
                      <td>{b ? b.unit : DASH}</td>
                      <td className="so-num">
                        <input className={"so-qtyin" + (over ? " over" : "")} type="number" min={0} value={r.dispatchQty}
                          onChange={(e) => setQty(r.id, parseFloat(e.target.value) || 0)} />
                        {b && <span className="so-avail">of {nf(b.available)}</span>}
                      </td>
                      <td className="so-num">{b ? b.rate : DASH}</td>
                      <td className="so-num">{r.salesRate}</td>
                      <td>{r.gstTaxType}</td>
                      <td>
                        {r.found
                          ? <select className="so-batchsel" value={r.sel} onChange={(e) => setSel(r.id, Number(e.target.value))}>
                              {r.batches.map((bt, j) => <option key={bt.batchNumber + j} value={j}>{bt.batchNumber} · {bt.warehouse} · {nf(bt.available)} · exp {bt.exp}</option>)}
                            </select>
                          : <span className="so-nostock">No stock in report</span>}
                      </td>
                      <td>{b ? b.mfg : DASH}</td>
                      <td>{b ? b.exp : DASH}</td>
                      <td><button className="so-del" title="Remove line" onClick={() => removeRow(r.id)}>&times;</button></td>
                    </tr>
                  );
                })}
                {!rows.length && (
                  <tr><td className="so-empty" colSpan={COLS.length + 2}>{invMeta ? "Scan a barcode to add the first line." : "Import the batchwise report, then scan a barcode."}</td></tr>
                )}
              </tbody>
            </table>
          </div>

      <div className="soscan-foot">
        <span className="soscan-total">Lines: <b>{rows.length}</b></span>
        <span className="soscan-total">Total quantity: <b>{nf(totalQty)}</b></span>
      </div>

      {showInv && (
        <div className="inv-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowInv(false); }}>
          <div className="inv-panel">
            <div className="inv-head">
              <div><h3>Live inventory</h3><span className="inv-sub">{nf(invMeta ? invMeta.products : 0)} products · {nf(invMeta ? invMeta.batches : 0)} batches{syncedAt ? " · synced " + fmtSynced(syncedAt) : ""}</span></div>
              <button className="so-close" onClick={() => setShowInv(false)}><Icon n="x" size={18} /></button>
            </div>
            <div className="inv-searchbar">
              <Icon n="search" size={15} />
              <input autoFocus value={invQuery} placeholder="Search product code, name, batch or warehouse…" onChange={(e) => setInvQuery(e.target.value)} />
              <span className="inv-count">{nf(invFiltered.length)} rows</span>
            </div>
            <div className="inv-gridwrap">
              <table className="so-grid">
                <thead><tr><th className="so-rownum">#</th><th>Product code</th><th>Product name</th><th>Batch number</th><th>Warehouse</th><th>Unit</th><th>Quantity</th><th>Unit price</th><th>Manufacture date</th><th>Expiry date</th></tr></thead>
                <tbody>
                  {invFiltered.slice(0, 2000).map((r, i) => (
                    <tr key={r.code + r.batchNumber + i}>
                      <td className="so-rownum">{i + 1}</td>
                      <td className="so-mono">{r.code}</td>
                      <td className="so-name">{r.name}</td>
                      <td className="so-mono">{r.batchNumber}</td>
                      <td>{r.warehouse}</td>
                      <td>{r.unit}</td>
                      <td className="so-num">{nf(r.available)}</td>
                      <td className="so-num">{r.rate}</td>
                      <td>{r.mfg}</td>
                      <td>{r.exp}</td>
                    </tr>
                  ))}
                  {!invFiltered.length && <tr><td className="so-empty" colSpan={10}>No matching stock.</td></tr>}
                </tbody>
              </table>
              {invFiltered.length > 2000 && <div className="inv-more">Showing first 2,000 of {nf(invFiltered.length)} — refine your search to narrow.</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function HomeScreen({ onOpen, counts }: { onOpen: (v: "stock" | "sales" | "salesorder") => void; counts: { bills: number; so: number } }) {
  return (
    <div className="home">
      <div className="home-head">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="home-logo" src="/logo.png" alt="Sukhna Foods" />
        <h1>Sukhna Foods Operations</h1>
        <p>Choose what you&rsquo;d like to work on.</p>
      </div>
      <div className="tiles">
        <button className="tile stock" onClick={() => onOpen("stock")}>
          <span className="tile-ic"><Icon n="inbox" size={30} /></span>
          <span className="tile-ttl">Stock Inward &amp; Bill Uploader</span>
          <span className="tile-sub">Review incoming bills, verify entries, print PACT labels and push stock inward.</span>
          <span className="tile-meta">{counts.bills} bill{counts.bills === 1 ? "" : "s"} in inbox</span>
          <span className="tile-go">Open <Icon n="arrowRight" size={15} /></span>
        </button>
        <button className="tile sales" onClick={() => onOpen("sales")}>
          <span className="tile-ic"><Icon n="file" size={30} /></span>
          <span className="tile-ttl">Sales Order Creation</span>
          <span className="tile-sub">Upload a sales order, view it full-screen in a table, and save it to your database.</span>
          <span className="tile-meta">{counts.so} sales order{counts.so === 1 ? "" : "s"} saved</span>
          <span className="tile-go">Open <Icon n="arrowRight" size={15} /></span>
        </button>
        <a className="tile dispatch" href="/outlet-dispatch/index.html">
          <span className="tile-ic"><Icon n="truck" size={30} /></span>
          <span className="tile-ttl">Outlet Dispatch Tool</span>
          <span className="tile-sub">Build the day&rsquo;s outlet dispatch challans and the PACT ERP upload from the order sheets. Fully manual.</span>
          <span className="tile-meta">Manual · opens the dispatch app</span>
          <span className="tile-go">Open <Icon n="arrowRight" size={15} /></span>
        </a>
        <button className="tile salesorder" onClick={() => onOpen("salesorder")}>
          <span className="tile-ic"><Icon n="inbox" size={30} /></span>
          <span className="tile-ttl">Sales Order</span>
          <span className="tile-sub">Scan food-item barcodes (Honeywell) against live PACT inventory — batch, warehouse, quantity, price &amp; expiry per line.</span>
          <span className="tile-meta">Barcode scan · live inventory</span>
          <span className="tile-go">Open <Icon n="arrowRight" size={15} /></span>
        </button>
      </div>
    </div>
  );
}

type PriceRow = { code: string; name: string; customer: string; unit: string; rate: number | null; wef: string };
let PRICES: PriceRow[] = PRICE_CHART as PriceRow[];
const CAT_LEVELS = (() => { const m = new Map<string, (typeof CATALOG)[number]["levels"]>(); for (const c of CATALOG) { if (c.levels && Object.keys(c.levels).length) m.set(c.name.trim().toLowerCase(), c.levels); } return m; })();
function productLevels(name: string) { return CAT_LEVELS.get((name || "").trim().toLowerCase()) || null; }
function unitConversion(name: string, unit: string): number | null {
  const lv = productLevels(name); if (!lv) return null;
  const u = (unit || "").trim().toLowerCase();
  for (const k of ["L1", "L2", "L3"] as const) { const e = lv[k]; if (e && String(e.u).trim().toLowerCase() === u) return Number(e.s); }
  return null;
}
let PRICE_NAME_SET = new Set(PRICES.map((p) => p.name.trim().toLowerCase()).filter(Boolean));
const inPriceChart = (name: string) => PRICE_NAME_SET.has((name || "").trim().toLowerCase());
function rebuildPriceIndex() { PRICE_NAME_SET = new Set(PRICES.map((p) => p.name.trim().toLowerCase()).filter(Boolean)); }
function setActivePrices(rows: PriceRow[]) { PRICES = rows; rebuildPriceIndex(); }
function parsePriceRows(rows: (string | number | null)[][]): PriceRow[] {
  const hi = rows.findIndex((r) => r && r.some((c) => String(c ?? "").trim().toLowerCase() === "product code"));
  const hdr = (hi >= 0 ? rows[hi] : rows[0] || []).map((c) => String(c ?? "").toLowerCase().trim());
  const col = (res: RegExp[]) => { for (let i = 0; i < hdr.length; i++) if (res.some((r) => r.test(hdr[i]))) return i; return -1; };
  const ci = { code: col([/product code/, /^code$/]), name: col([/product name/, /^product$/, /^name$/]), customer: col([/customer/]), unit: col([/unit name/, /^unit$/, /uom/]), rate: col([/sales rate/, /^rate$/, /price/]), wef: col([/w\.?e\.?f/, /effective/]) };
  const out: PriceRow[] = [];
  for (const r of rows.slice((hi >= 0 ? hi : 0) + 1)) {
    if (!r) continue;
    const g = (i: number) => (i >= 0 && i < r.length ? r[i] : null);
    const name = String(g(ci.name) ?? "").trim(); const code = String(g(ci.code) ?? "").trim();
    if (!name && !code) continue;
    const rr = g(ci.rate); const rate = rr != null && String(rr).trim() !== "" ? parseFloat(String(rr).replace(/,/g, "")) : NaN;
    out.push({ code, name, customer: String(g(ci.customer) ?? "").trim(), unit: String(g(ci.unit) ?? "").trim(), rate: isFinite(rate) ? rate : null, wef: String(g(ci.wef) ?? "").trim() });
  }
  return out;
}
function loadStoredPrices(): boolean { try { const raw = window.localStorage.getItem("sf_price_chart"); if (raw) { const r = JSON.parse(raw); if (Array.isArray(r) && r.length) { setActivePrices(r as PriceRow[]); return true; } } } catch { /* ignore */ } return false; }
const wefNum = (w: string) => { const m = (w || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (!m) return 0; const d = +m[1], mo = +m[2]; const yy = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return yy * 10000 + mo * 100 + d; };
function lookupRate(name: string, unit: string, customer?: string): PriceRow | null {
  const n = (name || "").trim().toLowerCase(); const u = (unit || "").trim().toLowerCase();
  if (!n) return null;
  let cands = PRICES.filter((p) => p.rate != null && p.name.trim().toLowerCase() === n && (!u || p.unit.trim().toLowerCase() === u));
  if (!cands.length && u) cands = PRICES.filter((p) => p.rate != null && p.name.trim().toLowerCase() === n);
  if (!cands.length) return null;
  const c = (customer || "").trim().toLowerCase();
  const scored = cands.map((p) => ({ p, cm: c && p.customer && (p.customer.toLowerCase().includes(c) || c.includes(p.customer.toLowerCase().split("-")[0].trim())) ? 1 : 0, w: wefNum(p.wef) }));
  scored.sort((x, y) => (y.cm - x.cm) || (y.w - x.w));
  return scored[0].p;
}

function PriceChartModal({ onClose, onUpdated }: { onClose: () => void; onUpdated?: () => void }) {
  const [q, setQ] = useState("");
  const [ver, setVer] = useState(0);
  const fileRef = useRef<HTMLInputElement | null>(null);
  async function onPriceFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) { return; }
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(await f.arrayBuffer(), { type: "array" });
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "", raw: false, blankrows: false }) as (string | number | null)[][];
      const rows = parsePriceRows(aoa);
      if (!rows.length) { window.alert("Couldn't read any price rows. Make sure the file has Product Code / Product Name / Customer / Unit Name / Sales Rate columns."); return; }
      setActivePrices(rows);
      try { window.localStorage.setItem("sf_price_chart", JSON.stringify(rows)); } catch { /* ignore */ }
      setVer((v) => v + 1); onUpdated?.();
    } catch { window.alert("Couldn't read that file — upload a valid Excel (.xlsx / .xls) or CSV."); } finally { e.target.value = ""; }
  }
  const ql = q.trim().toLowerCase();
  const rows = ql ? PRICES.filter((p) => (p.name + " " + p.code + " " + p.customer + " " + p.unit).toLowerCase().includes(ql)) : PRICES;
  return (
    <div className="overlay show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pmodal">
        <div className="phead">
          <span className="pbadge" style={{ background: "#0284c7", boxShadow: "0 6px 16px rgba(2,132,199,.35)" }}><Icon n="rupee" size={15} /></span>
          <div className="pttl">
            <h2>Sales Price Chart</h2>
            <div className="sub" data-v={ver}>{PRICES.length.toLocaleString("en-IN")} rates · reference for sales order creation</div>
          </div>
          <button className="pmbtn add" style={{ marginRight: 8 }} onClick={() => fileRef.current?.click()}><Icon n="upload" size={14} />Update price chart</button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }} onChange={onPriceFile} />
          <button className="mclose" onClick={onClose}><Icon n="x" size={16} /></button>
        </div>
        <div className="pmsearch">
          <Icon n="search" size={15} />
          <input placeholder="Search product, code, customer or unit…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          <span className="pmcount">{rows.length === PRICES.length ? PRICES.length : `${rows.length} of ${PRICES.length}`} shown</span>
        </div>
        <div className="pmbody">
          <table className="pmtable">
            <thead><tr><th>#</th><th>Code</th><th>Product Name</th><th>Customer Name</th><th>Unit</th><th>Rate</th><th>L1</th><th>L2</th><th>L3</th><th>W.E.F.</th></tr></thead>
            <tbody>
              {rows.map((p, i) => (
                <tr key={p.code + p.unit + p.customer + i}>
                  <td className="n">{i + 1}</td>
                  <td>{p.code || "—"}</td>
                  <td className="nm">{p.name}</td>
                  <td>{p.customer || "—"}</td>
                  <td>{p.unit || "—"}</td>
                  <td className="lv" style={{ textAlign: "right", fontWeight: 700 }}>{p.rate != null ? inr(p.rate) : "—"}</td>
                  {(() => { const lv = productLevels(p.name); const cell = (k: "L1" | "L2" | "L3") => lv && lv[k] ? `${lv[k]!.u} ×${lv[k]!.s}` : "—"; return (<><td className="lv">{cell("L1")}</td><td className="lv">{cell("L2")}</td><td className="lv">{cell("L3")}</td></>); })()}
                  <td>{p.wef || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="pfoot">
          <span className="pstatus ok"><Icon n="shield" size={16} />Read-only reference · used to auto-fill Unit Price when creating an order</span>
          <button className="btn btn-ghost" style={{ padding: "10px 15px" }} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

async function downloadOrderXlsx(o: SalesOrder) {
  try {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    (o.sheets.length ? o.sheets : [{ name: "Sheet1", rows: [] as (string | number | null)[][] }]).forEach((sh, i) => {
      const ws = XLSX.utils.aoa_to_sheet((sh.rows || []) as (string | number | null)[][]);
      XLSX.utils.book_append_sheet(wb, ws, (sh.name || `Sheet${i + 1}`).slice(0, 31));
    });
    const base = (o.name || "sales_order").replace(/\.(xlsx|xls|csv)$/i, "").replace(/[^a-zA-Z0-9._-]+/g, "_") || "sales_order";
    XLSX.writeFile(wb, base + ".xlsx");
  } catch { /* ignore */ }
}

const SO_HEADERS = ["DOC DATE", "PREFIX", "DOC NO", "CUSTOMER NAME", "PRODUCT NAME", "SALES UNITS", "SALES QTY", "UNITS", "QTY", "UNIT PRICE", "VALUE", "TAX", "IMPORT_STATUS", "IMPORT_MESSAGE"];
type SoLine = { product: string; salesUnits: string; salesQty: string; units: string; qty: string; unitPrice: string; value: string; tax: string };
const soBlankLine = (): SoLine => ({ product: "", salesUnits: "Container", salesQty: "", units: "Gms", qty: "", unitPrice: "", value: "", tax: "" });

function dedupeSO(list: SalesOrder[]): SalesOrder[] {
  const seen = new Set<string>(); const out: SalesOrder[] = [];
  for (const o of list) { const k = (o.name || "").trim().toLowerCase(); if (seen.has(k)) continue; seen.add(k); out.push(o); }
  return out;
}

const SO_BASE_UNIT = /^(gms?|grams?|kg|kgs|ml|ltr|l|litres?|liters?)$/i;
function soCustomers(): string[] { return Array.from(new Set(PRICES.map((p) => p.customer).filter(Boolean))).sort(); }
function soProducts(customer: string): string[] { const c = customer.trim().toLowerCase(); return Array.from(new Set(PRICES.filter((p) => p.customer.trim().toLowerCase() === c).map((p) => p.name))).sort(); }
function soPriceInfo(customer: string, product: string): { salesUnit: string; baseUnit: string; unitPrice: number | null } {
  const c = customer.trim().toLowerCase(), n = product.trim().toLowerCase();
  const rows = PRICES.filter((p) => p.customer.trim().toLowerCase() === c && p.name.trim().toLowerCase() === n && p.rate != null);
  if (!rows.length) return { salesUnit: "", baseUnit: "", unitPrice: null };
  const sales = rows.filter((r) => !SO_BASE_UNIT.test(r.unit.trim())).sort((a, b) => wefNum(b.wef) - wefNum(a.wef));
  const base = rows.filter((r) => SO_BASE_UNIT.test(r.unit.trim())).sort((a, b) => wefNum(b.wef) - wefNum(a.wef));
  const su = sales[0] || base[0]; const bu = base[0] || sales[0];
  return { salesUnit: su ? su.unit : "", baseUnit: bu ? bu.unit : "", unitPrice: su && su.rate != null ? su.rate : bu && bu.rate != null ? bu.rate : null };
}
function soPackSize(name: string): number | null {
  const m = name.match(/\(([^)]*)\)\s*$/) || name.match(/\(([^)]*)\)/);
  if (!m) return null;
  const parts = m[1].split("/").map((s) => s.trim());
  const num = (s: string) => { const x = s.match(/([\d.]+)/); return x ? parseFloat(x[1]) : null; };
  if (parts.length >= 2) { const a = num(parts[0]), b = num(parts[1]); if (/pcs|pack|piece|pc\b/i.test(parts[1])) return a != null && b != null ? a * b : null; return b; }
  return num(parts[0]);
}

function SalesOrderCreate({ nextDocNo, onClose, onSave }: { nextDocNo: string; onClose: () => void; onSave: (name: string, sheets: SalesOrder["sheets"]) => void }) {
  const [docDate, setDocDate] = useState("");
  const [prefix, setPrefix] = useState("26-27/");
  const [docNo, setDocNo] = useState(nextDocNo);
  const [customer, setCustomer] = useState("");
  const [lines, setLines] = useState<SoLine[]>([soBlankLine()]);
  const [err, setErr] = useState("");
  const customers = useMemo(() => soCustomers(), []);
  const products = useMemo(() => (customer ? soProducts(customer) : []), [customer]);
  const onCustomer = (v: string) => { setCustomer(v); setLines([soBlankLine()]); };
  const onProduct = (i: number, product: string) => {
    const info = soPriceInfo(customer, product);
    const ps = unitConversion(product, info.salesUnit) ?? soPackSize(product);
    setLines((prev) => prev.map((l, j) => {
      if (j !== i) return l;
      const sq = parseFloat(l.salesQty);
      const lv = productLevels(product);
      const l1u = lv && lv.L1 ? String(lv.L1.u) : (info.baseUnit || l.units);
      const nl: SoLine = { ...l, product, salesUnits: info.salesUnit || l.salesUnits, units: l1u };
      if (ps != null && isFinite(sq)) nl.qty = String(Math.round(sq * ps * 100) / 100);
      return nl;
    }));
  };
  const onSalesQty = (i: number, v: string) => {
    setLines((prev) => prev.map((l, j) => {
      if (j !== i) return l;
      const sq = parseFloat(v); const ps = unitConversion(l.product, l.salesUnits) ?? soPackSize(l.product);
      const nl: SoLine = { ...l, salesQty: v };
      if (ps != null && isFinite(sq)) nl.qty = String(Math.round(sq * ps * 100) / 100);
      return nl;
    }));
  };
  const setField = (i: number, key: keyof SoLine, v: string) => setLines((prev) => prev.map((l, j) => (j === i ? { ...l, [key]: v } : l)));
  const addLine = () => setLines((prev) => [...prev, soBlankLine()]);
  const delLine = (i: number) => setLines((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : prev));
  const fmtDate = (iso: string) => { if (!iso) return ""; const d = new Date(iso + "T00:00:00"); if (isNaN(d.getTime())) return iso; return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`; };
  const lineCount = lines.filter((l) => l.product.trim()).length;
  function build(): (string | number | null)[][] {
    const dd = fmtDate(docDate);
    const rows = lines.filter((l) => l.product.trim()).map((l) => [dd, prefix.trim(), docNo.trim(), customer.trim(), l.product.trim(), l.salesUnits.trim(), l.salesQty.trim(), l.units.trim(), l.qty.trim(), l.unitPrice.trim(), l.value.trim(), l.tax.trim(), "", ""]);
    return [SO_HEADERS, ...rows];
  }
  function submit() {
    if (!customer.trim()) { setErr("Select a customer."); return; }
    if (!docNo.trim()) { setErr("Enter a Doc No."); return; }
    if (!lineCount) { setErr("Add at least one product."); return; }
    setErr("");
    onSave(("Manual SO " + (prefix.trim() + docNo.trim())).trim(), [{ name: "Sales Order", rows: build() }]);
  }
  return (
    <div className="overlay show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pmodal" style={{ maxWidth: 1160 }}>
        <div className="phead">
          <span className="pbadge" style={{ background: "#0284c7", boxShadow: "0 6px 16px rgba(2,132,199,.35)" }}><Icon n="plus" size={15} /></span>
          <div className="pttl">
            <h2>Create a sales order</h2>
            <div className="sub">Pick a customer, then its products. Sales Units, Units (L1) and Converted Qty fill automatically; Unit Price, Value &amp; Tax are left blank and locked.</div>
          </div>
          <button className="mclose" onClick={onClose}><Icon n="x" size={16} /></button>
        </div>
        <div className="pbody">
          <div className="beform">
            <div className="besec">Order details (single document)</div>
            <div className="begrid">
              <label className="befield"><span>Doc Date</span><input type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} /></label>
              <label className="befield"><span>Prefix</span><input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="e.g. 26-27/" /></label>
              <label className="befield"><span>Doc No <small style={{ color: "var(--faint)", fontWeight: 600 }}>(auto · editable)</small></span><input value={docNo} onChange={(e) => setDocNo(e.target.value)} placeholder="e.g. 69" /></label>
              <label className="befield full"><span>Customer Name</span>
                <select value={customer} onChange={(e) => onCustomer(e.target.value)}>
                  <option value="">Select customer…</option>
                  {customers.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            </div>

            <div className="besec">Products{customer ? "" : " — pick a customer first"}</div>
            <div className="beitems">
              <div className="soih">
                <span>Product Name</span><span>Sales Units</span><span>Sales Qty</span><span>Units</span><span>Converted Qty</span><span>Unit Price</span><span>Value</span><span>Tax</span><span></span>
              </div>
              {lines.map((l, i) => (
                <div className="soir" key={i}>
                  <select value={l.product} onChange={(e) => onProduct(i, e.target.value)} disabled={!customer}>
                    <option value="">{customer ? "Select product…" : "Pick customer first"}</option>
                    {products.map((pn) => <option key={pn} value={pn}>{pn}</option>)}
                  </select>
                  <input value={l.salesUnits} onChange={(e) => setField(i, "salesUnits", e.target.value)} placeholder="Container" />
                  <input value={l.salesQty} onChange={(e) => onSalesQty(i, e.target.value)} inputMode="decimal" placeholder="0" />
                  <input value={l.units} onChange={(e) => setField(i, "units", e.target.value)} placeholder="Gms" />
                  <input value={l.qty} onChange={(e) => setField(i, "qty", e.target.value)} inputMode="decimal" placeholder="0" />
                  <input className="frozen" value={l.unitPrice} readOnly tabIndex={-1} placeholder="—" title="From price chart (locked)" />
                  <input className="frozen" value={l.value} readOnly tabIndex={-1} placeholder="—" title="Sales Qty × Unit Price (locked)" />
                  <input className="frozen" value={l.tax} readOnly tabIndex={-1} placeholder="—" title="Locked" />
                  <button className="bex" title="Remove line" onClick={() => delLine(i)} disabled={lines.length === 1}><Icon n="x" size={13} /></button>
                </div>
              ))}
              <button className="beadd" onClick={addLine} disabled={!customer}><Icon n="plus" size={13} />Add product line</button>
            </div>
          </div>
        </div>
        <div className="pfoot">
          <span className="pstatus ok"><Icon n="file" size={16} />{lineCount} product{lineCount === 1 ? "" : "s"} · Doc {prefix.trim()}{docNo.trim() || "—"}{customer ? " · " + customer : ""}</span>
          {err && <span className="pstatus err" style={{ marginLeft: 8 }}><Icon n="alert" size={16} />{err}</span>}
          <button className="btn btn-ghost" style={{ padding: "10px 15px" }} onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" style={{ padding: "10px 15px" }} onClick={submit}><Icon n="plus" size={14} />Create sales order</button>
        </div>
      </div>
    </div>
  );
}

function soCol(headers: (string | number | null)[], res: RegExp[]): number {
  for (let i = 0; i < headers.length; i++) {
    const h = String(headers[i] ?? "").toLowerCase().replace(/[_\s]+/g, " ").trim();
    if (res.some((r) => r.test(h))) return i;
  }
  return -1;
}
function analyzeSO(o: SalesOrder) {
  const sheet = o.sheets[0] || { name: "", rows: [] };
  const headers = sheet.rows[0] || [];
  const body = sheet.rows.slice(1).filter((r) => r.some((c) => String(c ?? "").trim() !== ""));
  const cDate = soCol(headers, [/doc ?date/, /^date$/, /order date/]);
  const cDoc = soCol(headers, [/doc ?(no|number|num)/, /document no/]);
  const cCust = soCol(headers, [/customer/, /party/, /consignee/, /buyer/]);
  const cProduct = soCol(headers, [/product/, /item name/, /^item$/]);
  const cStatus = soCol(headers, [/import ?status/, /^status$/]);
  const cMsg = soCol(headers, [/import ?message/, /message/, /remark/, /reason/]);
  const vAt = (r: (string | number | null)[], c: number) => (c >= 0 ? String(r[c] ?? "").trim() : "");
  const uniq = (c: number) => Array.from(new Set(body.map((r) => vAt(r, c)).filter(Boolean)));
  const docs = uniq(cDoc);
  const custs = uniq(cCust);
  const statuses = body.map((r) => vAt(r, cStatus)).filter(Boolean);
  const passN = statuses.filter((s) => /pass|success|imported|ok/i.test(s)).length;
  const dateTxt = cDate >= 0 && body[0] ? vAt(body[0], cDate) : "";
  return { headers, body, cDate, cDoc, cCust, cProduct, cStatus, cMsg, docs, custs, statuses, passN, dateTxt, vAt };
}

function ordersByDoc(a: ReturnType<typeof analyzeSO>) {
  const map = new Map<string, { docNo: string; customer: string; lines: number; statuses: string[] }>();
  a.body.forEach((r) => {
    const doc = a.vAt(r, a.cDoc) || "—";
    const cust = a.vAt(r, a.cCust);
    const st = a.vAt(r, a.cStatus);
    let g = map.get(doc);
    if (!g) { g = { docNo: doc, customer: cust, lines: 0, statuses: [] }; map.set(doc, g); }
    g.lines++; if (!g.customer && cust) g.customer = cust; if (st) g.statuses.push(st);
  });
  return Array.from(map.values()).map((g) => ({ ...g, passN: g.statuses.filter((x) => /pass|success|imported|ok/i.test(x)).length }));
}

function SalesOrderDetail({ order, exported }: { order: SalesOrder; exported: boolean }) {
  const a = analyzeSO(order);
  const docs = ordersByDoc(a);
  return (
    <div className="sodetail-wrap">
      <table className="sodetail">
        <thead><tr><th>Doc No</th><th>Customer Name</th><th>Import Status</th></tr></thead>
        <tbody>
          {docs.map((d, di) => {
            const cls = d.statuses.length === 0 ? "pending" : d.statuses.some((x) => !/pass|success|imported|ok/i.test(x)) ? "fail" : "ok";
            return (
              <tr key={di}>
                <td className="dn">{d.docNo}</td>
                <td>{d.customer || "—"}</td>
                <td>{cls === "ok" ? <span className="pill ok"><Icon n="check" size={11} />Imported</span> : cls === "fail" ? <span className="pill err"><Icon n="alert" size={11} />Failed</span> : exported ? <span className="pill mut"><Icon n="upload" size={11} />Awaiting import</span> : <span className="pill mut">Not exported</span>}</td>
              </tr>
            );
          })}
          {!docs.length && <tr><td colSpan={3} className="pmmore" style={{ textAlign: "center" }}>No documents in this order.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function SalesPage({ orders, onUpload, supaOk, exportedIds, onExport }: { orders: SalesOrder[]; onUpload: () => void; supaOk: boolean; exportedIds: Set<string>; onExport: (o: SalesOrder) => void }) {
  const [viewId, setViewId] = useState<string | null>(null);
  const [statusId, setStatusId] = useState<string | null>(null);
  const fmtDate = (t: number) => { try { return new Date(t).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }); } catch { return ""; } };
  if (orders.length === 0) {
    return (
      <div className="content salespage">
        <div className="sonone big">
          <Icon n="file" size={44} />
          <span>No sales orders yet</span>
          <small>Upload a sales order Excel or CSV. Each file appears here as a row you can View or run a Status check on, and it&rsquo;s saved to your database{supaOk ? "" : " (running on local storage until Supabase is connected)"}.</small>
          <button className="btn btn-print" style={{ padding: "11px 18px", marginTop: 4 }} onClick={onUpload}><Icon n="upload" size={15} />Upload Sales Order</button>
        </div>
      </div>
    );
  }
  const viewOrder = orders.find((o) => o.id === viewId) || null;
  const statusOrder = orders.find((o) => o.id === statusId) || null;
  return (
    <div className="content salespage">
      <div className="panel">
        <div className="panelbar">
          <h2>Sales Orders</h2>
          <div className="ghost" style={{ marginLeft: "auto", cursor: "default" }}>{orders.length} order file{orders.length === 1 ? "" : "s"}{supaOk ? " · saved to database" : ""}</div>
        </div>
        <div className="thead">
          <span className="c-date">Date</span>
          <span className="c-v">Sales order</span>
          <span className="c-inv">Doc No</span>
          <span className="c-items">Line items</span>
          <span className="c-verify">Import status</span>
          <span className="c-act">Actions</span>
        </div>
        <div id="list">
          {orders.map((o, oi) => {
            const a = analyzeSO(o);
            const cust = a.custs.length <= 1 ? (a.custs[0] || `${a.body.length} rows`) : `${a.custs.length} customers`;
            const docTxt = a.docs.length === 1 ? a.docs[0] : a.docs.length === 0 ? "—" : `${a.docs.length} docs`;
            const dgArr = ordersByDoc(a);
            const dgOk = dgArr.filter((d) => d.statuses.length && !d.statuses.some((x) => !/pass|success|imported|ok/i.test(x))).length;
            const dgAny = dgArr.some((d) => d.statuses.length);
            const prodNames = Array.from(new Set(a.body.map((r) => a.vAt(r, a.cProduct)).filter(Boolean)));
            const unmatched = prodNames.filter((pn) => !inPriceChart(pn)).length;
            return (
              <div key={o.id} className="soblock">
                <div className="row" style={{ cursor: "default" }}>
                <span className="c-date">{a.dateTxt || fmtDate(o.at)}</span>
                <span className="c-v">
                  <span className="mono" style={{ background: MC[oi % MC.length] }}>{initials(a.custs[0] || o.name)}</span>
                  <span className="vmeta">
                    <span className="vname">{o.name}</span>
                    <span className="vsub">{cust}</span>
                    {unmatched > 0 && <span className="sowarn"><Icon n="alert" size={11} />{unmatched} product{unmatched === 1 ? "" : "s"} not in price chart</span>}
                  </span>
                </span>
                <span className="c-inv">{docTxt}</span>
                <span className="c-items"><span className="itcount">{a.body.length}</span></span>
                <span className="c-verify">
                  {!dgAny
                    ? (exportedIds.has(o.id) ? <span className="pill mut"><Icon n="upload" size={12} />Awaiting import</span> : <span className="pill mut">Not exported</span>)
                    : dgOk === dgArr.length
                      ? <span className="pill ok"><Icon n="check" size={12} />Imported {dgOk}/{dgArr.length}</span>
                      : <span className="pill err"><Icon n="alert" size={12} />{dgOk}/{dgArr.length} imported</span>}
                </span>
                <span className="c-act">
                  <button className="btn btn-primary" title="Create the Excel and export this order to PACT" onClick={() => onExport(o)}><Icon n="upload" size={14} />Export to PACT</button>
                  <button className="btn btn-ghost" title="Download this order as Excel (FSALES format)" onClick={() => downloadOrderXlsx(o)}><Icon n="download" size={14} />Excel</button>
                  <button className="btn btn-ghost" onClick={() => setViewId(o.id)}><Icon n="eye" size={14} />View</button>
                  <button className={"btn " + (exportedIds.has(o.id) ? "btn-primary" : "btn-ghost")} disabled={!exportedIds.has(o.id)} title={exportedIds.has(o.id) ? "Check PACT import status" : "Export to PACT first to enable"} onClick={() => { if (exportedIds.has(o.id)) setStatusId(o.id); }}><Icon n="checkCircle" size={14} />Status check</button>
                </span>
                </div>
                <SalesOrderDetail order={o} exported={exportedIds.has(o.id)} />
              </div>
            );
          })}
        </div>
      </div>
      {viewOrder && <SalesOrderView order={viewOrder} onClose={() => setViewId(null)} />}
      {statusOrder && <SalesOrderStatus order={statusOrder} onClose={() => setStatusId(null)} />}
    </div>
  );
}

function SalesOrderView({ order, onClose }: { order: SalesOrder; onClose: () => void }) {
  const [si, setSi] = useState(0);
  const sheet = order.sheets[si] || order.sheets[0] || { name: "", rows: [] };
  const headers = sheet.rows[0] || [];
  const body = sheet.rows.slice(1);
  const cols = Math.max(headers.length, ...body.map((r) => r.length), 1);
  const idx = Array.from({ length: cols }, (_, i) => i);
  const prodCol = soCol(headers, [/product/, /item name/, /^item$/]);
  return (
    <div className="overlay show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pmodal" style={{ maxWidth: 1200 }}>
        <div className="phead">
          <span className="pbadge" style={{ background: "#16a34a", boxShadow: "0 6px 16px rgba(22,163,74,.35)" }}><Icon n="file" size={15} /></span>
          <div className="pttl"><h2>{order.name}</h2><div className="sub">{body.length} row{body.length === 1 ? "" : "s"} · {headers.length} column{headers.length === 1 ? "" : "s"}</div></div>
          <button className="mclose" onClick={onClose}><Icon n="x" size={16} /></button>
        </div>
        {order.sheets.length > 1 && (
          <div className="sotabs" style={{ padding: "10px 20px 0" }}>
            {order.sheets.map((sh, i) => <button key={i} className={"tab" + (i === si ? " active" : "")} onClick={() => setSi(i)}>{sh.name || `Sheet ${i + 1}`}</button>)}
          </div>
        )}
        <div className="pbody">
          <div className="sowrap full">
            <table className="lbltbl sotbl">
              <thead><tr><th className="sonum">#</th>{idx.map((c) => <th key={c}>{String(headers[c] ?? "")}</th>)}</tr></thead>
              <tbody>{body.map((r, ri) => <tr key={ri}><td className="sonum">{ri + 1}</td>{idx.map((c) => { const v = String(r[c] ?? ""); const bad = c === prodCol && v.trim() !== "" && !inPriceChart(v); return <td key={c} className={bad ? "nomatch" : ""} title={bad ? "Not found in price chart" : undefined}>{v}</td>; })}</tr>)}</tbody>
            </table>
            {!body.length && <div className="pmmore">No data rows found in this sheet.</div>}
          </div>
        </div>
        <div className="pfoot"><button className="btn btn-ghost" style={{ padding: "10px 15px" }} onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

function SalesOrderStatus({ order, onClose }: { order: SalesOrder; onClose: () => void }) {
  const a = analyzeSO(order);
  return (
    <div className="overlay show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pmodal" style={{ maxWidth: 960 }}>
        <div className="phead">
          <span className="pbadge" style={{ background: "#0284c7", boxShadow: "0 6px 16px rgba(2,132,199,.35)" }}><Icon n="checkCircle" size={15} /></span>
          <div className="pttl"><h2>Import status — {order.name}</h2><div className="sub">{a.passN}/{a.statuses.length || a.body.length} line{(a.statuses.length || a.body.length) === 1 ? "" : "s"} passed{a.docs.length ? (a.docs.length === 1 ? ` · Doc ${a.docs[0]}` : ` · ${a.docs.length} docs`) : ""}</div></div>
          <button className="mclose" onClick={onClose}><Icon n="x" size={16} /></button>
        </div>
        <div className="pbody">
          <div className="sowrap full">
            <table className="lbltbl sotbl">
              <thead><tr><th className="sonum">#</th><th>Doc No</th><th>Customer</th><th>Product</th><th>Import status</th><th>Message</th></tr></thead>
              <tbody>
                {a.body.map((r, ri) => {
                  const st = a.vAt(r, a.cStatus);
                  const ok = /pass|success|imported|ok/i.test(st);
                  return (
                    <tr key={ri}>
                      <td className="sonum">{ri + 1}</td>
                      <td>{a.vAt(r, a.cDoc) || "—"}</td>
                      <td>{a.vAt(r, a.cCust) || "—"}</td>
                      <td>{a.vAt(r, a.cProduct) || "—"}</td>
                      <td>{st ? <span className={"pill " + (ok ? "ok" : "err")}>{ok ? <Icon n="check" size={12} /> : <Icon n="alert" size={12} />}{st}</span> : <span className="pill mut">Pending</span>}</td>
                      <td>{a.vAt(r, a.cMsg) || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!a.body.length && <div className="pmmore">No data rows found.</div>}
          </div>
        </div>
        <div className="pfoot">
          <span className="pstatus ok"><Icon n="file" size={16} />Status read from the uploaded file</span>
          <button className="btn btn-primary" disabled title="Live PACT import check will be wired next"><Icon n="download" size={14} />Re-check from PACT</button>
          <button className="btn btn-ghost" style={{ padding: "10px 15px" }} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

type DraftItem = { name: string; hsn: string; qty: string; uom: string; price: string; rate: string };
type DraftCharge = { label: string; amount: string };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function BillEntry({ nextId, onClose, onSave }: { nextId: number; onClose: () => void; onSave: (b: Bill) => void }) {
  const [vendor, setVendor] = useState("");
  const [vendorGst, setVendorGst] = useState("");
  const [invoice, setInvoice] = useState("");
  const [dateStr, setDateStr] = useState("");
  const [buyer, setBuyer] = useState(BUYER_NAME);
  const [buyerGst, setBuyerGst] = useState(BUYER_GST);
  const [roundOff, setRoundOff] = useState("0");
  const [note, setNote] = useState("");
  const [items, setItems] = useState<DraftItem[]>([{ name: "", hsn: "", qty: "1", uom: "Nos", price: "", rate: "5" }]);
  const [charges, setCharges] = useState<DraftCharge[]>([]);
  const [err, setErr] = useState("");
  const [mode, setMode] = useState<"pdf" | "manual">("pdf");
  const [scanUrl, setScanUrl] = useState("");
  const [scanName, setScanName] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function onScan(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) await handleScan(file);
    if (fileRef.current) fileRef.current.value = "";
  }
  async function handleScan(file: File) {
    setErr(""); setBusy(true); setScanName(file.name);
    try {
      if (!supabase) { setErr("Supabase isn't connected, so the scan can't be saved. Enter the bill manually instead."); setBusy(false); return; }
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `bills/${Date.now()}_${safe}`;
      const up = await supabase.storage.from("scans").upload(path, file, { upsert: true, contentType: file.type || undefined });
      if (up.error) { setErr("Couldn't save the scan (" + up.error.message + "). Run the one-time 'scans' storage setup, or enter the bill manually."); setBusy(false); return; }
      const url = supabase.storage.from("scans").getPublicUrl(path).data.publicUrl;
      setScanUrl(url);
      const r = await fetch("/api/extract-bill", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fileUrl: url }) });
      const j = await r.json().catch(() => null);
      if (!j || !j.ok) {
        setErr(j?.reason === "not_configured"
          ? "AI reading isn't set up yet (add the Gemini key the stamp-check uses). The scan is saved — fill the fields below and Add."
          : "Couldn't read the scan automatically. The scan is saved — fill the fields below and Add.");
        setBusy(false); return;
      }
      applyExtract(j.bill);
    } catch (e2) {
      setErr("Upload failed: " + String(e2).slice(0, 140));
    } finally {
      setBusy(false);
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function applyExtract(x: any) {
    if (!x) return;
    if (x.vendor) setVendor(String(x.vendor));
    if (x.vendorGst) setVendorGst(String(x.vendorGst));
    if (x.invoice) setInvoice(String(x.invoice));
    if (x.invoiceDate && /^\d{4}-\d{2}-\d{2}/.test(String(x.invoiceDate))) setDateStr(String(x.invoiceDate).slice(0, 10));
    if (x.buyer) setBuyer(String(x.buyer));
    if (x.buyerGst) setBuyerGst(String(x.buyerGst));
    if (x.roundOff != null && x.roundOff !== "") setRoundOff(String(x.roundOff));
    if (Array.isArray(x.items) && x.items.length) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setItems(x.items.map((it: any) => ({ name: String(it.name ?? ""), hsn: String(it.hsn ?? ""), qty: String(it.qty ?? 1), uom: String(it.uom ?? "Nos"), price: it.price == null ? "" : String(it.price), rate: String(it.rate ?? 5) })));
    }
    if (Array.isArray(x.otherCharges) && x.otherCharges.length) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setCharges(x.otherCharges.map((c: any) => ({ label: String(c.label ?? ""), amount: String(c.amount ?? 0) })));
    }
  }

  const num = (v: string) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const line = (it: DraftItem) => { const net = num(it.qty) * num(it.price); const gst = net * num(it.rate) / 100; return { net, gst, gross: net + gst }; };
  const taxable = items.reduce((s, it) => s + line(it).net, 0);
  const gstTotal = items.reduce((s, it) => s + line(it).gst, 0);
  const chargeTotal = charges.reduce((s, c) => s + num(c.amount), 0);
  const grandTotal = taxable + gstTotal + num(roundOff) + chargeTotal;

  const setItem = (i: number, patch: Partial<DraftItem>) => setItems((prev) => prev.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  const addItem = () => setItems((prev) => [...prev, { name: "", hsn: "", qty: "1", uom: "Nos", price: "", rate: "5" }]);
  const delItem = (i: number) => setItems((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : prev));
  const setCharge = (i: number, patch: Partial<DraftCharge>) => setCharges((prev) => prev.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  function build(): Bill {
    const d = dateStr ? new Date(dateStr + "T00:00:00") : null;
    const dd = d ? String(d.getDate()).padStart(2, "0") : "";
    const mon = d ? MONTHS[d.getMonth()] : "";
    const yr = d ? d.getFullYear() : "";
    return {
      id: nextId,
      vendor: vendor.trim(),
      vendorGst: vendorGst.trim(),
      invoice: invoice.trim(),
      date: d ? `${Number(dd)} ${mon}` : "",
      dateFull: d ? `${dd}-${mon}-${yr}` : "",
      buyer: buyer.trim(),
      buyerGst: buyerGst.trim(),
      taxable: Math.round(taxable * 100) / 100,
      gstTotal: Math.round(gstTotal * 100) / 100,
      roundOff: num(roundOff),
      grandTotal: Math.round(grandTotal * 100) / 100,
      otherCharges: charges.filter((c) => c.label.trim() || num(c.amount)).map((c) => ({ label: c.label.trim(), amount: num(c.amount) })),
      note: note.trim() || undefined,
      scanUrl: scanUrl || undefined,
      items: items.map((it) => { const l = line(it); return { name: it.name.trim(), hsn: it.hsn.trim(), qty: num(it.qty), uom: it.uom.trim() || "Nos", price: it.price === "" ? null : num(it.price), net: Math.round(l.net * 100) / 100, taxRate: `${num(it.rate)}%`, gst: Math.round(l.gst * 100) / 100, gross: Math.round(l.gross * 100) / 100, uploaded: false }; }),
      voided: false,
    };
  }

  const preview = build();
  const check = validate(preview);

  function submit() {
    if (!vendor.trim()) { setErr("Enter the vendor name."); return; }
    if (!invoice.trim()) { setErr("Enter the invoice number."); return; }
    if (!dateStr) { setErr("Pick the invoice date."); return; }
    if (!items.some((it) => it.name.trim())) { setErr("Add at least one line item with a product name."); return; }
    setErr("");
    onSave(build());
  }

  return (
    <div className="overlay show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pmodal" style={{ maxWidth: 1080 }}>
        <div className="phead">
          <span className="pbadge" style={{ background: "#0284c7", boxShadow: "0 6px 16px rgba(2,132,199,.35)" }}><Icon n="upload" size={15} /></span>
          <div className="pttl">
            <h2>Add a bill</h2>
            <div className="sub">Enter a bill manually — it joins the Invoice Inbox and runs the same 3 checks &amp; Upload-to-PACT flow.</div>
          </div>
          <button className="mclose" onClick={onClose}><Icon n="x" size={16} /></button>
        </div>
        <div className="pbody">
          <div className="bemodes">
            <button className={"bemode" + (mode === "pdf" ? " active" : "")} onClick={() => setMode("pdf")}><Icon n="upload" size={14} />Upload scan (PDF / image)</button>
           </div>
          {mode === "pdf" && (
            <div className={"bedrop" + (busy ? " busy" : "") + (scanUrl && !busy ? " done" : "")} onClick={() => { if (!busy) fileRef.current?.click(); }}>
              <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" style={{ display: "none" }} onChange={onScan} />
              {busy ? (
                <><span className="bespin" /><b>Reading {scanName}…</b><small>Uploading the scan and extracting the bill with AI — this can take a few seconds.</small></>
              ) : scanUrl ? (
                <><Icon n="checkCircle" size={26} /><b>Scan attached{scanName ? " · " + scanName : ""}</b><small>The fields below were auto-filled — review &amp; edit them, then Add. Click here to replace the scan.</small></>
              ) : (
                <><Icon n="upload" size={26} /><b>Click to upload the scanned bill</b><small>PDF, JPG or PNG. It&rsquo;s read automatically, saved with the bill, and runs the same checks.</small></>
              )}
            </div>
          )}
          <div className="beform">
            <div className="besec">Bill details</div>
            <div className="begrid">
              <label className="befield"><span>Vendor name</span><input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="e.g. Wonder Packagings" /></label>
              <label className="befield"><span>Vendor GSTIN</span><input value={vendorGst} onChange={(e) => setVendorGst(e.target.value)} placeholder="e.g. 09AABC...1ZL" /></label>
              <label className="befield"><span>Invoice number</span><input value={invoice} onChange={(e) => setInvoice(e.target.value)} placeholder="e.g. GST-454/2026-27" /></label>
              <label className="befield"><span>Invoice date</span><input type="date" value={dateStr} onChange={(e) => setDateStr(e.target.value)} /></label>
              <label className="befield"><span>Billed to (buyer)</span><input value={buyer} onChange={(e) => setBuyer(e.target.value)} /></label>
              <label className="befield"><span>Buyer GSTIN</span><input value={buyerGst} onChange={(e) => setBuyerGst(e.target.value)} /></label>
            </div>

            <div className="besec">Line items</div>
            <div className="beitems">
              <div className="beih">
                <span>Product name</span><span>HSN</span><span>Qty</span><span>Unit</span><span>Price</span><span>GST %</span><span>Net</span><span></span>
              </div>
              {items.map((it, i) => {
                const l = line(it);
                return (
                  <div className="beir" key={i}>
                    <input value={it.name} onChange={(e) => setItem(i, { name: e.target.value })} placeholder="Product name" list="be-products" />
                    <input value={it.hsn} onChange={(e) => setItem(i, { hsn: e.target.value })} placeholder="HSN" />
                    <input value={it.qty} onChange={(e) => setItem(i, { qty: e.target.value })} inputMode="decimal" />
                    <input value={it.uom} onChange={(e) => setItem(i, { uom: e.target.value })} list="be-units" />
                    <input value={it.price} onChange={(e) => setItem(i, { price: e.target.value })} inputMode="decimal" placeholder="0.00" />
                    <input value={it.rate} onChange={(e) => setItem(i, { rate: e.target.value })} inputMode="decimal" />
                    <span className="benet">{inr(l.net)}</span>
                    <button className="bex" title="Remove line" onClick={() => delItem(i)} disabled={items.length === 1}><Icon n="x" size={13} /></button>
                  </div>
                );
              })}
              <datalist id="be-units">{ALL_UNITS.map((u) => <option key={u} value={u} />)}</datalist>
              <datalist id="be-products">{CATALOG.slice(0, 400).map((p) => <option key={p.name} value={p.name} />)}</datalist>
              <button className="beadd" onClick={addItem}><Icon n="plus" size={13} />Add line item</button>
            </div>

            {charges.length > 0 && (
              <>
                <div className="besec">Other charges</div>
                <div className="beitems">
                  {charges.map((c, i) => (
                    <div className="becr" key={i}>
                      <input value={c.label} onChange={(e) => setCharge(i, { label: e.target.value })} placeholder="e.g. Freight" />
                      <input value={c.amount} onChange={(e) => setCharge(i, { amount: e.target.value })} inputMode="decimal" placeholder="0.00" />
                      <button className="bex" title="Remove charge" onClick={() => setCharges((prev) => prev.filter((_, j) => j !== i))}><Icon n="x" size={13} /></button>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="betotals">
              <button className="beadd ghost" onClick={() => setCharges((prev) => [...prev, { label: "", amount: "" }])}><Icon n="plus" size={13} />Add other charge</button>
              <div className="spacer" />
              <label className="befield sm"><span>Round off</span><input value={roundOff} onChange={(e) => setRoundOff(e.target.value)} inputMode="decimal" /></label>
              <div className="besum">
                <div><span>Taxable</span><b>{inr(taxable)}</b></div>
                <div><span>GST</span><b>{inr(gstTotal)}</b></div>
                <div className="gt"><span>Grand total</span><b>{inr(grandTotal)}</b></div>
              </div>
            </div>

            <label className="befield full"><span>Note (optional)</span><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything to flag for review" /></label>
          </div>
        </div>
        <div className="pfoot">
          <span className={"pstatus " + (check.status === "OK" ? "ok" : "err")}>
            <Icon n={check.status === "OK" ? "checkCircle" : "alert"} size={16} />
            {check.status === "OK" ? "Passes all 3 checks — will show as Verified" : "Will show as Needs review — " + (check.checks.find((c) => c.status === "fail")?.label || "check the totals")}
          </span>
          {err && <span className="pstatus err" style={{ marginLeft: 8 }}><Icon n="alert" size={16} />{err}</span>}
          <button className="btn btn-ghost" style={{ padding: "10px 15px" }} onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" style={{ padding: "10px 15px" }} onClick={submit}><Icon n="plus" size={14} />Add bill to dashboard</button>
        </div>
      </div>
    </div>
  );
}

const FLOW_ARCH: string[] = [
  "1) A supplier bill arrives and AI reads it into line items, which land in the Invoice Inbox (stored in our database).",
  "2) You open Upload to PACT, confirm the party, products, units, quantities and manufactured dates, then click Confirm & Push.",
  "3) That does NOT click PACT directly. It saves a job in the database and signals GitHub to run the automation.",
  "4) GitHub Actions starts a cloud computer, opens PACT in a headless (invisible) Chrome, and a Playwright script performs every click and keystroke exactly as a person would.",
  "5) When done, the script checks that PACT shows Posted, and writes the full step-log back to the database so you can see the result on the dashboard — no need to open GitHub.",
];

const FLOW_STEPS: { n: number; dash: { t: string; d: string }; pact: { t: string; d: string }; how: string; notes: string[] }[] = [
  {
    n: 1,
    dash: { t: "Bill lands in the Invoice Inbox", d: "The supplier bill is read by AI into structured line items and appears in the inbox. Three checks run — receiving stamp, buyer GST, and totals — and it shows OK or Needs review." },
    pact: { t: "(nothing yet)", d: "PACT is not touched until you push." },
    how: "How it works: the bill image is sent to a vision-AI endpoint (/api/extract-bill) that returns the line items as JSON, and a second endpoint (/api/verify-stamp) checks the stamp. The result is saved in the bills table in Supabase (our database).",
    notes: [
      "Only bills marked OK can be pushed to PACT.",
      "If extraction failed (AI busy), the bill shows an error — re-upload or retry.",
    ],
  },
  {
    n: 2,
    dash: { t: 'Click "Upload to Pact"', d: "Opens the Upload-to-PACT panel with each line item already matched against the PACT item master (product list)." },
    pact: { t: "(preparing)", d: "Nothing is posted yet — this is the review screen where you confirm everything before it goes to PACT." },
    how: "How it works: matching happens inside the browser against pact-catalog.json — a copy of the PACT product master (2,176 products, each with its PACT code). No PACT connection is made at this stage.",
    notes: [
      'A frozen "Uploaded to Pact · View" button means the bill was already pushed (read-only).',
      "To redo an already-pushed bill, it must be unlocked first.",
    ],
  },
  {
    n: 3,
    dash: { t: "Party Name (supplier)", d: 'Auto-matched from the PACT supplier master — GSTIN first, then name. The "· PACT master" tag confirms it is the master name, not the bill wording. Fix it with the search dropdown if wrong.' },
    pact: { t: "Vendor field (#100)", d: "Playwright types the first few letters of the supplier, waits for PACT's type-ahead dropdown to appear, and clicks the matching supplier." },
    how: "How it works: Playwright targets the vendor input by its id (#100) and types character-by-character using pressSequentially(). Real key events are required because PACT is an Angular app whose dropdown only appears in response to keydown/input events — a plain paste or .fill() sets the text without firing them, so no dropdown shows. Playwright then scores each suggestion in .List__dropdown--suggestions by word overlap and clicks the best match.",
    notes: [
      "The supplier must exist in PACT's ledger, or it fails with \"vendor not matched\".",
      "Matching ignores suffixes like Pvt/Ltd and punctuation, so small spelling differences still match.",
    ],
  },
  {
    n: 4,
    dash: { t: "Product Name", d: 'Each line is the PACT master product, shown with its code, e.g. "1 Kg LD Pouch (270×200)mm (RM0388)". You can search by name OR code.' },
    pact: { t: "Product Name grid cell", d: "Playwright opens the Product Name cell in the item grid, types the product CODE, and picks the matching product." },
    how: "How it works: the grid is a SlickGrid. Playwright clicks the Product Name cell (found via its column marker aria-describedby$=\"ProductName\") to open its inline editor, then types the code (e.g. RM0388) with real keystrokes. We use the CODE, not the name, because product names contain the × sign and brackets that break PACT's text lookup — the code is unique and plain, so it matches every time.",
    notes: [
      "Sending the code avoids the × / bracket problem entirely.",
      "If a product ever fails, it means that code is missing from the PACT item master.",
    ],
  },
  {
    n: 5,
    dash: { t: "Unit & quantities", d: "Pick the Purchase Unit. Purchase Quantity is read-only; Receipt Quantity = Packing Size × Purchase Qty, and everything is pushed at level L1 (the base unit)." },
    pact: { t: "Unit level + Approve Qty", d: "Playwright sets Purchase Unit Level = L1 from the row's dropdown, then types the Approve Qty equal to the Receipt Qty into the numeric cell and commits it." },
    how: "How it works: the unit-level cell holds a native <select>, so Playwright uses selectOption('L1'). The quantity cell opens a text editor (input.PactTextBoxEditor); Playwright fills it and presses Enter to commit. Approve Qty MUST equal Receipt Qty, otherwise PACT records the line as 0.",
    notes: [
      "All quantities are sent at the L1 (base) level to keep PACT consistent.",
    ],
  },
  {
    n: 6,
    dash: { t: "Manufactured date / batch", d: "Set the Manufactured Date for each batch (use Split if one line has multiple batches)." },
    pact: { t: '"Generate Batch Numbers" box', d: "Playwright presses Enter on Approve Qty, then Enter on Base Qty — that keystroke opens the batch box. It sets the Manufactured Date, clicks Save & Add, selects the created batch, sets its quantity, then Save." },
    how: "How it works: the batch box is opened by the Enter key inside the grid (there is no button for it) — that is why the exact key sequence matters. The date uses PACT's calendar widget (app-pactextradatepicker); rather than typing (which is fussy about format and spaces), Playwright opens the calendar and clicks the day number. Expiry and quantity auto-fill inside PACT; we only supply the manufactured date.",
    notes: [
      "Expiry is auto-calculated by PACT — we never type it.",
      "The batch box only opens once a product is actually selected in the row.",
    ],
  },
  {
    n: 7,
    dash: { t: 'Click "Confirm & Push to PACT"', d: "Queues the job and hands it to the background automation — you do not have to sit and watch PACT." },
    pact: { t: "Login → Stock Inward → Post", d: 'Playwright logs in (button labelled "Select"), opens Flows → Stock Inward, sets the location (Factory), fills vendor, bill no and bill date, adds the products and batches, then clicks Post.' },
    how: "How it works: Confirm & Push sends the bill to /api/push-to-pact, which inserts a row in the pact_jobs table and fires a GitHub repository_dispatch event. The push-to-pact GitHub Actions workflow then runs scripts/run-pact-job.js on a cloud machine with headless Chromium driven by Playwright, using the PACT login stored in GitHub secrets. The login button's accessible name is \"Select\" and the page has no real <form>, so Playwright clicks #btnLogn and submits directly.",
    notes: [
      "A Voucher Prefix / Location popup asks for the location = Factory first.",
      "The old Goods Gate Entry step was removed — this is Stock-Inward only.",
    ],
  },
  {
    n: 8,
    dash: { t: "Result on the dashboard", d: 'The bill flips to "Uploaded to Pact" and its items are marked uploaded.' },
    pact: { t: "Voucher shows Posted", d: 'The Stock Inward voucher shows the green "Posted" badge in PACT.' },
    how: "How it works: before declaring success, the script reads PACT's screen and confirms the word Posted is present. It then writes status (done/failed) plus the full step-by-step log back into the pact_jobs table, so any failure and its exact reason are visible from the database — no need to open GitHub.",
    notes: [
      "The step log names the exact step that failed, which makes fixing fast.",
    ],
  },
];

const FLOW_GOTCHAS: string[] = [
  "Real keystrokes, not paste: PACT's dropdowns only appear on real key events, so Playwright types character-by-character instead of pasting.",
  "Match products by CODE: names contain × and brackets that break PACT's search; the code (e.g. RM0388) is unique and plain, so it always matches.",
  "Dates via the calendar: PACT's date field is fussy about format and spaces, so Playwright opens the calendar and clicks the day instead of typing.",
  "The batch box opens on Enter: Approve Qty → Enter → Enter on Base Qty. There is no button for it, so the key sequence is exact by design.",
  "Approve Qty must equal Receipt Qty, or PACT records the line as 0.",
  "Two different actions: double-click _pushx.bat to DEPLOY code changes; the dashboard Confirm & Push TRIGGERS the actual PACT posting.",
  'GitHub shows "done" but nothing in PACT? Open the step log for that job (stored in the database) — it names the exact step that failed.',
  "Timeouts: the background job caps at 25 minutes and each single click fails after 20 seconds, so it never hangs silently.",
  "Vendor / product not found is almost always a master-data gap in PACT (add it there and retry), not a dashboard bug.",
];

function PactFlowDoc({ onClose }: { onClose: () => void }) {
  return (
    <div className="overlay show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pmodal flowmodal">
        <div className="phead">
          <span className="pbadge"><Icon n="file" size={15} /></span>
          <div className="pttl">
            <h2>PACT Flow Guide</h2>
            <div className="sub">How the dashboard and PACT work together — the steps, and the logic behind each one — for anyone on the team.</div>
          </div>
          <button className="mclose" onClick={onClose}><Icon n="x" size={16} /></button>
        </div>
        <div className="flowbody">
          <div className="flowintro">
            <h3><Icon n="shield" size={15} /> How the whole thing works (in plain words)</h3>
            <ol>
              {FLOW_ARCH.map((a, i) => <li key={i}>{a}</li>)}
            </ol>
            <p className="flowintro-note">Everything below shows each dashboard step, the matching PACT step that <b>Playwright</b> (the automation) performs, and a &ldquo;How it works&rdquo; note explaining the logic behind that click.</p>
          </div>
          <div className="flowcols-head">
            <span className="fch dash"><Icon n="file" size={14} /> On the dashboard</span>
            <span className="fch pact"><Icon n="upload" size={14} /> In PACT — what Playwright does</span>
          </div>
          {FLOW_STEPS.map((st) => (
            <div className="flowrow" key={st.n}>
              <span className="flownum">{st.n}</span>
              <div className="flowpair">
                <div className="flowcell dash">
                  <div className="fct">{st.dash.t}</div>
                  <div className="fcd">{st.dash.d}</div>
                </div>
                <div className="flowarrow"><Icon n="arrowRight" size={16} /></div>
                <div className="flowcell pact">
                  <div className="fct">{st.pact.t}</div>
                  <div className="fcd">{st.pact.d}</div>
                </div>
              </div>
              <div className="flowhow"><Icon n="file" size={13} /><span>{st.how}</span></div>
              {st.notes.length > 0 && (
                <ul className="flownotes">
                  {st.notes.map((nt, i) => <li key={i}>{nt}</li>)}
                </ul>
              )}
            </div>
          ))}
          <div className="flowgotchas">
            <h3><Icon n="alert" size={15} /> Gotchas &amp; troubleshooting</h3>
            <ul>
              {FLOW_GOTCHAS.map((g, i) => <li key={i}>{g}</li>)}
            </ul>
          </div>
        </div>
        <div className="pfoot">
          <span className="pstatus ok"><Icon n="shield" size={16} />Living document — kept in sync with the Playwright automation</span>
          <button className="btn btn-ghost" style={{ padding: "10px 15px" }} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function SupplierMaster({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const ql = q.trim().toLowerCase();
  const all = ALL_SUPPLIERS;
  const rows = useMemo(() => {
    if (!ql) return all;
    return all.filter((s) => (s.name + " " + s.gstin + " " + s.city + " " + s.code).toLowerCase().includes(ql));
  }, [ql, all]);
  return (
    <div className="overlay show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pmodal">
        <div className="phead">
          <span className="pbadge"><Icon n="mail" size={15} /></span>
          <div className="pttl">
            <h2>PACT Supplier Master</h2>
            <div className="sub">{all.length.toLocaleString("en-IN")} suppliers · bills are matched against this (GST first, then name)</div>
          </div>
          <button className="mclose" onClick={onClose}><Icon n="x" size={16} /></button>
        </div>
        <div className="pmsearch">
          <Icon n="search" size={15} />
          <input placeholder="Search name, GSTIN or city…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          <span className="pmcount">{rows.length === all.length ? all.length : `${rows.length} of ${all.length}`} shown</span>
        </div>
        <div className="pmbody">
          <table className="pmtable">
            <thead><tr><th>#</th><th>Supplier Name</th><th>GSTIN</th><th>City</th><th>Phone</th><th>Email</th></tr></thead>
            <tbody>
              {rows.map((s, i) => (
                <tr key={s.code + i}>
                  <td className="n">{i + 1}</td>
                  <td className="nm">{s.name}</td>
                  <td className="lv">{s.gstin || "—"}</td>
                  <td>{s.city || "—"}</td>
                  <td>{s.phone || "—"}</td>
                  <td>{s.email || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <div className="pmmore">No suppliers match that search.</div>}
        </div>
        <div className="pfoot">
          <span className="pstatus ok"><Icon n="shield" size={16} />Read-only · from your PACT supplier ledger export</span>
          <button className="btn btn-ghost" style={{ padding: "10px 15px" }} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function ProductMaster({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const ql = q.trim().toLowerCase();
  const rows = useMemo(() => {
    // Show every matching product (the list is virtual-free but a plain scroll
    // handles ~2k rows fine); no artificial cap.
    return ql ? CATALOG.filter((p) => p.name.toLowerCase().includes(ql)) : CATALOG;
  }, [ql]);
  const total = ql ? CATALOG.filter((p) => p.name.toLowerCase().includes(ql)).length : CATALOG.length;
  const lvlTxt = (p: (typeof CATALOG)[number]) =>
    (["L1", "L2", "L3"] as const).filter((k) => p.levels[k]).map((k) => `${k}:${p.levels[k].u}${p.levels[k].s != null ? ` (${p.levels[k].s})` : ""}`).join("  ");
  return (
    <div className="overlay show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pmodal">
        <div className="phead">
          <span className="pbadge"><Icon n="file" size={15} /></span>
          <div className="pttl">
            <h2>PACT Product Master</h2>
            <div className="sub">{CATALOG.length.toLocaleString("en-IN")} products · L1 base / L2 / L3 packaging levels</div>
          </div>
          <button className="mclose" onClick={onClose}><Icon n="x" size={16} /></button>
        </div>
        <div className="pmsearch">
          <Icon n="search" size={15} />
          <input placeholder="Search product name…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          <span className="pmcount">{rows.length === total ? total : `${rows.length} of ${total}`} shown</span>
        </div>
        <div className="pmbody">
          <table className="pmtable">
            <thead><tr><th>#</th><th>Product Name</th><th>Purchase Units</th><th>Print level</th><th>Packaging levels</th></tr></thead>
            <tbody>
              {rows.map((p, i) => (
                <tr key={p.name + i}>
                  <td className="n">{i + 1}</td>
                  <td className="nm">{p.name}</td>
                  <td>{p.units.join(", ") || "—"}</td>
                  <td>{p.printLevel || "—"}</td>
                  <td className="lv">{lvlTxt(p) || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {total > rows.length && <div className="pmmore">Showing first {rows.length}. Refine your search to see the rest.</div>}
        </div>
        <div className="pfoot">
          <span className="pstatus ok"><Icon n="shield" size={16} />Read-only view · reupload to refresh from source</span>
          <button className="btn btn-ghost" style={{ padding: "10px 15px" }} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
