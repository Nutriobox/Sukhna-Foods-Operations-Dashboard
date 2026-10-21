// On-demand PACT "Stock Outlet Outward (Transfer Location)" sync.
//
// Mirrors scripts/sync-outlet-requisitions.js: drive the BI report UI, set
// From/To, run the report, intercept the ReportDataSet response (its token is
// single-use so we can't replay it), parse the rows, and upsert into
// public.pact_stock_outlet_outward. The dashboard's Purchase tab reads this
// table via /api/outlet-grns.
//
// Column discovery:
// PACT keys columns with per-report content hashes like "C0af47bff...". I
// don't have a HAR capture of this specific report yet, so the scraper
// auto-detects which column is which by matching the first row's values
// against the known report shape (SOT-AF/... for Doc No, "Nutribox (…)" for
// Transfer Location, Frozen/Chiller/… for Outlet Issue Type, etc.). Once a
// run succeeds, the detected keys are logged — paste them into the C constant
// below to pin the mapping and speed up later runs.
//
// Env:
//   PACT_URL, PACT_USER, PACT_PASS (or PACT_PASSWORD)
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
//   OUTWARD_DAYS_BACK   (default 30 — how far back to pull)
//   OUTWARD_HEADLESS    ('false' to see the browser; default 'true')
//   OUTWARD_DRY_RUN     ('true' to parse + log without writing to Supabase)
//
// Schedule:
//   Hourly, same as the other PACT syncs. On the pact-windows EC2 use Task
//   Scheduler → New Task → Trigger: Daily, repeat every 1 hour → Action: Run
//   'node C:\path\to\scripts\sync-outlet-outward.js' from the repo root.

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const { login } = require('../src/lib/pact/login');

// Pinned column keys for the Stock Outlet Outward_Transfer Location report,
// captured from the live BI UI 2026-10-21 inventory dump. All 9 fields are
// pinned; the leftover keys (C6eaf..Abr/.dno/.prf) are PACT's decomposed
// doc-no sub-fields and are intentionally not mapped.
// Leave a field as '' to force auto-detect on it (keep the inventory block
// below enabled so we can re-pin if PACT re-hashes its column keys).
const C = {
  doc_no:            'C6eaf2c1718724b5695d4188c9639eeb0',
  doc_date:          'Ccc334cab7d154f7f93b37cf5939e3d50',
  transfer_location: 'C46fa7a64d72945f8b8f62e7c196733c1',
  product_name:      'C4b0092c636c3470889bc640d8b6095e9',
  unit:              'Cec13213b195e44d4a3b8eeec133d1ee3',
  outlet_qty:        'C82163b1c94994480a17bafa73e0bb1fc',
  batch_no:          'Cc0c28a4205ce45fe81407f37d59668a1',
  outlet_issue_type: 'C9a90c6d9e41e4da68c86ba51770e7c5d',
  narration:         'Cb70889a95cb9418c95030889f3fb6906',
};

const sb = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

const DAYS_BACK = Math.max(1, Math.min(365, Number(process.env.OUTWARD_DAYS_BACK) || 30));
const HEADLESS  = String(process.env.OUTWARD_HEADLESS ?? 'true').toLowerCase() !== 'false';
const DRY_RUN   = String(process.env.OUTWARD_DRY_RUN  ?? 'false').toLowerCase() === 'true';

const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/,/g, '')); return isNaN(n) ? 0 : n; };
const str = (v) => { const s = String(v == null ? '' : v).trim(); return (s === 'None') ? '' : s; };
const log = (...a) => console.log.apply(console, a);

// Dashboard-friendly branch label stripped from PACT's "Nutribox (Prashant
// Vihar)" style. Keep the raw transfer_location too; this is a convenience
// for the API's ?outlet= filter and the dashboard's outlet picker.
function normalizeOutletName(transferLocation) {
  if (!transferLocation) return '';
  const t = String(transferLocation).trim();
  const m = t.match(/^(?:nutri[o]?box)\s*\(([^)]+)\)\s*$/i);
  if (m) return m[1].trim();
  return t;
}

const KNOWN_CATEGORIES = new Set(['Frozen', 'Chiller', 'Vegetable', 'Dry Store', 'Packaging']);

