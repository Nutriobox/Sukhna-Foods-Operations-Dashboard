// Live sync: PACT "Batch Wise Stock Analysis" -> costing_snapshots (report='bs').
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
// TODO(activation): fill each from the first run's logged keys.
const COLMAP = {
  'Batch Number': [],
  'Doc No':       [],
  'Location':     [],
  'Warehouse':    [],
  'Doc Date':     [],
  'Product Code': [],
  'Product Name': [],
  'Units':        [],
  'Quantity':     [],
  'Rate':         [],
  'Value':        [],
  'Exp. Date':    [],
  'Mfg. Date':    [],
};

runCostingReport({ report: 'bs', headers: HEADERS, colmap: COLMAP });
