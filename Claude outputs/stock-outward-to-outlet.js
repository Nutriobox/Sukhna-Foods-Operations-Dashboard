// Stock Outward to Outlet — live PACT flow.
// On open, a "Voucher Prefix" modal demands Location=Factory + Ok. Then the form
// unlocks: Transfer Location (outlet), Outlet Issue Type (category), Outlet ReqNo
// (OMR) are pact-listview dropdowns (type to filter, click the Name row). Then scan.
// SAFE: dryRun=true fills but does NOT Post.
const path = require('path');

async function clickFirst(page, factories, label, timeout) {
  for (const f of factories) {
    try { const loc = f(); await loc.first().waitFor({ state: 'visible', timeout: timeout || 6000 }); await loc.first().click({ timeout: timeout || 6000, force: true }); console.log('  [ui] ' + label); return true; } catch (e) {}
  }
  console.log('  [ui] could NOT ' + label);
  return false;
}
async function boxIndexByLabel(page, labelSrc) {
  return await page.evaluate((reSrc) => {
    const re = new RegExp(reSrc, 'i');
    const boxes = [...document.querySelectorAll('app-pactlistbox')];
    for (let i = 0; i < boxes.length; i++) {
      let p = boxes[i].closest('div'), label = '';
      for (let up = 0; up < 5 && p; up++) { const lab = p.querySelector('label'); if (lab && lab.innerText.trim()) { label = lab.innerText.trim(); break; } p = p.parentElement; }
      if (re.test(label)) return i;
    }
    return -1;
  }, labelSrc);
}
function filterTerm(v){ const m=String(v).match(/\(([^)]+)\)/); return (m?m[1]:String(v)).trim(); }

async function handleVoucherPrefix(page){
  const modal = page.locator('modal-container.show').first();
  if(!(await modal.isVisible().catch(()=>false))){ console.log('  [ui] no Voucher Prefix modal'); return; }
  const inp = modal.locator('input').first();
  await inp.click({force:true}).catch(()=>{});
  await page.waitForTimeout(700);
  try{ await inp.fill('Factory'); }catch(e){ await inp.type('Factory',{delay:20}).catch(()=>{}); }
  await page.waitForTimeout(1100);
  await clickFirst(page,[
    ()=>page.locator('pact-listview').getByText('Factory',{exact:true}),
    ()=>page.locator('pact-listview').getByText(/^Factory$/i),
  ],'VP select Factory',5000);
  await page.waitForTimeout(700);
  await clickFirst(page,[
    ()=>modal.getByRole('button',{name:/Ok/i}),
    ()=>modal.locator('button').filter({hasText:/Ok/i}),
    ()=>page.getByRole('button',{name:/^\s*Ok\s*$/i}),
  ],'VP Ok',5000);
  await page.waitForTimeout(1800);
}

async function selectField(page, labelSrc, valueName, name){
  const i = await boxIndexByLabel(page, labelSrc);
  if(i<0){ console.log('  [ui] no field '+name); return false; }
  const box = page.locator('app-pactlistbox').nth(i);
  const input = box.locator('input[name="List"]').first();
  await input.click({force:true}).catch(()=>{});
  await page.waitForTimeout(500);
  const term = filterTerm(valueName);
  try{ await input.fill(term); }catch(e){ await input.type(term,{delay:15}).catch(()=>{}); }
  await page.waitForTimeout(1300);
  const esc = String(valueName).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const re = new RegExp('^\\s*'+esc+'\\s*$','i');
  const ok = await clickFirst(page,[
    ()=>page.locator('pact-listview').getByText(re),
    ()=>page.locator('pact-listview').getByText(new RegExp(esc,'i')),
    ()=>page.getByText(new RegExp(esc,'i')),
  ],'select '+name+' = '+valueName,5000);
  await page.waitForTimeout(900);
  return ok;
}