// Classify a sample value against the expected report-column shapes. The
// return keys match the C constant above; the first row's values let us pin
// the hashes without a HAR capture.
function classifyColumn(sampleValues) {
  const sv = sampleValues.filter((v) => v != null && String(v).trim() !== '');
  if (!sv.length) return null;
  const first = String(sv[0]).trim();
  // Doc No: SOT-AF/26-27/3151, or similar outward-doc prefix
  if (/^SOT[-_]/i.test(first)) return 'doc_no';
  // Doc Date — try every PACT date shape I've seen:
  //  2026-10-01, 2026-10-01T00:00:00(.000)(Z)?, 01/10/2026, 01-Oct-2026,
  //  /Date(1727740800000)/ (old .NET format), or a 10/13-digit Unix epoch.
  if (/^\d{4}-\d{1,2}-\d{1,2}(T\d{1,2}:\d{1,2}(:\d{1,2}(\.\d{1,3})?)?Z?)?$/.test(first)) return 'doc_date';
  if (/^\d{1,2}[\/\-\. ]\d{1,2}[\/\-\. ]\d{2,4}$/.test(first)) return 'doc_date';
  if (/^\d{1,2}[\/\-\. ][A-Za-z]{3,}[\/\-\. ]\d{2,4}$/.test(first)) return 'doc_date';
  if (/^\/Date\(\d+([+-]\d+)?\)\/$/.test(first)) return 'doc_date';
  // Unix epoch: 10-digit seconds (post-2001) or 13-digit ms (post-2001)
  if (/^1[6-9]\d{8}$/.test(first) || /^1[6-9]\d{11}$/.test(first)) return 'doc_date';
  // Transfer Location: starts with Nutribox / Nutriobox
  if (/^nutri[o]?box\b/i.test(first)) return 'transfer_location';
  // Outlet Issue Type: one of the five storage categories
  if (sv.every((v) => KNOWN_CATEGORIES.has(String(v).trim()))) return 'outlet_issue_type';
  // Unit: short code
  if (sv.every((v) => /^(Pkt|Pcs|Bunch|Kg|Gms|ML|L|Bottle|Can|Bag|Box|Case|Tin|Container|Unit)$/i.test(String(v).trim()))) return 'unit';
  // Batch No: typically alphanumeric with slash, e.g. FN0049/24092601
  if (sv.every((v) => /^[A-Z]{1,6}\d{3,}[\/-]?\d*$/i.test(String(v).trim()))) return 'batch_no';
  // Outlet Qty: numeric, non-negative
  if (sv.every((v) => /^-?\d+(\.\d+)?$/.test(String(v).trim()))) return 'outlet_qty';
  // Everything else: Product Name or Narration (both are free text). Narration
  // is typically mostly empty across rows; Product Name is always present.
  return null;  // let the caller resolve
}

// Pick product_name and narration by density: product_name is populated on
// every row, narration mostly empty.
function assignProductAndNarration(unassignedKeys, allRows) {
  if (!unassignedKeys.length) return {};
  const stats = unassignedKeys.map((k) => {
    const filled = allRows.filter((r) => str(r[k]) !== '').length;
    return { key: k, filled };
  });
  stats.sort((a, b) => b.filled - a.filled);
  const out = {};
  if (stats[0]) out.product_name = stats[0].key;
  if (stats[1]) out.narration    = stats[1].key;
  return out;
}

function firstNonEmpty(rows, k, limit = 50) {
  for (let i = 0; i < Math.min(rows.length, limit); i++) {
    const v = rows[i][k];
    const s = v == null ? '' : String(v).trim();
    if (s) return s;
  }
  return '';
}

function discoverColumns(rows) {
  const first = rows[0] || {};
  const keys = Object.keys(first);
  const colSamples = {};
  for (const k of keys) {
    colSamples[k] = rows.slice(0, 20).map((r) => r[k]);
  }
  const map = {};
  const unassigned = [];
  for (const k of keys) {
    const cls = classifyColumn(colSamples[k]);
    if (cls && !map[cls]) map[cls] = k;
    else if (!cls) unassigned.push(k);
  }
  // Deterministic fallback for Product Name / Narration.
  const resolved = assignProductAndNarration(unassigned, rows);
  if (resolved.product_name) map.product_name = resolved.product_name;
  if (resolved.narration)    map.narration    = resolved.narration;
  // Keep the leftover keys so the caller can print sample values for them.
  map.__unassigned = unassigned.filter((k) => k !== resolved.product_name && k !== resolved.narration);
  return map;
}

