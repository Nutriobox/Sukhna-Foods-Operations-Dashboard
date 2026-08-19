// Creates a Stock Inward in PACT. Rebuilt to mirror the user's Playwright
// recording (pact-recording.js) of the CURRENT PACT screen:
//   - No "Link GGE" step (removed from PACT).
//   - Product is entered manually into the grid.
//   - Qty typed into the row -> Enter, Enter opens the "Generate Batch Numbers"
//     box -> set Manufactured date -> Save & Add -> pick the created batch ->
//     set its quantity -> Save -> Post (+ Extra Fields date if PACT asks).

const path = require('path');
const { pickVendorSuggestion, pickSuggestion } = require('./gge');

// "18/08/2026" -> "18"  (day-of-month, no leading zero) for the calendar picker.
const dayOf = (dmy) => { const m = /^(\d{1,2})/.exec(String(dmy || '')); return m ? String(parseInt(m[1], 10)) : ''; };

// PACT product names often contain the multiplication sign "×" and brackets,
// e.g. "1 Kg LD Pouch (270×200)mm". Typing those special chars into the lookup
// breaks the type-ahead, so we type a clean prefix (letters/digits/space up to
// the first special char) to trigger the dropdown, then match the suggestion by
// a normalized comparison that treats "×" and "x" the same and ignores spacing.
const typePrefix = (name) => {
  const m = String(name || '').match(/^[A-Za-z0-9 ]+/);
  let pfx = (m ? m[0] : String(name || '')).trim();
  if (pfx.length < 3) pfx = String(name || '').slice(0, 6);
  return pfx.slice(0, 16);
};
const normProd = (s) => String(s || '').toLowerCase().replace(/×/g, 'x').replace(/[^a-z0-9]/g, '');

// Pick the product from PACT's suggestions dropdown. Returns how many options
// were shown and whether we matched the exact product (vs. fell back to first).
async function pickProduct(page, fullName) {
  const want = normProd(fullName);
  const dd = page.locator('.List__dropdown--suggestions');
  await dd.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  const opts = dd.locator('.suggestions__list-name');
  let n = await opts.count().catch(() => 0);
  if (!n) { // some builds render suggestions without the wrapper class
    const alt = page.locator('.suggestions__list-name');
    if (await alt.count().catch(() => 0)) { n = await alt.count(); return await pickFrom(alt, n, want); }
    return { ok: false, n: 0, matched: false, text: '' };
  }
  return await pickFrom(opts, n, want);
}
async function pickFrom(opts, n, want) {
  const texts = [];
  let idx = -1;
  for (let i = 0; i < n; i++) { const t = ((await opts.nth(i).innerText().catch(() => '')) || '').trim(); texts.push(t); if (normProd(t) === want) { idx = i; break; } }
  if (idx < 0) for (let i = 0; i < n; i++) { const c = normProd(texts[i]); if (c && (c.includes(want) || want.includes(c))) { idx = i; break; } }
  const matched = idx >= 0;
  if (idx < 0) idx = 0; // fall back to the first suggestion
  await opts.nth(idx).click({ timeout: 6000 }).catch(() => {});
  return { ok: true, n, matched, text: texts[idx] || '' };
}

