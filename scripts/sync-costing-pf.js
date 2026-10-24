// Live sync: PACT "Process Flow Report" -> costing_snapshots (report='pf').
// Feeds the dashboard's Batch Actual tab (per-batch actual cost).
//
// Browser-driven by scripts/lib/costing-report.js — logs into PACT, opens
// BI -> List of Reports -> "Process Flow Report", picks the last 10 days
// (DATE_DAYS.pf in the runner), hits Select All on cost centers + OK, and
// intercepts the ReportDataSet response. No recorded request body is
// needed — the earlier BODY_B64 param is a historical leftover and is
// ignored by the runner.

const { runCostingReport } = require('./lib/costing-report');

const HEADERS = ['JOB','Production Date','Batch Allocation','Product Code','Product Name','RM Units','RM Qty','PM Unit','PM Qty','FG No','FG Units','FG Qty'];

// PACT's Process Flow Report ReportDataSet keys (verified against the live
// response fields visible in the ERP: JOB, Production Date, Batch Allocation,
// Product Code, Product Name, Warehouse, Request No, Request Unit, Request Qty,
// Issue No, Issue Units, Issue Qty). Several of these are the "Request/Issue"
// legs of the batch — PACT's convention is Request = planned, Issue = actual,
// so we map RM Qty <- RequestQty (planned raw material) and FG Qty <- IssueQty
// (actual output). If PACT renames a column, extend the candidate list here.
const COLMAP = {
  'JOB':              ['JOB','Job','JobNo'],
  'Production Date':  ['ProductionDate','ProdDate','Date','ProductionDt'],
  'Batch Allocation': ['BatchAllocation','Batch','BatchNo'],
  'Product Code':     ['ProductCode','Code'],
  'Product Name':     ['ProductName','Name'],
  'RM Units':         ['RequestUnit','RMUnits','RMUnit','RawUnits','ReqUnit'],
  'RM Qty':           ['RequestQty','RMQty','RawQty','ReqQty'],
  'PM Unit':          ['PMUnit','PMUnits','PackUnit'],
  'PM Qty':           ['PMQty','PackQty'],
  'FG No':            ['IssueNo','FGNo','FGNumber'],
  'FG Units':         ['IssueUnits','IssueUnit','FGUnits','FGUnit'],
  'FG Qty':           ['IssueQty','FGQty'],
};

runCostingReport({ report: 'pf', headers: HEADERS, colmap: COLMAP });
