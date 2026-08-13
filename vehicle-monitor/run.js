const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { downloadReport } = require('./lib/download-report');
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
    const headless = String(process.env.HEADLESS).toLowerCase() === 'true';
    const browser = await chromium.launch({ headless });
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true });
    const page = await ctx.newPage();
    console.log('Downloading tracker report...');
    sourceXlsx = await downloadReport(page, outDir);
    await ctx.close(); await browser.close();
    console.log('Downloaded:', sourceXlsx);
  }

  console.log('Building summary' + (apiKey ? ' (with Google road names)' : ' (no Google key -> raw coords)') + '...');
  const rows = await buildSummary(sourceXlsx, apiKey);
  console.log(`Produced ${rows.length} trip rows.`);
  console.table(rows.map(r => ({ Veh: r['Vehicle No.'], From: r['Start Destination'], To: r['Finished Destination'],
    Dispatch: r['Dispatch Time'], Travel: r['Total Travel Time '], Remarks: r['Remarks'] })));

  const outXlsx = path.join(outDir, `movement-summary-${Date.now()}.xlsx`);
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
