// Live sync: PACT "BatchWise StockAnalysis" -> costing_snapshots (report='bs').
// Feeds the costing dashboard's Closing Stock view (batch-wise on-hand stock,
// then valued with the dashboard's own rates). Driven through the BI UI exactly
// like the other costing reports (see scripts/lib/costing-report.js).
//
// ACTIVATION (one-time, same as si/pf were): the encrypted ReportDataSet column
// IDs below are report-specific and only visible from a live run. Run this once
// (Live Sync, or `node scripts/sync-costing-bs.js` on the worker); the run log
// prints the captured column keys + an unmapped-header report. Paste the C-ids
// into COLMAP (match by the sample values the log shows), then re-run. Until
// COLMAP is filled the snapshot stores rows the dashboard can read but without
// resolved columns.

const { runCostingReport } = require('./lib/costing-report');

// Column order as the report exports it (BatchWise StockAnalysis, verified from
// the sample export 2026-11-04).
const HEADERS = [
  'Batch Number', 'Doc No', 'Location', 'Warehouse', 'Doc Date',
  'Product Code', 'Product Name', 'Units', 'Quantity', 'Rate',
  'Value', 'Exp. Date', 'Mfg. Date',
];

// display name -> [encrypted ReportDataSet column id(s)].
// Filled from the live run on 2026-11-04 (matched by sample values in the log).
const COLMAP = {
  'Batch Number': ['BatchNumber'],
  'Doc No':       ['DocNo'],
  'Location':     ['C1670fcbc94be45dd93f038ac5a9b9b9b'],
  'Warehouse':    ['Cadd9f5d435664ce4b1f2e58b7a15cf50'],
  'Doc Date':     ['DocDate'],
  'Product Code': ['C40b7055b92a44fa68fb58e1f2d10d918'],
  'Product Name': ['ProductName'],
  'Units':        ['Cb496c39c630742db9682b044774518c3'],
  'Quantity':     ['Quantity'],
  'Rate':         ['Rate'],
  'Value':        ['Value'],
  'Exp. Date':    ['ExpDate'],
  'Mfg. Date':    ['MfgDate'],
};

runCostingReport({ report: 'bs', headers: HEADERS, colmap: COLMAP });
