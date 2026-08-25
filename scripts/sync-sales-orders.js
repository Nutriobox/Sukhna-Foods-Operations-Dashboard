// On-demand PACT "Pending Sales Order Quantity" sync (GitHub Actions entrypoint).
//
// Logs into PACT, then REPLAYS the exact API sequence the browser used to open
// report 10255 and fetch its data (captured via record-sales-orders.bat):
//   RPT010 open -> GetReport -> GetCategoryandField -> GetReportFields x3 ->
//   GetCostCenterSummary (filter) x2 -> ReportDataSet RPT022 (the 36MB data).
// The report needs its open sequence to run first in the same session, otherwise
// the data call returns HTTP 500. Rows are grouped per sales order and written to
// public.pending_sales_orders (read by /api/sales-orders).
//
// Env: PACT_USER, PACT_PASS/PACT_PASSWORD, PACT_URL, SUPABASE_URL, SUPABASE_SERVICE_KEY.

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const { login } = require('../src/lib/pact/login');

// The captured request sequence (base64 JSON). Last entry is the data call.
const REPLAY_B64 = "W3sibWV0aG9kIjoiUE9TVCIsInBhdGgiOiIvYXBpL1JlcG9ydC9SZXBvcnREYXRhU2V0IiwiYm9keSI6IntcIlVzZXJJRFwiOlwiMTAwODBcIixcIkxhbmdJRFwiOlwiMVwiLFwiaXNSZXBvcnREQlwiOjAsXCJRdWVyeUNvZGVcIjpcIlJQVDAxMFwiLFwicDFcIjpcIjEwMjU1XCIsXCJwMlwiOlwiXCIsXCJwM1wiOlwiXCJ9In0seyJtZXRob2QiOiJHRVQiLCJwYXRoIjoiL2FwaS9SZXBvcnQvR2V0UmVwb3J0P3BhcmFtPVswLDEwMjU1LCUyMjEwMDgwJTIyLCUyMjUxOSUyMiwxXSIsImJvZHkiOm51bGx9LHsibWV0aG9kIjoiR0VUIiwicGF0aCI6Ii9hcGkvUmVwb3J0L0dldENhdGVnb3J5YW5kRmllbGQ/cGFyYW09Wy0xLDAsMSwwLCUyMjEwMDgwJTIyLDFdIiwiYm9keSI6bnVsbH0seyJtZXRob2QiOiJHRVQiLCJwYXRoIjoiL2FwaS9SZXBvcnQvR2V0UmVwb3J0RmllbGRzP3BhcmFtPVs0MDAsMCwlMjIxMDA4MCUyMiwxXSIsImJvZHkiOm51bGx9LHsibWV0aG9kIjoiR0VUIiwicGF0aCI6Ii9hcGkvUmVwb3J0L0dldFJlcG9ydEZpZWxkcz9wYXJhbT1bNDEwNjQsMCwlMjIxMDA4MCUyMiwxXSIsImJvZHkiOm51bGx9LHsibWV0aG9kIjoiR0VUIiwicGF0aCI6Ii9hcGkvUmVwb3J0L0dldFJlcG9ydEZpZWxkcz9wYXJhbT1bNDEwNjUsMCwlMjIxMDA4MCUyMiwxXSIsImJvZHkiOm51bGx9LHsibWV0aG9kIjoiR0VUIiwicGF0aCI6Ii9hcGkvQ29tbW9uL0dldENvc3RDZW50ZXJHcmlkVmlld0xpc3Q/VXNlcklEPTEwMDgwJlJvbGVJRD01MTkmTGFuZ3VhZ2VJRD0xJkNvc3RDZW50ZXJJRD01MDAyMyZJc1JlcG9ydERCPWZhbHNlIiwiYm9keSI6bnVsbH0seyJtZXRob2QiOiJQT1NUIiwicGF0aCI6Ii9hcGkvQ29tbW9uL0dldENvc3RDZW50ZXJTdW1tYXJ5IiwiYm9keSI6IntcInAxXCI6LTEsXCJMYW5nSURcIjpcIjFcIixcInAyXCI6ZmFsc2UsXCJhbFwiOlwiSWpjNTRZMjNPWFV0TWVHTnR6bDFNVEF3TU9HTnR6bDE0WTIzT1hYaGpiYzVkZUdOdHpsMU1PR050emwxTURFdmFtRnVMekU1TUREaGpiYzVkZUdOdHpsMTRZMjNPWFV3NFkyM09YVXc0WTIzT1hWbVlXeHpaU0k9XCJ9In0seyJtZXRob2QiOiJHRVQiLCJwYXRoIjoiL2FwaS9Db21tb24vR2V0Q29zdENlbnRlckdyaWRWaWV3TGlzdD9Vc2VySUQ9MTAwODAmUm9sZUlEPTUxOSZMYW5ndWFnZUlEPTEmQ29zdENlbnRlcklEPTUwMDAyJklzUmVwb3J0REI9ZmFsc2UiLCJib2R5IjpudWxsfSx7Im1ldGhvZCI6IlBPU1QiLCJwYXRoIjoiL2FwaS9Db21tb24vR2V0Q29zdENlbnRlclN1bW1hcnkiLCJib2R5Ijoie1wicDFcIjotMSxcIkxhbmdJRFwiOlwiMVwiLFwicDJcIjpmYWxzZSxcImFsXCI6XCJJall3NFkyM09YVXRNZUdOdHpsMU1UQXdNT0dOdHpsMVFTNUpjMGR5YjNWd1BURWdUMUlnUVM1T2IyUmxTVVFnU1U0Z0tERXlMREUyTERJeExESXlMREl6TERJMExESTFMREkyTERJM0xESTRMREk1TERNd0tlR050emwxNFkyM09YVXhNaXd4Tml3eU1Td3lNaXd5TXl3eU5Dd3lOU3d5Tml3eU55d3lPQ3d5T1N3ek1PR050emwxTU9HTnR6bDFNREV2YW1GdUx6RTVNRERoamJjNWRlR050emwxNFkyM09YVXc0WTIzT1hVdzRZMjNPWFZtWVd4elpTST1cIn0ifSx7Im1ldGhvZCI6IlBPU1QiLCJwYXRoIjoiL2FwaS9SZXBvcnQvUmVwb3J0RGF0YVNldCIsImJvZHkiOiJ7XCJVc2VySURcIjpcIjEwMDgwXCIsXCJMYW5nSURcIjpcIjFcIixcImlzUmVwb3J0REJcIjowLFwiUXVlcnlDb2RlXCI6XCJSUFQwMjJcIixcInAxXCI6XCJXMlhPVFdQV0tIU3tObTdqZFlXaVkyT3lbWVsyUDRIa1xcXFxvW3tRVmkyW29cXFxcb1FWQ3pcXFxcRkMyUFZleU9WbTNRVm00W1gydVhGT3dTWVBsZDVYd2ZHN2pkWVdpWTJPMk9ZSGtQfG15UG9QbVtWUzJbNFs3W2xPNFtWbm5cXFxcb1s1W1ZHfE98aXxPMzJ1WEZTd1dKTHhcXFxcSlhsZkc3amRZV2lZMk96T1ZEalxcXFxJTGtQWVRsW29PMlxcXFxWbTRbVlhsUEZDN1tsV3pcXFxcRkhrXFxcXElYa1BIMnVYRlt3XFxcXElQUWZZMjdLSHZGXFxcXElHe1BGRzVcXFxcb1c3XFxcXEZcXFxca1BJXFxcXG5bVml6UHxHMltsQ3tbbFN7T3xXNVxcXFxWSGZORzdYVkd5aVkyT3tQWU97W1lLN1FGWG1PbG0yUG9PMlFWV3tbVkN8TzRHM1tsbXxcXFxcb0xrUDMydVZuWE9WRURkU3xLNU9WU3tQSUc1UFlHelBsU3pPbFs2UElHelxcXFxGWzNbbERsXFxcXFZDNFBvWGxaVXpRWFd6T0tIdkZcXFxcVkRsWzRbM09vSG1PRlt5UElcXFxcb1tWbTZQfEc1W1lQbltvUG1cXFxcWUhtT2xUZk5HN1hWR3lpWTJQb09sTGxbWUxtT2xIa1xcXFxWaTJbWVxcXFxqUVZbe09WbXtRSVRtUVlPN09vTzZPSDJ1Vm5YT1ZFRGRTNEd8UGxmbVtWR3lcXFxcb1czUEZUbFtWamtPRlsyT1ZHNE9vXFxcXG9PbFN5XFxcXElQa1pVelFYV3pPS0h2Rk98aXpcXFxcVld8XFxcXElXe1FJS3lQRkc1UUlLNU9sUG9cXFxcSVd7T0ZleVBvTG5RRlBmRlNxaVRuTFJWVURMVm5cXFxcaFRJO2xUSVgyW1ludWV7RExWbltpZjRuMmNFandkNHp4WzR1cktJem5cXFxccFNpY287cmRrREZWMjNoVEk7bFMyUEdbWlRqS0hUR1MyT2lmNG4yY0Vqd2Q0enhbNHVyS0k7d0tHblFYazdMZHBcXFxcR2Q0UEdcXFxcWlRqY1l6fFVXUztYR1RGU3s3TGRwXFxcXEdkNFBHXFxcXFpUamNZenxVV1NpZElYb2ZFRHNkNG53S0dQUlZYO0ZTfFd5T0ZLfEtIU3tLSmZyZklpcWRvO3VkNFB0TVVEeGRrRFdUR1BGTm9UbFMyUFFVV1N7T3wzV09rN1FkNFRuVVdTaWRJWG9mRURzZDRud0tHSEZTMztEWzRQeGZZNzJle0RXT3tENWNaVHFNSTd4ZEk7bGN7bWlkNDZpVVc3WU5tVG5bb24yU1lQbGQ1WHdmRjNXT3s3RFs0UHhmWTcyVVdTaWRJWG9mRURzZDRud0tHblFYbjtTZW87bWZZUDJLSFMyS0pmcmZJaXFkbzt1ZDRQdE1VRHhka0RMVm5bd1dKTHhcXFxcSlhsZkduR1JYUzJObkR7ZDRUM1s1VExURUR1XFxcXFlcXFxcMktJcnhjWTZpUzI7UFoyVHhbMjczZFdUamZJR2lYRltpZjRuMmNFandkNHp4WzR1cktJO3dLR25RWGs3TFZuXFxcXEdWMlBHVFhURFVXelZVV1M7WEZbd1VXN1lURztGVEdYV1NXbk9XMm5HRlNxaVgyakhXbVdpWEdURlN7N21bMlBGVm1uR09rRExWa0NxT1ZLdU9WW3VPbEd1T2xLdU9sT3VPbFN1T2xXdU9sW3VPbGV1T2xpdU9sbXVPfENyS0dIUVRFQ3FVVzdZTm1QeGU1VEZcXFxcWTcyXFxcXFpMTFRGMjJPVkM0UEVtUEVrRFhWbW5SVmtERFZHeWlGU3JWVFd6SFMzU2lYRkt3Vm9IdlxcXFxVeldPezdEWzRQeGZZNzJWb0h2XFxcXFV6V1BFN1NlbzttZllQMlZvSHZcXFxcVXpRWFd6T05IUzROb1RsVnBYdk9WS3VVVzdZTm5MamZJV3VYRlt3XFxcXElQUWZZMjRPe3pXUGs3bVsyNzNkVls2TkhTNE5vVGxWcFh2UGxldVhGW3dcXFxcSVBRZlkyNFFTMk1LR1xcXFxVVjIyaVVXN1laMlR4WzJUbmZJSHJkSk9pVVc3WUtKZnJmSWlxZG87dWQ0UHRNVUR1XFxcXFlcXFxcMktJcnhjWTZpUzI7UFoyVHhbMlBGVElIMltVRFdUR1BGS0pmcmZJaXFkbzt1ZDRQdE1VRHhka0RMVm5bd1VZNzRUSTtsVElYMltZbnVlMm5HUlhUR1MyT3dVWTc0VEk7bFRJWDJbWW51ZTJuR0tJem5cXFxccFNpY287cmRrREZWMjNoUzJPM09GQ3tPe0RXT2tENWNaVHFNSTd4ZEk7bGN7bWlkNDZpWEdURlN7N21bMlBGVm1uR09sTztYRkt3Vm87bVxcXFxXbkdLSXpuXFxcXHBTaWNvO3Jka0REUzJQaFNZUGxkNVh3ZkpPaVhGT2lmNG4yY0Vqd2Q0enhbNHVyS0k7d0tHblFYazdHXFxcXFlMcmZHSGxbNDszZHBTO1hGT3dTWVBsZDVYd2ZHbkdLSXpuXFxcXHBTaWNvO3Jka0RMVm5cXFxcaFdKTHhcXFxcSlhsZkVEV1BFRDVjWlRxTUk3eGRJO2xje21pZDQ2aVVXN1lObkR7ZDRUM1s1VExURjNXUEU3U2VvO21mWVAyVVdTaWRJWG9mRURzZDRud0tHUFJWWDtHZDRQUWZZM0dbWlRqS0hTNEtKZnJmSWlxZG87dWQ0UHRNVUR4ZGtETFZuW3dVVzdZVEc7RlRHWFdTV25PVzJuR1JYUzRObW5RWG1UUlMyVEhYR0hMVkhQTFRDMk1LSGZLVFhMSEtIVEdTMk93XFxcXElQRlMyN0xURktpVVc2aU1GR3tORkc0TkZLek5GS3tORkt8TkZLMk5GSzNORks0TkZLNU5GSzZORks3TkZPeU1VRERWbVNpTUduUVhrN0ZkNVAyUzRYd2ZJWHtVV1M7UEZHeVBsV3JLRztVVEdYVUtHTFxcXFxLSHZGT0lIb1BGZmpbb1xcXFxvT2xtNlBJTG9cXFxcbG15T1lTeVBGVzVPRkc3UFZtN1BvSGZLRXpkU3xHek9JSG1bb0szXFxcXElQa1t8VG5RVlxcXFxqUFlPMk9GbmtQVkhtT1lMbVxcXFxZSzJaVUM/XCIsXCJwMlwiOlwiMTAyNTVcIixcInAzXCI6XCJcIn0ifV0=";

