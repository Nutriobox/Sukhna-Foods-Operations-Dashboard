"use client";

import React, { useEffect, useMemo, useState } from "react";
import type { Bill } from "@/lib/types";
import { validate, allUploaded, canUpload, BUYER_GST, BUYER_NAME } from "@/lib/validate";
import { resolveLine, type PactLine } from "@/lib/pact";
import { inr, inrShort } from "@/lib/format";
import { supabase } from "@/lib/supabaseClient";
import { rowToBill, billToRow } from "@/lib/data";
import { Icon } from "./icons";

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
  const [modalTab, setModalTab] = useState<"scan" | "data">("scan");
  const [toast, setToast] = useState<{ msg: string; show: boolean }>({ msg: "", show: false });

  // Pull live data from Supabase if configured; otherwise stay on seed data.
  useEffect(() => {
    if (!supabase) return;
    (async () => {
      const { data, error } = await supabase.from("bills").select("*").order("id");
      if (!error && data && data.length) setBills(data.map(rowToBill));
    })();
  }, []);

  function ping(msg: string) {
    setToast({ msg, show: true });
    window.setTimeout(() => setToast((t) => ({ ...t, show: false })), 2300);
  }

  async function persist(b: Bill) {
    if (!supabase) return;
    try {
      await supabase.from("bills").upsert(billToRow(b));
    } catch (e) {
      /* best-effort in the prototype */
    }
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
  });

  const active = modalId != null ? bills.find((b) => b.id === modalId) || null : null;
  const pactActive = pactId != null ? bills.find((b) => b.id === pactId) || null : null;

  return (
    <div className="app">
      <div className="main">
        {/* Top bar */}
        <div className="topbar">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="brandlogo" src="/logo.png" alt="Sukhna Foods" />
          <span className="brand-div">Operations Dashboard</span>
          <div className="search">
            <Icon n="search" />
            <input placeholder="Search vendor or invoice number…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="spacer" />
          <div className="mailpill"><Icon n="mail" size={15} /> mis@nutriobox.com</div>
          <div className="sync"><span className="pulse" /> Synced just now</div>
          <button className="iconbtn"><span className="badge">{kpis.err}</span><Icon n="bell" size={17} /></button>
          <div className="tb-av" title={`${BUYER_NAME}`}>S</div>
        </div>

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
                  <div key={b.id} className={"row" + (b.voided ? " voided" : "")} onClick={(e) => { if (!(e.target as HTMLElement).closest("button")) openModal(b.id); }}>
                    <span className="c-date">{b.date}</span>
                    <span className="c-v">
                      <span className="mono" style={{ background: MC[(b.id - 1) % MC.length] }}>{initials(b.vendor)}</span>
                      <span className="vmeta">
                        <span className="vname">{b.vendor}</span>
                        <span className="vsub">{b.items[0].name}{b.items.length > 1 ? ` · +${b.items.length - 1} more` : ""}</span>
                      </span>
                    </span>
                    <span className="c-inv">{b.invoice}</span>
                    <span className="c-items"><span className="itcount">{b.items.length}</span></span>
                    <span className="c-verify">
                      {b.voided
                        ? <span className="pill void"><Icon n="lock" size={12} />{up ? "Uploaded" : "Voided"}</span>
                        : v.status === "OK"
                          ? <span className="pill ok"><Icon n="check" size={12} />OK</span>
                          : <span className="pill err"><Icon n="alert" size={12} />Review</span>}
                    </span>
                    <span className="c-amt tnum">₹{inr(b.grandTotal)}</span>
                    <span className="c-act">
                      {b.voided
                        ? <button className="btn btn-done"><Icon n="check" size={14} />{up ? "Uploaded" : "Voided"}</button>
                        : <span className="upcol">
                            {v.status !== "OK"
                              ? <button className="btn btn-primary" disabled title="All 3 checks must pass before upload"><Icon n="upload" size={14} />Upload to Pact</button>
                              : <button className="btn btn-primary" onClick={(e) => { e.stopPropagation(); setPactId(b.id); }}><Icon n="upload" size={14} />Upload to Pact</button>}
                            {b.items.length > 1 && <span className="upfrac">{upCount}/{b.items.length} items to Pact</span>}
                          </span>}
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
      </div>

      {/* Modal */}
      {active && <BillDetail b={active} tab={modalTab} setTab={setModalTab} onClose={() => setModalId(null)} uploadItem={uploadItem} openPact={(id) => { setModalId(null); setPactId(id); }} voidBill={voidBill} downloadTxt={downloadTxt} />}

      {/* PACT upload form */}
      {pactActive && <PactUpload b={pactActive} onClose={() => setPactId(null)} uploadItem={uploadItem} onConfirm={() => { uploadAll(pactActive.id); setPactId(null); }} />}

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

  const itemUpBtn = (i: number) => {
    const it = b.items[i];
    if (it.uploaded) return <span className="up-done"><Icon n="check" size={12} />Uploaded</span>;
    if (b.voided) return <span className="up-dash">—</span>;
    if (v.status !== "OK") return <button className="mini" disabled title="All 3 checks must pass"><Icon n="upload" size={11} />Upload</button>;
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
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="scanimg" src={b.scanUrl} alt={`Scanned bill — ${b.vendor}`} />
              </div>
              <div className="scancap"><Icon n="image" size={15} /><span>Original scanned bill · {b.vendor} · {b.invoice}</span></div>
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
                <div className="tr grand"><span className="l">Grand Total</span><span className="a tnum">₹{inr(b.grandTotal)}</span></div>
              </div>
              <div className="checks">
                <h3>Validation — 3 checks</h3>
                {v.checks.map((c, i) => (
                  <div key={i} className={"chk " + c.status}>
                    <span className="ico"><Icon n={c.status === "pass" ? "check" : c.status === "fail" ? "x" : "dash"} size={13} /></span>
                    <div><div className="t">{c.label}</div><div className="d">{c.detail}</div></div>
                  </div>
                ))}
              </div>
              <button className="btn btn-ghost" style={{ marginTop: 14 }} onClick={() => downloadTxt(b.id)}><Icon n="download" size={14} />Download extracted .txt</button>
            </>
          )}
        </div>

        <div className="mfoot">
          <span className={"status-big " + (b.voided ? "void" : v.status === "OK" ? "ok" : "err")}>
            {b.voided ? <><Icon n="lock" size={17} />{up ? "Uploaded to Pact · frozen" : "Voided · frozen"}</> : v.status === "OK" ? <><Icon n="shield" size={17} />All checks passed</> : <><Icon n="alert" size={17} />1 check failed — review needed</>}
          </span>
          <button className="btn btn-void" style={{ padding: "10px 15px" }} disabled={b.voided} onClick={() => voidBill(b.id)}><Icon n="ban" size={14} />Void</button>
          {b.voided
            ? <button className="btn btn-done" style={{ padding: "10px 15px" }}><Icon n="check" size={14} />{up ? "Uploaded" : "Voided"}</button>
            : v.status !== "OK"
              ? <button className="btn btn-primary" disabled style={{ padding: "10px 15px" }} title="All 3 checks must pass"><Icon n="upload" size={14} />Upload all to Pact</button>
              : <button className="btn btn-primary" style={{ padding: "10px 15px" }} onClick={() => openPact(b.id)}><Icon n="upload" size={14} />Upload all to Pact</button>}
          <button className="btn btn-ghost" style={{ padding: "10px 15px" }} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

