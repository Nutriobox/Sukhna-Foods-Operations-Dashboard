"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Per-tile "how does this work" panel on the home screen — same pattern as the
 * NutrioBox ops dashboard (eye button → modal with an Overview / Technical
 * toggle and a vertical flowchart). Overview is written for ops staff; Technical
 * names the actual routes, tables and jobs so whoever maintains a tool can find
 * the code. Keep both in step with the code when a tool's flow changes.
 */

type FlowNode = { stage: string; detail?: string; branches?: string[]; edge?: string };
type Mode = "Automated" | "Semi-automated" | "Manual";
export type TileKey =
  | "stock" | "sales" | "dispatch" | "salesorder" | "costing"
  | "consumption" | "salary" | "closing" | "dispatchReport";

type Info = {
  title: string;
  mode: Mode;
  schedule: string;
  tasks: string[];
  overview: FlowNode[];
  tech: { stack: string; nodes: FlowNode[] };
};

const INFO: Record<TileKey, Info> = {
  stock: {
    title: "Stock Inward & Bill Uploader",
    mode: "Semi-automated",
    schedule: "On demand · bills arrive continuously",
    tasks: ["Bill intake", "AI extraction", "Validation", "Stamp check", "PACT Stock Inward"],
    overview: [
      { stage: "A supplier bill comes in", branches: ["From the mis@nutriobox.com mailbox, picked up automatically", "Or uploaded by hand with Bill Upload (photo or PDF)"], edge: "bill lands in the Invoice Inbox" },
      { stage: "AI reads the bill", detail: "Vendor, invoice number, date, every item line, GST and the grand total are filled in for you." },
      { stage: "Three automatic checks", branches: ["Item math: quantity × rate matches each line", "Buyer is Sukhna Foods", "Line totals + GST + round-off equal the grand total"], edge: "pass → Verified · fail → Needs review" },
      { stage: "Stamp check", detail: "The scan is checked for the Gate No. and Store Checked stamps before the bill can go to PACT." },
      { stage: "Operator reviews and prints PACT labels", detail: "Fix anything flagged, then confirm." },
      { stage: "Upload to PACT", detail: "A Stock Inward voucher is entered in PACT and the bill is frozen so it can't be pushed twice." },
    ],
    tech: {
      stack: "Next.js API routes · Supabase · Google Gemini vision · GitHub Actions + Playwright",
      nodes: [
        { stage: "POST /api/ingest", detail: "Email extractor upserts bills into Supabase `bills` (service key, guarded by x-ingest-secret)." },
        { stage: "POST /api/extract-bill", detail: "Gemini flash models, newest first; retries with backoff on 503/429 so a busy model never leaves the form blank." },
        { stage: "src/lib/validate.ts", detail: "Item math, buyer match and totals reconcile, run client-side on every bill." },
        { stage: "POST /api/verify-stamp", detail: "Gemini vision looks for the Gate No. and Store Checked stamps on the scan." },
        { stage: "POST /api/push-to-pact", detail: "Writes a `pact_jobs` row, then fires a GitHub repository_dispatch (push-to-pact).", edge: "GitHub Actions" },
        { stage: "push-to-pact.yml → scripts/run-pact-job.js", detail: "Playwright logs into PACT and enters the Stock Inward voucher; status is written back to `pact_jobs`, which the UI polls." },
      ],
    },
  },
  sales: {
    title: "Sales Order Creation",
    mode: "Manual",
    schedule: "On demand",
    tasks: ["Upload / create order", "Price chart", "Save", "Export"],
    overview: [
      { stage: "Start a sales order", branches: ["Upload a sales order file (.xlsx, .xls or .csv)", "Or create one by hand with Create Sales Order"] },
      { stage: "Check it full-screen", detail: "Every line is shown in one table, with rates from the customer price chart." },
      { stage: "Save", detail: "The order is stored in the shared database so everyone sees the same list." },
      { stage: "Export", detail: "Export the order for PACT; exported orders are marked so nothing goes out twice." },
    ],
    tech: {
      stack: "React (Dashboard.tsx → SalesPage) · SheetJS parsing in the browser · Supabase",
      nodes: [
        { stage: "File parse", detail: "onSalesOrderFile reads the sheet in the browser; nothing is uploaded until you save." },
        { stage: "Price chart", detail: "PRICE_CHART data in the bundle (code, customer, unit, rate, w.e.f.), editable from the Price Chart button." },
        { stage: "Supabase `sales_orders`", detail: "Saved and listed with supabase-js." },
        { stage: "Export", detail: "markExported records which orders were exported." },
      ],
    },
  },
  dispatch: {
    title: "Outlet Dispatch Tool",
    mode: "Manual",
    schedule: "Daily · run by the dispatch team",
    tasks: ["Read order sheets", "Build challans", "PACT upload file"],
    overview: [
      { stage: "Load the day's outlet order sheets", detail: "One sheet per outlet with what each kitchen asked for." },
      { stage: "Match items to the PACT Product Master", detail: "Names, codes and units come from the same master every tool uses. Use Sync to pull the latest from PACT." },
      { stage: "Build dispatch challans", detail: "One challan per outlet, ready to print." },
      { stage: "Generate the PACT ERP upload", detail: "A file in PACT's import format, so stock outward doesn't have to be typed in." },
    ],
    tech: {
      stack: "Static app (public/outlet-dispatch/index.html, v6.2) · Supabase · EC2 PACT worker",
      nodes: [
        { stage: "GET /api/product-master", detail: "Reads the Product Master snapshot from `costing_snapshots`." },
        { stage: "Sync PM", detail: "POST /api/sync-costing?report=pm queues a `pact_jobs` row; the EC2 worker runs sync-costing-pm.js and refreshes the snapshot.", edge: "Realtime update" },
        { stage: "/js/sync-refresh.js", detail: "One Supabase Realtime channel per page; reloads the master when a sync lands, and disconnects when the tab is hidden." },
        { stage: "/api/dispatch-ref", detail: "Saves the dispatch reference data in Supabase `dispatch_ref` so it's shared across machines." },
      ],
    },
  },
  salesorder: {
    title: "Sales Order (barcode scan)",
    mode: "Semi-automated",
    schedule: "Inventory refreshed by the worker · scanning on demand",
    tasks: ["Live inventory", "Barcode scan", "Order lines", "Push to PACT"],
    overview: [
      { stage: "Live PACT inventory loads", detail: "Batch, warehouse, quantity, price and expiry for every item. Sync now pulls a fresh copy." },
      { stage: "Scan each item with the Honeywell scanner", detail: "The barcode is matched to its batch in inventory, and the line is added to the order." },
      { stage: "Check stock against open orders", detail: "Pending sales orders and outlet requisitions are taken into account so the same stock isn't promised twice." },
      { stage: "Send to PACT", branches: ["B2B customer → Factory Sales Invoice", "NutrioBox outlet → Stock Outward to Outlet"], edge: "filled in PACT, then posted by the operator" },
    ],
    tech: {
      stack: "React (SalesOrderScan) · Supabase · EC2 PACT worker (Playwright)",
      nodes: [
        { stage: "Supabase `inventory_snapshots`", detail: "Latest PACT batchwise report. Refreshed by the worker's inventory schedule; Sync now calls POST /api/sync-inventory." },
        { stage: "/api/order", detail: "`sales_order_lines`, scoped per sales order; shared with the scanner app." },
        { stage: "/api/order-stock", detail: "Joins inventory with `pending_sales_orders` and `pending_outlet_requisitions`." },
        { stage: "/api/push-fsi · /api/push-stock-outward", detail: "Queue `pact_jobs`; the worker fills the PACT document and stops before Post by default (dryRun)." },
      ],
    },
  },
  costing: {
    title: "Factory Costing Dashboard",
    mode: "Automated",
    schedule: "Stock Inward every 3h · Process Flow 8 PM · Product Master + BOM 4 AM (IST)",
    tasks: ["Product Master", "BOM", "Stock Inward", "Process Flow", "Balance Sheet"],
    overview: [
      { stage: "PACT reports are pulled on a schedule", branches: ["Stock Inward: purchase rates, every 3 hours", "Process Flow: what each batch actually used and produced, nightly", "Product Master + BOM: items and recipes, every morning"], edge: "or any time with the Sync buttons" },
      { stage: "Rates", detail: "Latest purchase rate for every raw and packing material." },
      { stage: "Ideal costing", detail: "Recipe (BOM) quantities × current rates = what each product should cost." },
      { stage: "Actual batch costing", detail: "Real issues and yields from Process Flow, per batch and per day." },
      { stage: "Compare and adjust", detail: "Spot the gap between ideal and actual; manual rate overrides are saved for everyone." },
    ],
    tech: {
      stack: "Static app (public/costing/index.html) · Supabase · EC2 worker (Windows service SukhnaWorker)",
      nodes: [
        { stage: "Worker scheduler (COSTING_CRON=1)", detail: "Queues `pact_jobs` with __sync: costing-si / pf / pm / bom on the schedule above; polls every 5 s, 5 min job cap." },
        { stage: "scripts/sync-costing-*.js", detail: "Playwright opens the PACT report and captures the ReportDataSet response; lib/costing-report.js maps the hashed column ids to captions." },
        { stage: "Supabase `costing_snapshots`", detail: "One snapshot per report, read through GET /api/costing/<report>." },
        { stage: "On-demand sync", detail: "POST /api/sync-costing?report=… then the page polls /api/pact-job?id=… until done." },
        { stage: "/api/costing-overrides", detail: "Manual rate overrides, shared across users." },
      ],
    },
  },
  consumption: {
    title: "Outlet Consumption",
    mode: "Semi-automated",
    schedule: "Outlet outward synced hourly · counts entered by outlets",
    tasks: ["Product Master & BOM", "Opening inventory", "Ideal inventory", "Wastage", "Outlet sales"],
    overview: [
      { stage: "One shared Product Master", detail: "Browse and search the PACT master and recipes; Sync pulls the latest." },
      { stage: "What each outlet received", detail: "Stock sent from the factory to each outlet, pulled from PACT every hour." },
      { stage: "What each outlet sold", detail: "Outlet sales from the POS, broken down into ingredients through the recipes." },
      { stage: "Counts from the outlet", branches: ["Opening inventory count", "Wastage, approved by OTP", "Loose denomination: which pack levels are sold loose"] },
      { stage: "Ideal vs actual", detail: "Received + opening − ideal usage, compared with what's actually on the shelf." },
    ],
    tech: {
      stack: "Static app (public/outlet-consumption/index.html) · Supabase · EC2 worker · NutrioBox POS data",
      nodes: [
        { stage: "/api/sync-outlet-outward", detail: "Queues the outlet-outward sync; the worker also runs it hourly (OUTLET_OUTWARD_SYNC_MIN)." },
        { stage: "/api/outlet-invoices", detail: "Reads orders × order_items × dishes × restaurants from the NutrioBox Food Inspector database (fed by the PetPooja webhook)." },
        { stage: "/api/opening-inventory · /api/ideal-inventory", detail: "`opening_inventory_counts` and `ideal_inventory_snapshots`." },
        { stage: "/api/outlet-wastage + /api/wastage-otp", detail: "`outlet_wastage_counts`; approvals via `wastage_approval_otps`." },
        { stage: "/api/loose-denomination", detail: "Saves the loose L1/L2/L3 marks shown on the Opening Inventory sheet." },
      ],
    },
  },
  salary: {
    title: "Salary Structure",
    mode: "Manual",
    schedule: "Monthly · password protected",
    tasks: ["Build structure", "Import register", "Generate slips", "Cloud save"],
    overview: [
      { stage: "Unlock the tool", detail: "Salary data sits behind a password." },
      { stage: "Build or import", branches: ["Build take-home pay for one employee", "Import last month's salary register"] },
      { stage: "PF and ESIC applied", detail: "Statutory deductions are worked out automatically from the structure." },
      { stage: "Generate salary slips" },
      { stage: "Every change saved to the cloud", detail: "With versioned backups, so an earlier state can be restored." },
    ],
    tech: {
      stack: "Static app (public/salary/index.html) · Supabase",
      nodes: [
        { stage: "Client-side password gate", detail: "Rendered before any salary content; unlock is remembered for the browser session." },
        { stage: "/api/salary-data", detail: "Stores the whole workbook as one blob in `salary_data` and writes a copy to `salary_data_backups` on each save." },
      ],
    },
  },
  closing: {
    title: "Closing Stock",
    mode: "Semi-automated",
    schedule: "On demand",
    tasks: ["PACT stock pull", "Filters", "Valuation"],
    overview: [
      { stage: "Pull batch-wise stock from PACT", detail: "Press Sync to fetch the latest closing stock." },
      { stage: "Filter", detail: "By location, warehouse and date." },
      { stage: "Value it", detail: "Each batch is valued with the same rates the costing dashboard uses." },
    ],
    tech: {
      stack: "Static app (public/closing-stock/index.html) · Supabase · EC2 worker",
      nodes: [
        { stage: "POST /api/sync-costing?report=bs", detail: "Queues the balance-stock sync; the worker runs sync-costing-bs.js." },
        { stage: "Supabase `costing_snapshots` (bs)", detail: "Read through GET /api/costing/bs." },
      ],
    },
  },
  dispatchReport: {
    title: "Dispatch Report",
    mode: "Automated",
    schedule: "Sources synced from PACT · report always live",
    tasks: ["Factory sales invoices", "Outlet stock outward", "Scan orders", "Export"],
    overview: [
      { stage: "Three sources in one list", branches: ["B2B factory sales invoices", "Stock outward to NutrioBox outlets", "Inventory orders scanned on the floor"] },
      { stage: "Filter", detail: "By date, source, customer or outlet, and item." },
      { stage: "Export", detail: "Download as CSV or Excel." },
    ],
    tech: {
      stack: "Next.js page (src/app/dispatch-report) · Supabase",
      nodes: [
        { stage: "GET /api/dispatch-report", detail: "Merges `detail_fsi_snapshot`, `outlet_dispatch_snapshot` and `inventory_orders`." },
        { stage: "Sources", branches: ["detail_fsi_snapshot ← /api/sync-detail-fsi (worker pulls PACT Detail FSI report)", "outlet_dispatch_snapshot ← outlet-outward sync (hourly)", "inventory_orders ← scanner app via /api/inventory-orders"] },
        { stage: "Export", detail: "exportCsv / exportXlsx in the browser." },
      ],
    },
  },
};

