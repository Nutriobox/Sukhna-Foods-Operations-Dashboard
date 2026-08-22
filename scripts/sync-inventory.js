// Scheduled PACT inventory sync (GitHub Actions entrypoint).
//
// Logs into PACT with a real Chromium, pulls the "BatchWise Stock Analysis"
// report as its full Excel/HTML export, parses every batch, and writes ONE new
// snapshot row to Supabase (public.inventory_snapshots). The dashboard reads the
// latest snapshot so the Sales Order grid always matches live PACT stock.
//
// Why the export (not the on-screen grid): PACT renders the grid with SlickGrid,
// which only keeps the visible ~30 rows in the DOM. The "Export to Excel" output
// is the complete table — that is what we ingest.
//
// Env (GitHub Actions secrets):
//   PACT_USER, PACT_PASSWORD/PACT_PASS, PACT_URL
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
//   INV_REPORT_EXPORT_URL  — (preferred) the URL that returns the full HTML/Excel
//                            export of the BatchWise Stock Analysis. Captured once
//                            from the browser's Network tab when you click Export.
//   INV_REPORT_URL         — (fallback) the report page URL; the script opens it
//                            and clicks an Export/Excel button, capturing the file.

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const { login } = require('../src/lib/pact/login');

const RUN_LOG = [];
const _log = console.log.bind(console);
console.log = (...a) => { try { RUN_LOG.push(a.map(String).join(' ')); } catch {} _log(...a); };
const logTail = (n = 60) => RUN_LOG.slice(-n).join('\n').slice(-3500);

const sb = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

// ---- HTML export parser (Node, no DOM) -------------------------------------
function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, ' ').trim();
}
function cellsOf(rowHtml) {
  const out = [];
  const re = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let m;
  while ((m = re.exec(rowHtml))) out.push(decodeEntities(m[1].replace(/<[^>]+>/g, ' ')));
  return out;
}
function parseExport(html) {
  // Pick the <table> with the most rows (the data grid).
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  let best = '', bestRows = 0;
  for (const t of tables) {
    const n = (t.match(/<tr[\s>]/gi) || []).length;
    if (n > bestRows) { bestRows = n; best = t; }
  }
  const scope = best || html;
  const rows = scope.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  let header = null, cIdx = {};
  const norm = (s) => s.toLowerCase();
  const find = (cells, re) => cells.findIndex((c) => re.test(norm(c)));
  const data = [];
  for (const r of rows) {
    const cells = cellsOf(r);
    if (!header) {
      if (cells.some((c) => /product\s*code/i.test(c))) {
        header = cells;
        cIdx = {
          code: find(cells, /product\s*code/), name: find(cells, /product\s*name/),
          batch: find(cells, /batch/), wh: find(cells, /warehouse/), unit: find(cells, /unit/),
          qty: find(cells, /quantity/), rate: find(cells, /^\s*rate/), exp: find(cells, /exp/), mfg: find(cells, /mfg/),
        };
      }
      continue;
    }
    const code = (cells[cIdx.code] || '').trim();
    if (!/^[A-Za-z]{2}\d/.test(code)) continue;
    const qty = parseFloat((cells[cIdx.qty] || '0').replace(/,/g, '')) || 0;
    data.push({
      code,
      name: cells[cIdx.name] || '',
      batch: cells[cIdx.batch] || '—',
      warehouse: cells[cIdx.wh] || '—',
      unit: cells[cIdx.unit] || '—',
      qty,
      rate: (cells[cIdx.rate] || '').trim(),
      exp: cells[cIdx.exp] || '—',
      mfg: cells[cIdx.mfg] || '—',
    });
  }
  const products = new Set(data.map((d) => d.code)).size;
  return { data, products, batches: data.length, headerFound: !!header };
}

// ---- Get the report export HTML --------------------------------------------
async function fetchReportHtml(page) {
  const exportUrl = process.env.INV_REPORT_EXPORT_URL;
  if (exportUrl) {
    console.log('[report] GET export URL (with logged-in session cookies)');
    const resp = await page.context().request.get(exportUrl, { timeout: 60000, ignoreHTTPSErrors: true });
    console.log('[report] export status', resp.status());
    return await resp.text();
  }
  const reportUrl = process.env.INV_REPORT_URL;
  if (reportUrl) {
    console.log('[report] open report page and click Export');
    await page.goto(reportUrl, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(2500);
    // Best-effort: click a Generate/Show button first, then an Excel/Export one.
    for (const label of [/generate|show|view|search/i]) {
      await page.getByRole('button', { name: label }).first().click({ timeout: 3000 }).catch(() => {});
    }
    await page.waitForTimeout(2000);
    const clickExport = async () => {
      const tries = [
        () => page.getByRole('button', { name: /excel|export/i }).first().click({ timeout: 4000 }),
        () => page.getByTitle(/excel|export/i).first().click({ timeout: 4000 }),
        () => page.locator('[class*="excel" i], [id*="excel" i], [class*="export" i]').first().click({ timeout: 4000 }),
      ];
      for (const t of tries) { try { await t(); return true; } catch {} }
      return false;
    };
    const dl = await Promise.race([
      page.waitForEvent('download', { timeout: 20000 }).then((d) => d).catch(() => null),
      (async () => { await clickExport(); return null; })(),
    ]);
    if (dl) {
      const p = await dl.path();
      console.log('[report] captured download', dl.suggestedFilename());
      return fs.readFileSync(p, 'utf8');
    }
    console.log('[report] no download event — reading current page HTML as fallback');
    return await page.content();
  }
  throw new Error('Neither INV_REPORT_EXPORT_URL nor INV_REPORT_URL is set. Configure the BatchWise Stock Analysis export URL (see scripts/sync-inventory.js header).');
}

async function writeSnapshot(patch) {
  if (!sb) { console.log('[supabase] not configured; skipping write'); return; }
  const { error } = await sb.from('inventory_snapshots').insert(patch);
  if (error) console.log('[supabase] insert failed:', error.message);
  else console.log('[supabase] snapshot inserted:', patch.status, patch.batches, 'batches');
}

(async () => {
  if (!process.env.PACT_PASSWORD && process.env.PACT_PASS) process.env.PACT_PASSWORD = process.env.PACT_PASS;
  const browser = await chromium.launch({ headless: true, args: ['--window-size=1600,1000'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  try {
    await login(page);
    console.log('Logged in.');
    const html = await fetchReportHtml(page);
    const { data, products, batches, headerFound } = parseExport(html);
    if (!headerFound) throw new Error('Export parsed but no "Product Code" header row found — the export URL may be wrong or the session expired. First 300 chars: ' + html.slice(0, 300));
    if (!batches) throw new Error('Export parsed, header found, but 0 batch rows matched. Check the report filters (all warehouses).');
    console.log(`Parsed ${batches} batches across ${products} products.`);
    await writeSnapshot({ synced_at: new Date().toISOString(), products, batches, source: 'pact-batchwise', status: 'ok', data });
    console.log('SYNC DONE.');
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    console.log('SYNC FAILED:', msg.slice(0, 300));
    await writeSnapshot({ synced_at: new Date().toISOString(), products: 0, batches: 0, source: 'pact-batchwise', status: 'failed', error: (msg + '\n--- log ---\n' + logTail()).slice(0, 3500), data: [] });
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
})();
