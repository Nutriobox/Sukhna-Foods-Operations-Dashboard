// Live sync: PACT "Stage Wise BOM With Wastage Summary" -> costing_snapshots (report='bom').
// Feeds the dashboard's BOM Ideal and Summary Ideal tabs.
//
// TO ACTIVATE: record + Export the Stage-wise BOM report, then
// `node scripts/extract-costing-body.js pact-costing-bom.har` and fill BODY_B64 / COLMAP.
// See COSTING-LIVE-SYNC.md. NOTE: this report is ~23k rows — the largest of the four.

const { runCostingReport } = require('./lib/costing-report');

const BODY_B64 = ''; // <-- paste the recorded ReportDataSet request body (base64)

const HEADERS = ['Section','Stage','BOMCode','BOM','Product Code','Product Name','Unit','Usage Qty','Wastage','Raw Qty','OPQty'];

const COLMAP = {
  'Section':       ['Section','Sec'],
  'Stage':         ['Stage'],
  'BOMCode':       ['BOMCode','BomCode'],
  'BOM':           ['BOM','BOMName','BomName'],
  'Product Code':  ['ProductCode','Code'],
  'Product Name':  ['ProductName','Name'],
  'Unit':          ['Unit','UOM'],
  'Usage Qty':     ['UsageQty','Usage'],
  'Wastage':       ['Wastage','WastagePct','WastageQty'],
  'Raw Qty':       ['RawQty','Raw'],
  'OPQty':         ['OPQty','OutputQty','OpQty'],
};

runCostingReport({ report: 'bom', bodyB64: BODY_B64, headers: HEADERS, colmap: COLMAP });