function Flow({ nodes }: { nodes: FlowNode[] }) {
  return (
    <div className="ti-flow">
      {nodes.map((n, i) => (
        <div key={i} className="ti-step">
          <div className="ti-box">
            <div className="ti-stage">{n.stage}</div>
            {n.detail && <div className="ti-detail">{n.detail}</div>}
            {n.branches && (
              <ul className="ti-branches">
                {n.branches.map((b, j) => (
                  <li key={j}><span className="ti-tree">{j === n.branches!.length - 1 ? "└──" : "├──"}</span>{b}</li>
                ))}
              </ul>
            )}
          </div>
          {i < nodes.length - 1 && (
            <div className="ti-arrow">
              {n.edge && <span className="ti-edge">{n.edge}</span>}
              <span aria-hidden>▼</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function TileInfoModal({ k, onClose }: { k: TileKey; onClose: () => void }) {
  const info = INFO[k];
  const [tab, setTab] = useState<"overview" | "tech">("overview");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="ti-overlay" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className={`ti-card ti-${k}`} role="dialog" aria-modal="true" aria-label={info.title} onClick={(e) => e.stopPropagation()}>
        <div className="ti-head">
          <div className="ti-headrow">
            <h2>{info.title}</h2>
            <button className="ti-close" onClick={onClose} aria-label="Close">×</button>
          </div>
          <div className="ti-badges">
            <span className={`ti-badge ti-mode-${info.mode.toLowerCase().replace(/[^a-z]/g, "")}`}>{info.mode}</span>
            <span className="ti-badge ti-sched">{info.schedule}</span>
          </div>
          <div className="ti-tasks">{info.tasks.map((t) => <span key={t}>{t}</span>)}</div>
          <div className="ti-toggle" role="tablist">
            <button role="tab" aria-selected={tab === "overview"} className={tab === "overview" ? "on" : ""} onClick={() => setTab("overview")}>Overview</button>
            <button role="tab" aria-selected={tab === "tech"} className={tab === "tech" ? "on" : ""} onClick={() => setTab("tech")}>Technical</button>
          </div>
        </div>
        <div className="ti-body">
          {tab === "tech" && <div className="ti-stack"><b>Stack</b> {info.tech.stack}</div>}
          <Flow nodes={tab === "overview" ? info.overview : info.tech.nodes} />
        </div>
      </div>
    </div>
  );
}

/**
 * Eye button placed inside a tile. Tiles are <button>/<a>, and a <button>
 * can't legally nest in either, so this is a span with role="button". It
 * stops the click (and Enter/Space) from reaching the tile so opening the
 * panel never navigates away.
 */
export function TileInfoButton({ k }: { k: TileKey }) {
  const [open, setOpen] = useState(false);
  const stop = (e: React.SyntheticEvent) => { e.preventDefault(); e.stopPropagation(); };
  return (
    <>
      <span
        role="button"
        tabIndex={0}
        className="tile-info"
        title="How this works"
        aria-label={`How ${INFO[k].title} works`}
        onClick={(e) => { stop(e); setOpen(true); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { stop(e); setOpen(true); } }}
      >
        <svg viewBox="0 0 24 24" aria-hidden><path d="M1.5 12S5.5 4.5 12 4.5 22.5 12 22.5 12 18.5 19.5 12 19.5 1.5 12 1.5 12z" /><circle cx="12" cy="12" r="3" /></svg>
      </span>
      {open && <TileInfoModalPortal k={k} onClose={() => setOpen(false)} />}
    </>
  );
}

// Rendered through a portal so the modal sits outside the tile in the DOM (no native
// <a> navigation). React events still bubble through portals, hence the stopPropagation
// on the overlay and card.
function TileInfoModalPortal({ k, onClose }: { k: TileKey; onClose: () => void }) {
  if (typeof document === "undefined") return null;
  return createPortal(<TileInfoModal k={k} onClose={onClose} />, document.body);
}
