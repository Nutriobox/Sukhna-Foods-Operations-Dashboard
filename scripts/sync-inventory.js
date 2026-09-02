// On-demand PACT inventory sync (GitHub Actions entrypoint).
//
// Logs into PACT with a real Chromium (to obtain a valid Bearer token + session
// cookie), then replays the BatchWise Stock Analysis report's own data call
//   POST /PACTALLUSUREAPI/api/Report/ReportDataSet
// and writes ONE snapshot row to Supabase (public.inventory_snapshots). No UI
// clicking — the request template was captured from a real report load, so this
// is fast and stable. The dashboard reads the latest snapshot.
//
// The "Quantity" mirrors the BatchWise report exactly (gross received qty per
// lot, matching the Excel export). Env: PACT_USER, PACT_PASS/PACT_PASSWORD,
// PACT_URL, SUPABASE_URL, SUPABASE_SERVICE_KEY.

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const { login } = require('../src/lib/pact/login');

// Exact ReportDataSet request body captured from a real report load (base64 so
// the embedded SQL / newlines survive verbatim). Date + UserID are re-injected
// at run time. Re-record (record-inventory.bat) if PACT changes this report.
const BODY_B64 = "eyJVc2VySUQiOiIxMDA4MCIsIkxhbmdJRCI6IjEiLCJpc1JlcG9ydERCIjowLCJRdWVyeUNvZGUiOiJSUFRTVF84MSIsInAxIjoiXG5kZWNsYXJlIEBUbyBmbG9hdFxuc2V0IEBUbz1DT05WRVJUKEZMT0FULENPTlZFUlQoREFURVRJTUUsJzIyIEF1ZyAyMDI2JykpXG4gICAgICAgICAgICBTRUxFQ1QgUC5Qcm9kdWN0SUQsUC5Qcm9kdWN0TmFtZSxCLkJhdGNoTnVtYmVyLEIuQmF0Y2hJRCxELkludkRvY0RldGFpbHNJRCxDT05WRVJUKERBVEVUSU1FLEIuRXhwaXJ5RGF0ZSkgRXhwRGF0ZSxDT05WRVJUKERBVEVUSU1FLEIuTWZnRGF0ZSkgTWZnRGF0ZSxELlVPTUNvbnZlcnRlZFF0eSBRdWFudGl0eSxELlN0b2NrVmFsdWUvRC5VT01Db252ZXJ0ZWRRdHkgUmF0ZSxELlZvdWNoZXJObyBEb2NObyxDT05WRVJUKERBVEVUSU1FLEQuRG9jRGF0ZSkgRG9jRGF0ZSxEb2N1bWVudFR5cGUuRG9jdW1lbnROYW1lIEFTIFtDMGQ5NTc4OWQzMGQyNDk2ODkzZGYzZTZkMGNhNzIyZTZdLFQxLk5hbWUgQVMgW0NhZGQ5ZjVkNDM1NjY0Y2U0YjFmMmU1OGI3YTE1Y2Y1MF0sVDIuUHJvZHVjdENvZGUgQVMgW0M0MGI3MDU1YjkyYTQ0ZmE2OGZiNThlMWYyZDEwZDkxOF0sVDIuUHJvZHVjdE5hbWUgQVMgW0NmZDMzMGFjYTJhMWY0NGJlODcxNmYxMDYzNjRiM2NjZl0sVDMuQmFzZU5hbWUgQVMgW0NiNDk2YzM5YzYzMDc0MmRiOTY4MmIwNDQ3NzQ1MThjM10sSFNORC5Db2RlIEFTIEhTTkNvZGUsSFNORC5OYW1lIEFTIEhTTk5hbWVcbkZST00gW0lOVl9Eb2NEZXRhaWxzXSBEIHdpdGgobm9sb2NrKVxuSU5ORVIgSk9JTiBJTlZfQmF0Y2hlcyBCIHdpdGgobm9sb2NrKSBPTiBELkJhdGNoSUQ9Qi5CYXRjaElEXG5JTk5FUiBKT0lOIFtJTlZfUHJvZHVjdF0gUCB3aXRoKG5vbG9jaykgT04gQi5Qcm9kdWN0SUQ9UC5Qcm9kdWN0SUQgSU5ORVIgSk9JTiBDT01fRG9jQ0NEYXRhIERDQyBXSVRIKE5PTE9DSykgT04gRENDLkludkRvY0RldGFpbHNJRD1ELkludkRvY0RldGFpbHNJRCAgTEVGVCBKT0lOIEFETV9Eb2N1bWVudFR5cGVzIEFTIERvY3VtZW50VHlwZSB3aXRoKG5vbG9jaykgT04gRG9jdW1lbnRUeXBlLkNvc3RDZW50ZXJJRD1ELkNvc3RDZW50ZXJJRCBMRUZUIEpPSU4gQ09NX0NDNTAwMDkgQVMgVDEgd2l0aChub2xvY2spIE9OIFQxLk5vZGVJRD1EQ0MuZGNDQ05JRDkgTEVGVCBKT0lOIElOVl9Qcm9kdWN0IEFTIFQyIHdpdGgobm9sb2NrKSBPTiBUMi5Qcm9kdWN0SUQ9UC5Qcm9kdWN0SUQgTEVGVCBKT0lOIENPTV9VT00gQVMgVDMgd2l0aChub2xvY2spIE9OIFQzLlVPTUlEPVAuVU9NSUQgTEVGVCBKT0lOIENPTV9DQzUwMDY3IEhTTkQgd2l0aChub2xvY2spIE9OIEhTTkQuTm9kZUlEPURDQy5kY0NDTklENjdcbldIRVJFIEQuQmF0Y2hJRD4xIGFuZCBELlZvdWNoZXJUeXBlPTEgQU5EIEQuSXNRdHlJZ25vcmVkPTAgYW5kIEQuU3RhdHVzSUQ9MzY5IEFORCBEQ0MuZGNDQ05JRDkgSU4gKDEsMTUsMjEsMTEsMTgsMjIsOCwxMywyMCwxMCw5LDE3LDE2LDE0LDEyLDE5KSBBTkQgRENDLmRjQ0NOSUQyIElOICgxMiwxNiwyMSwyMiwyMywyNCwyNSwyNiwyNywyOCwyOSwzMCkgQU5EIEQuRG9jRGF0ZTw9QFRvIE9yZGVyIEJ5IFAuUHJvZHVjdE5hbWUsQmF0Y2hOdW1iZXIsQi5CYXRjaElELEIuTWZnRGF0ZSxELkRvY0RhdGUsRC5SYXRlXHRzZWxlY3QgRC5SZWZJbnZEb2NEZXRhaWxzSUQsc3VtKEQuVU9NQ29udmVydGVkUXR5KSBRdHkgZnJvbSBJTlZfRG9jRGV0YWlscyBEIHdpdGgobm9sb2NrKSBJTk5FUiBKT0lOIENPTV9Eb2NDQ0RhdGEgRENDIFdJVEgoTk9MT0NLKSBPTiBEQ0MuSW52RG9jRGV0YWlsc0lEPUQuSW52RG9jRGV0YWlsc0lEICB3aGVyZSBELkJhdGNoSUQ+MSBhbmQgRC5Wb3VjaGVyVHlwZT0tMSBBTkQgRC5Jc1F0eUlnbm9yZWQ9MCBhbmQgRC5TdGF0dXNJRD0zNjkgQU5EIERDQy5kY0NDTklEOSBJTiAoMSwxNSwyMSwxMSwxOCwyMiw4LDEzLDIwLDEwLDksMTcsMTYsMTQsMTIsMTkpIEFORCBEQ0MuZGNDQ05JRDIgSU4gKDEyLDE2LDIxLDIyLDIzLDI0LDI1LDI2LDI3LDI4LDI5LDMwKSBBTkQgRC5Eb2NEYXRlPD1AVG8gZ3JvdXAgYnkgRC5SZWZJbnZEb2NEZXRhaWxzSUQiLCJwMiI6IjB+MCIsInAzIjoiIn0=";