function findDataTable(json, discoveryHints) {
  const tables = (json && json.Tables) || [];
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i];
    if (!Array.isArray(t) || !t.length || !t[0] || typeof t[0] !== 'object') continue;
    // Prefer a table whose row count looks like line items (> 1 and the first
    // row contains at least one obviously-SOT value).
    const vals = Object.values(t[0]).map((v) => String(v || ''));
    if (vals.some((v) => /^SOT[-_]/i.test(v))) return { rows: t, tableIndex: i };
  }
  // Fallback: the biggest Tables[i] by row count.
  let best = { rows: [], tableIndex: -1 };
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i];
    if (Array.isArray(t) && t.length > best.rows.length) best = { rows: t, tableIndex: i };
  }
  return best;
}

async function upsertRows(rows) {
  if (!sb) { log('[supabase] not configured; skipping write'); return; }
  if (DRY_RUN) { log('[dry-run] would upsert', rows.length, 'rows'); return; }
  if (!rows.length) { log('[supabase] no rows to upsert'); return; }
  // Chunk to stay under PostgREST payload limits on a big back-fill.
  let total = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await sb
      .from('pact_stock_outlet_outward')
      .upsert(chunk, { onConflict: 'doc_no,product_name,batch_no,unit' });
    if (error) { log('[supabase] upsert chunk', i / 500, 'failed:', error.message); return; }
    total += chunk.length;
  }
  log('[supabase] upserted', total, 'rows');
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

// Set the date range on the two pactdatepickers. From = today - DAYS_BACK,
// To = today. Robust against build-to-build differences in the picker.
async function setDateRange(page) {
  try {
    const pickers = page.locator('app-pactdatepicker');
    const n = await pickers.count();
    log('[date] pact datepickers on form:', n);
    if (n < 2) return;
    const now = new Date();
    const from = new Date(now); from.setDate(from.getDate() - DAYS_BACK);
    const d2 = (n) => String(n).padStart(2, '0');
    const typeInto = async (picker, isoDate) => {
      // Try the native input first (fastest); fall back to click + calendar if it fails.
      try {
        const input = picker.locator('input').first();
        await input.click({ timeout: 3000 });
        await input.fill('');
        // PACT date input accepts dd/mm/yyyy
        const [y, m, d] = isoDate.split('-');
        await input.type(`${d}/${m}/${y}`, { delay: 20 });
        await input.press('Tab');
        return true;
      } catch (e) { /* fall through */ }
      try {
        await picker.locator('.List__button, button').first().click({ timeout: 4000 });
        // Walk the mini-calendar back; this is best-effort.
        await page.getByText(String(Number((isoDate).split('-')[2])), { exact: true }).first().click({ timeout: 4000 });
        return true;
      } catch (e) { return false; }
    };
    await typeInto(pickers.nth(0), from.getFullYear() + '-' + d2(from.getMonth() + 1) + '-' + d2(from.getDate()));
    log('[date] set From to', DAYS_BACK, 'days back');
    await typeInto(pickers.nth(1), now.getFullYear()  + '-' + d2(now.getMonth()  + 1) + '-' + d2(now.getDate()));
    log('[date] set To to today');
  } catch (e) {
    log('[date] range set skipped:', String(e.message).slice(0, 80));
  }
}