async function createStockInward(page, bill, { dryRun = true } = {}) {
  console.log('  [SI build] v7: two-case batch (new: mfg+exp+1yr+qty; duplicate: pick last batch+qty) + Save&Add + Save');
  const tab = page.getByRole('tabpanel').filter({ hasText: 'Stock Inward' });
  const problems = [];   // collect per-item issues so we can report a real pass/fail

  // 1. Open Stock Inward (via the Flows menu if the link isn't already showing).
  const link = page.getByRole('link', { name: 'Stock Inward', exact: true }).first();
  if (!(await link.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Flows' }).click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1050);
  }
  await link.click({ timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1400);

  // 1b. Voucher Prefix / Location popup (if it appears). The recording double-
  //     clicks the check-square to select the row, then confirms.
  const vp = page.locator('modal-container.show').first();
  if (await vp.isVisible().catch(() => false)) {
    const chk = vp.locator('.fa.fa-check-square-o, .List__button').first();
    await chk.dblclick({ timeout: 4000 }).catch(async () => { await chk.click().catch(() => {}); });
    await page.waitForTimeout(400);
    await page.getByText(bill.company || 'Factory', { exact: true }).first().click({ timeout: 5000 }).catch(() => {});
    await vp.getByRole('button', { name: 'Ok' }).click({ timeout: 5000 }).catch(() => {});
    await vp.waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
  }
  await page.waitForTimeout(700);

  // 2. Vendor (type-ahead, then pick the matching suggestion).
  const siVendor = tab.locator('[id="100"]').first();
  await siVendor.click().catch(() => {});
  await siVendor.fill('').catch(() => {});
  await siVendor.pressSequentially(String(bill.vendorSearch || bill.vendor.slice(0, 4)), { delay: 60 }).catch(() => {});
  await page.waitForTimeout(500);
  await pickVendorSuggestion(page, bill.vendor);
  await page.waitForTimeout(550);

  // 3. Bill number.
  await tab.locator('#BillNo').first().fill(String(bill.billNo)).catch(() => {});
  await tab.locator('#BillNo').first().press('Enter').catch(() => {});
  await page.waitForTimeout(600);

  // 3b. Bill Date + a required date on the "Extra Fields" tab (both set in the
  //     working recording). Use the manufactured day the user picked (= today).
  const todayDay = dayOf(bill.items[0] && bill.items[0].batch && bill.items[0].batch.mfgDate) || String((new Date()).getDate());
  await tab.locator('#BillDate').first().click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.getByText(todayDay, { exact: true }).first().click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(300);
  const exTab = tab.getByRole('tab', { name: 'Extra Fields' }).first();
  if (await exTab.isVisible().catch(() => false)) {
    await exTab.click().catch(() => {});
    await page.waitForTimeout(700);
    await tab.locator('.tab-pane.active app-pactextradatepicker .List__button, app-pactextradatepicker .List__button').first().click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(400);
    await page.getByText(todayDay, { exact: true }).first().click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(300);
    console.log('  set Bill Date + Extra Fields date to day ' + todayDay);
  }

  // 4. Add each product row, then create/allocate its batch.
  for (let i = 0; i < bill.items.length; i++) {
    const it = bill.items[i];
    const search = String(it.search || it.name || '').trim();
    const qty = it.qty;
    const unitLevel = it.unitLevel || 'L1';
    const mfgDay = dayOf(it.batch && it.batch.mfgDate);
    console.log(`  item[${i + 1}] "${search}" qty=${qty} level=${unitLevel} mfgDay=${mfgDay || '(none)'}`);

    // 4a. Product Name cell -> open editor -> type with REAL keystrokes so PACT's
    //     type-ahead fires, then pick the matching suggestion (a plain fill() sets
    //     the value without firing the events the dropdown needs, so nothing gets
    //     selected and the batch box never opens — that was the earlier bug).
    // Open the ProductName editor for THIS row. Prefer the column scoped by
    // aria-describedby (GGE's proven approach) so we never type into a
    // neighbouring cell; fall back to the accessible "Product Name" gridcell.
    let prodCell = page.locator('.slick-cell[aria-describedby$="ProductName"]').nth(i);
    if (!(await prodCell.count().catch(() => 0))) {
      prodCell = page.getByRole('gridcell', { description: 'Product Name', exact: true }).nth(i);
    }
    const editorLoc = () => page.locator('.slick-cell[aria-describedby$="ProductName"].editable input, .slick-cell.editable input, input.PactTextBoxEditor').first();
    await prodCell.scrollIntoViewIfNeeded().catch(() => {});
    await prodCell.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(400);
    if (!(await editorLoc().isVisible().catch(() => false))) { await prodCell.dblclick({ timeout: 4000 }).catch(() => {}); await page.waitForTimeout(350); }
    if (!(await editorLoc().isVisible().catch(() => false))) { await prodCell.click().catch(() => {}); await page.keyboard.press('Enter').catch(() => {}); await page.waitForTimeout(350); }

    // One-time diagnostics on the first item: is the editor open? what columns
    // does the product row have? which suggestion containers exist after typing?
    if (i === 0) {
      const dg = await page.evaluate(() => {
        const hdr = {}; document.querySelectorAll('.slick-header-column').forEach(h => { hdr[h.id] = (h.innerText || '').trim(); });
        const row = [...document.querySelectorAll('.slick-row')].find(r => r.querySelector('.slick-cell.editable')) || document.querySelector('.slick-row');
        const cells = row ? [...row.querySelectorAll('.slick-cell')].map(c => (c.getAttribute('aria-describedby') || '').replace(/^slickgrid_\d+/, '')).filter(Boolean).slice(0, 20) : [];
        const editCount = document.querySelectorAll('.slick-cell.editable input').length;
        const active = document.activeElement ? `${document.activeElement.tagName}#${document.activeElement.id || '-'}` : 'none';
        return { cells, editCount, active };
      }).catch(() => ({}));
      console.log(`  [prod-diag] editorVisible=${await editorLoc().isVisible().catch(() => false)} editCount=${dg.editCount} active=${dg.active} cols=${JSON.stringify(dg.cells)}`);
    }

    const dumpSuggest = async (tag) => {
      const d = await page.evaluate(() => ({
        sugDD: document.querySelectorAll('.List__dropdown--suggestions').length,
        sugName: document.querySelectorAll('.suggestions__list-name').length,
        listDD: document.querySelectorAll('.List__dropdown').length,
        anyLi: document.querySelectorAll('ul li').length,
      })).catch(() => ({}));
      console.log(`  [sugg ${tag}] ${JSON.stringify(d)}`);
    };

    // Read what the ProductName cell currently shows (after the editor closes).
    const readProdCell = async () => {
      const t = ((await prodCell.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      return t;
    };
    const wantNorm = normProd(it.name);

    // Type a query, accept the highlighted match with Enter (exactly like the
    // manual recording), then VERIFY the cell now holds the right product. This
    // does not depend on locating a specific suggestion container.
    const typeAndSelect = async (query, label) => {
      const ed = editorLoc();
      await ed.click().catch(() => {});
      await ed.fill('').catch(() => {});
      await ed.pressSequentially(String(query), { delay: 70 }).catch(async () => { await page.keyboard.type(String(query)).catch(() => {}); });
      await page.waitForTimeout(950);
      if (i === 0) await dumpSuggest(label);
      // First try clicking a suggestion if PACT rendered the known dropdown…
      const res = await pickProduct(page, it.name).catch(() => ({ ok: false, n: 0 }));
      // …but always also accept via keyboard: highlight the first row + Enter.
      if (!(res.ok && res.n > 0)) { await page.keyboard.press('ArrowDown').catch(() => {}); await page.waitForTimeout(200); }
      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForTimeout(600);
      await page.locator('#revwebbody').press('Enter').catch(() => {});
      await page.waitForTimeout(300);
      const cell = await readProdCell();
      const cn = normProd(cell);
      const selected = cn.length > 2 && (cn === wantNorm || cn.includes(wantNorm) || wantNorm.includes(cn));
      console.log(`  item[${i + 1}] ${label} "${query}" -> suggestions=${res.n} cell="${cell.slice(0, 44)}" selected=${selected}`);
      return selected;
    };

    // Prefer the PACT product CODE (unique, no special chars). Fall back to a
    // clean name prefix (letters/digits before the first "×"/bracket).
    const pfx = typePrefix(search);
    let selectedOk = false;
    if (it.code) selectedOk = await typeAndSelect(it.code, 'code');
    if (!selectedOk) selectedOk = await typeAndSelect(pfx, 'name-prefix');
    await page.waitForTimeout(300);
    if (!selectedOk) { const m = `item[${i + 1}] product "${it.name}" (code ${it.code || 'n/a'}) — could not select in PACT grid`; console.log('  ' + m); problems.push(m); continue; }

    // 4b. Purchase Unit Level dropdown -> select (L1).
    const lvlSel = page.locator('.slick-cell .input_cntrl, .slick-cell select').first();
    await lvlSel.selectOption(unitLevel).catch(() => {});
    await lvlSel.press('Enter').catch(() => {});
    await page.waitForTimeout(450);

    // 4c. Quantity -> type it, Enter, Enter -> opens the batch box. After the
    //     unit-level Enter the qty editor is usually active; if not, open the
    //     Approve Qty cell explicitly.
    let qed = page.locator('input.PactTextBoxEditor, .slick-cell.editable input, input.editor-text').first();
    if (!(await qed.isVisible().catch(() => false))) {
      const aqCell = page.getByRole('gridcell', { description: 'Approve Qty', exact: true }).nth(i);
      await aqCell.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(250);
      await aqCell.dblclick({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(250);
      qed = page.locator('input.PactTextBoxEditor, .slick-cell.editable input, input.editor-text').first();
    }
    await qed.fill(String(qty)).catch(async () => { await page.keyboard.type(String(qty)).catch(() => {}); });
    await qed.press('Enter').catch(() => {});
    await page.waitForTimeout(400);

    // Reliable header-label -> aria-describedby suffix map (getByRole did not
    // reliably match the Batch No / Mfg Date cells; suffix targeting does).
    const suffixMap = await page.evaluate(() => {
      const hdr = {}; document.querySelectorAll('.slick-header-column').forEach(h => { const t = (h.innerText || '').trim(); if (t) hdr[h.id] = t; });
      const map = {};
      document.querySelectorAll('.slick-row .slick-cell').forEach(c => { const db = c.getAttribute('aria-describedby') || ''; const label = hdr[db]; if (label && !map[label]) map[label] = db.replace(/^slickgrid_\d+/, ''); });
      return map;
    }).catch(() => ({}));
    const cellBy = (label) => page.getByRole('gridcell', { description: label, exact: true }).nth(i);
    const gcell = (label) => { const suf = suffixMap[label]; return suf ? page.locator('.slick-row').nth(i).locator('.slick-cell[aria-describedby$="' + suf + '"]').first() : cellBy(label); };
    const batchOpen = async () => ((await page.locator('modal-container.show').count().catch(() => 0)) > 0);

    // Try to open the "Generate Batch Numbers" popup (used by some products).
    const openSeq = [
      ['BatchNo dblclick', async () => { await gcell('Batch No').scrollIntoViewIfNeeded().catch(() => {}); await gcell('Batch No').dblclick({ timeout: 4000 }); }],
      ['BatchNo click+Enter', async () => { await gcell('Batch No').click({ timeout: 4000 }); await page.waitForTimeout(200); await page.keyboard.press('Enter'); }],
      ['MfgDate dblclick', async () => { await gcell('Mfg Date').dblclick({ timeout: 4000 }); }],
      ['BaseQty click+Enter', async () => { await gcell('Base Qty').click({ timeout: 4000 }); await page.waitForTimeout(200); await page.keyboard.press('Enter'); }],
      ['Enter', async () => { await page.keyboard.press('Enter'); }],
    ];
    let openedVia = '';
    for (const [name, fn] of openSeq) {
      if (await batchOpen()) { openedVia = 'already'; break; }
      await fn().catch(() => {});
      await page.waitForTimeout(650);
      if (await batchOpen()) { openedVia = name; break; }
    }
    console.log(`  batch[${i + 1}] open: ${openedVia ? 'POPUP via ' + openedVia : 'no popup -> inline'}`);

    const dlg = page.locator('modal-container.show').last();
    const modalOpened = await dlg.isVisible().catch(() => false);

    if (!modalOpened) {
      // INLINE batch: fill the Mfg Date and Batch No cells directly in the row.
      const mfgDmyI = (it.batch && it.batch.mfgDate) || '';
      const batchNo = 'B' + String(mfgDmyI).replace(/[^0-9]/g, '').slice(0, 6) + (it.code ? '-' + it.code : '');
      // Mfg Date — open the cell editor and try several entry methods.
      await gcell('Mfg Date').scrollIntoViewIfNeeded().catch(() => {});
      await gcell('Mfg Date').click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(200);
      await gcell('Mfg Date').dblclick({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(350);
      if (i === 0) {
        const md = await page.evaluate(() => {
          const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const inputs = [...document.querySelectorAll('input')].filter(vis).map(x => `#${x.id || '-'}|${x.type || ''}|${(x.className || '').trim().slice(0, 24)}|ph=${x.getAttribute('placeholder') || ''}`).slice(0, 14);
          const cals = [...document.querySelectorAll('.List__button, .fa-calendar, app-pactextradatepicker, .datepicker, ngb-datepicker')].filter(vis).map(e => e.tagName.toLowerCase() + '.' + (e.className || '').trim().slice(0, 24)).slice(0, 8);
          return { inputs, cals };
        }).catch(() => ({}));
        console.log('  [mfgdate-diag]', JSON.stringify(md));
      }
      let ded = page.locator('.slick-cell.editable input, input.PactTextBoxEditor, input.editor-text, app-pactextradatepicker input, input[id*="Date" i], input[placeholder*="/" i]').first();
      if (await ded.isVisible({ timeout: 1200 }).catch(() => false) && !(await ded.getAttribute('readonly').catch(() => null))) {
        await ded.fill('').catch(() => {}); await ded.pressSequentially(mfgDmyI, { delay: 25 }).catch(() => {}); await ded.press('Enter').catch(() => {});
        await page.waitForTimeout(250);
      }
      // If still no value, try a calendar picker: open it, then click the day.
      if (!((await gcell('Mfg Date').innerText().catch(() => '')) || '').trim() && mfgDay) {
        const calBtn = page.locator('.List__button, .fa-calendar, .input-group-append').first();
        if (await calBtn.isVisible({ timeout: 800 }).catch(() => false)) { await calBtn.click().catch(() => {}); await page.waitForTimeout(400); }
        await page.getByText(mfgDay, { exact: true }).first().click({ timeout: 3000 }).catch(() => {});
      }
      await page.waitForTimeout(400);
      // Batch No (only if still empty)
      const bText = ((await gcell('Batch No').innerText().catch(() => '')) || '').trim();
      if (!bText) {
        await gcell('Batch No').dblclick({ timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(250);
        const bed = page.locator('input.PactTextBoxEditor, .slick-cell.editable input').first();
        if (await bed.isVisible({ timeout: 1200 }).catch(() => false)) { await bed.fill(batchNo).catch(() => {}); await bed.press('Enter').catch(() => {}); }
      }
      await page.waitForTimeout(400);
      const after = await page.evaluate((sufPN) => {
        const hdr = {}; document.querySelectorAll('.slick-header-column').forEach(h => { const t = (h.innerText || '').trim(); if (t) hdr[h.id] = t; });
        const row = [...document.querySelectorAll('.slick-row')].find(r => r.querySelector('.slick-cell[aria-describedby$="' + sufPN + '"]'));
        const get = (lbl) => { let v = ''; row && row.querySelectorAll('.slick-cell').forEach(c => { if (hdr[c.getAttribute('aria-describedby')] === lbl) v = (c.innerText || '').trim(); }); return v; };
        return { mfg: get('Mfg Date'), batch: get('Batch No'), exp: get('Exp Date') };
      }, suffixMap['Product Name'] || 'ProductName').catch(() => ({}));
      console.log(`  batch[${i + 1}] inline -> mfg="${after.mfg}" batch="${after.batch}" exp="${after.exp}"`);
      if (!after.mfg && !after.batch) problems.push(`batch[${i + 1}] "${it.name}": could not set batch (no popup, inline failed)`);
      continue;
    }

    // Batch popup. The top form has #MfgDate #ExpiryDate #QTY. For "Save & Add"
    // to allocate the FULL amount (not 0), all three must be set. We set them by
    // typing (most reliable), log the values, then Save & Add + Save.
    const footerText = async () => (((await dlg.getByText(/Added[:\s].*of/i).first().innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim());
    const mfgDmy = (it.batch && it.batch.mfgDate) || '';
    const popupDay = dayOf(mfgDmy) || mfgDay || todayDay;
    const parts = String(mfgDmy).split('/');
    const expDmy = (parts.length === 3) ? `${parts[0]}/${parts[1]}/${parseInt(parts[2], 10) + 1}` : '';

    if (i === 0) {
      const dd = await dlg.evaluate((el) => ({
        inputs: [...el.querySelectorAll('input')].map((x) => '#' + (x.id || '-') + (x.readOnly ? '(ro)' : '')).slice(0, 12),
        btns: [...el.querySelectorAll('button, a')].map((b) => (b.innerText || b.title || '').trim()).filter(Boolean).slice(0, 16),
      })).catch(() => ({}));
      console.log(`  [batch-diag] inputs=${JSON.stringify(dd.inputs)} btns=${JSON.stringify(dd.btns)}`);
    }

    const typeInto = async (sel, val) => {
      const f = dlg.locator(sel).first();
      if (!(await f.isVisible().catch(() => false))) return '';
      if (await f.getAttribute('readonly').catch(() => null)) return '(readonly)';
      await f.click().catch(() => {}); await f.fill('').catch(() => {});
      await f.pressSequentially(String(val), { delay: 20 }).catch(async () => { await f.fill(String(val)).catch(() => {}); });
      await f.press('Tab').catch(() => {});
      await page.waitForTimeout(200);
      return (await f.inputValue().catch(() => '')) || '';
    };
    const mfgVal = mfgDmy ? await typeInto('#MfgDate, input[id*="Mfg" i]', mfgDmy) : '';
    // If typing the Mfg date didn't take, use the calendar day.
    if (mfgDmy && !/\d/.test(mfgVal)) {
      await dlg.locator('.ng-star-inserted > div > .List__button, app-pactextradatepicker .List__button').first().click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(400);
      await page.getByText(popupDay, { exact: true }).first().click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(300);
    }
    const expVal = expDmy ? await typeInto('#ExpiryDate, input[id*="Expiry" i]', expDmy) : '';
    const qtyVal = await typeInto('#QTY, input[id*="QTY" i], input[id*="Qty" i]', qty);
    console.log(`  batch[${i + 1}] popup set -> mfg="${mfgVal}" exp="${expVal}" qty="${qtyVal}"`);

    // Save & Add -> add + allocate the batch.
    await dlg.getByText('Save & Add', { exact: false }).first().click({ timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(1300);
    console.log(`  batch[${i + 1}] after Save&Add: "${await footerText()}"`);

    // CASE 2 (duplicate batch): if Save & Add didn't allocate (footer still 0) or
    // PACT shows a "duplicate" error, then a batch already exists — pick the LAST
    // batch code from the grid dropdown, set the Qty (L1), and Save & Add again.
    const parseAdded = (t) => { const m = (t || '').match(/([\d.]+)\s*of\s*([\d.]+)/); return m ? { added: parseFloat(m[1]), total: parseFloat(m[2]) } : null; };
    const pageText = async () => (await page.evaluate(() => document.body.innerText || '').catch(() => ''));
    let pf = parseAdded(await footerText());
    const dup = /duplicate|already\s*exist/i.test(await pageText());
    if (dup || !pf || pf.added + 0.001 < pf.total) {
      console.log(`  batch[${i + 1}] CASE-2 (duplicate=${dup}) -> select existing batch`);
      // dismiss any error popup/toast first
      await page.getByRole('button', { name: /^\s*(OK|Ok|Close|Yes)\s*$/ }).first().click({ timeout: 2000 }).catch(() => {});
      await page.locator('.swal2-confirm, .toast-close-button, .close').first().click({ timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(400);
      // click the Batch Number cell -> its dropdown -> select the LAST batch.
      await dlg.getByRole('gridcell', { description: 'Batch Number', exact: true }).first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500);
      let bcombo = dlg.locator('.slick-cell select, .slick-cell .input_cntrl').first();
      if (!(await bcombo.count().catch(() => 0))) bcombo = dlg.locator('select').last();
      const nopt = await bcombo.locator('option').count().catch(() => 0);
      let pickedTxt = '';
      if (nopt > 1) {
        pickedTxt = ((await bcombo.locator('option').nth(nopt - 1).innerText().catch(() => '')) || '').trim();
        await bcombo.selectOption({ index: nopt - 1 }).catch(() => {});
        await page.waitForTimeout(500);
        console.log(`  batch[${i + 1}] picked last batch "${pickedTxt}" (of ${nopt})`);
      } else {
        console.log(`  batch[${i + 1}] batch dropdown had ${nopt} option(s)`);
      }
      // commit the batch selection by clicking another cell (recording clicks Expiry).
      await dlg.getByRole('gridcell', { description: 'Expiry Date', exact: true }).first().click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(300);
      // set the Quantity (L1) on the batch row — dbl-click to open the editor.
      const qCell = dlg.getByRole('gridcell', { description: 'Quantity', exact: true }).first();
      await qCell.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(200);
      await qCell.dblclick({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(300);
      const bqed = dlg.locator('input.PactTextBoxEditor, .slick-cell.editable input, .slick-cell input').first();
      await bqed.fill('').catch(() => {}); await bqed.fill(String(qty)).catch(() => {}); await bqed.press('Enter').catch(() => {});
      await page.waitForTimeout(500);
      console.log(`  batch[${i + 1}] after CASE-2 set qty: "${await footerText()}"`);
    }

    // Save the popup (button labelled " Save").
    await dlg.getByRole('button', { name: /^\s*Save\s*$/ }).last().click({ timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(1300);

    // Ensure closed before next item.
    if ((await page.locator('modal-container.show').count().catch(() => 0)) > 0) {
      const ff = await footerText();
      await dlg.getByRole('button', { name: /^\s*Save\s*$/ }).last().click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(800);
      if ((await page.locator('modal-container.show').count().catch(() => 0)) > 0) {
        await dlg.getByRole('button', { name: /Close|Cancel/i }).first().click({ timeout: 3000 }).catch(() => {});
        await page.keyboard.press('Escape').catch(() => {});
        problems.push(`batch[${i + 1}] "${it.name}": batch would not save (${ff || 'no footer'})`);
      }
    }
    console.log(`  batch[${i + 1}] done (modalsOpen=${await page.locator('modal-container.show').count().catch(() => 0)})`);
  }

  if (dryRun) {
    await page.screenshot({ path: path.join('/tmp', 'stockinward-filled.png'), fullPage: true }).catch(() => {});
    console.log('  [DRY RUN] Stock Inward filled. Screenshot saved. Stopping before Post.');
    return { posted: false };
  }

  // 5. Post. The first Post may raise a validation asking for a date on the
  //    "Extra Fields" tab; set it (same day) and Post again — exactly as recorded.
  await page.screenshot({ path: path.join('/tmp', 'stockinward-before-post.png'), fullPage: true }).catch(() => {});
  page.once('dialog', (d) => d.accept().catch(() => {}));

  const clickPost = async () => {
    const btn = page.getByRole('button', { name: /^\s*Post\s*$/ }).filter({ hasText: /Post/ }).first();
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click({ timeout: 8000 }).catch(async () => {
      await page.locator('button[title="Post"]:visible').first().click({ timeout: 6000 }).catch(() => {});
    });
  };

  await clickPost();
  await page.waitForTimeout(1600);

  // Extra Fields date (if the tab / picker is present).
  const extraTab = page.getByRole('tab', { name: 'Extra Fields' });
  if (await extraTab.isVisible().catch(() => false)) {
    await extraTab.click().catch(() => {});
    await page.waitForTimeout(700);
    const exDay = dayOf(bill.items[0] && bill.items[0].batch && bill.items[0].batch.mfgDate);
    const dp = page.locator('.tab-pane.active app-pactextradatepicker .List__button').first();
    if (await dp.isVisible().catch(() => false) && exDay) {
      await dp.click().catch(() => {});
      await page.waitForTimeout(500);
      await page.getByText(exDay, { exact: true }).first().click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(400);
    }
    await clickPost();
    await page.waitForTimeout(1600);
  }

  await page.screenshot({ path: path.join('/tmp', 'stockinward-after-post.png'), fullPage: true }).catch(() => {});

  // Verify the voucher actually posted: PACT shows a green "Posted" status badge
  // next to the title once it commits. Also treat a lingering validation/error
  // toast or an open modal as "not posted".
  await page.waitForTimeout(800);
  const posted = await page.evaluate(() => {
    const txt = (document.body.innerText || '');
    const hasBadge = /\bPosted\b/i.test(txt);
    const modalOpen = !!document.querySelector('modal-container.show');
    const errToast = Array.from(document.querySelectorAll('.toast-error, .toast-message, .alert-danger, .swal2-html-container'))
      .some((e) => (e.innerText || '').trim().length > 0);
    return { hasBadge, modalOpen, errToast };
  }).catch(() => ({ hasBadge: false, modalOpen: true, errToast: false }));

  let ok = posted.hasBadge && !posted.modalOpen;
  const reasons = [];
  if (problems.length) reasons.push(problems.join('; '));
  if (!posted.hasBadge) reasons.push('no "Posted" status shown after Post');
  if (posted.modalOpen) reasons.push('a dialog was still open after Post');
  if (posted.errToast) reasons.push('an error message was visible after Post');
  // If any item failed to allocate, the whole voucher is not trustworthy.
  if (problems.length) ok = false;

  console.log(`  Stock Inward post result: posted=${ok} (badge=${posted.hasBadge} modal=${posted.modalOpen} err=${posted.errToast})`);
  return { posted: ok, reason: reasons.join(' | ') };
}

module.exports = { createStockInward };
