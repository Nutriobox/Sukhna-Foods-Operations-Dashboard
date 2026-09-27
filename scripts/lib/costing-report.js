// Shared runner for the 4 live Factory-Costing report syncs.
//
// Same proven approach as scripts/sync-inventory.js: launch Chromium, log into
// PACT to capture a Bearer token + API root, then REPLAY the report's own
//   POST /PACTALLUSUREAPI/api/Report/ReportDataSet
// call using a request body captured from a real report load (base64). The JSON
// rows are folded into the SAME array-of-arrays (header row first, then data
// rows) the dashboard's Excel parser consumes, and written to one row of
// public.costing_snapshots. The costing page reads the newest row per report.
//
// Each report supplies: { report, bodyB64, headers, colmap }.
//   headers : the friendly column labels the dashboard's parser expects (row 0)
//   colmap  : { 'Friendly Header': ['sourceKeyCandidate', ...] } into Tables[0]
//             (leave a header out to let the resolver guess by name)
//
// Env: PACT_USER, PACT_PASS/PACT_PASSWORD, PACT_URL, SUPABASE_URL, SUPABASE_SERVICE_KEY.

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const { login } = require('../../src/lib/pact/login');

const RUN_LOG = [];
const _log = console.log.bind(console);
console.log = (...a) => { try { RUN_LOG.push(a.map(String).join(' ')); } catch {} _log(...a); };
const logTail = (n = 50) => RUN_LOG.slice(-n).join('\n').slice(-3000);

const sb = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function istToken() {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000);
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function jwtUserId(bearer) {
  try {
    const p = JSON.parse(Buffer.from(bearer.split(' ')[1].split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    const uniq = String(p.unique_name || p.UserName || '');
    return uniq.split(',')[1] || '';
  } catch { return ''; }
}

// Normalise a key for loose matching: lower-case, strip spaces/underscores/slashes.
const norm = (s) => String(s).toLowerCase().replace(/[\s_/().-]+/g, '');

// Resolve each friendly header -> a concrete source key present in the rows.
function buildResolvers(headers, colmap, sampleRows) {
  const keys = new Set();
  for (const r of sampleRows) for (const k of Object.keys(r || {})) keys.add(k);
  const keyList = [...keys];
  const byNorm = new Map(keyList.map((k) => [norm(k), k]));
  const resolvers = {};
  const report = [];
  for (const h of headers) {
    const cands = (colmap && colmap[h]) || [];
    let hit = null;
    for (const c of cands) { if (keys.has(c)) { hit = c; break; } }         // exact candidate
    if (!hit) for (const c of cands) { const n = byNorm.get(norm(c)); if (n) { hit = n; break; } } // loose candidate
    if (!hit) { const n = byNorm.get(norm(h)); if (n) hit = n; }            // guess by header name
    resolvers[h] = hit;
    report.push(`${h} -> ${hit || '(UNRESOLVED)'}`);
  }
  console.log('[colmap] ' + report.join(' | '));
  return resolvers;
}

async function writeSnapshot(patch) {
  if (!sb) { console.log('[supabase] not configured; skipping'); return; }
  const { error } = await sb.from('costing_snapshots').insert(patch);
  if (error) console.log('[supabase] insert failed:', error.message);
  else console.log('[supabase] snapshot inserted:', patch.report, patch.status, patch.row_count, 'rows');
}

async function runCostingReport({ report, bodyB64, headers, colmap }) {
  const fail = async (msg) => {
    console.log('SYNC FAILED:', msg.slice(0, 300));
    await writeSnapshot({ report, synced_at: new Date().toISOString(), row_count: 0, source: 'pact-reportdataset', status: 'failed', error: (msg + '\n--- log ---\n' + logTail()).slice(0, 3500), data: [] });
    process.exitCode = 1;
  };

  if (!bodyB64) {
    return fail(`No recorded request for "${report}". Run record-costing.bat, then fill BODY_B64 in scripts/sync-costing-${report}.js (see COSTING-LIVE-SYNC.md).`);
  }

  if (!process.env.PACT_PASSWORD && process.env.PACT_PASS) process.env.PACT_PASSWORD = process.env.PACT_PASS;
  const browser = await chromium.launch({ headless: true, args: ['--window-size=1600,1000'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  let bearer = null, apiRoot = null;
  page.on('request', (req) => {
    const u = req.url();
    if (!apiRoot && /PACTALLUSUREAPI\/api\//i.test(u)) apiRoot = u.slice(0, u.toLowerCase().indexOf('/api/'));
    const a = req.headers()['authorization'];
    if (!bearer && a && /^Bearer /i.test(a)) bearer = a;
  });

  try {
    await login(page);
    console.log('Logged in.');
    await page.waitForTimeout(1500);
    if (!bearer) { await page.reload({ waitUntil: 'networkidle' }).catch(() => {}); await page.waitForTimeout(1500); }
    if (!bearer) throw new Error('Could not capture a Bearer token after login (the report API needs it).');
    if (!apiRoot) {
      const origin = new URL(process.env.PACT_URL || 'http://140.245.255.130:8443/').origin;
      apiRoot = origin + '/PACTALLUSUREAPI';
    }
    const REPORT_URL = apiRoot + '/api/Report/ReportDataSet';
    const userId = jwtUserId(bearer);
    console.log('[report] ' + report + ' url=' + REPORT_URL + ' userId=' + (userId || '(kept from template)'));

    let body = Buffer.from(bodyB64, 'base64').toString('utf8');
    // Re-inject today's IST date if the template embeds a 'D Mon YYYY' literal, and the caller's userId.
    body = body.replace(/'(\d{1,2} [A-Za-z]{3} \d{4})'/g, "'" + istToken() + "'");
    if (userId) body = body.replace(/"UserID":"\d+"/, '"UserID":"' + userId + '"');

    const resp = await page.context().request.post(REPORT_URL, {
      headers: { Authorization: bearer, 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*' },
      data: body, timeout: 120000, ignoreHTTPSErrors: true,
    });
    if (!resp.ok()) throw new Error('ReportDataSet HTTP ' + resp.status() + ' ' + (await resp.text().catch(() => '')).slice(0, 200));
    const json = await resp.json();
    const src = (json.Tables && json.Tables[0]) || [];
    if (!src.length) throw new Error('ReportDataSet returned 0 rows (Tables[0] empty).');

    const resolvers = buildResolvers(headers, colmap, src.slice(0, 50));
    const unresolved = headers.filter((h) => !resolvers[h]);
    if (unresolved.length) console.log('[colmap] WARNING unresolved columns: ' + unresolved.join(', ') + ' (add them to colmap in scripts/sync-costing-' + report + '.js)');

    const aoa = [headers.slice()];
    for (const r of src) {
      aoa.push(headers.map((h) => {
        const k = resolvers[h];
        const v = k ? r[k] : null;
        return v === undefined ? null : v;
      }));
    }
    const rowCount = aoa.length - 1;
    console.log(`Parsed ${rowCount} rows for ${report} (${headers.length} columns).`);
    await writeSnapshot({ report, synced_at: new Date().toISOString(), row_count: rowCount, source: 'pact-reportdataset', status: 'ok', error: '', data: aoa });
    console.log('SYNC DONE.');
  } catch (e) {
    await fail(String(e && e.message ? e.message : e));
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { runCostingReport };
