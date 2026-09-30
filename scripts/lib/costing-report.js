// Shared runner for the live Factory-Costing report syncs.
//
// PACT builds a one-time, session-bound encrypted request ("p1") in the browser,
// so a recorded request CANNOT be replayed (HTTP 500, verified even with a fresh
// live token). Instead we browser-DRIVE the report exactly like the proven
// scripts/sync-sales-orders.js does: log in, open the report through
//   BI  ->  List of Reports  ->  search <name>  ->  double-click the report
//   ->  Select All (cost centers)  ->  OK / Refresh
// and INTERCEPT the ReportDataSet response the page fires itself (via page.route
// + route.fetch, which streams large bodies — getResponseBody can't return the
// 10-40 MB some of these reports produce). The captured rows are folded into the
// array-of-arrays (header row + data) the dashboard parser consumes and written
// to public.costing_snapshots (served to the dashboard by /api/costing/<k>).
//
// Each report supplies: { report, headers, colmap }. Navigation per report: NAV.
//
// Env: PACT_USER, PACT_PASS/PACT_PASSWORD, PACT_URL, SUPABASE_URL, SUPABASE_SERVICE_KEY.

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const { login } = require('../../src/lib/pact/login');

const RUN_LOG = [];
const _log = console.log.bind(console);
const log = (...a) => { try { RUN_LOG.push(a.map(String).join(' ')); } catch {} _log(...a); };
const logTail = (n = 70) => RUN_LOG.slice(-n).join('\n').slice(-3000);

const sb = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

const norm = (s) => String(s).toLowerCase().replace(/[\s_/().-]+/g, '');

// How to open each report in PACT's "List of Reports" (search term + the exact
// report name to double-click). Names match the dashboard's report titles.
const NAV = {
  si:  { search: 'stock inward',  report: 'List Of Stock Inward Reports' },
  pm:  { search: 'product master', report: 'Product Master Report' },
  bom: { search: 'stage wise bom', report: 'Stage Wise BOM With Wastage Summary' },
  pf:  { search: 'process flow',  report: 'Process Flow Report' },
};

// Reports that return only today's data by default and need a rolling date range.
// Value = days back the range starts; the range ends today (IST).
const DATE_DAYS = { si: 7, pf: 7 };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (d) => d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
function istRange(daysBack) {
  const now = new Date(Date.now() + 5.5 * 3600 * 1000);
  const from = new Date(now.getTime() - daysBack * 86400 * 1000);
  return { fromStr: fmtDate(from), toStr: fmtDate(now) };
}
// Best-effort: fill the report's From/To date fields, and RETURN what fields
// exist (so the log reveals the exact fields + their format even if the guess
// misses). Tries id/placeholder/name matches first, then two date-looking inputs.
async function setDateRange(page, fromStr, toStr) {
  return await page.evaluate(({ fromStr, toStr }) => {
    const setV = (el, val) => { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, val); ['input', 'change', 'keyup', 'blur'].forEach((t) => el.dispatchEvent(new Event(t, { bubbles: true }))); };
    const inputs = [...document.querySelectorAll('input')];
    // Full dump of the report screen so the real date UI is visible in the log.
    const allInputs = inputs.slice(0, 30).map((i) => ({ id: i.id || '', ph: i.placeholder || '', nm: i.name || '', ty: i.type || '', v: (i.value || '').slice(0, 16) }));
    const selects = [...document.querySelectorAll('select')].slice(0, 12).map((s) => ({ id: s.id || '', nm: s.name || '', v: (s.value || '').slice(0, 16) }));
    const dateEls = [...document.querySelectorAll('label,span,div,button,th,td,a,mat-label')].map((e) => ({ tag: e.tagName, t: (e.innerText || '').trim() }))
      .filter((x) => x.t && x.t.length < 30 && /from|to date|todate|date|period|w\.?e\.?f|as on|calendar|duration|financial|month|year/i.test(x.t))
      .filter((v, i, a) => a.findIndex((z) => z.t === v.t) === i).slice(0, 20);
    const looksDate = (i) => /date|from|to|frm|dt|period/i.test((i.id || '') + (i.placeholder || '') + (i.name || '')) || i.type === 'date' || /\d{1,2}[ /-]\w{2,3}[ /-]\d{2,4}/.test(i.value || '');
    let fromSet = null, toSet = null;
    for (const i of inputs) { const tag = ((i.id || '') + ' ' + (i.placeholder || '') + ' ' + (i.name || '')).toLowerCase(); if (fromSet === null && /(from|frm)/.test(tag)) { setV(i, fromStr); fromSet = i.id || i.placeholder || 'from'; } }
    for (const i of inputs) { const tag = ((i.id || '') + ' ' + (i.placeholder || '') + ' ' + (i.name || '')).toLowerCase(); if (toSet === null && /(^|[^a-z])(to|till|upto)([^a-z]|$)/.test(tag) && !/from/.test(tag)) { setV(i, toStr); toSet = i.id || i.placeholder || 'to'; } }
    if (fromSet === null || toSet === null) { const di = inputs.filter(looksDate); if (di.length >= 2) { if (fromSet === null) { setV(di[0], fromStr); fromSet = 'pos0'; } if (toSet === null) { setV(di[1], toStr); toSet = 'pos1'; } } }
    return { totalInputs: inputs.length, allInputs, selects, dateEls, fromSet, toSet };
  }, { fromStr, toStr });
}

