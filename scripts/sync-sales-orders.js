// On-demand PACT "Pending Sales Order Quantity" sync (GitHub Actions entrypoint).
//
// The report's data call (ReportDataSet, RPT022) uses a single-use encrypted
// token that PACT rejects on replay (HTTP 500). So we DRIVE the report UI like
// the recording did (open report 10255, pick the filter, then Refresh/Export to
// make the page run the report) and INTERCEPT the ReportDataSet response the page
// fires itself. That JSON is parsed, grouped per sales order, and written to
// public.pending_sales_orders (read by /api/sales-orders).
//
// Env: PACT_USER, PACT_PASS/PACT_PASSWORD, PACT_URL, SUPABASE_URL, SUPABASE_SERVICE_KEY.

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const { login } = require('../src/lib/pact/login');

const C = {
  soNo:    'C0af47abff2984bff901d04570195996a',
  account: 'C41ab7906cda44cf9b36a9eff7a133833',
  product: 'C110adbb5dcbc4e96a5c409b51d1bdeb4',
  soQty:   'Cda2417fe9d6b4fea81714b02b42357e1',
  delQty:  'C25c2ab985d2946c4952a033a5b93fbb7',
  pendQty: 'Cf69663661a94446c919c81a12d3cd330',
  price:   'C271424a75a16412684a1d65b0ce066ec',
};

const sb = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/,/g, '')); return isNaN(n) ? 0 : n; };
const str = (v) => String(v == null ? '' : v).trim();
const log = (...a) => console.log.apply(console, a);

function findDataTable(json) {
  const tables = (json && json.Tables) || [];
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i];
    if (Array.isArray(t) && t.length && t[0] && Object.prototype.hasOwnProperty.call(t[0], C.soNo)) return { rows: t, tableIndex: i };
  }
  return { rows: [], tableIndex: -1 };
}
async function fullRefresh(orders, diag) {
  if (!sb) { log('[supabase] not configured; skipping'); return; }
  const del = await sb.from('pending_sales_orders').delete().gt('id', 0);
  if (del.error) { log('[supabase] delete failed:', del.error.message); return; }
  const rows = orders.map((o) => ({ vendor_name: o.vendor || '—', so_number: o.soNumber, so_date: null, status: 'pending', items: o.items }));
  if (diag) rows.push({ vendor_name: diag, so_number: '__DIAG__', so_date: null, status: 'debug', items: [] });
  if (!rows.length) { log('[supabase] nothing to insert'); return; }
  const ins = await sb.from('pending_sales_orders').insert(rows);
  if (ins.error) log('[supabase] insert failed:', ins.error.message);
  else log('[supabase] wrote', orders.length, 'orders' + (diag ? ' (+diag)' : ''));
}
async function clickFirst(page, factories, label, timeout) {
  for (const f of factories) {
    try {
      const loc = f();
      await loc.first().waitFor({ state: 'visible', timeout: timeout || 6000 });
      await loc.first().click({ timeout: timeout || 6000 });
      log('[ui] clicked ' + label);
      return true;
    } catch (e) { /* next */ }
  }
  log('[ui] could NOT click ' + label);
  return false;
}

