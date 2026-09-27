#!/usr/bin/env node
// Turn a recorded HAR into what sync-costing-<report>.js needs.
//
//   node scripts/extract-costing-body.js pact-costing-pm.har
//
// Finds the report's own POST .../api/Report/ReportDataSet call, prints:
//   1) BODY_B64  -> paste into BODY_B64 in the matching sync-costing-<report>.js
//   2) the real Tables[0] column keys -> confirm/adjust that file's COLMAP
// If several ReportDataSet calls were recorded, it prints each so you can pick.

const fs = require('fs');

const har = process.argv[2];
if (!har) { console.error('Usage: node scripts/extract-costing-body.js <file.har>'); process.exit(1); }
let log;
try { log = JSON.parse(fs.readFileSync(har, 'utf8')).log; }
catch (e) { console.error('Could not read/parse HAR:', e.message); process.exit(1); }

const entries = (log && log.entries) || [];
const hits = entries.filter((e) => e.request && /\/api\/Report\/ReportDataSet/i.test(e.request.url || '') && /post/i.test(e.request.method || ''));
if (!hits.length) { console.error('No POST .../api/Report/ReportDataSet call found in this HAR. Did the Export finish before you closed the browser?'); process.exit(2); }

hits.forEach((e, i) => {
  const text = (e.request.postData && e.request.postData.text) || '';
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  let queryCode = '';
  try { queryCode = JSON.parse(text).QueryCode || ''; } catch {}
  console.log(`\n================ ReportDataSet call #${i + 1}  ${queryCode ? '(QueryCode ' + queryCode + ')' : ''} ================`);
  console.log('URL:', e.request.url);
  console.log('\n--- BODY_B64 (paste into the matching sync-costing-<report>.js) ---\n' + b64);

  let resp = '';
  try { resp = (e.response && e.response.content && e.response.content.text) || ''; } catch {}
  try {
    const j = JSON.parse(resp);
    const t0 = (j.Tables && j.Tables[0]) || [];
    if (t0.length) {
      console.log('\n--- Tables[0] keys (confirm COLMAP candidates against these) ---');
      console.log(Object.keys(t0[0]).join(', '));
      console.log('\n--- first row sample ---');
      console.log(JSON.stringify(t0[0], null, 0).slice(0, 800));
    } else {
      console.log('\n(Response body not captured in HAR, or Tables[0] empty — run the sync once to see the keys in the worker log.)');
    }
  } catch {
    console.log('\n(Response body not captured in HAR — run the sync once; the runner logs resolved/unresolved columns.)');
  }
});
console.log('\nDone. Fill BODY_B64 (and COLMAP if any column shows UNRESOLVED), then queue a sync.');