// A ReportDataSet table is "real report data" only if its first row has more than
// one column and isn't PACT's tiny StaticReportType init payload.
function isRealReport(rows) {
  if (!Array.isArray(rows) || !rows.length) return false;
  const cols = Object.keys(rows[0] || {});
  if (cols.length <= 1) return false;
  if (cols.some((c) => /StaticReportType/i.test(c)) && cols.length <= 2) return false;
  return true;
}

function buildResolvers(headers, colmap, sampleRows) {
  const keys = new Set();
  for (const r of sampleRows) for (const k of Object.keys(r || {})) keys.add(k);
  const byNorm = new Map([...keys].map((k) => [norm(k), k]));
  const resolvers = {}; const rep = [];
  for (const h of headers) {
    if (colmap && typeof colmap[h] === 'function') { resolvers[h] = '(computed)'; rep.push(`${h} -> (computed)`); continue; }
    const cands = (colmap && colmap[h]) || [];
    let hit = null;
    for (const c of cands) { if (keys.has(c)) { hit = c; break; } }
    if (!hit) for (const c of cands) { const n = byNorm.get(norm(c)); if (n) { hit = n; break; } }
    if (!hit) { const n = byNorm.get(norm(h)); if (n) hit = n; }
    resolvers[h] = hit; rep.push(`${h} -> ${hit || '(UNRESOLVED)'}`);
  }
  log('[colmap] ' + rep.join(' | '));
  return resolvers;
}

async function writeSnapshot(patch) {
  if (!sb) { log('[supabase] not configured; skipping'); return; }
  const { error } = await sb.from('costing_snapshots').insert(patch);
  if (error) log('[supabase] insert failed:', error.message);
  else log('[supabase] snapshot inserted:', patch.report, patch.status, patch.row_count, 'rows');
}

async function clickFirst(page, factories, label, timeout) {
  for (const f of factories) {
    try {
      const loc = f();
      await loc.first().waitFor({ state: 'visible', timeout: timeout || 6000 });
      await loc.first().click({ timeout: timeout || 6000 });
      log('[ui] clicked ' + label);
      return true;
    } catch (e) { /* try next */ }
  }
  log('[ui] could NOT click ' + label);
  return false;
}

