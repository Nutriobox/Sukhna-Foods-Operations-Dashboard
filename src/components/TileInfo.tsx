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
  | "consumption" | "salary" | "closing" | "dispatchReport" | "pmr";

type Info = {
  title: string;
  mode: Mode;
  schedule: string;
  users: string;
  tasks: string[];
  about: string;
  overview: FlowNode[];
  notes: string[];
  tech: {
    stack: string;
    nodes: FlowNode[];
    data: { name: string; what: string }[];
    troubleshoot: string[];
  };
};

const INFO: Record<TileKey, Info> = {
  stock: {
    title: "Stock Inward & Bill Uploader",
    mode: "Semi-automated",
    schedule: "On demand · bills arrive through the day",
    users: "Stores / purchase team",
    tasks: ["Bill intake", "AI extraction", "3 checks", "Stamp check", "PACT labels", "PACT Stock Inward"],
    about:
      "Every supplier bill for raw and packing material comes through here before it becomes stock in PACT. The tool reads the bill for you, checks the arithmetic and the buyer, confirms the gate and store stamps are on the scan, and then enters the Stock Inward voucher in PACT, so nobody has to type a bill twice and a wrong bill can't slip through.",
    overview: [
      { stage: "A supplier bill comes in", branches: ["Emailed to mis@nutriobox.com and picked up automatically", "Or added with Bill Upload (photo or PDF)", "Or typed in manually; it then goes through exactly the same checks"], edge: "bill lands in the Invoice Inbox" },
      { stage: "AI reads the bill", detail: "Vendor, GSTIN, invoice number and date, every item line (quantity, unit, rate, net, GST), other charges, round-off and the grand total are filled in. Anything it gets wrong can be corrected on screen." },
      { stage: "Three automatic checks", branches: ["Item math: quantity × rate equals each line's net amount (₹0.50 tolerance)", "Buyer: billed to Sukhna Foods with the correct GSTIN", "Totals: line nets + GST + round-off equal the grand total (₹1 tolerance); extra charges outside the item lines are flagged for approval"], edge: "all pass → Verified · any fail → Needs review" },
      { stage: "Stamp check", detail: "The scan is checked for the Gate No. stamp and the Store Checked stamp. If a stamp is missing the bill is held; if the check can't run, the operator confirms the stamps by eye before uploading." },
      { stage: "Operator review", detail: "Fix anything flagged, match each line to its PACT product and unit, and print the PACT labels for the goods." },
      { stage: "Upload to PACT", detail: "The Stock Inward voucher is created in PACT. The bill is then frozen (Uploaded to PACT) so it can't be edited or pushed a second time." },
    ],
    notes: [
      "The tile counts the bills currently in the inbox.",
      "A bill that fails a check is never blocked forever; fix the field or approve the extra charge and it re-checks immediately.",
      "Voided bills are frozen too, so they stay on record without being pushed.",
    ],
    tech: {
      stack: "Next.js (Dashboard.tsx) · Supabase · Google Gemini vision · GitHub Actions + Playwright",
      nodes: [
        { stage: "Intake", branches: ["Email extractor → POST /api/ingest (header x-ingest-secret) → upsert into `bills`", "Bill Upload → file saved to the `scans` storage bucket → its URL sent to POST /api/extract-bill"] },
        { stage: "POST /api/extract-bill", detail: "Sends the image to Gemini and returns structured JSON. Tries GEMINI_VISION_MODEL, gemini-flash-latest, then gemini-2.5-flash, with backoff on 503 / 429 so a busy model never leaves the form blank." },
        { stage: "src/lib/validate.ts", detail: "The three checks run in the browser on every edit. Item math and totals use the tolerances above; buyer is compared with BUYER_NAME / BUYER_GST." },
        { stage: "POST /api/verify-stamp", detail: "Gemini vision on the scan, returning whether each of the two stamps is present. Same model fallback as extract-bill." },
        { stage: "POST /api/push-to-pact", detail: "Inserts a `pact_jobs` row (queued), then calls GitHub repository_dispatch with event_type push-to-pact and the bill as payload.", edge: "GitHub Actions runner" },
        { stage: "push-to-pact.yml → scripts/run-pact-job.js", detail: "Headless Chromium (Playwright) logs into PACT and runs createStockInward. Every log line is captured and written back to the `pact_jobs` row with status processing → done / failed; the dashboard polls that row." },
      ],
      data: [
        { name: "bills", what: "Every bill: extracted fields, lines, check results, upload / void state" },
        { name: "pact_jobs", what: "One row per PACT push: status, error, step log" },
        { name: "scans (storage bucket)", what: "Uploaded bill images, path bills/…" },
      ],
      troubleshoot: [
        "Form came back blank: all Gemini models were busy; extract again in a minute.",
        "Push stuck on queued: check the run in GitHub → Actions → push-to-pact, and the log saved on the `pact_jobs` row.",
        "Push failed after login: usually a changed PACT screen; the run saves screenshots and HTML for each step.",
      ],
    },
  },
  sales: {
    title: "Sales Order Creation",
    mode: "Manual",
    schedule: "On demand",
    users: "Sales / accounts team",
    tasks: ["Upload or create", "Price chart", "Save", "Export to PACT", "Excel (FSALES)"],
    about:
      "Customer sales orders arrive as spreadsheets in all shapes. This screen turns them into one clean list the whole team can see, priced from the customer price chart, and produces the file PACT imports, so orders don't have to be keyed into PACT line by line.",
    overview: [
      { stage: "Start a sales order", branches: ["Upload the customer's file (.xlsx, .xls or .csv); every sheet in it is kept", "Or build one from scratch with Create Sales Order"] },
      { stage: "Check it full-screen", detail: "The order opens as a table. Rates come from the Price Chart (by product code, customer and unit, with a w.e.f. date), so a wrong rate on the customer's sheet stands out." },
      { stage: "Save", detail: "The order goes into the shared database, so it shows up for everyone and survives a browser refresh." },
      { stage: "Export to PACT", detail: "Creates the PACT import file for the order and marks it exported, so the same order isn't sent twice." },
      { stage: "Track the import", detail: "Each order shows how many of its lines PACT has imported (for example Imported 12/12)." },
    ],
    notes: [
      "Excel downloads the order in the FSALES layout PACT expects.",
      "The Price Chart can be edited from the toolbar; new rates apply from their w.e.f. date.",
      "The live Re-check from PACT button is shown but not wired yet.",
    ],
    tech: {
      stack: "React (Dashboard.tsx → SalesPage, SalesOrderDetail) · SheetJS in the browser · Supabase",
      nodes: [
        { stage: "onSalesOrderFile", detail: "SheetJS reads every sheet of the uploaded workbook in the browser (sheet_to_json, header rows kept). Nothing leaves the browser until the order is saved." },
        { stage: "Price chart", detail: "PRICE_CHART data in the bundle (code, name, customer, unit, rate, w.e.f.)." },
        { stage: "Supabase `sales_orders`", detail: "Read and written with supabase-js from the browser." },
        { stage: "Export", branches: ["Export to PACT → builds the import file and calls markExported", "Excel → downloadOrderXlsx (FSALES layout)"] },
      ],
      data: [
        { name: "sales_orders", what: "Each order with its original sheets and line data" },
      ],
      troubleshoot: [
        "File won't load: it must be a real .xlsx / .xls / .csv; re-save from Excel if it was exported by another tool.",
        "Order missing for a colleague: check it was saved (Supabase configured shows on the page) rather than only uploaded.",
      ],
    },
  },
  dispatch: {
    title: "Outlet Dispatch Tool",
    mode: "Manual",
    schedule: "Daily · run before goods leave the factory",
    users: "Dispatch team",
    tasks: ["Outlet sheets", "Dispatch day", "Bread order", "Challans", "PACT import", "Validation report"],
    about:
      "Each NutrioBox outlet sends a stock-count sheet. This tool works out what each outlet should receive against its ideal stock and the dispatch schedule, then produces the outlet order sheets, the challans and the PACT import in one run. It runs entirely in the browser: the order files are read inside the tab and are never uploaded.",
    overview: [
      { stage: "1 · Load the files", branches: ["Pick the day's date folder (or drag the outlet sheets in)", "Reference files: Product Master, Ideal Inventory, Outlet dispatch schedule", "Product names on the sheets are matched to the PACT Product Master automatically; anything unmatched can be linked once and the link is remembered"] },
      { stage: "2 · Set the dispatch day", detail: "Choose the date goods go out and the starting voucher number, and confirm the working day. Only categories scheduled for that day are dispatched." },
      { stage: "Ordering rules", branches: ["Order = ideal level − on hand, for categories scheduled today", "Urgent top-up: if a category isn't scheduled but the outlet flagged a few items critically low, only those go", "Blank on-hand can be treated as 0, but a sheet the outlet never touched is always skipped"] },
      { stage: "3 · Extras and overrides (optional)", branches: ["Additional items per outlet, each on its own voucher", "Quantity overrides and NA / skip", "Bread: the factory's whole bread holding is split across outlets in proportion to their ideal", "Stationery and small ware are sent exactly as ordered"] },
      { stage: "Generate all sheets", detail: "Per-outlet order sheets, Dry Store / PM / HK challans, chiller summary, bread order message and the PACT import file. Validate only does a dry run first." },
      { stage: "Save and send", detail: "Download as Excel or a ZIP, or save straight into the connected folder." },
    ],
    notes: [
      "Items not in the PACT Product Master still go on the challan but are left out of the PACT import and listed in the Validation Report.",
      "Use ⚡ Sync Product Master from PACT if a new item was added in PACT today.",
      "Reference files and product links are saved centrally, so another laptop sees the same setup.",
    ],
    tech: {
      stack: "Static app (public/outlet-dispatch/index.html, v6.2) · Supabase · EC2 PACT worker",
      nodes: [
        { stage: "In-browser processing", detail: "Outlet sheets are parsed with SheetJS inside the tab; outputs are generated client-side and saved via the File System Access API or downloaded." },
        { stage: "GET /api/product-master", detail: "Product Master from the `costing_snapshots` pm snapshot (shared with every tool)." },
        { stage: "Sync Product Master", detail: "POST /api/sync-costing?report=pm → `pact_jobs` row → EC2 worker runs scripts/sync-costing-pm.js → new snapshot.", edge: "Realtime" },
        { stage: "/js/sync-refresh.js", detail: "One Supabase Realtime channel per page; reloads the master when a sync lands. Disconnects after 2 min hidden, reconnects on focus; a 5-minute safety poll covers missed events." },
        { stage: "/api/dispatch-ref", detail: "Stores the reference files and the product-to-master links (PLINK) as one JSON row, so they aren't lost when the browser cache is cleared." },
      ],
      data: [
        { name: "dispatch_ref", what: "Single row: reference files (base64) + product link overrides" },
        { name: "costing_snapshots (pm)", what: "PACT Product Master" },
        { name: "pact_jobs", what: "Product Master sync requests" },
      ],
      troubleshoot: [
        "Item shows as not an ERP item: sync the Product Master, then re-link it if the name differs.",
        "Wrong voucher numbers in the import: check the starting voucher number in step 2.",
        "Reference file looks old: Load a newer file, or check the date folder doesn't carry its own older copy.",
      ],
    },
  },
  salesorder: {
    title: "Sales Order (barcode scan)",
    mode: "Semi-automated",
    schedule: "Inventory on schedule + Sync now · scanning on demand",
    users: "Dispatch floor, with the Honeywell scanner",
    tasks: ["Live inventory", "GS1 barcode scan", "Shared order", "PACT push (scanner app)"],
    about:
      "The scan-to-order screen. Packed goods carry GS1 barcodes; scanning one pulls its product, batch, manufacture and expiry dates, and the live PACT stock for that batch, so every order line carries the right batch and price without typing. The same order is shared live with the Android scanner app.",
    overview: [
      { stage: "Live PACT inventory loads", detail: "Batch, warehouse, quantity, price and expiry for every item. Sync inventory from PACT fetches a fresh copy; Load last synced shows the latest saved one." },
      { stage: "Scan each item", detail: "The barcode gives the product code, batch, manufacture and expiry dates. Plain product codes or names work too. The line is matched to that batch in inventory." },
      { stage: "Order builds up", detail: "Each line shows product, HSN, warehouse, unit level, quantity, unit price, sales rate, GST type, batch and dates. Scans from the scanner app appear here within seconds, and the other way round." },
      { stage: "Push to PACT from the scanner app", branches: ["B2B customer → Factory Sales Invoice", "NutrioBox outlet → Stock Outward to Outlet"], edge: "PACT document is filled, then posted by the operator" },
    ],
    notes: [
      "If live inventory isn't available, import PACT's BatchWise Stock Analysis (.xls) instead.",
      "Clear order empties the shared order for everyone, so use it only when the order is done.",
    ],
    tech: {
      stack: "React (SalesOrderScan in Dashboard.tsx) · Supabase · EC2 PACT worker (Playwright)",
      nodes: [
        { stage: "Inventory", detail: "Reads the latest `inventory_snapshots` row. Sync now → POST /api/sync-inventory → `pact_jobs` (__sync: inventory) → worker runs scripts/sync-inventory.js. The worker also refreshes it on a timer when INVENTORY_CRON=1 (default every 15 min)." },
        { stage: "parseScan", detail: "GS1-128 application identifiers: (01) GTIN, (11) manufacture date, (17) expiry, (10) batch; GS-separated. Falls back to a plain code or name." },
        { stage: "/api/order", detail: "`sales_order_lines`, scoped per sales order (so / soNumber). The page polls every 3 s, which is how app and web stay in step." },
        { stage: "Scanner app pushes", branches: ["POST /api/push-fsi → Factory Sales Invoice", "POST /api/push-stock-outward → Stock Outward to Outlet", "Both queue `pact_jobs`; the worker fills the PACT document and stops before Post by default (dryRun)"] },
        { stage: "/api/order-stock", detail: "Combines inventory with `pending_sales_orders` and `pending_outlet_requisitions`, so stock already promised is visible." },
      ],
      data: [
        { name: "inventory_snapshots", what: "PACT batch-wise stock" },
        { name: "sales_order_lines", what: "Scanned lines, per sales order" },
        { name: "pending_sales_orders / pending_outlet_requisitions", what: "Open demand from PACT" },
        { name: "pact_jobs", what: "Inventory syncs and PACT pushes" },
      ],
      troubleshoot: [
        "Scan not found: the batch isn't in the last snapshot; sync inventory and scan again.",
        "Push didn't appear in PACT: check the `pact_jobs` row status and error; dryRun pushes stop before Post by design.",
      ],
    },
  },
  costing: {
    title: "Factory Costing Dashboard",
    mode: "Automated",
    schedule: "Stock Inward every 3h · Process Flow 8 PM · Product Master + BOM 4 AM (IST)",
    users: "Management, costing, production",
    tasks: ["Rate Dashboard", "BOM Ideal", "Summary Ideal", "Batch Actual", "Excel export"],
    about:
      "What each product should cost against what it actually cost. Purchase rates, recipes and production records are pulled from PACT on a schedule, so the numbers stay current without anyone exporting reports by hand.",
    overview: [
      { stage: "PACT reports are pulled automatically", branches: ["Stock Inward (purchase rates): every 3 hours", "Process Flow (what each batch used and produced): every night at 8 PM", "Product Master + BOM (items and recipes): every morning at 4 AM"], edge: "or any time with 🔄 Sync PACT Reports" },
      { stage: "💰 Rate Dashboard", detail: "Latest purchase rate for every raw and packing material, with category rates and margin settings." },
      { stage: "📋 BOM Ideal", detail: "Each recipe line × its current rate, including the PACT wastage % (which can be adjusted and reset)." },
      { stage: "📊 Summary Ideal", detail: "Ideal cost per product. Costs can be approved; products can be marked inactive to keep the list clean." },
      { stage: "🏷️ Batch Actual (PACT)", detail: "From Process Flow: for each production batch, what was issued and what came out (FG number, units and quantity), per batch and per day." },
      { stage: "Compare and export", detail: "Gap between ideal and actual shows where cost is leaking. Download this sheet or all dashboards as Excel." },
    ],
    notes: [
      "A sync replaces the dates it covers instead of adding to them, so re-syncing never double-counts a day.",
      "Rate overrides and approvals are saved centrally and seen by everyone.",
      "Schedule times shown are the worker's defaults.",
    ],
    tech: {
      stack: "Static app (public/costing/index.html) · Supabase · EC2 Windows worker (service SukhnaWorker, C:\\sukhna-worker)",
      nodes: [
        { stage: "Scheduler (COSTING_CRON=1)", detail: "Inside pact-worker/worker.js. Queues `pact_jobs` with __sync costing-si every COSTING_SI_HOURS (3), costing-pf at COSTING_PF_HOUR (20), costing-pm + costing-bom at COSTING_MASTER_HOUR (4)." },
        { stage: "Job runner", detail: "Polls `pact_jobs` every 5 s and spawns the script for each job; 5-minute cap per job, 7-minute watchdog." },
        { stage: "scripts/sync-costing-{pf,pm,bom,si,bs}.js", detail: "Playwright logs into PACT, opens the report and captures its ReportDataSet response. scripts/lib/costing-report.js maps PACT's hashed column ids to captions by position, skipping the hidden \"Ver\" columns." },
        { stage: "Process Flow FG fields", detail: "_fgLeg takes FG No / Units / Qty from the FG section; it falls back to the Receipt section only for the old layout with no FG columns." },
        { stage: "Supabase `costing_snapshots`", detail: "One snapshot per report, served by GET /api/costing/<report>. On-demand sync: POST /api/sync-costing?report=…, then the page polls /api/pact-job?id=… until done." },
      ],
      data: [
        { name: "costing_snapshots", what: "pf, pm, bom, si and bs report snapshots" },
        { name: "costing_overrides", what: "Manual rates, approvals, inactive flags" },
        { name: "pact_jobs", what: "Scheduled and on-demand sync jobs" },
      ],
      troubleshoot: [
        "Sync says no ReportDataSet captured: PACT returned only its init stub; run the sync again.",
        "Batch figures look shifted: PACT changed the report's columns; check costing-report.js mapping.",
        "Nothing syncing at all: on EC2 check the SukhnaWorker service is running and look at its log.",
      ],
    },
  },
  consumption: {
    title: "Outlet Consumption",
    mode: "Semi-automated",
    schedule: "Outlet outward hourly · counts entered by outlets",
    users: "Ops / outlet managers, management",
    tasks: ["Masters & BOM", "Sales", "Opening inventory", "Ideal inventory", "Wastage", "Variance"],
    about:
      "Tracks every NutrioBox outlet's raw-material use. It combines what the factory sent, what the outlet sold (broken down through the recipes) and the outlet's own stock counts, to show what should be on the shelf against what is, and where the difference went.",
    overview: [
      { stage: "Masters", branches: ["🥕 Raw Material Master and 📋 Item Master from PACT", "🧮 FG → RM: each finished item broken into raw materials", "Mismatch views: in PACT but not PetPooja and the other way round; in BOM but not in the RM Master and the other way round"] },
      { stage: "What came in", detail: "📦 Purchase: stock sent from the factory to each outlet, synced from PACT every hour." },
      { stage: "What was sold", detail: "🧾 Sales API and 🍳 Sales Summary: outlet sales from the POS, turned into 🥬 RM Consumption through the recipes." },
      { stage: "Counts from the outlet", branches: ["📝 Opening Inventory count", "🗑 Wastage, approved with a one-time code emailed to the admin inbox", "📏 Loose denomination: which pack level (L1 / L2 / L3) is sold loose"] },
      { stage: "📊 Ideal Inventory", detail: "Opening + received − ideal usage − wastage = what should be there. Each run can be saved per outlet." },
      { stage: "📦 Closing Inventory and ⚖ Variance", detail: "Actual closing count against ideal, item by item." },
    ],
    notes: [
      "Wastage only counts once it's approved with the OTP (valid 10 minutes).",
      "Fix the mismatch lists first; an item missing from a recipe makes its usage look like variance.",
    ],
    tech: {
      stack: "Static app (public/outlet-consumption/index.html) · Supabase · EC2 worker · NutrioBox AI Food Inspector database",
      nodes: [
        { stage: "Masters", detail: "/api/product-master and /api/costing/bom (costing_snapshots); Sync uses /api/sync-costing and polls /api/pact-job." },
        { stage: "Outlet outward", detail: "/api/sync-outlet-outward queues the sync; the worker also runs it every OUTLET_OUTWARD_SYNC_MIN (60) minutes." },
        { stage: "/api/outlet-invoices", detail: "Reads orders × order_items × dishes × restaurants from the AI Food Inspector database, which the PetPooja webhook fills." },
        { stage: "Counts", branches: ["/api/opening-inventory → `opening_inventory_counts`", "/api/ideal-inventory → `ideal_inventory_snapshots` (full computed table per save)", "/api/outlet-wastage → `outlet_wastage_counts`", "/api/loose-denomination → `loose_denomination_state`"] },
        { stage: "Wastage OTP", detail: "POST /api/wastage-otp/send makes a 6-digit code, stores it hashed (one active per snapshot, 10-minute expiry) and emails it via Resend; verified by PATCH /api/ideal-inventory (stage wastage)." },
      ],
      data: [
        { name: "opening_inventory_counts", what: "Outlet opening counts" },
        { name: "ideal_inventory_snapshots", what: "Saved ideal-inventory runs per outlet" },
        { name: "outlet_wastage_counts", what: "Wastage entries" },
        { name: "wastage_approval_otps", what: "Hashed OTPs for wastage approval" },
        { name: "loose_denomination_state", what: "Which pack levels are sold loose" },
      ],
      troubleshoot: [
        "No sales for an outlet: check the PetPooja webhook is still reaching the AI Food Inspector.",
        "OTP email not arriving: check RESEND_API_KEY / RESEND_FROM and the WASTAGE_OTP_TO inbox.",
      ],
    },
  },
  salary: {
    title: "Salary Structure",
    mode: "Manual",
    schedule: "Monthly payroll · password protected",
    users: "HR / founder's office",
    tasks: ["Employee list", "Calculator", "Import register", "Slips", "HRMS export", "Compliance"],
    about:
      "The Allsure salary structure in one place: each employee's CTC split into components, statutory PF and ESIC applied, and the monthly register and salary slips produced from it. Every change is saved centrally with a backup trail.",
    overview: [
      { stage: "Unlock", detail: "The salary data is hidden behind a password; nothing renders until it's entered." },
      { stage: "Build or import", branches: ["Calculator: work out take-home pay for one employee and add them to the list", "Import last month's salary register", "Edit the employee list in place: add rows, move or delete selected"] },
      { stage: "Statutory rules applied", detail: "PF and ESIC worked out from the structure, including the effect of a wage-ceiling revision." },
      { stage: "Review", branches: ["Dashboard, headcount mix and cost centres", "Compliance calendar of statutory due dates"] },
      { stage: "Finalise and export", branches: ["Finalise the sheet for the month", "Salary slips (preview or download)", "Export register, summary, salary ladder or HRMS format"] },
    ],
    notes: [
      "Each save keeps a versioned backup, so an earlier state can be restored.",
      "Download the template before a first import so the columns line up.",
    ],
    tech: {
      stack: "Static app (public/salary/index.html) · Supabase",
      nodes: [
        { stage: "Password gate", detail: "Rendered inline before any salary content; the unlock is remembered in this browser." },
        { stage: "In-browser engine", detail: "All salary calculations and exports run in the page." },
        { stage: "/api/salary-data", detail: "Saves the whole workbook as one JSON blob in `salary_data` and writes a copy to `salary_data_backups` on each save." },
      ],
      data: [
        { name: "salary_data", what: "Current salary workbook" },
        { name: "salary_data_backups", what: "Versioned copies of every save" },
      ],
      troubleshoot: [
        "Changes not showing on another laptop: reload; the page reads the latest saved version on open.",
        "Need an older version: restore from `salary_data_backups`.",
      ],
    },
  },
  closing: {
    title: "Closing Stock",
    mode: "Semi-automated",
    schedule: "Sync on demand · physical count at closing",
    users: "Stores, accounts, management",
    tasks: ["Stock Detail", "Batch-wise Stock", "Stock Valuation", "Physical count", "PACT Posting"],
    about:
      "The closing stock dashboard and physical stock count in one place. It loads PACT's batch-wise stock, lets the team enter what is actually on the shelf batch by batch, shows the excess or shortage and its value, and prepares the adjustment for PACT.",
    overview: [
      { stage: "Load PACT stock", branches: ["Opens with the latest PACT sync from the website (or the data built into the page if that is newer)", "⟳ Sync PACT pulls a fresh BatchWise StockAnalysis through the PACT worker", "Or drop an export, a product master or a handheld count file in Refresh data"] },
      { stage: "1 · Stock Detail and 2 · Batch-wise Stock", detail: "Every product, batch, warehouse and location with system quantity, UOM, manufacture and expiry dates. Filter by warehouse, location, category, group, product, UOM and expiry; search with Ctrl+F; switch between default UOM and base unit." },
      { stage: "Physical count", branches: ["Enter the actual quantity per batch, or fill selected lines in one go", "Add a batch found on the floor that PACT shows as nil", "Submit a product when its count is done; reopen it to recount"], edge: "difference = actual − system" },
      { stage: "3 · Stock Valuation", detail: "Quantities valued at the batch rate, with excess and shortage values. Records with an out-of-range quantity can be left out." },
      { stage: "4 · PACT Posting", detail: "Voucher details (doc date, location) and the sheet PACT expects (warehouse, product, unit, qty, batch, mfg, exp), downloaded as Excel or sent to a posting service. Saved batch-wise sheets are kept for reference." },
      { stage: "Export", detail: "Any report with the current filters and columns, to Excel or copied for Excel." },
    ],
    notes: [
      "Counts, submissions and settings are saved in this browser only. Finish a count on one computer, or export it, before moving to another.",
      "A sync service address in Settings overrides the website sync; leave it blank on the website.",
      "Product groups and HSN come from the product master built into the page; drop a newer master in Refresh data if they change.",
    ],
    tech: {
      stack: "Static app (public/closing-stock/index.html, Closing Stock Dashboard v11) · Supabase · EC2 PACT worker",
      nodes: [
        { stage: "Embedded payload", detail: "The page carries a full BatchWise StockAnalysis + product master snapshot (script#payload), so it works even with no connection." },
        { stage: "On open: GET /api/costing/bs", detail: "If the website snapshot is newer than the embedded one, rebuild() swaps it in. Header row is the same BatchWise StockAnalysis layout (Batch Number, Doc No, Location, Warehouse, Doc Date, Product Code, Product Name, Units, Quantity, Rate, Value, Exp. Date, Mfg. Date)." },
        { stage: "⟳ Sync PACT", detail: "POST /api/sync-costing?report=bs → `pact_jobs` row → worker runs scripts/sync-costing-bs.js → page polls /api/pact-job?id=… every 3 s (10-minute limit) → reloads /api/costing/bs.", edge: "if a sync service address is set" },
        { stage: "Local fallback", detail: "The original start.bat service: POST {address}/sync, poll /status, then /stock.json or /stock." },
        { stage: "Browser storage", detail: "localStorage keeps view preferences and the count (actual quantities, submissions, added batches, saved sheets, voucher settings)." },
        { stage: "Posting", detail: "Voucher sheet built in the browser with SheetJS; optional POST to the posting service address in Settings." },
      ],
      data: [
        { name: "costing_snapshots (bs)", what: "Latest PACT BatchWise StockAnalysis" },
        { name: "pact_jobs", what: "Sync requests from the Sync PACT button" },
        { name: "localStorage (browser)", what: "Counts, submissions, saved sheets, settings" },
      ],
      troubleshoot: [
        "Sync says it could not start: check you're signed in to the dashboard, then try again.",
        "Sync runs past 10 minutes: check the SukhnaWorker service on EC2.",
        "Counts missing on another computer: they live in the browser where they were entered.",
      ],
    },
  },
  pmr: {
    title: "Sukhna PMR",
    mode: "Automated",
    schedule: "On demand; the PACT robot posts within minutes",
    users: "Production planning, factory supervisors",
    tasks: ["Plan a day", "Live BOMs", "Sec Pack cartons", "Submit to PACT", "Track Job / PMR numbers"],
    about:
      "Plan a production day and let the PACT robot enter it. Each product becomes a Job and each batch a Production Material Request (PMR), with the BOM's Stage 1 and Stage 2 materials, so nobody types jobs or PMRs into PACT by hand. Same as the Sukhna PMR phone app; both send to the same queue.",
    overview: [
      { stage: "Pick the production date", detail: "Today, tomorrow or any date from the calendar." },
      { stage: "Add products", detail: "From the live PACT BOM feed. Set S1 / S2 quantity, batches, and Sec Pack YES to add the carton BOM automatically." },
      { stage: "Submit to PACT", detail: "The plan is queued; the same plan submitted twice is only queued once.", edge: "PACT robot on the PACT server" },
      { stage: "Robot posts it", branches: ["Creates the day's group '<date> Created by AI' if it isn't there", "Creates each Job, named 'Created by AI - <product> <date> <N>BATCH'", "Posts one PMR per batch"] },
      { stage: "Track on Submitted", detail: "Status, progress, Job No and PMR numbers per batch; refreshes itself while anything is running." },
    ],
    notes: [
      "The robot only works while nobody is connected to the PACT server's remote desktop; while someone is, submissions wait as 'queued'.",
      "An error on a submission shows PACT's reason; fix it in PACT, then re-queue it from the server.",
    ],
    tech: {
      stack: "Static app (public/pmr/index.html) · Supabase · PACT robot on the EC2 Windows server",
      nodes: [
        { stage: "GET /api/costing/bom", detail: "PACT 'Stage wise BOM' snapshot from `costing_snapshots`; the page builds the BOM list (same code as the app's bom.ts)." },
        { stage: "POST /api/pmr-inbox", detail: "Inserts a `production_jobs` row (queued) with the Jobs and batch PMRs; a dedupe key stops double submits." },
        { stage: "pmr_watcher.py + pmr_agent.py", detail: "Claim the row, drive PACT (Jobs, then PMRs), and write the result and progress back." },
        { stage: "GET /api/pmr-status", detail: "Latest 50 submissions with status, note and result for the Submitted tab." },
      ],
      data: [
        { name: "production_jobs", what: "One row per submission: payload (jobs, pmrs), status, progress note, result (Job / PMR numbers)" },
        { name: "costing_snapshots (bom)", what: "PACT stage-wise BOM feed" },
      ],
      troubleshoot: [
        "Stuck on 'queued': someone is connected to the PACT server, the server is stopped, or the robot isn't running.",
        "No BOMs listed: the BOM snapshot hasn't synced; sync it from the Costing dashboard.",
        "Same plan says 'Already queued': it was submitted before; change it or check the Submitted tab.",
      ],
    },
  },
  dispatchReport: {
    title: "Dispatch Report",
    mode: "Automated",
    schedule: "Sources synced from PACT · report always live",
    users: "Dispatch, accounts, management",
    tasks: ["B2B invoices", "Outlet stock outward", "Scan orders", "CSV / Excel"],
    about:
      "Every dispatch out of the factory in one list, whether it went to a B2B customer, to a NutrioBox outlet, or was scanned out against an inventory order, so there's one place to answer what left, when and to whom.",
    overview: [
      { stage: "Three sources in one list", branches: ["B2B: PACT Detail Factory Sales Invoices", "NB: PACT Stock Outward to NutrioBox outlets", "Scan: inventory orders scanned out with the gun"] },
      { stage: "One row per document", detail: "Date, type, doc / order number, outlet or customer, number of items and status." },
      { stage: "Filter and search", detail: "Search by doc or outlet / customer, filter by type and date; page through with Prev / Next; Reset clears it." },
      { stage: "Export", detail: "CSV or Excel of what's on screen." },
    ],
    notes: [
      "The report shows when the B2B and NB data were last synced from PACT.",
    ],
    tech: {
      stack: "Next.js page (src/app/dispatch-report) · Supabase",
      nodes: [
        { stage: "GET /api/dispatch-report", detail: "Merges the three tables into rows { date, type, doc, party, items, status, source }, plus counts per source and last-synced times." },
        { stage: "Sources", branches: ["detail_fsi_snapshot ← /api/sync-detail-fsi (worker pulls PACT's Detail FSI report for the business day, 4 AM to 4 AM IST)", "outlet_dispatch_snapshot ← outlet-outward sync (hourly on the worker)", "inventory_orders ← scanner app via /api/inventory-orders"] },
        { stage: "Export", detail: "exportCsv / exportXlsx in the browser." },
      ],
      data: [
        { name: "detail_fsi_snapshot", what: "B2B factory sales invoices" },
        { name: "outlet_dispatch_snapshot", what: "Outlet stock-outward invoices" },
        { name: "inventory_orders", what: "Scan-to-dispatch orders" },
      ],
      troubleshoot: [
        "B2B or NB rows missing for today: check the last-synced time and trigger that sync.",
      ],
    },
  },
};