(async () => {
  if (!process.env.PACT_PASSWORD && process.env.PACT_PASS) process.env.PACT_PASSWORD = process.env.PACT_PASS;
  log('[config] days_back=' + DAYS_BACK + ' headless=' + HEADLESS + ' dry_run=' + DRY_RUN);

  const browser = await chromium.launch({ headless: HEADLESS, args: ['--window-size=1680,1050'] });
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
      if (!dataText && body.length > 2000) { dataText = body; log('[capture] matched data body bytes=' + body.length); }
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
      await search.first().fill('stock outlet outward');
      await search.first().press('Enter');
      try { await page.getByRole('button').filter({ hasText: /^$/ }).first().click({ timeout: 2500 }); } catch (e2) {}
      log('[ui] searched stock outlet outward');
    } catch (e) { log('[ui] search skipped: ' + String(e.message).slice(0, 60)); }
    await page.waitForTimeout(2500);

    // Open the "Stock Outlet Outward_Transfer Location" row. Case-insensitive
    // and lenient on the connecting character (space, hyphen, underscore).
    let opened = false;
    const rowLoc = () => page.getByText(/Stock\s*Outlet\s*Outward[\s_\-]+Transfer\s*Location/i).first();
    try { await rowLoc().scrollIntoViewIfNeeded({ timeout: 4000 }); } catch (e) {}
    try { await rowLoc().dblclick({ timeout: 15000 }); opened = true; log('[ui] dblclicked report'); }
    catch (e) { log('[ui] dblclick failed: ' + String(e.message).slice(0, 60)); }
    if (!opened) {
      try { const el = rowLoc(); await el.click({ timeout: 8000 }); await el.press('Enter'); opened = true; log('[ui] click+Enter report'); }
      catch (e) { log('[ui] click+Enter failed: ' + String(e.message).slice(0, 60)); }
    }
    if (!opened) {
      try {
        const rows = await page.locator('.slick-row, [role="row"], li, tr').filter({ hasText: /Stock|Outward|Transfer/i }).allInnerTexts();
        log('[ui] report rows seen: ' + JSON.stringify(rows.slice(0, 8)).slice(0, 300));
      } catch (e) {}
      throw new Error('Could not open Stock Outlet Outward_Transfer Location report');
    }
    await page.waitForTimeout(3000);

    // Cost centers must be selected or the report returns no rows (same quirk
    // as the pending-outlet-requisition report).
    try { await page.getByText('Select All', { exact: true }).first().click({ timeout: 6000 }); log('[ui] checked Select All (cost centers)'); }
    catch (e) { log('[ui] Select All skip: ' + String(e.message).slice(0, 50)); }
    await page.waitForTimeout(600);

    await setDateRange(page);
    await page.waitForTimeout(600);

    await clickFirst(page, [
      () => page.getByRole('button', { name: 'OK', exact: true }),
      () => page.getByRole('button', { name: ' OK' }),
      () => page.getByText('OK', { exact: true }),
    ], 'OK');
    await page.waitForTimeout(3000);

    if (!dataText) {
      if (await clickFirst(page, [() => page.getByRole('button', { name: /Refresh/i }), () => page.getByText('Refresh', { exact: true })], 'Refresh')) await page.waitForTimeout(6000);
    }

    log('[ui] waiting for report data…');
    for (let i = 0; i < 120 && !dataText; i++) await page.waitForTimeout(1000);
    if (!dataText) throw new Error('ReportDataSet not captured. Responses seen=' + seen + '. Report UI may need a different trigger / date.');

    const json = JSON.parse(dataText);
    const { rows, tableIndex } = findDataTable(json);
    log('[report] data table index=' + tableIndex + ' rows=' + rows.length);
    if (!rows.length) { log('[report] empty data table — nothing to upsert'); return; }

    // Resolve column keys: always run auto-discovery, then let the pinned C
    // constants override. Pinned keys win; auto-discovery fills in anything
    // still unknown. When a required field is still missing, dump the first
    // non-empty value from each unassigned column so we can see which PACT
    // hash to pin.
    const discovered = discoverColumns(rows);
    const unassignedKeys = discovered.__unassigned || [];
    const map = {};
    for (const field of Object.keys(C)) {
      if (C[field]) { map[field] = C[field]; continue; }
      if (discovered[field]) map[field] = discovered[field];
    }
    log('[discover] column mapping:');
    for (const field of Object.keys(C)) {
      const key = map[field];
      const src = C[field] ? 'pinned' : (discovered[field] ? 'auto' : '(not found)');
      log('  ' + field.padEnd(20) + ' -> ' + (key || '-').padEnd(40) + ' [' + src + ']');
    }

    // Full-column inventory: every PACT column key and its first non-empty
    // sample value, with the field name we've mapped it to (if any). Lets us
    // spot cases where PACT exposes decomposed sub-fields of one logical
    // column (e.g. doc_no with .Abr / .dno / .prf parts) and the heuristic
    // pinned a sub-field by mistake.
    const keyToField = {};
    for (const field of Object.keys(C)) if (map[field]) keyToField[map[field]] = field;
    log('[inventory] all ' + Object.keys(rows[0] || {}).length + ' PACT column keys (first non-empty value):');
    for (const k of Object.keys(rows[0] || {})) {
      const field = keyToField[k] || '-';
      log('  ' + k.padEnd(42) + ' [' + field.padEnd(18) + '] = ' + JSON.stringify(firstNonEmpty(rows, k)));
    }

    // Required columns to produce a usable row.
    const required = ['doc_no', 'doc_date', 'transfer_location', 'product_name'];
    const missing = required.filter((f) => !map[f]);
    if (missing.length) {
      log('[discover] unassigned column keys (first non-empty sample value):');
      for (const k of unassignedKeys) {
        log('  ' + k + ' = ' + JSON.stringify(firstNonEmpty(rows, k)));
      }
      log('[discover] all keys in row 0: ' + Object.keys(rows[0] || {}).join(', '));
      throw new Error('Column discovery missing: ' + missing.join(', '));
    }

    // Parse into the Supabase row shape. doc_date comes back as text in
    // whatever PACT serialises; normalise to ISO YYYY-MM-DD. Supported shapes:
    //   dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy
    //   yyyy-mm-dd (bare or with Txx:xx[:xx[.sss]][Z] suffix)
    //   dd-Mon-yyyy / dd Mon yyyy
    //   /Date(1727740800000)/ (.NET epoch, optional ±hhmm offset)
    //   10-digit Unix epoch (seconds), 13-digit (ms)
    const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
    const toIso = (s) => {
      const t = String(s == null ? '' : s).trim();
      if (!t) return null;
      // dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy
      let m = t.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
      if (m) {
        const y = (m[3].length === 2 ? ('20' + m[3]) : m[3]);
        return y + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
      }
      // yyyy-mm-dd, optionally with Txx:xx[:xx[.sss]][Z]
      m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:T\d{1,2}:\d{1,2}(?::\d{1,2}(?:\.\d{1,3})?)?Z?)?$/);
      if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
      // dd-Mon-yyyy, dd Mon yyyy, dd/Mon/yyyy
      m = t.match(/^(\d{1,2})[\/\-\. ]([A-Za-z]{3,})[\/\-\. ](\d{2,4})$/);
      if (m) {
        const mm = MONTHS[m[2].slice(0, 3).toLowerCase()];
        if (mm) {
          const y = (m[3].length === 2 ? ('20' + m[3]) : m[3]);
          return y + '-' + String(mm).padStart(2, '0') + '-' + m[1].padStart(2, '0');
        }
      }
      // /Date(1727740800000)/ or /Date(1727740800000+0530)/
      m = t.match(/^\/Date\((\d+)(?:[+-]\d+)?\)\/$/);
      if (m) {
        const d = new Date(Number(m[1]));
        if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
      }
      // Bare Unix epoch: 10-digit seconds (post-2001) or 13-digit ms
      if (/^1[6-9]\d{8}$/.test(t))  { const d = new Date(Number(t) * 1000); if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10); }
      if (/^1[6-9]\d{11}$/.test(t)) { const d = new Date(Number(t));         if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10); }
      return null;
    };

    const parsed = [];
    const dropReasons = { no_doc: 0, no_date: 0, no_product: 0 };
    const dropSamples = [];
    for (const r of rows) {
      const docNoRaw  = r[map.doc_no];
      const docDateRaw = r[map.doc_date];
      const productRaw = r[map.product_name];
      const docNo    = str(docNoRaw);
      const docDate  = toIso(docDateRaw);
      const transfer = str(r[map.transfer_location]);
      const product  = str(productRaw);
      if (!docNo || !docDate || !product) {
        if (!docNo)   dropReasons.no_doc++;
        if (!docDate) dropReasons.no_date++;
        if (!product) dropReasons.no_product++;
        if (dropSamples.length < 3) {
          dropSamples.push({
            doc_no_raw: docNoRaw, doc_date_raw: docDateRaw, product_raw: productRaw,
            doc_date_parsed: docDate,
          });
        }
        continue;
      }
      parsed.push({
        doc_no:             docNo,
        doc_date:           docDate,
        transfer_location:  transfer,
        outlet_name:        normalizeOutletName(transfer),
        product_name:       product,
        unit:               map.unit              ? str(r[map.unit])              : null,
        outlet_qty:         map.outlet_qty        ? num(r[map.outlet_qty])        : null,
        batch_no:           map.batch_no          ? str(r[map.batch_no])          : null,
        outlet_issue_type:  map.outlet_issue_type ? str(r[map.outlet_issue_type]) : null,
        narration:          map.narration         ? str(r[map.narration])         : null,
      });
    }

    log('[parse] parsed', parsed.length, 'rows from', rows.length, 'raw report rows');
    if (parsed[0]) log('[parse] sample row:', JSON.stringify(parsed[0]));
    if (!parsed.length && rows.length) {
      log('[parse] all rows dropped. reasons:', JSON.stringify(dropReasons));
      log('[parse] first dropped-row samples (raw values, so you can see shape):');
      for (const d of dropSamples) log('  ', JSON.stringify(d));
    }
    await upsertRows(parsed);
    log('[done] sync complete');
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => {
  console.error('FATAL:', e && e.stack || e && e.message || e);
  process.exit(1);
});
