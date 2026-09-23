// On-demand PACT "Pending Outlet Requisition Quantity" sync.
//
// Reconstructed to replace the copy lost with the terminated AWS worker. Mirrors
// scripts/sync-sales-orders.js: drive the BI report UI (report 10260, "Pending
// Outlet Requisition"), set a From/To range, run it, and INTERCEPT the
// ReportDataSet response the page fires (its token is single-use, so we cannot
// replay it). The JSON is grouped per OMR and written to
// public.pending_outlet_requisitions (read by /api/outlet-requisitions).
//
// Env: PACT_USER, PACT_PASS/PACT_PASSWORD, PACT_URL, SUPABASE_URL, SUPABASE_SERVICE_KEY.

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const { login } = require('../src/lib/pact/login');

// Column keys captured live from pact-outlet-pending.har (report 10260).
const C = {
  omr:     'C0af47abff2984bff901d04570195996a', // OMR-AF/26-27/NNNN
  outlet:  'C4489aeff97a641c1bfbae009fc1886b8', // Nutriobox (Outlet)
  product: 'C110adbb5dcbc4e96a5c409b51d1bdeb4', // product name
  unit:    'C31828cb649a8415eabeb62fe7ef72be8', // Bunch / Pkt / ...
  reqQty:  'Cda2417fe9d6b4fea81714b02b42357e1', // ordered (requisition qty)
  outQty:  'C25c2ab985d2946c4952a033a5b93fbb7', // delivered/dispatched qty
  sot:     'Ca69ab9592b4e4202b857fe8430d8e9f1', // SOT voucher (dispatch rows)
};

const sb = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/,/g, '')); return isNaN(n) ? 0 : n; };
const str = (v) => { const s = String(v == null ? '' : v).trim(); return (s === 'None') ? '' : s; };
const log = (...a) => console.log.apply(console, a);

function findDataTable(json) {
  const tables = (json && json.Tables) || [];
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i];
    if (Array.isArray(t) && t.length && t[0] && Object.prototype.hasOwnProperty.call(t[0], C.omr)) return { rows: t, tableIndex: i };
  }
  return { rows: [], tableIndex: -1 };
}

