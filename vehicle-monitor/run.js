const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { downloadViaApi } = require('./lib/download-api');
const { buildSummary, writeTargetExcel } = require('./lib/transform');
const { uploadToSupabase } = require('./lib/upload');

(function loadEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
})();

async function main() {
  const outDir = path.join(__dirname, 'downloads');
  fs.mkdirSync(outDir, { recursive: true });
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  // Local-test mode:  node run.js --file report.xlsx   (skips the portal download)
  const fileArg = process.argv.indexOf('--file');
  let sourceXlsx;
  if (fileArg > -1) {
    sourceXlsx = process.argv[fileArg + 1];
    console.log('Using local file:', sourceXlsx);
  } else {
    console.log('Fetching tracker data via OneLap API...');
    sourceXlsx = await downloadViaApi(outDir);
    console.log('Source report:', sourceXlsx);
  }

  console.log('Building summary' + (apiKey ? ' (with Google road names)' : ' (no Google key -> raw coords)') + '...');
  const rows = await buildSummary(sourceXlsx, apiKey);
  console.log(`Produced ${rows.length} trip rows.`);
  console.table(rows.map(r => ({ Veh: r['Vehicle No.'], From: r['Start Destination'], To: r['Finished Destination'],
    Dispatch: r['Dispatch Time'], Travel: r['Total Travel Time '], Remarks: r['Remarks'] })));

  const _rd = process.env.REPORT_DATE || (() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`; })();
  const outXlsx = path.join(outDir, `report-${_rd}.xlsx`);
  writeTargetExcel(rows, outXlsx);
  console.log('Wrote:', outXlsx);

  // Upload to Supabase so it shows on the operations website
  const now = new Date();
  const runDate = process.env.REPORT_DATE ||
    `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  try {
    const n = await uploadToSupabase(rows, runDate);
    if (n >= 0 && process.env.SUPABASE_URL) console.log(`Uploaded ${n} rows to the website for ${runDate}.`);
  } catch (e) { console.error('Website upload failed:', e.message); }
}

main().catch((e) => { console.error(e); process.exit(1); });