// Transfer Location (outlet) selection — robust to naming differences between the
// requisition report and the Stock Outward master (e.g. "Nutriobox (Sector 63 Noida)"
// vs "Nutriobox (Noida)"). Reads the dropdown options and picks the best token match.
async function selectOutlet(page, outlet) {
  const na = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
  const want = na(outlet);
  const idx = await boxIndexByLabel(page, 'Transfer Location');
  if (idx < 0) { console.log('  [ui] no Transfer Location field'); return false; }
  const input = page.locator('app-pactlistbox').nth(idx).locator('input[name="List"]').first();
  await input.click({ force: true }).catch(() => {});
  await page.waitForTimeout(700);
  // The dropdown renders only ~8 rows and filters by name-PREFIX, so type the full
  // outlet name (then shorter prefixes) to surface it, and only click an EXACT match.
  const tries = [outlet, outlet.replace(/\)\s*$/, ''), outlet.replace(/,[^)]*\)?\s*$/, ''), outlet.slice(0, Math.max(8, outlet.length - 4))];
  const findExact = async () => await page.evaluate((w) => {
    const na = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    let hit = null;
    document.querySelectorAll('pact-listview').forEach((lv) => {
      if (lv.offsetParent !== null) lv.innerText.split('\n').map((s) => s.trim()).forEach((t) => { if (/nutr/i.test(t) && na(t) === w) hit = t; });
    });
    return hit;
  }, want);
  for (const term of tries) {
    try { await input.fill(term); } catch (e) { await input.type(term, { delay: 15 }).catch(() => {}); }
    await page.waitForTimeout(1100);
    const hit = await findExact();
    if (hit) {
      const esc = hit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const ok = await clickFirst(page, [
        () => page.locator('pact-listview').getByText(hit, { exact: true }),
        () => page.locator('pact-listview').getByText(new RegExp('^\\s*' + esc + '\\s*$', 'i')),
      ], 'pick Transfer Location = ' + hit, 4000);
      await page.waitForTimeout(800);
      if (ok) { console.log('  [ui] outlet "' + outlet + '" -> "' + hit + '"'); return true; }
    }
  }
  console.log('  [ui] could not reach outlet "' + outlet + '" in the dropdown — NOT guessing.');
  return false;
}

function fmtN(n){ return Number.isInteger(n) ? String(n) : Number(n).toFixed(3); }

// The "Scan Batch" box inside the Generate-Batch-Numbers dialog. It parses a
// CODE_BATCH_WEIGHT label and fills that batch's Quantity — same input a human uses.
async function batchScanInput(dlg){
  const cands = [
    () => dlg.getByPlaceholder(/scan/i),
    () => dlg.locator('input[type="text"]:visible').first(),
    () => dlg.locator('input:visible').first(),
  ];
  for (const f of cands){ try{ const loc=f().first(); if(await loc.count()){ await loc.waitFor({state:'visible',timeout:2000}); return loc; } }catch(e){} }
  return dlg.locator('input').first();
}

async function closeBatchDlg(page, dlg){
  await clickFirst(page, [() => dlg.getByText('Close',{exact:true}), () => dlg.getByRole('button',{name:/close/i})], 'close batch dialog', 3000);
}

