// Live sync: PACT "Process Flow Report" -> costing_snapshots (report='pf').
// Feeds the dashboard's Batch Actual tab (per-batch actual cost).
//
// Browser-driven by scripts/lib/costing-report.js — logs into PACT, opens
// BI -> List of Reports -> "Process Flow Report", picks the last 10 days
// (DATE_DAYS.pf in the runner), hits Select All on cost centers + OK, and
// intercepts the ReportDataSet response.
//
// PACT ships the Process Flow data columns keyed by stable, opaque hash
// IDs (verified 2026-10-24 against two separate runs) instead of readable
// captions. The runner's generic DOM-caption fallback only picked up the
// visible portion of PACT's virtualised grid and misaligned by 3 columns,
// so we hardcode the known hash -> caption map here. Captions beyond the
// confirmed positions still fall through to the DOM grabber. Add new
// mappings whenever a new PACT column is observed.

const { runCostingReport } = require('./lib/costing-report');

const HEADERS = [
  'JOB','Production Date','Batch Allocation','Product Code','Product Name',
  'Warehouse',
  'Request No','Request Unit','Request Qty',
  'Issue No','Issue Units','Issue Qty',
  // Keep the older RM/PM/FG shape too so parsePF resolves either leg.
  'RM Units','RM Qty','PM Unit','PM Qty','FG No','FG Units','FG Qty',
];

// Hash -> caption map for the Process Flow Report's ReportDataSet columns.
// The first 12 entries are confirmed hash IDs from sample row values.
const HASH_TO_CAPTION = {
  'C2d5a5a8e333842e483179f38b98765b9':    'JOB',                 // String — "65 MASALA (1 KG) 21-10-2..."
  'C683b960c1bc541a898ad9625279df716':    'Production Date',     // DateTime — "2026-10-21T00:00:00"
  'C853f7a71e5bb41b098f1db0f3756a062':    'Batch Allocation',    // String — "Batch 1"
  'Ccf3efdc914c84481921abb41522d777b':    'Product Code',        // String — "RM0024"
  'C653d5c4beb974034bba9004366d9813f':    'Product Name',        // String — "Curd (Dahi)"
  'C382b2ad7c70147f892bd63f9b8e281ef':    'Warehouse',           // String — "Dairy Chiller"
  'C08874c09c724436d88e0279eb00d80a3':    'Request No',          // String — "PMR-26-27/8813"
  'C08874c09c724436d88e0279eb00d80a3Ver': 'Request No Ver',      // Int32 — hidden doc version
  'C9d68e1edae6b44038db15fe383e7c7f7':    'Request Unit',        // String
  'C497eb3b21bd94e6ea2f23c45ac3ee766':    'Request Qty',         // Double
  'C262c31ad91e84b72a7de5cec6049a781':    'Issue No',            // String
  'Cb4e4428615ff4783b3ae0be8e2027c55':    'Issue Units',         // String
};

// Positional captions zipped with json.Columns[0]. Verified from the
// 2026-10-24 full-row diagnostic log (sample row 0 captured every column
// with its PACT label). This covers positions 12-36 — the FG columns live
// at 25-27, and the Receipt leg (where FG receipt amounts land for FG
// output rows) at 13-15.
const POSITIONAL_CAPTIONS = [
  'JOB',               // 0
  'Production Date',   // 1
  'Batch Allocation',  // 2
  'Product Code',      // 3
  'Product Name',      // 4
  'Warehouse',         // 5
  'Request No',        // 6
  'Request No Ver',    // 7  (hidden Int32)
  'Request Unit',      // 8
  'Request Qty',       // 9
  'Issue No',          // 10
  'Issue Units',       // 11
  'Issue Qty',         // 12
  'Receipt No',        // 13  — PACT uses this leg for FG receipts
  'Receipt Units',     // 14
  'Receipt Qty',       // 15
  'RM Issue No',       // 16
  'RM Units',          // 17
  'RM Qty',            // 18
  'WIP No',            // 19
  'WIP Unit',          // 20
  'WIP Qty',           // 21
  'PM Issue No',       // 22
  'PM Unit',           // 23
  'PM Qty',            // 24
  'FG No',             // 25
  'FG Units',          // 26
  'FG Qty',            // 27
  'Excess No',         // 28
  'Excess Units',      // 29
  'Excess Qty',        // 30
  'Secondary No',      // 31
  'Secondary Unit',    // 32
  'Secondary Qty',     // 33
  'Scrap No',          // 34
  'Scrap Unit',        // 35
  'Scrap Qty',         // 36
];

const COLMAP = {
  'JOB':              ['JOB','Job','JobNo'],
  'Production Date':  ['Production Date','ProductionDate','ProdDate','Date','ProductionDt'],
  'Batch Allocation': ['Batch Allocation','BatchAllocation','Batch','BatchNo'],
  'Product Code':     ['Product Code','ProductCode','Code'],
  'Product Name':     ['Product Name','ProductName','Name'],
  'Warehouse':        ['Warehouse','WarehouseName','WHName'],
  'Request No':       ['Request No','RequestNo','ReqNo'],
  'Request Unit':     ['Request Unit','RequestUnit','ReqUnit'],
  'Request Qty':      ['Request Qty','RequestQty','ReqQty'],
  'Issue No':         ['Issue No','IssueNo'],
  'Issue Units':      ['Issue Units','IssueUnits','IssueUnit'],
  'Issue Qty':        ['Issue Qty','IssueQty'],
  // Backward-compat aliases for parsePF's legacy RM/PM/FG column names.
  //
  // Critical mapping (verified 2026-10-24 after a full capture ran clean):
  // PACT's Process Flow Report splits every batch event into ~8 legs per
  // row (Request / Issue / Receipt / RMIssue / WIP / PMIssue / FG / Excess
  // / Secondary / Scrap). Only one leg is populated per row.
  //   - RM issuance rows: Request leg filled, Receipt/FG columns = null
  //   - FG receipt rows:  Receipt leg filled, Request/Issue columns = null
  // parsePF's FG detection ("fgq>0 && r[iFn]") only fires when the FG leg
  // is populated — but PACT NEVER populates the dedicated FG leg; FG qty
  // and doc number live in the Receipt leg instead. Map FG No -> Receipt
  // No and FG Qty -> Receipt Qty so parsePF catches the batch's FG output.
  'RM Units':         ['RM Units','Request Unit','RequestUnit'],
  'RM Qty':           ['RM Qty','Request Qty','RequestQty'],
  'PM Unit':          ['PM Unit','PMUnit','PackUnit'],
  'PM Qty':           ['PM Qty','PMQty','PackQty'],
  'FG No':            ['Receipt No','FG No','Issue No','IssueNo'],
  'FG Units':         ['Receipt Units','FG Units','Issue Units','IssueUnits'],
  'FG Qty':           ['Receipt Qty','FG Qty','Issue Qty','IssueQty'],
};

runCostingReport({ report: 'pf', headers: HEADERS, colmap: COLMAP, hashCaptionMap: HASH_TO_CAPTION, positionalCaptions: POSITIONAL_CAPTIONS });
