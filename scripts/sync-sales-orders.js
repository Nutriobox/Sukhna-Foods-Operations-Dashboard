// On-demand PACT "Pending Sales Order Quantity" sync (GitHub Actions entrypoint).
//
// Logs into PACT with a real Chromium (to obtain a valid Bearer token), then
// replays the report's own data call
//   POST /PACTALLUSUREAPI/api/Report/ReportDataSet   (QueryCode RPT022, report 10255)
// and writes the current pending sales orders to Supabase (public.pending_sales_orders),
// grouped per sales order. The Android app's "Fetch sales order" screen reads them
// via /api/sales-orders. No UI clicking — the request template was captured from a
// real report load (record-sales-orders.bat), so this is fast and stable.
//
// The report's p1 param is encrypted by PACT's client, so we replay the captured
// body VERBATIM (unlike inventory, we cannot re-inject the date). Re-run
// record-sales-orders.bat if PACT changes the report or the "as of" date drifts.
//
// Env: PACT_USER, PACT_PASS/PACT_PASSWORD, PACT_URL, SUPABASE_URL, SUPABASE_SERVICE_KEY.

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const { login } = require('../src/lib/pact/login');

// Exact ReportDataSet request body captured from a real report load (base64 so
// the embedded encrypted params survive verbatim). QueryCode RPT022, p2=10255.
const BODY_B64 = "eyJVc2VySUQiOiIxMDA4MCIsIkxhbmdJRCI6IjEiLCJpc1JlcG9ydERCIjowLCJRdWVyeUNvZGUiOiJSUFQwMjIiLCJwMSI6IlcyWE9UV1BXS0hTe05tN2pkWVdpWTJPeVtZWzJQNEhrXFxvW3tRVmkyW29cXG9RVkN6XFxGQzJQVmV5T1ZtM1FWbTRbWDJ1WEZPd1NZUGxkNVh3Zkc3amRZV2lZMk8yT1lIa1B8bXlQb1BtW1ZTMls0WzdbbE80W1Zublxcb1s1W1ZHfE98aXxPMzJ1WEZTd1dKTHhcXEpYbGZHN2pkWVdpWTJPek9WRGpcXElMa1BZVGxbb08yXFxWbTRbVlhsUEZDN1tsV3pcXEZIa1xcSVhrUEgydVhGW3dcXElQUWZZMjdLSHZGXFxJR3tQRkc1XFxvVzdcXEZcXGtQSVxcbltWaXpQfEcyW2xDe1tsU3tPfFc1XFxWSGZORzdYVkd5aVkyT3tQWU97W1lLN1FGWG1PbG0yUG9PMlFWV3tbVkN8TzRHM1tsbXxcXG9Ma1AzMnVWblhPVkVEZFN8SzVPVlN7UElHNVBZR3pQbFN6T2xbNlBJR3pcXEZbM1tsRGxcXFZDNFBvWGxaVXpRWFd6T0tIdkZcXFZEbFs0WzNPb0htT0ZbeVBJXFxvW1ZtNlB8RzVbWVBuW29QbVxcWUhtT2xUZk5HN1hWR3lpWTJQb09sTGxbWUxtT2xIa1xcVmkyW1lcXGpRVlt7T1Zte1FJVG1RWU83T29PNk9IMnVWblhPVkVEZFM0R3xQbGZtW1ZHeVxcb1czUEZUbFtWamtPRlsyT1ZHNE9vXFxvT2xTeVxcSVBrWlV6UVhXek9LSHZGT3xpelxcVld8XFxJV3tRSUt5UEZHNVFJSzVPbFBvXFxJV3tPRmV5UG9MblFGUGZGU3FpVG5MUlZVRExWblxcaFRJO2xUSVgyW1ludWV7RExWbltpZjRuMmNFandkNHp4WzR1cktJem5cXHBTaWNvO3Jka0RGVjIzaFRJO2xTMlBHW1pUaktIVEdTMk9pZjRuMmNFandkNHp4WzR1cktJO3dLR25RWGs3TGRwXFxHZDRQR1xcWlRqY1l6fFVXUztYR1RGU3s3TGRwXFxHZDRQR1xcWlRqY1l6fFVXU2lkSVhvZkVEc2Q0bndLR1BSVlg7RlN8V3lPRkt8S0hTe0tKZnJmSWlxZG87dWQ0UHRNVUR4ZGtEV1RHUEZOb1RsUzJQUVVXU3tPfDNXT2s3UWQ0VG5VV1NpZElYb2ZFRHNkNG53S0dIRlMzO0RbNFB4Zlk3MmV7RFdPe0Q1Y1pUcU1JN3hkSTtsY3ttaWQ0NmlVVzdZTm1UbltvbjJTWVBsZDVYd2ZGM1dPezdEWzRQeGZZNzJVV1NpZElYb2ZFRHNkNG53S0duUVhuO1NlbzttZllQMktIUzJLSmZyZklpcWRvO3VkNFB0TVVEeGRrRExWblt3V0pMeFxcSlhsZkduR1JYUzJObkR7ZDRUM1s1VExURUR1XFxZXFwyS0lyeGNZNmlTMjtQWjJUeFsyNzNkV1RqZklHaVhGW2lmNG4yY0Vqd2Q0enhbNHVyS0k7d0tHblFYazdMVm5cXEdWMlBHVFhURFVXelZVV1M7WEZbd1VXN1lURztGVEdYV1NXbk9XMm5HRlNxaVgyakhXbVdpWEdURlN7N21bMlBGVm1uR09rRExWa0NxT1ZLdU9WW3VPbEd1T2xLdU9sT3VPbFN1T2xXdU9sW3VPbGV1T2xpdU9sbXVPfENyS0dIUVRFQ3FVVzdZTm1QeGU1VEZcXFk3MlxcWkxMVEYyMk9WQzRQRW1QRWtEWFZtblJWa0REVkd5aUZTclZUV3pIUzNTaVhGS3dWb0h2XFxVeldPezdEWzRQeGZZNzJWb0h2XFxVeldQRTdTZW87bWZZUDJWb0h2XFxVelFYV3pPTkhTNE5vVGxWcFh2T1ZLdVVXN1lObkxqZklXdVhGW3dcXElQUWZZMjRPe3pXUGs3bVsyNzNkVls2TkhTNE5vVGxWcFh2UGxldVhGW3dcXElQUWZZMjRRUzJNS0dcXFVWMjJpVVc3WVoyVHhbMlRuZklIcmRKT2lVVzdZS0pmcmZJaXFkbzt1ZDRQdE1VRHhka0RMVm5bd1VXN1lURztGVEdYV1NXbk9XMm5HUlhTNE5tblFYbVRSUzJUSFhHSExWSFBMVEMyTUtIZktUWExIS0hUR1MyT3dcXElQRlMyN0xURktpVVc2aU1GR3tORkc0TkZLek5GS3tORkt8TkZLMk5GSzNORks0TkZLNU5GSzZORks3TkZPeU1VRERWbVNpTUduUVhrN0ZkNVAyUzRYd2ZJWHtVV1M7UEZHeVBsV3JLRztVVEdYVUtHTFxcS0h2Rk9JSG9QRmZqW29cXG9PbG02UElMb1xcbG15T1lTeVBGVzVPRkc3UFZtN1BvSGZLRXpkU3xHek9JSG1bb0szXFxJUGtbfFRuUVZcXGpQWU8yT0Zua1BWSG1PWUxtXFxZSzJaVUM/IiwicDIiOiIxMDI1NSIsInAzIjoiIn0=";

