// Live sync: PACT "Process Flow Report" -> costing_snapshots (report='pf').
// Feeds the dashboard's Batch Actual tab (per-batch actual cost). Runs daily.
//
// TO ACTIVATE: record + Export the Process Flow report, then
// `node scripts/extract-costing-body.js pact-costing-pf.har` and fill BODY_B64 / COLMAP.
// See COSTING-LIVE-SYNC.md. The template date is auto-set to today (IST) at run time.

const { runCostingReport } = require('./lib/costing-report');

const BODY_B64 = ''; // <-- paste the recorded ReportDataSet request body (base64)

const HEADERS = ['JOB','Production Date','Batch Allocation','Product Code','Product Name','RM Units','RM Qty','PM Unit','PM Qty','FG No','FG Units','FG Qty'];

const COLMAP = {
  'JOB':              ['JOB','Job','JobNo'],
  'Production Date':  ['ProductionDate','ProdDate','Date'],
  'Batch Allocation': ['BatchAllocation','Batch','BatchNo'],
  'Product Code':     ['ProductCode','Code'],
  'Product Name':     ['ProductName','Name'],
  'RM Units':         ['RMUnits','RMUnit','RawUnits'],
  'RM Qty':           ['RMQty','RawQty'],
  'PM Unit':          ['PMUnit','PMUnits','PackUnit'],
  'PM Qty':           ['PMQty','PackQty'],
  'FG No':            ['FGNo','FGNumber'],
  'FG Units':         ['FGUnits','FGUnit'],
  'FG Qty':           ['FGQty'],
};

runCostingReport({ report: 'pf', bodyB64: BODY_B64, headers: HEADERS, colmap: COLMAP });