type Batch = { mfg: string; qty: number | "" };
function PactUpload({ b, onClose, onConfirm, uploadItem }: { b: Bill; onClose: () => void; onConfirm: () => void; uploadItem: (id: number, i: number) => void }) {
  const lines: PactLine[] = useMemo(() => b.items.map((it) => resolveLine(it)), [b]);
  const today = new Date().toISOString().slice(0, 10);
  const [batches, setBatches] = useState<Record<number, Batch[]>>(() =>
    Object.fromEntries(b.items.map((_, i) => [i, [{ mfg: today, qty: lines[i].qty ?? 0 }]]))
  );
  const [editing, setEditing] = useState<Record<number, boolean>>({});
  const [packSize, setPackSize] = useState<Record<number, string>>(() =>
    Object.fromEntries(b.items.map((_, i) => [i, lines[i].packSize]))
  );

  const setBatch = (i: number, bi: number, patch: Partial<Batch>) =>
    setBatches((m) => ({ ...m, [i]: m[i].map((x, k) => (k === bi ? { ...x, ...patch } : x)) }));
  const split = (i: number) =>
    setBatches((m) => ({ ...m, [i]: [...m[i], { ...m[i][m[i].length - 1] }] }));
  const removeBatch = (i: number, bi: number) =>
    setBatches((m) => ({ ...m, [i]: m[i].filter((_, k) => k !== bi) }));

  const unmatched = lines.filter((l) => !l.matched).length;
  const datesReady = Object.values(batches).every((arr) => arr.every((bt) => !!bt.mfg));
  const allUp = b.items.every((it) => it.uploaded);
  const canConfirm = unmatched === 0 && datesReady && !allUp;

  return (
    <div className="overlay show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pmodal">
        <div className="phead">
          <span className="pbadge"><Icon n="upload" size={15} /></span>
          <div className="pttl">
            <h2>Upload to PACT</h2>
            <div className="sub">{b.vendor} · Invoice {b.invoice} · {lines.length} line item{lines.length > 1 ? "s" : ""} matched against PACT item master</div>
          </div>
          <button className="mclose" onClick={onClose}><Icon n="x" size={16} /></button>
        </div>

        <div className="pbody">
          {lines.map((l, i) => {
            const it = b.items[i];
            const done = it.uploaded;
            const bs = batches[i] || [];
            return (
              <div key={i} className={"pcard" + (l.matched ? "" : " err") + (done ? " done" : "")}>
                <div className="pcard-top">
                  <span className="pnum">{i + 1}</span>
                  <div className="pprod">
                    <div className="pname">{l.product}
                      {done
                        ? <span className="pmatch ok"><Icon n="check" size={11} />Uploaded to PACT</span>
                        : l.matched
                          ? <span className="pmatch ok"><Icon n="check" size={11} />PACT match{l.confidence ? ` · ${l.confidence}%` : ""}</span>
                          : <span className="pmatch bad"><Icon n="alert" size={11} />Unit not in PACT</span>}
                    </div>
                    <div className="pfrom">from bill: {l.billName}</div>
                  </div>
                </div>

                {/* Product line */}
                <div className="pgrid">
                  <div className="pf"><span className="pk">Product Name</span><span className="pv">{l.product}</span></div>
                  <div className="pf"><span className="pk">Purchase Unit</span>{l.unit ? <span className="pv">{l.unit}</span> : <span className="pv bad"><Icon n="alert" size={11} />Not matched</span>}</div>
                  <div className="pf"><span className="pk">Purchase Quantity</span>{l.qty != null ? <span className="pv tnum">{l.qty}</span> : <span className="pv bad">Requires matched unit</span>}</div>
                  <div className="pf"><span className="pk">Purchase Rate</span><span className="pv tnum">{l.rate != null ? "₹" + inr(l.rate) : "—"}</span></div>
                </div>

                {/* Manufacturing batches (splittable) */}
                <div className="pbatchbar">
                  <span className="pbl">Manufacturing batch{bs.length > 1 ? "es" : ""}</span>
                  <button className="psplit" disabled={done || !l.matched} onClick={() => split(i)} title={l.matched ? "Duplicate this batch row" : "Unit must match PACT"}><Icon n="copy" size={12} />Split</button>
                </div>
                {bs.map((bt, bi) => (
                  <div className="pbatch" key={bi}>
                    <div className="pf"><span className="pk">Manufactured Date</span>
                      <input type="date" className="pdate" value={bt.mfg} disabled={done} onChange={(e) => setBatch(i, bi, { mfg: e.target.value })} />
                    </div>
                    <div className="pf"><span className="pk">Quantity / Mfg Date</span>
                      <input type="number" min={0} className="pnuminp tnum" value={bt.qty} disabled={done} onChange={(e) => setBatch(i, bi, { qty: e.target.value === "" ? "" : Number(e.target.value) })} />
                    </div>
                    <div className="pf"><span className="pk">UOM</span>{l.uom ? <span className="pv">{l.uom}</span> : <span className="pv bad"><Icon n="alert" size={11} />Not matched</span>}</div>
                    <div className="pf pbrm">{bs.length > 1 && !done && <button className="pxbtn" title="Remove this batch" onClick={() => removeBatch(i, bi)}><Icon n="x" size={12} /></button>}</div>
                  </div>
                ))}

                {/* Product-master packaging attributes */}
                <div className="pgrid pmaster">
                  <div className="pf"><span className="pk">Packaging size UOM</span><span className="pv">{l.printUom}</span></div>
                  <div className="pf"><span className="pk">Packing size{editing[i] && !done ? <span className="pedit"> · manual</span> : ""}</span>
                    {editing[i] && !done
                      ? <input className="pnuminp" value={packSize[i]} onChange={(e) => setPackSize((p) => ({ ...p, [i]: e.target.value }))} />
                      : <span className="pv">{packSize[i]}</span>}
                  </div>
                  <div className="pf"><span className="pk">L1 UOM</span><span className="pv">{l.l1Uom}</span></div>
                  <div className="pf" />
                </div>

                {!l.matched && <div className="perr"><Icon n="alert" size={14} />Unit / UOM "{b.items[i].uom}" could not be matched in PACT — this line blocks the upload.</div>}

                {/* Per-item actions */}
                <div className="pcard-foot">
                  <button className="pmini" disabled={done} onClick={() => setEditing((s) => ({ ...s, [i]: !s[i] }))}><Icon n="edit" size={12} />{editing[i] ? "Done" : "Edit"}</button>
                  {done
                    ? <span className="up-done"><Icon n="check" size={12} />Uploaded</span>
                    : <button className="pmini up" disabled={!l.matched} title={l.matched ? "Upload just this item to PACT" : "Unit must match PACT"} onClick={() => uploadItem(b.id, i)}><Icon n="upload" size={12} />Upload</button>}
                </div>
              </div>
            );
          })}
        </div>

        <div className="pfoot">
          <span className={"pstatus " + (unmatched > 0 ? "bad" : allUp ? "ok" : datesReady ? "ok" : "warn")}>
            {unmatched > 0
              ? <><Icon n="alert" size={16} />{unmatched} item{unmatched > 1 ? "s" : ""} not matched — upload blocked</>
              : allUp
                ? <><Icon n="check" size={16} />All items uploaded</>
                : datesReady
                  ? <><Icon n="shield" size={16} />All items matched · ready to push</>
                  : <><Icon n="alert" size={16} />Select a manufactured date for every batch</>}
          </span>
          <button className="btn btn-ghost" style={{ padding: "10px 15px" }} onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" style={{ padding: "10px 15px" }} disabled={!canConfirm}
            title={canConfirm ? "" : "Every item must match PACT and have a manufactured date"}
            onClick={() => { if (canConfirm) onConfirm(); }}>
            <Icon n="upload" size={14} />Confirm &amp; Push to PACT
          </button>
        </div>
      </div>
    </div>
  );
}