// PACT opens this dialog when the EXACT batch our app scanned is stale/short in the
// dispatch warehouse. The old worker clicked Close and dropped the item (mislabelled
// "out of stock") — that was the entire un-posted gap. Instead, do what the operator
// does: read the product's in-stock batches from the grid and allocate the needed
// quantity earliest-expiry-first (FEFO), then Save. Returns { ok, need, filled }.
async function reallocateBatchesFEFO(page, dlg, bc){
  const m = String(bc).match(/_([0-9]+(?:\.[0-9]+)?)\s*$/);
  const need = m ? parseFloat(m[1]) : 0;
  const code = String(bc).split('_')[0];
  if (!(need > 0) || !code){ await closeBatchDlg(page, dlg); return { ok:false, need:0, filled:0 }; }

  const rows = await dlg.evaluate((root) => {
    const MON={Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
    const pd=(s)=>{ s=(s||'').trim();
      let x=s.match(/(\d{1,2})[\/\- ]([A-Za-z]{3})[\/\- ](\d{2,4})/); if(x){let y=+x[3]; if(y<100)y+=2000; return new Date(y,MON[x[2]],+x[1]).getTime();}
      x=s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/); if(x){let y=+x[3]; if(y<100)y+=2000; return new Date(y,+x[2]-1,+x[1]).getTime();}
      return Number.MAX_SAFE_INTEGER; };
    const heads=Array.from(root.querySelectorAll('.slick-header-column'));
    const idx={}; heads.forEach(h=>{ const id=h.getAttribute('data-id'); if(id) idx[id]=Array.from(h.parentNode.children).indexOf(h); });
    const col=(id,def)=> (id in idx)?idx[id]:def;
    const cBatch=col('BatchID',1), cExp=col('ExpDate',3), cQoh=col('QOH',5);
    const out=[];
    root.querySelectorAll('.grid-canvas .slick-row').forEach(r=>{
      const cells=Array.from(r.querySelectorAll('.slick-cell'));
      const t=(i)=> cells[i]?cells[i].innerText.trim():'';
      const qoh=parseFloat((t(cQoh)||'0').replace(/[^0-9.]/g,''))||0;
      const batch=t(cBatch);
      if(batch) out.push({ batch, exp:pd(t(cExp)), qoh });
    });
    return out;
  });

  const usable = rows.filter(r => r.qoh > 0).sort((a,b)=>a.exp-b.exp);   // FEFO
  const scanBatch = await batchScanInput(dlg);
  let remaining = need, filled = 0;
  for (const row of usable){
    if (remaining <= 1e-6) break;
    const give = Math.min(remaining, row.qoh);
    const label = code + '_' + row.batch + '_' + fmtN(give);
    try{
      await scanBatch.click({ force:true, timeout:3000 }).catch(()=>{});
      await scanBatch.fill('');
      await scanBatch.pressSequentially(label, { delay: 6 });
      await scanBatch.press('Enter');
      await page.waitForTimeout(500);
      remaining -= give; filled += give;
      console.log('    batch ' + row.batch + ' <- ' + fmtN(give));
    }catch(e){ console.log('    batch-alloc error ' + label + ': ' + String(e.message).split('\n')[0]); }
  }
  if (filled > 1e-6){
    await clickFirst(page, [ () => dlg.getByRole('button',{name:/^\s*Save\s*$/i}), () => dlg.locator('button').filter({hasText:/^\s*Save\s*$/}) ], 'save batch allocation', 4000);
    await page.waitForTimeout(900);
    return { ok: remaining <= 1e-6, need, filled };
  }
  await closeBatchDlg(page, dlg);
  return { ok:false, need, filled:0 };
}

