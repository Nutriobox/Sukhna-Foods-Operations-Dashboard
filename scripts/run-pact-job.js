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
  // Upsert (not update): the queued row may not have been inserted by the API
  // route if it lacked the service key, in which case a plain update is a no-op
  // and the dashboard would poll a row that never appears. Upsert guarantees the
  // row exists with a current status so the UI can track it.
  try {
    await sb.from('pact_jobs').upsert(
      { id: JOB_ID, invoice: bill.billNo || null, vendor: bill.vendor || null, ...patch, updated_at: new Date().toISOString() },
      { onConflict: 'id' }
    );
  } catch (e) { console.log('status upsert failed:', e.message); }
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
    try {
      const info = await page.evaluate(() => {
        const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const fields = Array.from(document.querySelectorAll('input,select,textarea'))
          .filter(vis)
          .map((e) => `${e.tagName.toLowerCase()}#${e.id || '-'}|${(e.getAttribute('placeholder') || e.getAttribute('title') || e.name || '').toString().slice(0, 24)}`)
          .slice(0, 70);
        const modals = Array.from(document.querySelectorAll('modal-container, .modal, [role="dialog"]'))
          .filter(vis)
          .map((m) => (m.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160));
        // Capture any open lookup/suggestions dropdown so we can see its markup.
        const dropdowns = Array.from(document.querySelectorAll('.List__dropdown, .List__dropdown--suggestions, .suggestions__group, .slick-row'))
          .filter(vis)
          .map((d) => `${d.tagName.toLowerCase()}.${(d.className || '').toString().trim().replace(/\s+/g, '.').slice(0, 40)} :: ${(d.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80)}`)
          .slice(0, 12);
        const activeEl = document.activeElement;
        const active = activeEl ? `${activeEl.tagName.toLowerCase()}#${activeEl.id || '-'} val="${(activeEl.value || '').slice(0, 30)}"` : 'none';
        return { fieldCount: fields.length, fields, modals, dropdowns, active };
      });
      console.log(`[debug ${tag}] visible fields (${info.fieldCount}): ${JSON.stringify(info.fields)}`);
      console.log(`[debug ${tag}] visible modals: ${JSON.stringify(info.modals)}`);
      console.log(`[debug ${tag}] dropdowns: ${JSON.stringify(info.dropdowns)}`);
      console.log(`[debug ${tag}] activeEl: ${info.active}`);
    } catch (e) { console.log(`[debug ${tag}] dom-dump failed: ${e.message}`); }
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