async function runCostingReport({ report, headers, colmap }) {
  const fail = async (msg) => {
    log('SYNC FAILED: ' + msg.slice(0, 300));
    await writeSnapshot({ report, synced_at: new Date().toISOString(), row_count: 0, source: 'pact-browserdrive', status: 'failed', error: (msg + '\n--- log ---\n' + logTail()).slice(0, 3500), data: [] });
    process.exitCode = 1;
  };

  const nav = NAV[report];
  if (!nav) return fail(`No navigation configured for "${report}" (add it to NAV in scripts/lib/costing-report.js).`);

  if (!process.env.PACT_PASSWORD && process.env.PACT_PASS) process.env.PACT_PASSWORD = process.env.PACT_PASS;
  const browser = await chromium.launch({ headless: true, args: ['--window-size=1680,1050'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1680, height: 1050 }, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  // Intercept every ReportDataSet response; keep the real table with most rows.
  let best = null, seen = 0;
  const consider = (body) => {
    if (!body || body.length < 120) return;
    let json; try { json = JSON.parse(body); } catch { return; }
    const tables = (json && json.Tables) || [];
    for (const t of tables) if (isRealReport(t) && (!best || t.length > best.length)) { best = t; log('[capture] table -> ' + t.length + ' rows, ' + Object.keys(t[0]).length + ' cols'); }
  };
  await page.route(/\/api\/Report\/ReportDataSet/i, async (route) => {
    if (route.request().method() !== 'POST') return route.continue().catch(() => {});
    seen++;
    try {
      const resp = await route.fetch();
      const body = await resp.text();
      log('[route] ReportDataSet #' + seen + ' status=' + resp.status() + ' bytes=' + body.length);
      consider(body);
      await route.fulfill({ response: resp, body });
    } catch (e) { log('[route] #' + seen + ' err ' + String(e).slice(0, 80)); await route.continue().catch(() => {}); }
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
      await search.first().fill(nav.search);
      await search.first().press('Enter');
      log('[ui] searched "' + nav.search + '"');
    } catch (e) { log('[ui] search skipped: ' + String(e.message).slice(0, 60)); }
    await page.waitForTimeout(1800);

    try { await page.getByText(nav.report).first().dblclick({ timeout: 8000 }); log('[ui] dblclicked "' + nav.report + '"'); }
    catch (e) { log('[ui] dblclick skipped: ' + String(e.message).slice(0, 60)); }
    await page.waitForTimeout(3000);

    // Date-driven reports (Stock Inward, Process Flow) need a rolling window.
    let dateDiag = '';
    if (DATE_DAYS[report]) {
      await page.waitForTimeout(2500); // let the report/parameter screen render
      const { fromStr, toStr } = istRange(DATE_DAYS[report]);
      try {
        const dr = await setDateRange(page, fromStr, toStr);
        dateDiag = ('range ' + fromStr + '->' + toStr + ' from=' + dr.fromSet + ' to=' + dr.toSet + ' nIn=' + dr.totalInputs
          + ' | IN=' + JSON.stringify(dr.allInputs) + ' | DATEELS=' + JSON.stringify(dr.dateEls) + ' | SEL=' + JSON.stringify(dr.selects)).slice(0, 1800);
        log('[date] ' + dateDiag);
      } catch (e) { dateDiag = 'date set error: ' + String(e.message).slice(0, 120); log('[date] ' + dateDiag); }
      await page.waitForTimeout(1000);
    }

    // Cost centers must be selected or the report returns NO rows (as in sales-orders).
    try { await page.getByText('Select All', { exact: true }).first().click({ timeout: 6000 }); log('[ui] checked Select All (cost centers)'); }
    catch (e) { log('[ui] Select All skip: ' + String(e.message).slice(0, 50)); }
    await page.waitForTimeout(600);

    // OK / Refresh / Regenerate run the report (fires the ReportDataSet we capture).
    await clickFirst(page, [
      () => page.getByRole('button', { name: 'OK' }),
      () => page.getByRole('button', { name: ' OK' }),
      () => page.getByText('OK', { exact: true }),
    ], 'OK');
    await page.waitForTimeout(3000);
    if (!best) { if (await clickFirst(page, [() => page.getByRole('button', { name: /Refresh/i }), () => page.getByText('Refresh', { exact: true })], 'Refresh')) await page.waitForTimeout(6000); }
    if (!best) { if (await clickFirst(page, [() => page.getByRole('button', { name: /Regenerate/i }), () => page.getByText('Regenerate', { exact: true })], 'Regenerate')) await page.waitForTimeout(8000); }

    log('[ui] waiting for report data…');
    // Don't stop at the FIRST table — big reports (BOM ~16k) stream in, and a tiny
    // intermediate table can arrive first. Wait until the captured size has been
    // stable for SETTLE_MS (and at least MIN_WAIT_MS total) so we always take the
    // complete report, never an early partial. The capture handler already keeps
    // the largest table seen, so we just wait for it to stop growing.
    {
      const deadline = Date.now() + 120000; // hard cap ~2 min (< the worker's 5-min job timeout)
      const SETTLE_MS = 8000;                // accept once the row count hasn't grown for 8s
      const MIN_WAIT_MS = 15000;             // always give the full report time to stream in
      const t0 = Date.now();
      let lastLen = -1, lastGrow = Date.now();
      while (Date.now() < deadline) {
        await page.waitForTimeout(1000);
        const len = best ? best.length : 0;
        if (len > lastLen) { lastLen = len; lastGrow = Date.now(); }
        if (best && (Date.now() - lastGrow >= SETTLE_MS) && (Date.now() - t0 >= MIN_WAIT_MS)) break;
      }
      if (best) log('[capture] settled at ' + best.length + ' rows');
    }
    if (!best || !best.length) throw new Error('No real ReportDataSet data captured for "' + report + '" (ReportDataSet responses seen=' + seen + '). The report UI may need a different trigger or a date range.');

    const src = best;
    log('[report] captured ' + src.length + ' rows, keys: ' + Object.keys(src[0]).slice(0, 10).join(','));
    const resolvers = buildResolvers(headers, colmap, src.slice(0, 50));
    const unresolved = headers.filter((h) => !resolvers[h]);
    if (unresolved.length) log('[colmap] WARNING unresolved: ' + unresolved.join(', '));

    const aoa = [headers.slice()];
    for (const r of src) aoa.push(headers.map((h) => {
      const cm = colmap && colmap[h];
      if (typeof cm === 'function') { const cv = cm(r); return cv === undefined ? null : cv; }
      const k = resolvers[h]; const v = k ? r[k] : null; return v === undefined ? null : v;
    }));
    const rowCount = aoa.length - 1;
    log(`Captured ${rowCount} rows for ${report} (${headers.length} columns).`);
    await writeSnapshot({ report, synced_at: new Date().toISOString(), row_count: rowCount, source: 'pact-browserdrive', status: 'ok', error: dateDiag, data: aoa });
    log('SYNC DONE.');
  } catch (e) {
    await fail(String(e && e.message ? e.message : e));
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { runCostingReport };
