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
  // Report names as they appear in PACT's BI → List of Reports grid. The scraper
  // double-clicks the exact row with this name, so these MUST match PACT's current
  // labels letter-for-letter. SI was wrong (verified 2026-10-17 via screenshot: the
  // actual stock-inward report is "Stock Inward Lab Report", not "List Of Stock
  // Inward Reports"). If PACT renames one, update it here.
  si:  { search: 'stock inward',  report: 'Stock Inward Lab Report' },
  pm:  { search: 'product master', report: 'Product Master Report' },
  bom: { search: 'stage wise bom', report: 'Stage Wise BOM With Wastage Summary' },
  pf:  { search: 'process flow',  report: 'Process Flow Report' },
};

// Reports that return only today's data by default and need a rolling date range.
// Value = days back the range starts; the range ends today (IST).
// 2026-10-24 (Satvik): Process Flow Report widened to a 10-day rolling window
// so the dashboard always carries the most recent batch cycle plus a buffer
// for late corrections. Stock Inward stays at 7 — stock receipts are logged
// same-day in PACT so a wider window just scrapes stale rows.
const DATE_DAYS = { si: 7, pf: 10 };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (d) => d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
function istRange(daysBack) {
  const now = new Date(Date.now() + 5.5 * 3600 * 1000);
  const from = new Date(now.getTime() - daysBack * 86400 * 1000);
  const iso = (d) => d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  return { fromStr: fmtDate(from), toStr: fmtDate(now), fromISO: iso(from), toISO: iso(now) };
}
// Best-effort: fill the report's From/To date fields, and RETURN what fields
// exist (so the log reveals the exact fields + their format even if the guess
// misses). Writes the value in multiple formats so PACT's picker (which may
// expect "DD MMM YYYY", "DD/MM/YYYY" or ISO) binds to at least one. Verifies
// the stored value after dispatching events — if the picker reset the field
// (common on bound widgets that reject out-of-pattern input), we try the next
// format. Returns the format that actually stuck for each field.
async function setDateRange(page, fromDisplay, toDisplay, fromISO, toISO) {
  return await page.evaluate(({ fromDisplay, toDisplay, fromISO, toISO }) => {
    const setV = (el, val) => {
      const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      s.call(el, val);
      ['input', 'change', 'keyup', 'blur'].forEach((t) => el.dispatchEvent(new Event(t, { bubbles: true })));
    };
    // Try several candidate formats in order; keep the first one the input
    // actually retains after the events fire. PACT's angular-material pickers
    // routinely reject "DD MMM YYYY" and bind "DD/MM/YYYY" (verified 2026-10-24
    // for the Process Flow Report parameter screen).
    const trySet = (el, variants) => {
      for (const v of variants) {
        try { setV(el, v); } catch { continue; }
        // Read back — if the picker rewrote it (whitespace, slashes, blank), skip.
        const after = (el.value || '').trim();
        if (after && after.replace(/\s+/g, '').length >= 6) return v + ' -> ' + after;
      }
      return null;
    };
    const dmy  = (iso) => { const [y, m, d] = iso.split('-'); return d + '/' + m + '/' + y; };
    const dmyD = (iso) => { const [y, m, d] = iso.split('-'); return d + '-' + m + '-' + y; };
    // DD/MM/YYYY first — verified from the Process Flow Report parameter screen
    // (dbcol_dt1/dbcol_dt2 carry e.g. "01/04/2026" by default). Other variants
    // kept as fallbacks for reports that use ISO or "DD MMM YYYY".
    const fromVariants = [dmy(fromISO), dmyD(fromISO), fromDisplay, fromISO];
    const toVariants   = [dmy(toISO),   dmyD(toISO),   toDisplay,   toISO];

    const inputs = [...document.querySelectorAll('input')];
    // Full dump so the log shows the real date UI even if the match misses.
    const allInputs = inputs.slice(0, 30).map((i) => ({
      id: i.id || '', ph: i.placeholder || '', nm: i.name || '', ty: i.type || '',
      v: (i.value || '').slice(0, 24),
    }));
    const selects = [...document.querySelectorAll('select')].slice(0, 12).map((s) => ({
      id: s.id || '', nm: s.name || '', v: (s.value || '').slice(0, 24),
    }));

    // 2026-10-24 (Satvik): first look for PACT's dbcol_dt<N> inputs, which
    // the Process Flow / Stock Inward parameter screens use for the date
    // filter (dbcol_dt1 = From, dbcol_dt2 = To — verified from a live
    // dateDiag log). When those exist we use them in numerical-suffix order
    // and skip the heuristic ranker entirely.
    const dbColInputs = inputs
      .map((i, idx) => ({ i, idx, m: /^dbcol_dt(\d+)$/i.exec(i.id || '') }))
      .filter((x) => x.m)
      .sort((a, b) => Number(a.m[1]) - Number(b.m[1]));

    let fromSet = null, toSet = null;
    if (dbColInputs.length >= 2) {
      const fRes = trySet(dbColInputs[0].i, fromVariants);
      if (fRes) fromSet = dbColInputs[0].i.id + ' <- ' + fRes;
      const tRes = trySet(dbColInputs[1].i, toVariants);
      if (tRes) toSet   = dbColInputs[1].i.id + ' <- ' + tRes;
    }

    // Score each remaining input by how likely it is to be the From or To
    // date, used when dbcol_dt<N> isn't present. Highest signal wins.
    const tag = (i) => ((i.id || '') + ' ' + (i.placeholder || '') + ' ' + (i.name || '') + ' ' + (i.getAttribute('ng-reflect-name') || '')).toLowerCase();
    const rankFrom = (i) => {
      const s = tag(i);
      let r = 0;
      if (/\bfromdate\b|\bdtfrom\b|\bdatefrom\b|\btxtfromdate\b|\bfrmdt\b|\bdbcol_?dt1\b/.test(s)) r += 10;
      if (/\b(from|frm|w\.?e\.?f|start)\b/.test(s)) r += 4;
      if (i.type === 'date')                        r += 2;
      if (/\d{1,2}[ /-]\w{2,3}[ /-]\d{2,4}/.test(i.value || '')) r += 1;
      return r;
    };
    const rankTo = (i) => {
      const s = tag(i);
      let r = 0;
      if (/\btodate\b|\bdtto\b|\bdateto\b|\btxttodate\b|\btodt\b|\btill\b|\bupto\b|\bdbcol_?dt2\b/.test(s)) r += 10;
      if (/(^|[^a-z])(to|till|upto|end)([^a-z]|$)/.test(s) && !/from/.test(s)) r += 4;
      if (i.type === 'date')                        r += 2;
      if (/\d{1,2}[ /-]\w{2,3}[ /-]\d{2,4}/.test(i.value || '')) r += 1;
      return r;
    };
    if (fromSet === null) {
      const fromCands = inputs.map((i, idx) => ({ i, idx, r: rankFrom(i) })).filter((x) => x.r > 0).sort((a, b) => b.r - a.r);
      if (fromCands[0]) {
        const r = trySet(fromCands[0].i, fromVariants);
        if (r) fromSet = (fromCands[0].i.id || fromCands[0].i.placeholder || ('pos' + fromCands[0].idx)) + ' <- ' + r;
      }
    }
    if (toSet === null) {
      const toCands = inputs.map((i, idx) => ({ i, idx, r: rankTo(i) })).filter((x) => x.r > 0).sort((a, b) => b.r - a.r);
      if (toCands[0]) {
        const r = trySet(toCands[0].i, toVariants);
        if (r) toSet = (toCands[0].i.id || toCands[0].i.placeholder || ('pos' + toCands[0].idx)) + ' <- ' + r;
      }
    }
    // Last-ditch fallback — but ONLY among inputs that look like a date and
    // explicitly skip the top-of-page search boxes that trapped the old
    // heuristic (SearchByPage, "Search..." placeholders).
    if (fromSet === null || toSet === null) {
      const isSearch = (i) => /searchbypage|^search\.\.\.$|^search$/i.test(((i.id || '') + ' ' + (i.placeholder || '')).trim());
      const looksDate = (i) => !isSearch(i) && (/date|from|to|frm|dt|period/i.test(tag(i)) || i.type === 'date' || /\d{1,2}[ /-]\w{2,3}[ /-]\d{2,4}/.test(i.value || ''));
      const di = inputs.filter(looksDate);
      if (fromSet === null && di[0]) { const r = trySet(di[0], fromVariants); if (r) fromSet = 'pos0 <- ' + r; }
      if (toSet   === null && di[1]) { const r = trySet(di[1], toVariants);   if (r) toSet   = 'pos1 <- ' + r; }
    }
    return { totalInputs: inputs.length, allInputs, selects, fromSet, toSet };
  }, { fromDisplay, toDisplay, fromISO, toISO });
}