const RUN_LOG = [];
const _log = console.log.bind(console);
console.log = (...a) => { try { RUN_LOG.push(a.map(String).join(' ')); } catch {} _log(...a); };
const logTail = (n = 50) => RUN_LOG.slice(-n).join('\n').slice(-3000);

const sb = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Business date in IST (Actions runs in UTC) as 'D Mon YYYY' for the @To param.
function istToken() {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000);
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
// ISO '2026-05-09T00:00:00' -> '09/May/2026' (matches the Excel export style).
function isoDMY(s) {
  if (!s) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  if (!m) return '—';
  return `${m[3]}/${MON[Number(m[2]) - 1]}/${m[1]}`;
}
function jwtUserId(bearer) {
  try {
    const p = JSON.parse(Buffer.from(bearer.split(' ')[1].split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    const uniq = String(p.unique_name || p.UserName || '');
    return uniq.split(',')[1] || '';
  } catch { return ''; }
}

// Report column aliases (from the report definition captured in the request).
const F = {
  code: 'C40b7055b92a44fa68fb58e1f2d10d918',   // Product Code
  name2: 'Cfd330aca2a1f44be8716f106364b3ccf',  // Product Name
  wh: 'Cadd9f5d435664ce4b1f2e58b7a15cf50',     // Warehouse
  unit: 'Cb496c39c630742db9682b044774518c3',   // Unit (base UOM)
};

async function writeSnapshot(patch) {
  if (!sb) { console.log('[supabase] not configured; skipping'); return; }
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

  // Capture the Bearer token + API root from the app's own requests during login.
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
    if (!bearer) {
      // Nudge the app to issue an authenticated call if none seen yet.
      await page.reload({ waitUntil: 'networkidle' }).catch(() => {});
      await page.waitForTimeout(1500);
    }
    if (!bearer) throw new Error('Could not capture a Bearer token after login (the report API needs it).');

    if (!apiRoot) {
      // Derive from PACT_URL origin as a fallback.
      const origin = new URL(process.env.PACT_URL || 'http://140.245.255.130:8443/').origin;
      apiRoot = origin + '/PACTALLUSUREAPI';
    }
    const REPORT_URL = apiRoot + '/api/Report/ReportDataSet';
    const userId = jwtUserId(bearer);
    console.log('[report] url=' + REPORT_URL + ' userId=' + (userId || '(kept from template)'));

    let body = Buffer.from(BODY_B64, 'base64').toString('utf8');
    body = body.replace(/'(\d{1,2} [A-Za-z]{3} \d{4})'/, "'" + istToken() + "'");
    if (userId) body = body.replace(/"UserID":"\d+"/, '"UserID":"' + userId + '"');

    const resp = await page.context().request.post(REPORT_URL, {
      headers: { Authorization: bearer, 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*' },
      data: body, timeout: 120000, ignoreHTTPSErrors: true,
    });
    if (!resp.ok()) throw new Error('ReportDataSet HTTP ' + resp.status() + ' ' + (await resp.text().catch(() => '')).slice(0, 200));
    const json = await resp.json();
    const inward = (json.Tables && json.Tables[0]) || [];
    if (!inward.length) throw new Error('ReportDataSet returned 0 rows (Tables[0] empty).');

    const detail = inward.map((r) => ({
      code: String(r[F.code] || '').trim(),
      name: String(r.ProductName || r[F.name2] || ''),
      batch: String(r.BatchNumber || '—'),
      warehouse: String(r[F.wh] || '—'),
      unit: String(r[F.unit] || '—'),
      qty: Number(r.Quantity) || 0,
      rate: r.Rate != null ? Number(r.Rate).toFixed(2) : '',
      exp: isoDMY(r.ExpDate),
      mfg: isoDMY(r.MfgDate),
      hsn: String(r.HSNCode || r.HSNName || '').trim(),
    })).filter((x) => x.code);
    // The BatchWise DETAIL (p2=0~0) lists a batch once PER document, and the same
    // batch can sit in several warehouses. Fold to ONE row per (code, batch,
    // warehouse), summing the quantity — so each warehouse's holding is its own
    // row and the app shows the exact warehouse split (batch totals unchanged).
    const byKey = new Map();
    for (const r of detail) {
      const key = r.code + '|' + r.batch + '|' + r.warehouse;
      const cur = byKey.get(key);
      if (cur) {
        cur.qty += r.qty;
        if (!cur.hsn && r.hsn) cur.hsn = r.hsn;
        if ((!cur.exp || cur.exp === '—') && r.exp && r.exp !== '—') cur.exp = r.exp;
        if ((!cur.mfg || cur.mfg === '—') && r.mfg && r.mfg !== '—') cur.mfg = r.mfg;
        if (!cur.rate && r.rate) cur.rate = r.rate;
      } else {
        byKey.set(key, { ...r });
      }
    }
    const rows = Array.from(byKey.values());
    console.log('[warehouse] folded ' + detail.length + ' detail rows -> ' + rows.length + ' (code x batch x warehouse) rows');

    const withHsn = rows.filter((r) => r.hsn).length;
    console.log('[hsn] rows with HSN: ' + withHsn + ' / ' + rows.length);
    const products = new Set(rows.map((r) => r.code)).size;
    console.log(`Parsed ${rows.length} batches across ${products} products.`);
    await writeSnapshot({ synced_at: new Date().toISOString(), products, batches: rows.length, source: 'pact-batchwise-api', status: 'ok', data: rows });
    console.log('SYNC DONE.');
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    console.log('SYNC FAILED:', msg.slice(0, 300));
    await writeSnapshot({ synced_at: new Date().toISOString(), products: 0, batches: 0, source: 'pact-batchwise-api', status: 'failed', error: (msg + '\n--- log ---\n' + logTail()).slice(0, 3500), data: [] });
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
})();