// Report column IDs (from ReportDefnXML of report 10255, captured in the HAR).
const C = {
  soNo:    'C0af47abff2984bff901d04570195996a', // SO No
  account: 'C41ab7906cda44cf9b36a9eff7a133833', // Account Name (vendor / party)
  product: 'C110adbb5dcbc4e96a5c409b51d1bdeb4', // Product Name
  soQty:   'Cda2417fe9d6b4fea81714b02b42357e1', // SOQTY (ordered)
  delQty:  'C25c2ab985d2946c4952a033a5b93fbb7', // DELQTY (delivered)
  pendQty: 'Cf69663661a94446c919c81a12d3cd330', // PEND QTY (remaining to dispatch)
  price:   'C271424a75a16412684a1d65b0ce066ec', // UnitPrice
};

const RUN_LOG = [];
const _log = console.log.bind(console);
console.log = (...a) => { try { RUN_LOG.push(a.map(String).join(' ')); } catch {} _log(...a); };
const logTail = (n = 60) => RUN_LOG.slice(-n).join('\n').slice(-3000);

const sb = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

function jwtUserId(bearer) {
  try {
    const p = JSON.parse(Buffer.from(bearer.split(' ')[1].split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    const uniq = String(p.unique_name || p.UserName || '');
    return uniq.split(',')[1] || '';
  } catch { return ''; }
}
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/,/g, '')); return isNaN(n) ? 0 : n; };
const str = (v) => String(v == null ? '' : v).trim();