async function createStockOutward(page, order, { dryRun = true } = {}) {
  const { omr, outlet, category = 'Frozen', barcodes = [] } = order;
  console.log('Stock Outward: OMR=' + omr + ' outlet=' + outlet + ' cat=' + category + ' items=' + barcodes.length + ' dryRun=' + dryRun);
  await clickFirst(page, [ () => page.getByRole('link', { name: 'Stock Outward to Outlet' }), () => page.getByText('Stock Outward to Outlet', { exact: true }) ], 'open Stock Outward to Outlet');
  await page.waitForTimeout(3200);
  await handleVoucherPrefix(page);
  await page.screenshot({ path:'/tmp/so-a-form.png', fullPage:true }).catch(()=>{});

  await selectOutlet(page, outlet);
  await selectField(page, 'Outlet Issue Type', category, 'Outlet Issue Type');
  await selectField(page, 'Outlet ReqNo', omr, 'Outlet ReqNo');
  await page.waitForTimeout(1000);
  await page.screenshot({ path:'/tmp/so-b-fields.png', fullPage:true }).catch(()=>{});

  const scan = page.getByRole('textbox', { name: 'Scan' }).first();
  await scan.waitFor({ state: 'visible', timeout: 12000 }).catch(() => console.log('  ! Scan field not visible'));
  let entered = 0; const skipped = []; const unfulfilled = [];
  for (const bc of barcodes) {
    try {
      await scan.click({ timeout: 4000 }).catch(() => {});
      await scan.fill('');
      await scan.pressSequentially(String(bc), { delay: 8 });
      await scan.press('Enter');
      await page.waitForTimeout(1300);
      const dlg = page.locator('modal-container.show').first();
      if (await dlg.isVisible().catch(() => false)) {
        // The scanned batch is stale/short → allocate valid batches FEFO instead of quitting.
        const a = await reallocateBatchesFEFO(page, dlg, bc);
        if (a.ok) { entered++; console.log('  added (re-batched ' + fmtN(a.filled) + '): ' + bc); }
        else if (a.filled > 0) { entered++; unfulfilled.push({ bc, need: a.need, got: a.filled }); console.log('  PARTIAL (' + fmtN(a.filled) + '/' + fmtN(a.need) + ' available): ' + bc); }
        else { skipped.push(bc); console.log('  UNFULFILLED (genuinely no stock in any batch): ' + bc); }
        continue;
      }
      // Big orders make the grid heavy, so a scan can take many seconds to register.
      // Wait generously (up to ~16s), watch for a batch dialog that pops in late, retry
      // the scan once, and only skip if it truly never lands — never drop an item just
      // because the grid was slow. This is the second size-triggered drop.
      let cleared = false, handled = false;
      for (let attempt = 0; attempt < 2 && !cleared && !handled; attempt++) {
        for (let t = 0; t < 40; t++) {
          await page.waitForTimeout(400);
          const dlg2 = page.locator('modal-container.show').first();
          if (await dlg2.isVisible().catch(() => false)) {
            const a = await reallocateBatchesFEFO(page, dlg2, bc);
            if (a.ok) { entered++; console.log('  added (re-batched ' + fmtN(a.filled) + '): ' + bc); }
            else if (a.filled > 0) { entered++; unfulfilled.push({ bc, need: a.need, got: a.filled }); console.log('  PARTIAL (' + fmtN(a.filled) + '/' + fmtN(a.need) + ' available): ' + bc); }
            else { skipped.push(bc); console.log('  UNFULFILLED (genuinely no stock in any batch): ' + bc); }
            handled = true; break;
          }
          if ((await scan.inputValue().catch(() => '')) !== String(bc)) { cleared = true; break; }
        }
        if (!cleared && !handled && attempt === 0) {   // re-scan once in case a keystroke dropped on the busy grid
          await scan.click({ timeout: 4000 }).catch(() => {});
          await scan.fill('');
          await scan.pressSequentially(String(bc), { delay: 8 });
          await scan.press('Enter');
          await page.waitForTimeout(1000);
        }
      }
      if (handled) { /* already logged above */ }
      else if (cleared) { entered++; console.log('  added ' + entered + ': ' + bc); }
      else { skipped.push(bc); await scan.fill('').catch(() => {}); console.log('  NOT-REGISTERED after retry (slow grid): ' + bc); }
    } catch (e) { skipped.push(bc); console.log('  scan error ' + bc + ': ' + String(e.message).split('\n')[0]); }
  }
  await page.screenshot({ path:'/tmp/stock-outward-filled.png', fullPage:true }).catch(()=>{});
  // (grid inspector removed after diagnosis)

  // Narration: mark the voucher as auto-dispatched by the AI worker (audit trail,
  // visible in PACT + the app). Best-effort only — never let this block a Post.
  try {
    const narr = 'Entry made by AI - OMR ' + (omr || '');
    let nf = page.locator('#CommonNarration').first();
    if (!(await nf.count().catch(() => 0))) {
      nf = page.locator('textarea[name*="arration" i], input[name*="arration" i], textarea[id*="arration" i], input[id*="arration" i]').first();
    }
    if (await nf.count().catch(() => 0)) {
      await nf.click({ timeout: 3000 }).catch(() => {});
      await nf.fill(narr).catch(() => {});
      console.log('  narration = ' + narr);
    } else {
      console.log('  narration field not found — skipped');
    }
  } catch (e) { console.log('  narration fill skipped: ' + String(e.message).split('\n')[0]); }

  if (dryRun) { console.log('  [DRY RUN] Filled ' + entered + '/' + barcodes.length + '. Stopping before Post.'); return { posted:false, entered, skipped, unfulfilled, total:barcodes.length }; }

  // ---- Post (single click) with correct success detection --------------------
  // IMPORTANT: PACT's Stock Outward, on a SUCCESSFUL Post, saves the voucher and
  // immediately opens a FRESH BLANK Draft for the next entry. So "Draft badge is
  // gone" is the WRONG success test (the new blank doc is itself a Draft). The
  // reliable signals that the voucher posted are: the grid emptied (Net Total ->
  // 0.000 where it was non-zero) OR the Doc No advanced. We therefore snapshot the
  // pre-Post state, click Post ONCE (never blind-retry — a second Post on the fresh
  // blank doc does nothing, and re-running risks a DOUBLE real-stock dispatch), and
  // poll for those signals. A validation toast => genuine failure (nothing moved).
  async function soState(pg) {
    return await pg.evaluate(() => {
      const txt = document.body ? (document.body.innerText || '') : '';
      let badge = '';
      const bm = txt.match(/Stock Outward to Outlet\s*\n?\s*(Posted|Draft)/i);
      if (bm) badge = bm[1];
      let net = '';
      const nm = txt.match(/Net Total\s*:?\s*([\d.,]+)/i);
      if (nm) net = nm[1].replace(/,/g, '');
      // Doc No: read from the page's DISPLAYED text. The OMR (OMR-AF/...) lives in
      // an <input> value, which is NOT part of innerText, so this reliably returns the
      // voucher number AF/26-27/<n> and never the OMR requisition number (the old
      // input-value scan matched the OMR ReqNo box and stored the wrong number).
      let docNo = '';
      {
        const bt = document.body ? (document.body.innerText || '') : '';
        const rx = /(?:SOT-)?AF\/\s*(\d{2})\s*-\s*(\d{2})\s*\/\s*(\d{3,7})/g; let mm;
        while ((mm = rx.exec(bt))) {
          const pre = bt.slice(Math.max(0, mm.index - 4), mm.index);
          if (/OMR-?$/i.test(pre)) continue;   // skip an OMR-AF/... if it ever shows as text
          docNo = 'AF/' + mm[1] + '-' + mm[2] + '/' + mm[3]; break;
        }
      }
      return { badge: badge, net: net, docNo: docNo };
    }).catch(() => ({ badge: '', net: '', docNo: '' }));
  }
  const before = await soState(page);
  const netBefore = parseFloat(before.net || '0') || 0;
  const docBefore = before.docNo || '';
  console.log('  [post] before: docNo=' + (docBefore || '?') + ' netTotal=' + (before.net || '?') + ' badge=' + (before.badge || '?'));

  let posted = false, reason = '', postedDoc = '', warn = '', seenToast = '';
  const consoleErrs = [];
  page.on('console', (m) => { try { if (m.type() === 'error') consoleErrs.push(String(m.text()).slice(0, 200)); } catch (e) {} });
  page.on('dialog', (d) => d.accept().catch(() => {}));   // accept any native confirm dialog, on every attempt
  // Commit the grid before posting: a person clicks off the scan box first, which
  // registers all the scanned rows. Do the same — blur the active field — so PACT
  // sees a fully committed document when we click Post.
  try { await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); }); } catch (e) {}
  try { await page.keyboard.press('Tab'); } catch (e) {}
  await page.waitForTimeout(900);
  // DIAGNOSTIC + FIX: PACT renders duplicate toolbars (desktop + responsive), so more
  // than one element can carry title="Post". A hidden duplicate's click is a no-op —
  // exactly the "click succeeds, nothing posts, no error" symptom. Dump every Post
  // control's visibility so the log proves which instance is the real one.
  try {
    const pinfo = await page.evaluate(() => {
      const cands = Array.from(document.querySelectorAll('button, a, [role="button"]')).filter((el) => {
        const t = ((el.getAttribute && el.getAttribute('title')) || '').trim();
        const x = (el.textContent || '').replace(/\s+/g, ' ').trim();
        return t === 'Post' || x === 'Post';
      });
      return cands.map((el) => {
        const r = el.getBoundingClientRect();
        const vis = el.offsetParent !== null && r.width > 0 && r.height > 0;
        let top = false;
        if (vis) { const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); top = !!(e && (e === el || el.contains(e) || (e.contains && e.contains(el)))); }
        return { vis: vis, top: top, w: Math.round(r.width), h: Math.round(r.height), cls: String(el.className || '').slice(0, 30) };
      });
    });
    console.log('  [post-diag] Post controls: ' + JSON.stringify(pinfo));
  } catch (e) {}
  // A correct, trusted click on the single visible Post button does NOT trigger PACT's
  // save under automation (proven: net/doc never change, no error), yet a human click
  // works. So we (a) capture whether clicking fires ANY network request, and (b) try
  // several activation methods — mouse click, keyboard Enter/Space on the focused
  // button, a full synthetic pointer sequence, and form submit — stopping the instant
  // the grid clears (a real post). SAFE against double-dispatch: every method re-checks
  // the net first and stops the moment net -> 0, so nothing fires against an empty draft.
  const netLog = [];
  const isAsset = (u) => /\.(js|css|png|jpe?g|gif|svg|woff2?|ttf|ico|map)(\?|$)/i.test(u);
  const onReq = (req) => { try { const u = req.url(); if (!isAsset(u)) netLog.push(req.method() + ' ' + u.slice(0, 130)); } catch (e) {} };
  const onResp = (res) => { try { const u = res.url(); if (!isAsset(u)) netLog.push('<-' + res.status() + ' ' + u.slice(0, 130)); } catch (e) {} };
  page.on('request', onReq); page.on('response', onResp);

  // The visible Post button, resolved fresh each time inside the page.
  const POST_FINDER = "var C=Array.from(document.querySelectorAll('button,a,[role=\\\"button\\\"]')).filter(function(el){var t=((el.getAttribute&&el.getAttribute('title'))||'').trim();var x=(el.textContent||'').replace(/\\s+/g,' ').trim();return t==='Post'||x==='Post';});var B=C.find(function(el){return el.offsetParent!==null&&el.getBoundingClientRect().width>0;})||C[0];";

  // Wrap every finder+body in an IIFE so `return` inside the string is legal
  // (page.evaluate treats a bare string as an EXPRESSION, where `return` throws).
  const EV = (body) => page.evaluate("(function(){" + POST_FINDER + body + "})()");
  async function fireTrigger(kind) {
    if (kind === 'mouseclick') {
      const c = await EV("if(!B)return null;B.scrollIntoView({block:'center',inline:'center'});var r=B.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};");
      if (c) { await page.mouse.move(c.x, c.y); await page.mouse.click(c.x, c.y); }
    } else if (kind === 'enter' || kind === 'space') {
      await EV("if(B){B.focus();}");
      await page.keyboard.press(kind === 'enter' ? 'Enter' : 'Space');
    } else if (kind === 'pointerseq') {
      await EV("if(!B)return;var r=B.getBoundingClientRect();var x=r.left+r.width/2,y=r.top+r.height/2;var o={bubbles:true,cancelable:true,composed:true,view:window,clientX:x,clientY:y,button:0};['pointerover','pointerenter','pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){try{var E=t.indexOf('pointer')===0?PointerEvent:MouseEvent;B.dispatchEvent(new E(t,o));}catch(e){try{B.dispatchEvent(new Event(t,{bubbles:true}));}catch(e2){}}});");
    } else if (kind === 'submit') {
      await EV("if(!B)return;var f=B.closest('form');if(f){if(f.requestSubmit){try{f.requestSubmit(B);return;}catch(e){}}try{f.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));}catch(e){}}");
    }
  }

  // ROOT CAUSE: the form is ng-VALID but ng-PRISTINE (the programmatic fill never
  // registered as user input), and PACT's Post silently skips a pristine form — which
  // is why no trigger ever fired a save request. FIX: mark the form dirty by typing and
  // deleting one character in a real text field (the Narration box), so Angular sees
  // genuine user input. Then a normal click posts, exactly like a human's.
  try {
    const fc = await EV("var f=document.querySelector('form');if(!f)return '(no form)';var stack=[];var ctx=f.__ngContext__;if(ctx&&typeof ctx==='object')stack.push(ctx);stack.push(f);var seen=new Set();var ctrls=[];var steps=0;while(stack.length&&steps<40000){steps++;var o=stack.pop();if(!o||typeof o!=='object')continue;if(seen.has(o))continue;seen.add(o);var isCtrl=false;try{isCtrl=(typeof o.markAsDirty==='function'&&typeof o.markAllAsTouched==='function'&&('status'in o));}catch(e){}if(isCtrl)ctrls.push(o);if(seen.size>40000)break;for(var k in o){try{var v=o[k];if(v&&typeof v==='object'&&!seen.has(v))stack.push(v);}catch(e){}}}var top=null;for(var i=0;i<ctrls.length;i++){try{if(ctrls[i].parent==null){top=ctrls[i];break;}}catch(e){}}if(!top&&ctrls.length)top=ctrls[0];if(top){try{top.markAsDirty();top.markAllAsTouched();if(top.updateValueAndValidity)top.updateValueAndValidity();}catch(e){}}return 'ctrls='+ctrls.length+' marked='+(!!top)+' formClass=['+f.className+']';");
    console.log('  [post] ng-dirty attempt: ' + fc);
  } catch (e) { console.log('  [post] ng-dirty step threw: ' + String(e.message).split('\n')[0]); }

  // With the form now dirty, a normal click should post like a human's. Keep submit as
  // a backup. The loop STOPS the instant the grid clears (net -> 0), so at most ONE posts.
  const methods = ['mouseclick', 'submit'];
  for (let mi = 0; mi < methods.length && !posted && !warn; mi++) {
    const cur = await soState(page);
    const curNet = parseFloat(cur.net || '0') || 0;
    if (netBefore > 0 && curNet === 0) { posted = true; postedDoc = cur.docNo || docBefore; break; }   // already saved -> stop (no double-post)
    const netMark = netLog.length;
    console.log('  [post] try method=' + methods[mi] + ' docNow=' + (cur.docNo || '?') + ' net=' + (cur.net || '?'));
    try { await fireTrigger(methods[mi]); } catch (e) { console.log('  [post] method ' + methods[mi] + ' threw: ' + String(e.message).split('\n')[0]); }
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const cdlg = page.locator('modal-container.show').first();
      if (await cdlg.isVisible().catch(() => false)) {
        const cbtn = cdlg.getByRole('button', { name: /^(Ok|Yes|Post|Confirm|Save|Proceed|Continue)$/i }).filter({ visible: true }).first();
        if (await cbtn.count().catch(() => 0)) { await cbtn.click({ timeout: 4000 }).catch(() => {}); await page.waitForTimeout(600); }
      }
      const wt = await page.getByText(/please select|cannot be blank|is required|mandatory|not valid|invalid|insufficient|not enough|stock not/i).filter({ visible: true }).allInnerTexts().catch(() => []);
      const wj = wt.join(' | ').replace(/\s+/g, ' ').trim();
      if (wj) { warn = wj; break; }
      const now = await soState(page);
      const netNow = parseFloat(now.net || '0') || 0;
      if (now.badge && /posted/i.test(now.badge)) { posted = true; postedDoc = now.docNo || cur.docNo || docBefore; break; }
      if (netBefore > 0 && netNow === 0) { posted = true; postedDoc = cur.docNo || docBefore; break; }   // grid cleared => saved
      await page.waitForTimeout(400);
    }
    console.log('  [post] method=' + methods[mi] + ' -> ' + (posted ? 'POSTED' : (warn ? 'VALIDATION' : 'no change')) + '; requests fired by it: ' + (netLog.length - netMark));
    if (!posted && !warn) await page.waitForTimeout(800);
  }
  try { page.off('request', onReq); page.off('response', onResp); } catch (e) {}
  if (!posted && !warn) {
    console.log('  [post-diag] network during post (last 20): ' + (netLog.slice(-20).join('  |  ') || '(NONE — no non-asset requests fired by ANY trigger)'));
    const dump = await EV("if(!B)return 'POST_BTN_NOT_FOUND';var f=B.closest('form');return 'type='+(B.getAttribute('type')||'')+' inForm='+(!!f)+' outerHTML='+B.outerHTML.slice(0,240);").catch(() => '?');
    console.log('  [post-diag] postBtn ' + dump);
    // Which form controls does Angular consider INVALID? That is what makes post() bail.
    const inv = await EV("var f=document.querySelector('form');var fc=f?(f.className||''):'(no form)';var bad=[];document.querySelectorAll('.ng-invalid').forEach(function(e){if(e.tagName==='FORM')return;if(e.offsetParent===null)return;var lab='';var p=e.closest('div');for(var i=0;i<6&&p;i++){var l=p.querySelector('label');if(l&&l.innerText.trim()){lab=l.innerText.trim();break;}p=p.parentElement;}var fcn=(e.getAttribute&&e.getAttribute('formcontrolname'))||'';var key=(lab||'?')+(fcn?('['+fcn+']'):'');if(bad.indexOf(key)<0&&bad.length<20)bad.push(key);});return 'formClass=['+fc+'] invalidControls=['+(bad.length?bad.join(', '):'none')+']';").catch(function(){return '?';});
    console.log('  [post-diag] ng-invalid: ' + inv);
  }
  await page.screenshot({ path: '/tmp/stock-outward-after-post.png', fullPage: true }).catch(() => {});
  const docNo = postedDoc || docBefore || '';
  if (posted) {
    console.log('  Post CONFIRMED docNo=' + (docNo || '?'));
    return { posted: true, docNo: docNo, reason: '', entered: entered, skipped: skipped, unfulfilled: unfulfilled, total: barcodes.length };
  }
  if (warn) {
    reason = warn.slice(0, 180);
    console.log('  Post REJECTED (nothing dispatched): ' + reason);
    return { posted: false, docNo: '', reason: reason, entered: entered, skipped: skipped, unfulfilled: unfulfilled, total: barcodes.length };
  }
  // No success signal and no validation toast: DO NOT retry (double-post risk).
  // Report uncertain so a human verifies in PACT rather than the worker re-posting.
  try {
    const diag = await page.evaluate(() => {
      const bits = [];
      document.querySelectorAll('modal-container, .modal-content, .toast, .toast-message, .toast-container, .alert, [class*="notification"], [class*="validation"], [class*="error"], [class*="message"], .k-notification, .swal2-popup, [role="alert"]').forEach((e) => {
        if (e.offsetParent !== null) { const t = (e.innerText || '').replace(/\s+/g, ' ').trim(); if (t && t.length < 500) bits.push(t); }
      });
      const btns = [];
      document.querySelectorAll('modal-container.show button, .modal.show button').forEach((bn) => { if (bn.offsetParent !== null) { const t = (bn.innerText || '').trim(); if (t) btns.push(t); } });
      return { msgs: Array.from(new Set(bits)).slice(0, 12), btns: Array.from(new Set(btns)).slice(0, 10) };
    }).catch(() => ({ msgs: [], btns: [] }));
    if (diag && (diag.msgs.length || diag.btns.length)) {
      console.log('  [post-diag] messages: ' + (diag.msgs.join(' || ').slice(0, 700) || '(none)'));
      console.log('  [post-diag] modal buttons: ' + (diag.btns.join(', ') || '(none)'));
    } else {
      console.log('  [post-diag] no visible message/modal captured after Post');
    }
    const btnState = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      const b = els.find((el) => ((el.getAttribute && el.getAttribute('title')) || '').trim() === 'Post')
             || els.find((el) => (el.textContent || '').replace(/\s+/g, ' ').trim() === 'Post');
      if (!b) return 'POST_BTN_NOT_FOUND';
      const dis = !!(b.disabled || b.getAttribute('disabled') != null || (b.className && /disabl/i.test(b.className)) || (b.getAttribute('aria-disabled') === 'true'));
      return 'tag=' + b.tagName + ' disabled=' + dis + ' cls=' + String(b.className || '').slice(0, 60);
    }).catch(() => '?');
    console.log('  [post-diag] postBtn ' + btnState);
    if (consoleErrs.length) console.log('  [post-diag] consoleErrs: ' + consoleErrs.slice(-6).join('  ||  ').slice(0, 500));
  } catch (e) { console.log('  [post-diag] failed: ' + (e && e.message)); }
  console.log('  Post UNCERTAIN: no success signal and no validation error — needs manual check (see /tmp/stock-outward-after-post.png). docBefore=' + (docBefore || '?'));
  return { posted: false, uncertain: true, docNo: docBefore || '', reason: 'post-uncertain: verify in PACT (Doc ' + (docBefore || '?') + ')', entered: entered, skipped: skipped, unfulfilled: unfulfilled, total: barcodes.length };
}
module.exports = { createStockOutward };