// A ReportDataSet table is "real report data" only if its first row has more than
// one column, isn't PACT's tiny StaticReportType init payload, AND has at least
// MIN_REAL_ROWS rows. Without the row-count check, PACT's intermediate init table
// (column defs with 1-2 all-null rows) matches and the sync records a bogus
// "status: ok, row_count: 2" with no actual data (observed in BOM/SI 2026-10-17).
const MIN_REAL_ROWS = 10;
function isRealReport(rows) {
  if (!Array.isArray(rows) || rows.length < MIN_REAL_ROWS) return false;
  const cols = Object.keys(rows[0] || {});
  if (cols.length <= 1) return false;
  if (cols.some((c) => /StaticReportType/i.test(c)) && cols.length <= 2) return false;
  return true;
}
// Fallback for the end-of-wait path: accept a smaller table if nothing bigger
// ever arrived. Still rejects StaticReportType stubs and single-column shells.
function isUsableReport(rows) {
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
  page.setDefaultTimeout(60000); // PACT can be slow; 20s was too tight (observed timeouts 2026-10-17)

  // Intercept every ReportDataSet response. Keep two candidates:
  //   `best`     — the largest table that passes isRealReport (>=10 rows).
  //   `fallback` — the largest table that is at least usable (>1 col, not stub)
  //                — used only if nothing bigger ever arrives.
  //
  // 2026-10-24 (Satvik): PACT's Process Flow Report ships its data columns
  // keyed by opaque hashes like "C2d5a5a8e333842e483179f38b98765b9" instead
  // of readable captions. Verified from the live response:
  //   • json.Columns      = [[hash0, hash1, ..., hash43]]   (positional ids)
  //   • json.ColumnsTypes = [[type0, type1, ..., type43]]   (positional types)
  //   • The captions themselves are NOT in the JSON — they live in the
  //     rendered grid's <th> cells on the report page.
  // After the report renders, grabCaptionsFromGrid() reads the grid headers
  // and we zip them with bestColumnIds to build hash->caption, then apply
  // it to the data before buildResolvers runs.
  let best = null, bestSchema = null, bestColumnIds = null, fallback = null, seen = 0;
  const isSchemaTable = (t) => {
    if (!Array.isArray(t) || !t.length || t.length > 300) return false;
    const row0 = t[0] || {};
    const keys = Object.keys(row0);
    // A schema row typically carries both a column identifier and a
    // human caption. Match generously — PACT has used ColumnID, ColumnId,
    // Name, DataField, FieldName, Alias in various reports.
    const hasId      = keys.some((k) => /^(columnid|columnname|name|datafield|fieldname|alias|id)$/i.test(k));
    const hasCaption = keys.some((k) => /^(caption|header|headertext|displayname|label|title)$/i.test(k));
    return hasId && hasCaption;
  };
  const consider = (body) => {
    if (!body || body.length < 120) return;
    let json; try { json = JSON.parse(body); } catch { return; }
    const tables = (json && json.Tables) || [];

    // The hash->caption mapping travels in json.Columns (sibling, not inside
    // Tables). Verified 2026-10-24 Process Flow run: top-level JSON keys are
    // Tables, Columns, ColumnsTypes, obj, AppColTypeAccess. We look at both
    // Columns and ColumnsTypes just in case the id/caption fields are split
    // across them. Each shape handled:
    //   • Array of { ColumnID, Caption }-style rows -> rebuilt into a Map
    //   • Plain object { "C2d5...": "JOB", ... }    -> used directly
    //   • Nested in a key like .obj                 -> unwrap and retry
    let schemaHere = null;
    const extractSchema = (val) => {
      if (!val) return null;
      // Shape: plain object { id: caption, ... }
      if (!Array.isArray(val) && typeof val === 'object') {
        const entries = Object.entries(val).filter(
          ([k, v]) => typeof k === 'string' && (typeof v === 'string' || typeof v === 'number')
            && k.length > 4 && String(v).length > 0 && String(v).length < 80
        );
        if (entries.length >= 3) {
          return entries.map(([id, caption]) => ({ ColumnID: id, Caption: String(caption) }));
        }
      }
      // Shape: array of row objects — reuse the Tables-schema detector.
      if (Array.isArray(val) && val.length && typeof val[0] === 'object') {
        if (isSchemaTable(val)) return val;
      }
      return null;
    };
    for (const siblingKey of ['Columns', 'ColumnsTypes', 'obj']) {
      const raw = json && json[siblingKey];
      if (raw != null) {
        // Diagnostic: always log the raw shape of each sibling so we can see
        // what PACT actually sends even if extractSchema can't normalise it.
        if (Array.isArray(raw)) {
          const row0 = raw[0];
          log('[schema-raw] .' + siblingKey + ' is array[' + raw.length + ']'
            + (row0 && typeof row0 === 'object' ? ' | row[0] keys: ' + Object.keys(row0).join(',') + ' | row[0]=' + JSON.stringify(row0).slice(0, 240) : ' | row[0]=' + JSON.stringify(row0).slice(0, 240)));
        } else if (typeof raw === 'object') {
          const entries = Object.entries(raw);
          log('[schema-raw] .' + siblingKey + ' is object with ' + entries.length + ' entries'
            + ' | sample: ' + entries.slice(0, 4).map(([k, v]) => k.slice(0, 10) + '=' + String(v).slice(0, 40)).join(' | '));
        } else {
          log('[schema-raw] .' + siblingKey + ' is ' + typeof raw + ' = ' + String(raw).slice(0, 80));
        }
      }
      const found = extractSchema(raw);
      if (found) {
        schemaHere = found;
        const sample = found[0] || {};
        log('[schema] from .' + siblingKey + ' -> ' + found.length + ' entries | row[0]=' + JSON.stringify(sample).slice(0, 300));
        break;
      }
    }
    // Fall back to scanning Tables for a schema-shaped sibling (older
    // behaviour, still supported in case PACT re-shapes between reports).
    if (!schemaHere) {
      for (const t of tables) {
        if (isSchemaTable(t)) {
          schemaHere = t;
          const sample = t[0] || {};
          log('[schema] candidate (in Tables) -> ' + t.length + ' rows, keys: ' + Object.keys(sample).join(',')
            + ' | row[0]=' + JSON.stringify(sample).slice(0, 300));
          break;
        }
      }
    }
    for (const t of tables) {
      if (isRealReport(t) && (!best || t.length > best.length)) {
        best = t;
        if (schemaHere) bestSchema = schemaHere;
        // Store the positional id list travelling in json.Columns[0] so
        // we can later zip it with the grid's visible captions.
        if (json && Array.isArray(json.Columns) && Array.isArray(json.Columns[0])
            && json.Columns[0].length === Object.keys(t[0]).length) {
          bestColumnIds = json.Columns[0].slice();
        }
        const sampleKeys = Object.keys(t[0]).slice(0, 6);
        const sampleVals = sampleKeys.map((k) => k.slice(0, 10) + '=' + String(t[0][k]).slice(0, 24)).join(' | ');
        log('[capture] REAL table -> ' + t.length + ' rows, ' + Object.keys(t[0]).length + ' cols');
        log('[capture] sample row0: ' + sampleVals);
      } else if (isUsableReport(t) && (!fallback || t.length > fallback.length)) {
        fallback = t;
        log('[capture] fallback stub -> ' + t.length + ' rows, ' + Object.keys(t[0]).length + ' cols');
      }
    }
    // Also log top-level JSON shape when nothing resolved — useful if the
    // schema travels in a sibling key instead of a Tables entry.
    if (!best && json && typeof json === 'object') {
      const topKeys = Object.keys(json).slice(0, 10);
      log('[json] top-level keys: ' + topKeys.join(',') + ' | Tables.len=' + tables.length);
    }
  };

  // Pull the visible column captions from the report's grid header. PACT's
  // response omits them (only hash IDs come across), so the only reliable
  // source is the rendered DOM. We prefer <th> cells that live under the
  // report body (not the global SearchByPage header); fall back to any
  // non-empty <th>. Returns an array in the grid's column order.
  const grabCaptionsFromGrid = async () => {
    try {
      const caps = await page.evaluate(() => {
        // Candidate header containers, in rough preference order. The report
        // page uses angular-material-style grids where columnheader is on a
        // <th>, <mat-header-cell>, or an element with [role="columnheader"].
        const roots = [
          '.report-body table thead',
          '.report-container table thead',
          'mat-table mat-header-row',
          '[role="rowgroup"] [role="row"]:first-child',
          'table thead',
          'thead',
        ];
        for (const sel of roots) {
          const root = document.querySelector(sel);
          if (!root) continue;
          const cells = [...root.querySelectorAll('th, mat-header-cell, [role="columnheader"]')];
          const texts = cells.map((c) => (c.innerText || c.textContent || '').replace(/\s+/g, ' ').trim())
            .filter((t) => t && t.length < 80);
          if (texts.length >= 6) return { sel, texts };
        }
        // Last-ditch: every <th> on the page, filtered.
        const all = [...document.querySelectorAll('th, mat-header-cell, [role="columnheader"]')];
        const texts = all.map((c) => (c.innerText || c.textContent || '').replace(/\s+/g, ' ').trim())
          .filter((t) => t && t.length < 80 && !/^(check|select all|action|edit|delete)$/i.test(t));
        return { sel: '*', texts };
      });
      log('[grid] caption sel=' + caps.sel + ' count=' + caps.texts.length
        + ' | first: ' + caps.texts.slice(0, 12).join(' | '));
      return caps.texts;
    } catch (e) {
      log('[grid] caption extract failed: ' + String(e.message).slice(0, 120));
      return [];
    }
  };

  // Rename columns in a captured table using a zip of PACT's positional
  // column-id list and the grid's visible captions. Falls through to the
  // schema-mapping path when a schema table was found instead.
  const applyPositionalMapping = (data, ids, captions) => {
    if (!data || !ids || !captions || !ids.length || !captions.length) return data;
    // The grid may have an extra leading "#" / selector column that the data
    // doesn't carry — if captions is one longer than ids, drop the first.
    let caps = captions.slice();
    if (caps.length === ids.length + 1) caps = caps.slice(1);
    const n = Math.min(ids.length, caps.length);
    const map = new Map();
    for (let i = 0; i < n; i++) {
      const id = String(ids[i] || '').trim();
      const cap = String(caps[i] || '').trim();
      if (id && cap) map.set(id, cap);
    }
    if (!map.size) return data;
    log('[grid] positional mapping -> ' + map.size + ' entries. sample: '
      + [...map.entries()].slice(0, 8).map(([k, v]) => k.slice(0, 10) + '->' + v).join(' | '));
    return data.map((row) => {
      const out = {};
      for (const k of Object.keys(row)) out[map.get(k) || k] = row[k];
      return out;
    });
  };

  // Rename columns in a captured table from PACT's opaque hash IDs to
  // human captions, using a schema table that carries both. Returns the
  // same table reference with renamed keys when a mapping is found, or
  // the input unchanged when no schema is available.
  const applySchemaMapping = (data, schema) => {
    if (!data || !schema || !schema.length) return data;
    const row0 = schema[0] || {};
    const keys = Object.keys(row0);
    const idKey = keys.find((k) => /^(columnid|columnname|name|datafield|fieldname|alias|id)$/i.test(k));
    const capKey = keys.find((k) => /^(caption|header|headertext|displayname|label|title)$/i.test(k));
    if (!idKey || !capKey) return data;
    const map = new Map();
    for (const r of schema) {
      const id = String(r[idKey] == null ? '' : r[idKey]).trim();
      const cap = String(r[capKey] == null ? '' : r[capKey]).trim();
      if (id && cap) map.set(id, cap);
    }
    if (!map.size) return data;
    log('[schema] applying mapping, ' + map.size + ' entries. sample: '
      + [...map.entries()].slice(0, 5).map(([k, v]) => k.slice(0, 10) + '->' + v).join(' | '));
    const renamed = data.map((row) => {
      const out = {};
      for (const k of Object.keys(row)) out[map.get(k) || k] = row[k];
      return out;
    });
    return renamed;
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

    // Open the report. The grid is sometimes virtualized / below the fold, and
    // getByText loosely can resolve to a hidden duplicate (menu tooltip, etc.),
    // so prefer an EXACT-text locator, scroll it into view, then dblclick.
    // Fallbacks: the enclosing row's dblclick, and a single-click + Enter.
    let opened = false;
    try {
      const exactText = page.getByText(nav.report, { exact: true }).first();
      await exactText.scrollIntoViewIfNeeded({ timeout: 6000 }).catch(() => {});
      await exactText.dblclick({ timeout: 10000 });
      opened = true;
      log('[ui] dblclicked exact "' + nav.report + '"');
    } catch (e) { log('[ui] exact dblclick failed: ' + String(e.message).slice(0, 80)); }

    if (!opened) {
      // Fallback: target the <tr> / grid row that contains the exact text — the
      // row is often the real dblclick handler, with the inner cell no-op'ing.
      try {
        const row = page.locator('tr, [role="row"]').filter({ hasText: nav.report }).first();
        await row.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
        await row.dblclick({ timeout: 8000 });
        opened = true;
        log('[ui] dblclicked row with "' + nav.report + '"');
      } catch (e) { log('[ui] row dblclick failed: ' + String(e.message).slice(0, 80)); }
    }

    if (!opened) {
      // Last-resort: single-click to focus the row, then press Enter — PACT's
      // grid supports keyboard activation on the focused row.
      try {
        const exactText = page.getByText(nav.report, { exact: true }).first();
        await exactText.click({ timeout: 5000 });
        await page.keyboard.press('Enter');
        opened = true;
        log('[ui] opened "' + nav.report + '" via click + Enter');
      } catch (e) { log('[ui] click+Enter also failed: ' + String(e.message).slice(0, 80)); }
    }
    await page.waitForTimeout(3000);

    // Date-driven reports (Stock Inward, Process Flow) need a rolling window.
    let dateDiag = '';
    if (DATE_DAYS[report]) {
      await page.waitForTimeout(2500); // let the report/parameter screen render
      const { fromStr, toStr, fromISO, toISO } = istRange(DATE_DAYS[report]);
      try {
        const dr = await setDateRange(page, fromStr, toStr, fromISO, toISO);
        dateDiag = ('range ' + fromStr + '->' + toStr + ' from=' + dr.fromSet + ' to=' + dr.toSet + ' nIn=' + dr.totalInputs
          + ' | IN=' + JSON.stringify(dr.allInputs) + ' | SEL=' + JSON.stringify(dr.selects)).slice(0, 2000);
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
    // the largest REAL table seen, so we just wait for it to stop growing.
    {
      const deadline = Date.now() + 180000; // hard cap ~3 min (< the worker's 5-min job timeout)
      const SETTLE_MS = 12000;               // accept once the row count hasn't grown for 12s
      const MIN_WAIT_MS = 30000;             // always give the full report time to stream in
      const t0 = Date.now();
      let lastLen = -1, lastGrow = Date.now();
      while (Date.now() < deadline) {
        await page.waitForTimeout(1000);
        const len = best ? best.length : 0;
        if (len > lastLen) { lastLen = len; lastGrow = Date.now(); }
        if (best && (Date.now() - lastGrow >= SETTLE_MS) && (Date.now() - t0 >= MIN_WAIT_MS)) break;
      }
      if (best) log('[capture] settled at ' + best.length + ' rows');
      else if (fallback) log('[capture] no real table captured; fallback has ' + fallback.length + ' rows (will fail — not real data)');
    }
    if (!best || !best.length) {
      const fbInfo = fallback ? ' Fallback stub table had ' + fallback.length + ' rows, keys: ' + Object.keys(fallback[0]).slice(0, 10).join(',') + '.' : '';
      throw new Error('No real ReportDataSet data captured for "' + report + '" (ReportDataSet responses seen=' + seen + ', min rows required=' + MIN_REAL_ROWS + ').' + fbInfo + ' Likely: PACT returned only an init stub — the OK/Refresh click never triggered the real report, or the double-click opened the wrong page.');
    }

    // Rename hash-keyed columns to the captions the colmap understands. Two
    // paths available depending on what PACT shipped:
    //   1. PACT bundled a schema table alongside the data (BOM, PM, SI) — use
    //      applySchemaMapping (handles both {ColumnID, Caption}[] shape and
    //      plain {hash: caption} object maps).
    //   2. PACT ships only positional ids in json.Columns and leaves the
    //      captions in the DOM (Process Flow 2026-10-24) — grab the grid's
    //      <th> captions and zip them with bestColumnIds.
    let src = best;
    if (bestSchema) {
      src = applySchemaMapping(src, bestSchema);
    } else if (bestColumnIds && bestColumnIds.length) {
      const gridCaptions = await grabCaptionsFromGrid();
      if (gridCaptions.length >= Math.min(6, bestColumnIds.length)) {
        src = applyPositionalMapping(src, bestColumnIds, gridCaptions);
      }
    }
    log('[report] captured ' + src.length + ' rows, keys: ' + Object.keys(src[0]).slice(0, 12).join(','));
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
    // Save a short diagnostic trail on success too, so we can tell apart a healthy
    // run from one that squeaked past the row-count floor without having to re-run.
    const okDiag = ('rows=' + rowCount + ' | seen=' + seen + (dateDiag ? ' | ' + dateDiag.slice(0, 500) : '') + '\n--- log ---\n' + logTail(30)).slice(0, 3000);
    await writeSnapshot({ report, synced_at: new Date().toISOString(), row_count: rowCount, source: 'pact-browserdrive', status: 'ok', error: okDiag, data: aoa });
    log('SYNC DONE.');
  } catch (e) {
    await fail(String(e && e.message ? e.message : e));
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { runCostingReport };