// Locate the data table inside the ReportDataSet response: the first Tables[]
// entry whose rows carry the SO-No column id. Returns { rows, tableIndex }.
function findDataTable(json) {
  const tables = (json && json.Tables) || [];
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i];
    if (Array.isArray(t) && t.length && t[0] && Object.prototype.hasOwnProperty.call(t[0], C.soNo)) {
      return { rows: t, tableIndex: i };
    }
  }
  return { rows: [], tableIndex: -1 };
}

// Compact structure description, written into a diagnostic row so it can be read
// back through /api/sales-orders during setup if the parse ever misses.
function describe(json) {
  const tables = (json && json.Tables) || [];
  const parts = tables.map((t, i) => {
    const first = Array.isArray(t) && t[0] ? Object.keys(t[0]).slice(0, 8).join(',') : '(empty)';
    return `T${i}:len=${Array.isArray(t) ? t.length : '?'}[${first}]`;
  });
  return `tables=${tables.length} ${parts.join(' | ')}`.slice(0, 400);
}

async function fullRefresh(orders, diag) {
  if (!sb) { console.log('[supabase] not configured; skipping write'); return; }
  const del = await sb.from('pending_sales_orders').delete().gt('id', 0);
  if (del.error) { console.log('[supabase] delete failed:', del.error.message); return; }
  const rows = orders.map((o) => ({
    vendor_name: o.vendor || '—',
    so_number: o.soNumber,
    so_date: null,
    status: 'pending',
    items: o.items,
  }));
  if (diag) rows.push({ vendor_name: diag, so_number: '__DIAG__', so_date: null, status: 'debug', items: [] });
  if (!rows.length) { console.log('[supabase] nothing to insert'); return; }
  const ins = await sb.from('pending_sales_orders').insert(rows);
  if (ins.error) console.log('[supabase] insert failed:', ins.error.message);
  else console.log('[supabase] wrote', orders.length, 'orders' + (diag ? ' (+1 diag)' : ''));
}

(async () => {
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
    console.log('[report] url=' + REPORT_URL + ' userId=' + (userId || '(kept from template)'));

    let body = Buffer.from(BODY_B64, 'base64').toString('utf8');
    if (userId) body = body.replace(/"UserID":"\d+"/, '"UserID":"' + userId + '"');

    const resp = await page.context().request.post(REPORT_URL, {
      headers: { Authorization: bearer, 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*' },
      data: body, timeout: 180000, ignoreHTTPSErrors: true,
    });
    if (!resp.ok()) throw new Error('ReportDataSet HTTP ' + resp.status() + ' ' + (await resp.text().catch(() => '')).slice(0, 200));
    const text = await resp.text();
    console.log('[report] response bytes=' + text.length);
    const json = JSON.parse(text);
    const structure = describe(json);
    console.log('[report] ' + structure);

    const { rows, tableIndex } = findDataTable(json);
    console.log('[report] data table index=' + tableIndex + ' rows=' + rows.length);
    if (!rows.length) {
      await fullRefresh([], 'NO SO-No column found. ' + structure);
      throw new Error('Data table not found by SO-No column id. Structure: ' + structure);
    }

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
      o.items.push({
        code: '',
        name: product,
        qty: pend,
        unit: '',
        rate: num(r[C.price]) || '',
        ordered: num(r[C.soQty]),
        delivered: num(r[C.delQty]),
      });
    }
    const orders = [...map.values()].filter((o) => o.items.length);
    const lines = orders.reduce((n, o) => n + o.items.length, 0);
    console.log(`Parsed ${orders.length} pending sales orders (${lines} lines).`);
    if (orders[0]) console.log('First order:', orders[0].soNumber, '/', orders[0].vendor, '/', orders[0].items.length, 'items');

    await fullRefresh(orders, orders.length ? '' : 'Parsed 0 orders. ' + structure);
    console.log('SALES-ORDER SYNC DONE.');
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    console.log('SALES-ORDER SYNC FAILED:', msg.slice(0, 300));
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
})();
