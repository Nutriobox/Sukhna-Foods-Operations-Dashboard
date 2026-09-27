// Live sync: PACT "Product Master Report" -> costing_snapshots (report='pm').
// Feeds the dashboard's Rate Dashboard, L1/L2/L3 conversions and Product Packing.
//
// TO ACTIVATE: run record-costing.bat, open the Product Master report and Export,
// then use `node scripts/extract-costing-body.js pact-costing-pm.har` to print the
// base64 ReportDataSet body + the real Tables[0] keys. Paste the body into BODY_B64
// and confirm/adjust COLMAP candidates against the printed keys. See COSTING-LIVE-SYNC.md.

const { runCostingReport } = require('./lib/costing-report');

const BODY_B64 = ''; // <-- paste the recorded ReportDataSet request body (base64)

const HEADERS = ['Product Code','Product Name','L1Unit','L2Unit','L2ConversionRate','L3Unit','L3ConversionRate','Rate','Inventory Category','DefaultBarcodePrintUOM'];

const COLMAP = {
  'Product Code':            ['ProductCode','Code'],
  'Product Name':            ['ProductName','Name'],
  'L1Unit':                  ['L1Unit','L1'],
  'L2Unit':                  ['L2Unit','L2'],
  'L2ConversionRate':        ['L2ConversionRate','L2Conversion','L2Rate'],
  'L3Unit':                  ['L3Unit','L3'],
  'L3ConversionRate':        ['L3ConversionRate','L3Conversion','L3Rate'],
  'Rate':                    ['Rate','PurchaseRate','StdRate'],
  'Inventory Category':      ['InventoryCategory','Category','ItemCategory'],
  'DefaultBarcodePrintUOM':  ['DefaultBarcodePrintUOM','DefaultPrintUOM','PrintUOM'],
};

runCostingReport({ report: 'pm', bodyB64: BODY_B64, headers: HEADERS, colmap: COLMAP });