(async () => {
  if (!process.env.PACT_PASSWORD && process.env.PACT_PASS) process.env.PACT_PASSWORD = process.env.PACT_PASS;
  const browser = await chromium.launch({ headless: true, args: ['--window-size=1680,1050'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1680, height: 1050 }, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  // Intercept the report's data request and read the body through Playwright's
  // own fetch (route.fetch), which streams large bodies — the page's response is
  // 36 MB and Chrome's getResponseBody can't return that after the fact.
  let dataText = null, seen = 0;
  await page.route(/\/api\/Report\/ReportDataSet/i, async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') { return route.continue().catch(() => {}); }
    seen++;
    try {
      const resp = await route.fetch();                 // performs the request once
      const body = await resp.text();                    // streamed read, no size cap
      log('[route] ReportDataSet #' + seen + ' status=' + resp.status() + ' bytes=' + body.length);
      if (!dataText && body.length > 5000 && body.indexOf(C.soNo) >= 0) { dataText = body; log('[capture] matched data body bytes=' + body.length); }
      await route.fulfill({ response: resp, body });      // hand the same response back to the page
    } catch (e) {
      log('[route] #' + seen + ' error ' + String(e).slice(0, 80));
      await route.continue().catch(() => {});
    }
  });

  try {
    await login(page);
    log('Logged in.');
    await page.waitForTimeout(2500);

    await clickFirst(page, [
      () => page.getByRole('listitem', { name: 'BI' }).locator('i'),
      () => page.getByRole('listitem', { name: 'BI' }),
      () => page.getByText('BI', { exact: true }),
    ], 'BI menu');
    await page.waitForTimeout(1200);
    await clickFirst(page, [
      () => page.getByRole('link', { name: 'List of Reports' }),
      () => page.getByText('List of Reports'),
    ], 'List of Reports');
    await page.waitForTimeout(1800);

    try {
      const search = page.getByRole('textbox', { name: 'Search...' });
      await search.first().fill('pending');
      await search.first().press('Enter');
      log('[ui] searched pending');
    } catch (e) { log('[ui] search skipped: ' + String(e.message).slice(0, 60)); }
    await page.waitForTimeout(1800);

    try { await page.getByText('Pending Sales Order Quantity').first().dblclick({ timeout: 8000 }); log('[ui] dblclicked report'); }
    catch (e) { log('[ui] dblclick skipped: ' + String(e.message).slice(0, 60)); }
    await page.waitForTimeout(3000);

    try { await page.getByText('FSOD-26-27/').first().click({ timeout: 8000 }); log('[ui] picked filter node'); }
    catch (e) { log('[ui] filter node skipped: ' + String(e.message).slice(0, 60)); }
    await clickFirst(page, [
      () => page.getByRole('button', { name: 'OK' }),
      () => page.getByRole('button', { name: ' OK' }),
      () => page.getByText('OK', { exact: true }),
    ], 'OK');
    await page.waitForTimeout(3000);

    // The report often needs an explicit run. Try Refresh, then Regenerate, then Export.
    if (!dataText) { await clickFirst(page, [() => page.getByRole('button', { name: /Refresh/i }), () => page.getByText('Refresh', { exact: true })], 'Refresh'); await page.waitForTimeout(6000); }
    if (!dataText) { await clickFirst(page, [() => page.getByRole('button', { name: /Regenerate/i }), () => page.getByText('Regenerate', { exact: true })], 'Regenerate'); await page.waitForTimeout(8000); }
    if (!dataText) {
      // Export path (what the recording used): Export -> Grid XLS -> Export
      if (await clickFirst(page, [() => page.getByRole('button', { name: /Export/i }), () => page.getByText('Export')], 'Export')) {
        await page.waitForTimeout(1500);
        try { await page.locator('app-pactradio').filter({ hasText: 'Grid XLS' }).getByRole('radio').check({ timeout: 5000 }); log('[ui] chose Grid XLS'); } catch (e) { log('[ui] Grid XLS skip: ' + String(e.message).slice(0, 50)); }
        await clickFirst(page, [() => page.getByRole('button', { name: 'Export', exact: true })], 'Export (confirm)');
      }
    }

    log('[ui] waiting for report data…');
    for (let i = 0; i < 90 && !dataText; i++) await page.waitForTimeout(1000);
    if (!dataText) throw new Error('ReportDataSet data not captured. ReportDataSet responses seen=' + seen + '. Report UI may need a different trigger.');

    const json = JSON.parse(dataText);
    const { rows, tableIndex } = findDataTable(json);
    log('[report] data table index=' + tableIndex + ' rows=' + rows.length);
    if (!rows.length) { await fullRefresh([], 'NO SO-No column in captured data.'); throw new Error('Data table not found in captured response.'); }

    const map = new Map();
    let curSo = '', curAcc = '';
    for (const r of rows) {
      const so = str(r[C.soNo]) || curSo;
      const acc = str(r[C.account]) || curAcc;
      curSo = so; curAcc = acc;
      const product = str(r[C.product]);
      if (!so || !product) continue;
      const pend = num(r[C.pendQty]);
      if (pend <= 0) continue;
      if (!map.has(so)) map.set(so, { soNumber: so, vendor: acc, items: [] });
      const o = map.get(so);
      if (!o.vendor && acc) o.vendor = acc;
      o.items.push({ code: '', name: product, qty: pend, unit: '', rate: num(r[C.price]) || '', ordered: num(r[C.soQty]), delivered: num(r[C.delQty]) });
    }
    const orders = [...map.values()].filter((o) => o.items.length);
    const lines = orders.reduce((n, o) => n + o.items.length, 0);
    log('Parsed ' + orders.length + ' pending sales orders (' + lines + ' lines).');
    if (orders[0]) log('First:', orders[0].soNumber, '/', orders[0].vendor, '/', orders[0].items.length, 'items');
    await fullRefresh(orders, orders.length ? '' : 'Parsed 0 orders (all lines had pend<=0).');
    log('SALES-ORDER SYNC DONE.');
  } catch (e) {
    log('SALES-ORDER SYNC FAILED:', String(e && e.message ? e.message : e).slice(0, 300));
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
})();