// Report column IDs (from ReportDefnXML of report 10255).
const C = {
  soNo:    'C0af47abff2984bff901d04570195996a',
  account: 'C41ab7906cda44cf9b36a9eff7a133833',
  product: 'C110adbb5dcbc4e96a5c409b51d1bdeb4',
  soQty:   'Cda2417fe9d6b4fea81714b02b42357e1',
  delQty:  'C25c2ab985d2946c4952a033a5b93fbb7',
  pendQty: 'Cf69663661a94446c919c81a12d3cd330',
  price:   'C271424a75a16412684a1d65b0ce066ec',
};

const sb = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/,/g, '')); return isNaN(n) ? 0 : n; };
const str = (v) => String(v == null ? '' : v).trim();

function findDataTable(json) {
  const tables = (json && json.Tables) || [];
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i];
    if (Array.isArray(t) && t.length && t[0] && Object.prototype.hasOwnProperty.call(t[0], C.soNo)) return { rows: t, tableIndex: i };
  }
  return { rows: [], tableIndex: -1 };
}
function describe(json) {
  const tables = (json && json.Tables) || [];
  return ('tables=' + tables.length + ' ' + tables.map((t, i) => 'T' + i + ':len=' + (Array.isArray(t) ? t.length : '?') + '[' + (Array.isArray(t) && t[0] ? Object.keys(t[0]).slice(0, 8).join(',') : '(empty)') + ']').join(' | ')).slice(0, 400);
}
async function fullRefresh(orders, diag) {
  if (!sb) { console.log('[supabase] not configured; skipping'); return; }
  const del = await sb.from('pending_sales_orders').delete().gt('id', 0);
  if (del.error) { console.log('[supabase] delete failed:', del.error.message); return; }
  const rows = orders.map((o) => ({ vendor_name: o.vendor || '\u2014', so_number: o.soNumber, so_date: null, status: 'pending', items: o.items }));
  if (diag) rows.push({ vendor_name: diag, so_number: '__DIAG__', so_date: null, status: 'debug', items: [] });
  if (!rows.length) { console.log('[supabase] nothing to insert'); return; }
  const ins = await sb.from('pending_sales_orders').insert(rows);
  if (ins.error) console.log('[supabase] insert failed:', ins.error.message);
  else console.log('[supabase] wrote', orders.length, 'orders' + (diag ? ' (+diag)' : ''));
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
    if (!bearer) throw new Error('Could not capture a Bearer token after login.');
    if (!apiRoot) apiRoot = new URL(process.env.PACT_URL || 'http://140.245.255.130:8443/').origin + '/PACTALLUSUREAPI';

    const steps = JSON.parse(Buffer.from(REPLAY_B64, 'base64').toString('utf8'));
    const H = { Authorization: bearer, Accept: 'application/json, text/plain, */*' };
    const ctx = page.context().request;
    console.log('[replay] ' + steps.length + ' steps, apiRoot=' + apiRoot);

    // Warm up: replay the report-open sequence (all but the final data call).
    for (let i = 0; i < steps.length - 1; i++) {
      const st = steps[i];
      const url = apiRoot + st.path;
      try {
        const r = st.method === 'GET'
          ? await ctx.get(url, { headers: H, timeout: 60000, ignoreHTTPSErrors: true })
          : await ctx.post(url, { headers: Object.assign({}, H, { 'Content-Type': 'application/json' }), data: st.body || '', timeout: 60000, ignoreHTTPSErrors: true });
        console.log('[replay] ' + i + ' ' + st.method + ' ' + st.path.split('?')[0].split('/api/')[1] + ' -> ' + r.status());
      } catch (e) { console.log('[replay] ' + i + ' error ' + String(e).slice(0, 80)); }
      await page.waitForTimeout(250);
    }

    // Final data call.
    const last = steps[steps.length - 1];
    const resp = await ctx.post(apiRoot + last.path, {
      headers: Object.assign({}, H, { 'Content-Type': 'application/json' }),
      data: last.body, timeout: 180000, ignoreHTTPSErrors: true,
    });
    if (!resp.ok()) throw new Error('ReportDataSet HTTP ' + resp.status() + ' ' + (await resp.text().catch(() => '')).slice(0, 200));
    const text = await resp.text();
    console.log('[report] response bytes=' + text.length);
    const json = JSON.parse(text);
    const structure = describe(json);
    console.log('[report] ' + structure);

    const { rows, tableIndex } = findDataTable(json);
    console.log('[report] data table index=' + tableIndex + ' rows=' + rows.length);
    if (!rows.length) { await fullRefresh([], 'NO SO-No column. ' + structure); throw new Error('Data table not found. ' + structure); }

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
      o.items.push({ code: '', name: product, qty: pend, unit: '', rate: num(r[C.price]) || '', ordered: num(r[C.soQty]), delivered: num(r[C.delQty]) });
    }
    const orders = [...map.values()].filter((o) => o.items.length);
    const lines = orders.reduce((n, o) => n + o.items.length, 0);
    console.log('Parsed ' + orders.length + ' pending sales orders (' + lines + ' lines).');
    if (orders[0]) console.log('First:', orders[0].soNumber, '/', orders[0].vendor, '/', orders[0].items.length, 'items');
    await fullRefresh(orders, orders.length ? '' : 'Parsed 0 orders. ' + structure);
    console.log('SALES-ORDER SYNC DONE.');
  } catch (e) {
    console.log('SALES-ORDER SYNC FAILED:', String(e && e.message ? e.message : e).slice(0, 300));
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
})();