// `name` in content strings renders as inline code (table, route or file names).
function fmt(t: string) {
  return t.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));
}

function Flow({ nodes }: { nodes: FlowNode[] }) {
  return (
    <div className="ti-flow">
      {nodes.map((n, i) => (
        <div key={i} className="ti-step">
          <div className="ti-box">
            <div className="ti-stage">{fmt(n.stage)}</div>
            {n.detail && <div className="ti-detail">{fmt(n.detail)}</div>}
            {n.branches && (
              <ul className="ti-branches">
                {n.branches.map((b, j) => (
                  <li key={j}><span className="ti-tree">{j === n.branches!.length - 1 ? "└──" : "├──"}</span>{fmt(b)}</li>
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
          {tab === "overview" ? (
            <>
              <div className="ti-about">
                <p>{info.about}</p>
                <div className="ti-users"><b>Used by</b> {info.users}</div>
              </div>
              <h3 className="ti-h">How it works</h3>
              <Flow nodes={info.overview} />
              {info.notes.length > 0 && (
                <>
                  <h3 className="ti-h">Good to know</h3>
                  <ul className="ti-list">{info.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
                </>
              )}
            </>
          ) : (
            <>
              <div className="ti-stack"><b>Stack</b> {info.tech.stack}</div>
              <h3 className="ti-h">Flow</h3>
              <Flow nodes={info.tech.nodes} />
              <h3 className="ti-h">Where the data lives</h3>
              <table className="ti-table">
                <tbody>{info.tech.data.map((d) => <tr key={d.name}><td><code>{d.name}</code></td><td>{d.what}</td></tr>)}</tbody>
              </table>
              <h3 className="ti-h">When something goes wrong</h3>
              <ul className="ti-list">{info.tech.troubleshoot.map((n, i) => <li key={i}>{fmt(n)}</li>)}</ul>
            </>
          )}
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
