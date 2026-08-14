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

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.setDefaultTimeout(45000);

  try {
    await login(page);
    console.log('Logged in.');
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
    await setStatus({ status: 'failed', error: msg });
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
})();
