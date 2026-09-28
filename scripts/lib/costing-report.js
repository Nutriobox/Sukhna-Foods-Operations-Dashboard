// Shared runner for the live Factory-Costing report syncs.
//
// PACT builds a one-time, session-bound encrypted request ("p1") in the browser,
// so a recorded request CANNOT be replayed (it returns HTTP 500 "Please contact
// your administrator" — verified even with a fresh live token). Instead we
// browser-DRIVE each report: log in, open the report in the PACT web app so the
// app builds a fresh valid request itself, and capture the ReportDataSet
// RESPONSE. The rows are folded into the array-of-arrays (header row first, then
// data rows) the dashboard's Excel parser consumes and written to one row of
// public.costing_snapshots. The costing page reads the newest row per report.
//
// Each report supplies: { report, headers, colmap }.
//   headers : the friendly column labels the dashboard parser expects (row 0)
//   colmap  : { 'Friendly Header': ['sourceKeyCandidate', ...] } into Tables[0]
// The open-flow (how the report is opened in the SPA) is configured in OPEN.
//
// Env: PACT_USER, PACT_PASS/PACT_PASSWORD, PACT_URL, SUPABASE_URL, SUPABASE_SERVICE_KEY.

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const { login } = require('../../src/lib/pact/login');

const RUN_LOG = [];
const _log = console.log.bind(console);
console.log = (...a) => { try { RUN_LOG.push(a.map(String).join(' ')); } catch {} _log(...a); };
const logTail = (n = 60) => RUN_LOG.slice(-n).join('\n').slice(-3000);

const sb = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

const norm = (s) => String(s).toLowerCase().replace(/[\s_/().-]+/g, '');

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
  console.log('[colmap] ' + rep.join(' | '));
  return resolvers;
}

async function writeSnapshot(patch) {
  if (!sb) { console.log('[supabase] not configured; skipping'); return; }
  const { error } = await sb.from('costing_snapshots').insert(patch);
  if (error) console.log('[supabase] insert failed:', error.message);
  else console.log('[supabase] snapshot inserted:', patch.report, patch.status, patch.row_count, 'rows');
}

// How to open each report in the PACT web app. Steps are clicked in order.
//   by:'text' -> click first element whose EXACT text matches (opens menus/flows)
//   by:'link' -> click the <a> link with that exact accessible name (opens report)
// NOTE: 'si' (Stock Inward) is verified live. The others are best-effort first
// guesses (the report's own name) and will be refined after the first run using
// the failure log, which prints what was and wasn't found.
const OPEN = {
  si:  [ { by: 'text', text: 'List Of Stock Inward Reports' }, { by: 'link', text: 'List Of Stock Inward Reports' } ],
  pm:  [ { by: 'link', text: 'Product Master Report' } ],
  bom: [ { by: 'link', text: 'Stage Wise BOM With Wastage Summary' } ],
  pf:  [ { by: 'link', text: 'Process Flow Report' } ],
};

async function runCostingReport({ report, headers, colmap }) {
  const fail = async (msg) => {
    console.log('SYNC FAILED:', msg.slice(0, 300));
    await writeSnapshot({ report, synced_at: new Date().toISOString(), row_count: 0, source: 'pact-browserdrive', status: 'failed', error: (msg + '\n--- log ---\n' + logTail()).slice(0, 3500), data: [] });
    process.exitCode = 1;
  };

  const open = OPEN[report];
  if (!open) return fail(`No open-flow configured for "${report}" (add it to OPEN in scripts/lib/costing-report.js).`);

  if (!process.env.PACT_PASSWORD && process.env.PACT_PASS) process.env.PACT_PASSWORD = process.env.PACT_PASS;
  const browser = await chromium.launch({ headless: true, args: ['--window-size=1600,1000'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  // Capture every ReportDataSet response; keep the one with the most data rows.
  let best = null;
  page.on('response', async (resp) => {
    try {
      if (!/\/api\/Report\/ReportDataSet/i.test(resp.url())) return;
      if ((resp.request().method() || '').toUpperCase() !== 'POST') return;
      const j = await resp.json().catch(() => null);
      const rows = j && j.Tables && j.Tables[0] ? j.Tables[0] : null;
      if (Array.isArray(rows) && rows.length && (!best || rows.length > best.length)) { best = rows; console.log('[capture] ReportDataSet -> ' + rows.length + ' rows'); }
    } catch {}
  });

  try {
    await login(page);
    console.log('Logged in.');
    await page.waitForTimeout(2500);
    try { if (!/#\/home/.test(page.url())) { await page.evaluate(() => { location.hash = '#/home'; }); await page.waitForTimeout(1500); } } catch {}

    console.log('[open] ' + report + ' (' + open.length + ' step(s))');
    for (const step of open) {
      const loc = step.by === 'link'
        ? page.getByRole('link', { name: step.text, exact: true }).first()
        : page.getByText(step.text, { exact: true }).first();
      await loc.waitFor({ state: 'visible', timeout: 20000 });
      await loc.click();
      console.log('[open] clicked ' + step.by + ': ' + step.text);
      await page.waitForTimeout(step.wait || 3500);
    }

    // Wait up to 35s for a non-empty ReportDataSet response to arrive.
    const deadline = Date.now() + 35000;
    while (Date.now() < deadline && !best) { await page.waitForTimeout(1000); }
    if (!best || !best.length) throw new Error('No ReportDataSet rows captured after opening "' + report + '". The open-flow (OPEN.' + report + ') likely needs adjusting, or a date range must be set.');

    const src = best;
    const resolvers = buildResolvers(headers, colmap, src.slice(0, 50));
    const unresolved = headers.filter((h) => !resolvers[h]);
    if (unresolved.length) console.log('[colmap] WARNING unresolved: ' + unresolved.join(', '));

    const aoa = [headers.slice()];
    for (const r of src) aoa.push(headers.map((h) => { const k = resolvers[h]; const v = k ? r[k] : null; return v === undefined ? null : v; }));
    const rowCount = aoa.length - 1;
    console.log(`Captured ${rowCount} rows for ${report} (${headers.length} columns).`);
    await writeSnapshot({ report, synced_at: new Date().toISOString(), row_count: rowCount, source: 'pact-browserdrive', status: 'ok', error: '', data: aoa });
    console.log('SYNC DONE.');
  } catch (e) {
    await fail(String(e && e.message ? e.message : e));
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { runCostingReport };