async function fullRefresh(orders, diag) {
  if (!sb) { log('[supabase] not configured; skipping write'); return; }
  const del = await sb.from('pending_outlet_requisitions').delete().gt('id', 0);
  if (del.error) { log('[supabase] delete failed:', del.error.message); return; }
  const rows = orders.map((o) => ({ omr_number: o.omr, outlet: o.outlet || '—', status: o.status, items: o.items }));
  if (diag) rows.push({ omr_number: '__DIAG__', outlet: String(diag).slice(0, 250), status: 'debug', items: [] });
  if (!rows.length) { log('[supabase] nothing to insert'); return; }
  // insert in chunks so a big fiscal-year pull never trips PostgREST payload limits
  for (let i = 0; i < rows.length; i += 500) {
    const ins = await sb.from('pending_outlet_requisitions').insert(rows.slice(i, i + 500));
    if (ins.error) { log('[supabase] insert failed:', ins.error.message); return; }
  }
  const pend = orders.filter((o) => o.status === 'pending').length;
  log('[supabase] wrote', orders.length, 'requisitions (' + pend + ' pending)' + (diag ? ' (+diag)' : ''));
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

// Best-effort: give the report a valid From/To so it runs. The report returns
// ALL currently-pending OMRs regardless of the exact window (verified in the
// capture: an old OMR still came back), so we just need a valid range. Logged,
// never fatal — the live row count tells us if it needs widening.
async function setDateRange(page) {
  try {
    const pickers = page.locator('app-pactdatepicker');
    const n = await pickers.count();
    log('[date] pact datepickers on form:', n);
    // FROM = first picker: open, jump back a year, pick day 1.
    if (n >= 1) {
      await pickers.nth(0).locator('.List__button, button').first().click({ timeout: 5000 }).catch(() => {});
      for (let i = 0; i < 12; i++) await page.getByRole('button', { name: '‹' }).first().click({ timeout: 1500 }).catch(() => {});
      await page.getByText('1', { exact: true }).first().click({ timeout: 4000 }).catch(() => {});
      log('[date] set From (~12 months back, day 1)');
    }
    // TO = second picker: open, pick day 28 of the current view (>= today for the month).
    if (n >= 2) {
      await pickers.nth(1).locator('.List__button, button').first().click({ timeout: 5000 }).catch(() => {});
      await page.getByText('28', { exact: true }).first().click({ timeout: 4000 }).catch(() => {});
      log('[date] set To (day 28)');
    }
  } catch (e) { log('[date] range set skipped:', String(e.message).slice(0, 60)); }
}

(async () => {
  if (!process.env.PACT_PASSWORD && process.env.PACT_PASS) process.env.PACT_PASSWORD = process.env.PACT_PASS;
  const browser = await chromium.launch({ headless: true, args: ['--window-size=1680,1050'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1680, height: 1050 }, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  let dataText = null, seen = 0;
  await page.route(/\/api\/Report\/ReportDataSet/i, async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') { return route.continue().catch(() => {}); }
    seen++;
    try {
      const resp = await route.fetch();
      const body = await resp.text();
      log('[route] ReportDataSet #' + seen + ' status=' + resp.status() + ' bytes=' + body.length);
      if (!dataText && body.length > 5000 && body.indexOf(C.omr) >= 0) { dataText = body; log('[capture] matched data body bytes=' + body.length); }
      await route.fulfill({ response: resp, body });
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
      await search.first().click();
      await search.first().fill('pending outlet');
      await search.first().press('Enter');
      // some builds only filter on the magnifier button, not Enter
      try { await page.getByRole('button').filter({ hasText: /^$/ }).first().click({ timeout: 2500 }); } catch (e2) {}
      log('[ui] searched pending outlet');
    } catch (e) { log('[ui] search skipped: ' + String(e.message).slice(0, 60)); }
    await page.waitForTimeout(2500);

    // Open the report row. Try dblclick, then click+Enter, on a case-insensitive
    // match — the row reads "Pending Outlet Requisition Quantity".
    let opened = false;
    const rowLoc = () => page.getByText(/Pending Outlet Requisition/i).first();
    try { await rowLoc().scrollIntoViewIfNeeded({ timeout: 4000 }); } catch (e) {}
    try { await rowLoc().dblclick({ timeout: 15000 }); opened = true; log('[ui] dblclicked report'); }
    catch (e) { log('[ui] dblclick failed: ' + String(e.message).slice(0, 60)); }
    if (!opened) {
      try { const el = rowLoc(); await el.click({ timeout: 8000 }); await el.press('Enter'); opened = true; log('[ui] click+Enter report'); }
      catch (e) { log('[ui] click+Enter failed: ' + String(e.message).slice(0, 60)); }
    }
    if (!opened) {
      // last resort: dump the visible report-list rows so we can see the real text
      try {
        const rows = await page.locator('.slick-row, [role="row"], li, tr').filter({ hasText: /Pending|Outlet|Requisition/i }).allInnerTexts();
        log('[ui] report rows seen: ' + JSON.stringify(rows.slice(0, 8)).slice(0, 300));
      } catch (e) {}
    }
    await page.waitForTimeout(3000);

    // Cost centers must be selected or the report returns NO rows.
    try { await page.getByText('Select All', { exact: true }).first().click({ timeout: 6000 }); log('[ui] checked Select All (cost centers)'); }
    catch (e) { log('[ui] Select All skip: ' + String(e.message).slice(0, 50)); }
    await page.waitForTimeout(600);

    await setDateRange(page);
    await page.waitForTimeout(600);

    // OK runs the report (fires the ReportDataSet query we intercept).
    await clickFirst(page, [
      () => page.getByRole('button', { name: 'OK', exact: true }),
      () => page.getByRole('button', { name: ' OK' }),
      () => page.getByText('OK', { exact: true }),
    ], 'OK');
    await page.waitForTimeout(3000);

    // Fallbacks: Refresh, then the Export -> Grid XLS path the recording used.
    if (!dataText) { if (await clickFirst(page, [() => page.getByRole('button', { name: /Refresh/i }), () => page.getByText('Refresh', { exact: true })], 'Refresh')) await page.waitForTimeout(6000); }
    if (!dataText) {
      if (await clickFirst(page, [() => page.getByRole('button', { name: /Export/i }), () => page.getByText('Export')], 'Export')) {
        await page.waitForTimeout(1500);
        try { await page.getByText('Grid XLS').first().click({ timeout: 5000 }); log('[ui] chose Grid XLS'); } catch (e) { log('[ui] Grid XLS skip: ' + String(e.message).slice(0, 50)); }
        await clickFirst(page, [() => page.getByRole('button', { name: 'Export', exact: true })], 'Export (confirm)');
      }
    }

    log('[ui] waiting for report data…');
    for (let i = 0; i < 90 && !dataText; i++) await page.waitForTimeout(1000);
    if (!dataText) throw new Error('ReportDataSet not captured. Responses seen=' + seen + '. Report UI may need a different trigger/date.');

    const json = JSON.parse(dataText);
    const tables = (json && json.Tables) || [];
    log('[report] Tables=' + tables.length + ' lengths=' + tables.map((t) => Array.isArray(t) ? t.length : '?').join(','));
    const { rows, tableIndex } = findDataTable(json);
    log('[report] data table index=' + tableIndex + ' rows=' + rows.length);
    if (!rows.length) { await fullRefresh([], 'No OMR column in captured data.'); throw new Error('Data table not found.'); }
    if (rows[0]) log('[keys] ' + Object.keys(rows[0]).join(','));

    // Aggregate raw rows per (OMR, product): sum ordered & delivered.
    const agg = new Map();           // omr||product -> {omr, outlet, product, unit, ordered, delivered}
    const outletOf = new Map();      // omr -> outlet
    let curOmr = '', curOutlet = '';
    for (const r of rows) {
      const omr = str(r[C.omr]) || curOmr;
      const outlet = str(r[C.outlet]) || curOutlet;
      curOmr = omr; curOutlet = outlet;
      const product = str(r[C.product]);
      if (!omr || !product) continue;
      if (outlet && !outletOf.has(omr)) outletOf.set(omr, outlet);
      const key = omr + '||' + product;
      let a = agg.get(key);
      if (!a) { a = { omr, outlet, product, unit: '', ordered: 0, delivered: 0 }; agg.set(key, a); }
      a.ordered  += num(r[C.reqQty]);
      a.delivered += num(r[C.outQty]);
      const u = str(r[C.unit]); if (u && !a.unit) a.unit = u;   // unit lives on the requisition row
      if (!a.outlet && outlet) a.outlet = outlet;
    }
    log('[parse] aggregated to ' + agg.size + ' (OMR,product) lines from ' + rows.length + ' raw rows');

    // Group into OMRs. status = pending if any line still has qty to dispatch.
    const map = new Map();           // omr -> { omr, outlet, pendItems[], allItems[] }
    for (const a of agg.values()) {
      const pend = Math.round((a.ordered - a.delivered) * 1000) / 1000;
      if (!map.has(a.omr)) map.set(a.omr, { omr: a.omr, outlet: outletOf.get(a.omr) || a.outlet, pendItems: [], allItems: [] });
      const o = map.get(a.omr);
      const line = { name: a.product, unit: a.unit, ordered: a.ordered, delivered: a.delivered };
      o.allItems.push({ ...line, qty: a.ordered });
      if (pend > 0) o.pendItems.push({ ...line, qty: pend });
    }
    const orders = [];
    for (const o of map.values()) {
      const pending = o.pendItems.length > 0;
      orders.push({ omr: o.omr, outlet: o.outlet, status: pending ? 'pending' : 'completed', items: pending ? o.pendItems : o.allItems });
    }
    // newest OMR first (numeric suffix)
    const numOf = (s) => { const m = String(s).match(/(\d+)\s*$/); return m ? +m[1] : 0; };
    orders.sort((a, b) => numOf(b.omr) - numOf(a.omr));
    const pendCount = orders.filter((o) => o.status === 'pending').length;
    log('Parsed ' + orders.length + ' OMRs (' + pendCount + ' pending). Newest: ' + (orders[0] ? orders[0].omr : '—'));
    if (orders[0]) log('First:', orders[0].omr, '/', orders[0].outlet, '/', orders[0].status, '/', orders[0].items.length, 'items');

    await fullRefresh(orders, orders.length ? '' : ('agg=' + agg.size + ' rawRows=' + rows.length));
    log('OUTLET-REQUISITION SYNC DONE.');
  } catch (e) {
    log('OUTLET-REQUISITION SYNC FAILED:', String(e && e.message ? e.message : e).slice(0, 300));
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
})();
