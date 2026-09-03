// GitHub Actions entrypoint: create a Factory Sales Invoice in PACT from a
// scanned order, using a REAL headless Chromium. Reuses the same login module.
// Reads ORDER_JSON, records status in Supabase pact_jobs (same table as the
// stock-inward push, so the dashboard can track it).
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const { login } = require('../src/lib/pact/login');
const { createFactorySalesInvoice } = require('../src/lib/pact/factory-sales-invoice');

const JOB_ID = process.env.JOB_ID || '';
const DRY_RUN = String(process.env.DRY_RUN || 'true').toLowerCase() !== 'false'; // safe default
let order = {};
try { order = JSON.parse(process.env.ORDER_JSON || '{}'); } catch (e) { console.error('Bad ORDER_JSON', e.message); }

const RUN_LOG = [];
const _log = console.log.bind(console), _err = console.error.bind(console);
console.log = (...a) => { try { RUN_LOG.push(a.map(String).join(' ')); } catch {} _log(...a); };
console.error = (...a) => { try { RUN_LOG.push('ERR ' + a.map(String).join(' ')); } catch {} _err(...a); };
const logTail = (n = 60) => RUN_LOG.slice(-n).join('\n').slice(-3500);

const sb = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

async function setStatus(patch) {
  if (!sb || !JOB_ID) return;
  try {
    await sb.from('pact_jobs').upsert(
      { id: JOB_ID, invoice: order.soNumber || null, vendor: order.customer || null, ...patch, updated_at: new Date().toISOString() },
      { onConflict: 'id' }
    );
  } catch (e) { console.log('status upsert failed:', e.message); }
}

(async () => {
  if (!process.env.PACT_PASSWORD && process.env.PACT_PASS) process.env.PACT_PASSWORD = process.env.PACT_PASS;
  if (!order.barcodes || !order.barcodes.length) { console.error('No barcodes in order'); process.exit(1); }

  console.log(`Factory Sales Invoice for SO ${order.soNumber} (${order.barcodes.length} items), dryRun=${DRY_RUN}`);
  await setStatus({ status: 'processing' });

  const browser = await chromium.launch({ headless: true, args: ['--window-size=1920,1080'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  try {
    await login(page);
    console.log('Logged in.');
    const r = await createFactorySalesInvoice(page, order, { dryRun: DRY_RUN });
    console.log('FSI finished. posted=' + (r && r.posted) + ' entered=' + ((r && r.entered) || 0) + '/' + ((r && r.total) || 0));

    if (!DRY_RUN && !(r && r.posted)) {
      throw new Error('Invoice NOT posted: ' + ((r && r.reason) || 'still Draft') + '\n--- run log ---\n' + logTail());
    }
    const summary =
      `Filled ${(r && r.entered) || 0}/${(r && r.total) || 0} item(s)` +
      (r && r.skipped && r.skipped.length ? `, ${r.skipped.length} skipped (not in stock)` : '') +
      (DRY_RUN ? ' \u2014 dry run, not posted' : (' \u2014 POSTED' + (r && r.docNo ? ' as ' + r.docNo : '')));
    await setStatus({ status: 'done', invoice: ((r && r.docNo) || order.soNumber || null), error: summary });
    // Record the posted invoice so it shows in "View Past Sales Invoice". Items
    // are the aggregated barcodes (code_batch_weight) parsed for a readable list.
    if (!DRY_RUN && sb && r && r.posted) {
      try {
        const items = (order.barcodes || []).map((bc) => {
          const parts = String(bc).split('_');
          return { code: parts[0] || '', batch: parts[1] || '', weight: parts[2] || '', barcode: String(bc) };
        });
        await sb.from('sales_invoices').insert({
          vendor_name: order.customer || order.vendor || null,
          invoice_number: r.docNo || null,
          invoice_date: new Date().toISOString().slice(0, 10),
          amount: null,
          items,
        });
        console.log('Recorded invoice ' + (r.docNo || '') + ' (' + items.length + ' items) in sales_invoices.');
      } catch (e) { console.log('sales_invoices insert failed: ' + (e && e.message ? e.message : e)); }
    }
    console.log('JOB DONE. ' + summary);
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    console.error('JOB FAILED:', msg.slice(0, 200));
    await setStatus({ status: 'failed', error: (msg + '\n--- run log ---\n' + logTail()).slice(0, 3800) });
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
})();
