"use client";

import React, { useEffect, useMemo, useState } from "react";
import type { Bill } from "@/lib/types";
import { validate, allUploaded, canUpload, BUYER_GST, BUYER_NAME } from "@/lib/validate";
import { resolveLine, candidates, productByName, matchProduct, canonUnit, ALL_UNITS, CATALOG, type PactLine } from "@/lib/pact";
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
  const [pmOpen, setPmOpen] = useState(false);
  const [printedIds, setPrintedIds] = useState<Set<number>>(new Set());
  const [stampVer, setStampVer] = useState<Record<string, StampCheck & { status: "checking" | "done" }>>({});
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
    return sv.verified ? "OK" : "REVIEW";
  }

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
          <button className="pmbtn" onClick={() => setPmOpen(true)}><Icon n="file" size={14} />View product master</button>
          <button className="pmbtn ghost" onClick={() => ping("Product master re-upload — connect the source/server to enable live sync.")}><Icon n="refresh" size={14} />Reupload product master</button>
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
                      {b.voided
                        ? <button className="btn btn-done"><Icon n="check" size={14} />{up ? "Uploaded" : "Voided"}</button>
                        : <span className="upcol">
                            {v.status !== "OK"
                              ? <button className="btn btn-primary" disabled title="All 3 checks must pass before upload"><Icon n="upload" size={14} />Upload to Pact</button>
                              : <button className="btn btn-primary" onClick={(e) => { e.stopPropagation(); setPactId(b.id); }}><Icon n="upload" size={14} />Upload to Pact</button>}
                            {b.items.length > 1 && <span className="upfrac">{upCount}/{b.items.length} items to Pact</span>}
                          </span>}
                      {!b.voided && <span className="printcol">
                        <button className="btn btn-print" onClick={(e) => { e.stopPropagation(); setPrintedIds((prev) => new Set(prev).add(b.id)); ping("Sticker print queued — will print on PACT once the integration is connected."); }} title="Print PACT stickers (activates after PACT integration)"><Icon n="printer" size={14} />Print</button>
                        {printedIds.has(b.id) && <span className="printed-badge"><Icon n="check" size={11} />Printed</span>}
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

      {/* Product master list */}
      {pmOpen && <ProductMaster onClose={() => setPmOpen(false)} />}

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
  const [dstamp, setDstamp] = useState<(StampCheck & { status: "checking" | "done" }) | null>(null);
  useEffect(() => {
    if (!scanUrl || b.voided || validate(b).status !== "OK") return;
    setDstamp({ status: "checking", ok: false, verified: false, gateNo: false, storeChecked: false });
    fetchStamp(scanUrl).then((res) => setDstamp({ ...res, status: "done" }));
  }, [scanUrl, b]);
  const stampDone = !!dstamp && dstamp.status === "done";
  const fiveOkLocal = v.status === "OK" && stampDone && dstamp!.ok && dstamp!.verified;

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
          <span className={"status-big " + (b.voided ? "void" : v.status !== "OK" ? "err" : !stampDone ? "warn" : fiveOkLocal ? "ok" : "err")}>
            {b.voided ? <><Icon n="lock" size={17} />{up ? "Uploaded to Pact · frozen" : "Voided · frozen"}</> : v.status !== "OK" ? <><Icon n="alert" size={17} />1 check failed — review needed</> : !stampDone ? <><Icon n="shield" size={17} />Verifying bill stamps…</> : fiveOkLocal ? <><Icon n="shield" size={17} />All 5 checks passed</> : <><Icon n="alert" size={17} />Stamp check failed — review needed</>}
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
// Multiply an invoice quantity in `from` units by this to get `to` units (rate divides).
function convFactor(prod: { levels: LevelMap }, from: string, to: string): number | null {
  const nf = normU(from);
  const nt = normU(to);
  if (!nf || !nt) return null;
  if (nf === nt) return 1;
  const a = unitGrams(prod, from);
  const b = unitGrams(prod, to);
  if (a && b && a.fam === b.fam && b.g) return a.g / b.g;
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

function PactUpload({ b, onClose, onConfirm, uploadItem }: { b: Bill; onClose: () => void; onConfirm: () => void; uploadItem: (id: number, i: number) => void }) {
  const lines: PactLine[] = useMemo(() => b.items.map((it) => resolveLine(it)), [b]);
  const cands = useMemo(() => b.items.map((_, i) => candidates(lines[i].billName)), [b]);
  const allNames = useMemo(() => CATALOG.map((p) => p.name), []);
  const today = new Date().toISOString().slice(0, 10);

  const [batches, setBatches] = useState<Record<number, Batch[]>>(() =>
    Object.fromEntries(b.items.map((_, i) => [i, [{ id: 0, mfg: today, qty: 0 }]]))
  );
  const [editing, setEditing] = useState<Record<number, boolean>>({});
  const [stampOK, setStampOK] = useState(false);
  const [stampInfo, setStampInfo] = useState<{ status: "idle" | "checking" | "done" | "error" | "unconfigured" | "noscan"; gateNo?: boolean; storeChecked?: boolean; detail?: string }>({ status: "idle" });

  // Auto-detect the Gate No. + Store Checked stamps on the scan when the modal opens.
  useEffect(() => {
    const scan: string | undefined = (b as any).scanUrl;
    if (!scan) { setStampInfo({ status: "noscan" }); return; }
    const cached = STAMP_CACHE[scan];
    if (cached) { setStampInfo({ status: "done", gateNo: cached.gateNo, storeChecked: cached.storeChecked }); setStampOK(cached.verified); return; }
    let alive = true;
    setStampInfo({ status: "checking" });
    fetch("/api/verify-stamp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ imageUrl: scan }) })
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d?.ok) {
          const res: StampResult = { gateNo: !!d.gateNo, storeChecked: !!d.storeChecked, verified: !!d.verified };
          STAMP_CACHE[scan] = res;
          setStampInfo({ status: "done", gateNo: res.gateNo, storeChecked: res.storeChecked });
          setStampOK(res.verified);
        } else {
          setStampInfo({ status: d?.reason === "not_configured" ? "unconfigured" : "error", detail: d?.detail || d?.reason });
        }
      })
      .catch(() => { if (alive) setStampInfo({ status: "error" }); });
    return () => { alive = false; };
  }, [b]);
  const [selProduct, setSelProduct] = useState<Record<number, string>>(() =>
    Object.fromEntries(b.items.map((_, i) => [i, lines[i].product])));
  const [selUnit, setSelUnit] = useState<Record<number, string>>(() =>
    Object.fromEntries(b.items.map((_, i) => [i, lines[i].unit || ""])));
  // Packaging level + manual packing size are per batch row, keyed `${i}:${batchId}`.
  const [selLevel, setSelLevel] = useState<Record<string, string>>({});
  const [packEdit, setPackEdit] = useState<Record<string, string | undefined>>({});

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
  const canConfirm = unmatched === 0 && datesReady && !allUp && qtyAllOK && stampOK;

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
          <div className="pmi"><span className="pmk">Party name</span><span className="pmv">{b.vendor}</span></div>
          <div className="pmi"><span className="pmk">Party GST</span><span className="pmv tnum">{b.vendorGst}</span></div>
          <div className="pmi"><span className="pmk">Bill number</span><span className="pmv">{b.invoice}</span></div>
          <div className="pmi"><span className="pmk">Bill date</span><span className="pmv">{b.dateFull}</span></div>
          <div className="pmi"><span className="pmk">Delivery date</span><span className="pmv">{(b as any).deliveryDate || "—"}</span></div>
        </div>

        <div className={"pstamp" + (stampOK ? " ok" : "")}>
          <label className="pstamp-lbl"><input type="checkbox" checked={stampOK} onChange={(e) => setStampOK(e.target.checked)} /> Stamp verified — <b>Gate No.</b> &amp; <b>Store Checked</b></label>
          {stampInfo.status === "checking"
            ? <span className="pstamp-chk"><Icon n="refresh" size={13} />Auto-checking scan…</span>
            : stampOK
              ? <span className="pstamp-ok"><Icon n="check" size={13} />{stampInfo.status === "done" ? "Auto-detected on scan" : "Verified"}</span>
              : <span className="pstamp-err" title={stampInfo.detail || ""}><Icon n="alert" size={13} />{
                  stampInfo.status === "done" ? `Stamps not detected (Gate No. ${stampInfo.gateNo ? "✓" : "✗"} · Store Checked ${stampInfo.storeChecked ? "✓" : "✗"}) — verify manually`
                  : stampInfo.status === "unconfigured" ? "Auto-check off (set GEMINI_API_KEY) — verify manually"
                  : stampInfo.status === "error" ? "Auto-check failed — verify manually"
                  : stampInfo.status === "noscan" ? "No scan on file — verify manually"
                  : "Upload blocked until the bill stamp is verified"
                }</span>}
          {(b as any).scanUrl && <a className="pstamp-view" href={(b as any).scanUrl} target="_blank" rel="noreferrer">View scan</a>}
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
            const dispRate = l.rate != null ? l.rate / (factor ?? 1) : null;
            const splitMode = bs.length > 1;
            const batchSum = bs.reduce((a, x) => a + (typeof x.qty === "number" ? x.qty : 0), 0);
            const qtyOK = !splitMode || (dispQty != null && Math.abs(batchSum - dispQty) < 0.0001);
            const prodOpts = ed ? allNames : (cands[i].map((c) => c.name).includes(selProduct[i]) ? cands[i].map((c) => c.name) : [selProduct[i], ...cands[i].map((c) => c.name)]);
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
                    <select className="psel" disabled={done} value={selProduct[i]} onChange={(e) => pickProduct(i, e.target.value)}>
                      {prodOpts.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                  <div className="pf"><span className="pk">Purchase Unit{unit && !unitInMaster ? <span className="ureview" title="This unit is not one of the product's PACT units (e.g. Gms / Kg / Bags). Click Edit to pick a PACT unit."><Icon n="alert" size={11} />review</span> : ""}</span>
                    {ed
                      ? <select className={"psel" + (unit && !unitInMaster ? " warn" : "")} value={unit} onChange={(e) => setSelUnit((s) => ({ ...s, [i]: e.target.value }))}>
                          <option value="">— select —</option>
                          {(prod.units.length ? prod.units : ALL_UNITS).map((u) => <option key={u} value={u}>{u}</option>)}
                        </select>
                      : unit
                        ? <span className="pv">{unit}</span>
                        : <span className="pv bad"><Icon n="alert" size={11} />Not matched</span>}
                  </div>
                  <div className="pf"><span className="pk">Purchase Quantity{factor != null && factor !== 1 ? <span className="pedit"> · {it.uom}→{unit}</span> : ""}</span>{dispQty != null ? <span className="pv tnum">{fmtQty(dispQty)}</span> : <span className="pv bad">Requires unit</span>}</div>
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
                          : <span className="pv tnum">{splitMode ? bt.qty : fmtQty(dispQty ?? 0)}</span>}
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
                {splitMode && !qtyOK && <div className="perr"><Icon n="alert" size={14} />Batch quantities add up to {fmtQty(batchSum)} {unit}, but purchase quantity is {fmtQty(dispQty ?? 0)} {unit}. They must match before upload.</div>}

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
          <span className={"pstatus " + (unmatched > 0 || !qtyAllOK || (!allUp && !stampOK) ? "bad" : allUp ? "ok" : datesReady ? "ok" : "warn")}>
            {unmatched > 0
              ? <><Icon n="alert" size={16} />{unmatched} item{unmatched > 1 ? "s" : ""} not matched — upload blocked</>
              : allUp
                ? <><Icon n="check" size={16} />All items uploaded</>
                : !datesReady
                  ? <><Icon n="alert" size={16} />Select a manufactured date for every batch</>
                  : !qtyAllOK
                    ? <><Icon n="alert" size={16} />Split quantities must equal the purchase quantity</>
                    : !stampOK
                      ? <><Icon n="alert" size={16} />Verify the bill stamp (Gate No. + Store Checked) to enable upload</>
                      : <><Icon n="shield" size={16} />All items matched · ready to push</>}
          </span>
          <button className="btn btn-ghost" style={{ padding: "10px 15px" }} onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" style={{ padding: "10px 15px" }} disabled={!canConfirm}
            title={canConfirm ? "" : "Every item must have a purchase unit and a manufactured date"}
            onClick={() => { if (canConfirm) onConfirm(); }}>
            <Icon n="upload" size={14} />Confirm &amp; Push to PACT
          </button>
        </div>
      </div>
    </div>
  );
}

function ProductMaster({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const ql = q.trim().toLowerCase();
  const rows = useMemo(() => {
    const list = ql ? CATALOG.filter((p) => p.name.toLowerCase().includes(ql)) : CATALOG;
    return list.slice(0, 300);
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
