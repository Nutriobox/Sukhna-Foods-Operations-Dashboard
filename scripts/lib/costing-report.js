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
    for (let i = 0; i < 90 && !best; i++) await page.waitForTimeout(1000);
    if (!best || !best.length) throw new Error('No real ReportDataSet data captured for "' + report + '" (ReportDataSet responses seen=' + seen + '). The report UI may need a different trigger or a date range.');

    const src = best;
    log('[report] captured ' + src.length + ' rows, keys: ' + Object.keys(src[0]).slice(0, 10).join(','));
    const resolvers = buildResolvers(headers, colmap, src.slice(0, 50));
    const unresolved = headers.filter((h) => !resolvers[h]);
    if (unresolved.length) log('[colmap] WARNING unresolved: ' + unresolved.join(', '));

    const aoa = [headers.slice()];
    for (const r of src) aoa.push(headers.map((h) => { const k = resolvers[h]; const v = k ? r[k] : null; return v === undefined ? null : v; }));
    const rowCount = aoa.length - 1;
    log(`Captured ${rowCount} rows for ${report} (${headers.length} columns).`);
    await writeSnapshot({ report, synced_at: new Date().toISOString(), row_count: rowCount, source: 'pact-browserdrive', status: 'ok', error: '', data: aoa });
    log('SYNC DONE.');
  } catch (e) {
    await fail(String(e && e.message ? e.message : e));
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { runCostingReport };
