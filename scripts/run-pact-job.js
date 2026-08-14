// GitHub Actions entrypoint: runs the full PACT push for one bill using a REAL
// Chromium (full playwright), reusing the same login/GGE/StockInward modules.
// Reads the bill from BILL_JSON, updates job status in Supabase.
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const { login } = require('../src/lib/pact/login');
const { createGoodsGateEntry } = require('../src/lib/pact/gge');
const { createStockInward } = require('../src/lib/pact/stock-inward');

const JOB_ID = process.env.JOB_ID || '';
const DRY_RUN = String(process.env.DRY_RUN || 'false').toLowerCase() === 'true';
let bill = {};
try { bill = JSON.parse(process.env.BILL_JSON || '{}'); } catch (e) { console.error('Bad BILL_JSON', e.message); }

const sb = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

async function setStatus(patch) {
  if (!sb || !JOB_ID) return;
  try { await sb.from('pact_jobs').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', JOB_ID); }
  catch (e) { console.log('status update failed:', e.message); }
}

(async () => {
  if (!process.env.PACT_PASSWORD && process.env.PACT_PASS) process.env.PACT_PASSWORD = process.env.PACT_PASS;
  if (!bill.items || !bill.items.length) { console.error('No bill items'); process.exit(1); }

  console.log(`Running PACT push for ${bill.vendor} / ${bill.billNo} (${bill.items.length} items), dryRun=${DRY_RUN}`);
  await setStatus({ status: 'processing' });

  const browser = await chromium.launch({ headless: true, args: ['--window-size=1920,1080'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  page.setDefaultTimeout(45000);

  // Save a screenshot + HTML dump so we can see what the headless browser saw.
  const fs = require('fs');
  const DEBUG_DIR = '/tmp/pact-debug';
  try { fs.mkdirSync(DEBUG_DIR, { recursive: true }); } catch {}
  async function dumpDebug(tag) {
    try { await page.screenshot({ path: `${DEBUG_DIR}/${tag}.png`, fullPage: true }); } catch {}
    try { fs.writeFileSync(`${DEBUG_DIR}/${tag}.html`, await page.content()); } catch {}
    try { console.log(`[debug ${tag}] url=${page.url()} title=${await page.title()}`); } catch {}
  }

  try {
    await login(page);
    console.log('Logged in.');
    await dumpDebug('after-login');
    const gge = await createGoodsGateEntry(page, bill, { dryRun: DRY_RUN });
    const grn = gge && gge.grn ? gge.grn : '';
    console.log('GGE done, GRN =', grn || '(none)');
    if (!DRY_RUN && !grn) throw new Error('GGE posted but GRN was not captured');
    await createStockInward(page, bill, { dryRun: DRY_RUN, targetGrn: grn });
    console.log('Stock Inward done.');
    await setStatus({ status: 'done', grn, error: null });
    console.log('JOB DONE. GRN=' + grn);
  } catch (e) {
    const msg = String(e && e.message ? e.message : e).slice(0, 500);
    console.error('JOB FAILED:', msg);
    await dumpDebug('failure');
    await setStatus({ status: 'failed', error: msg });
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
})();
