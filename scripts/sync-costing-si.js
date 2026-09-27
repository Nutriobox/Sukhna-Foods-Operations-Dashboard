// Live sync: PACT "List Of Stock Inward Reports" -> costing_snapshots (report='si').
// Feeds the dashboard's Rate Dashboard: Last Purchase Price & Last Purchase Date.
//
// TO ACTIVATE: record + Export the Stock Inward report, then
// `node scripts/extract-costing-body.js pact-costing-si.har` and fill BODY_B64 / COLMAP.
// See COSTING-LIVE-SYNC.md.

const { runCostingReport } = require('./lib/costing-report');

const BODY_B64 = ''; // <-- paste the recorded ReportDataSet request body (base64)

const HEADERS = ['Doc No','Doc Date','Account Name','Product Code','Base Qty','PurchaseRate','Value'];

const COLMAP = {
  'Doc No':        ['DocNo','VoucherNo','DocumentNo'],
  'Doc Date':      ['DocDate','VoucherDate','Date'],
  'Account Name':  ['AccountName','Vendor','SupplierName','PartyName'],
  'Product Code':  ['ProductCode','Code'],
  'Base Qty':      ['BaseQty','BaseQuantity','Qty'],
  'PurchaseRate':  ['PurchaseRate','Rate'],
  'Value':         ['Value','StockValue','Amount'],
};

runCostingReport({ report: 'si', bodyB64: BODY_B64, headers: HEADERS, colmap: COLMAP });
