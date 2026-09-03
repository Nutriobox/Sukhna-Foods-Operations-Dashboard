// Creates a Factory Sales Invoice in PACT from a list of scanned barcodes.
// Modeled on stock-inward.js — the device scans + verifies against inventory,
// this SERVER-SIDE worker logs in, opens the invoice, selects the SO, feeds
// each barcode into PACT's Scan field (input id "SKU"), and (unless DRY_RUN)
// posts. No PC, no phone WebView — runs headless on the server / GitHub Actions.
//
// DIAG mode: FSI_DIAG=1 opens the invoice, selects the SO, dumps the form HTML
// (fsi-form.html) and stops — so the SO-No / grid selectors can be wired
// precisely from the real page, exactly like SI_DIAG did for Stock Inward.
//
// Input `order`: { soNumber, company?, barcodes: [ "FG0298_F2B057/25082601_5760", ... ] }

const path = require('path');
const fs = require('fs');

async function dumpOuter(page, name, locator) {
  try {
    const h = await locator.first().evaluate((el) => el.outerHTML);
    fs.writeFileSync(path.join(__dirname, '..', name), h);
    console.log('  [diag] wrote', name, '(' + h.length + ' bytes)');
    return true;
  } catch (e) {
    console.log('  [diag] dump ' + name + ' failed:', String(e.message).split('\n')[0]);
    return false;
  }
}

async function setGstSaleType(page, value) {
  // Reveal the GST tab, then set the Sale Type (input id="dcCCNID64").
  const tabs = page.getByText('GST', { exact: true });
  const n = await tabs.count().catch(() => 0);
  for (let i = 0; i < n; i++) { await tabs.nth(i).click({ timeout: 2500 }).catch(() => {}); await page.waitForTimeout(400); if (await page.locator('#dcCCNID64').first().isVisible().catch(() => false)) break; }
  const st = page.locator('#dcCCNID64').first();
  await st.click({ timeout: 4000 }).catch(() => {});
  await st.fill('').catch(() => {});
  await st.fill(value).catch(() => {});
  await page.waitForTimeout(1200);
  const opt = page.locator('.suggestions__list-name', { hasText: value }).filter({ visible: true }).first();
  if (await opt.count().catch(() => 0)) await opt.click({ timeout: 4000 }).catch(() => {});
  else await st.press('Enter').catch(() => {});
  await page.waitForTimeout(1000);
  console.log('  set GST Sale Type = ' + value);
}

// The voucher number lives in #TxtVoucherNo inside PACT's <app-voucher-no>
// (a prefix <select>, the number <input id="TxtVoucherNo">, and prev/next
// buttons). Returns the current number, "" when blank, "__noel__" when absent.
async function readVoucher(page) {
  return await page.evaluate(() => {
    const vc = document.querySelector('app-voucher-no'); if (!vc) return { num: '', prefix: '', found: false };
    const labels = [...vc.querySelectorAll('label')].map(l => (l.textContent || '').trim()).filter(Boolean);
    const num = labels.find(t => /^\d+$/.test(t)) || '';
    const prefix = labels.find(t => /\/$/.test(t)) || '';
    const inp = vc.querySelector('input'); const ival = inp ? String(inp.value || '').trim() : '';
    return { num: num || ival, prefix, found: true };
  }).catch(() => ({ num: '', prefix: '', found: false }));
}

// The Doc No number is a read-only <label> in <app-voucher-no> (e.g. "724") that
// PACT keeps populated on its own. Only if PACT actually reports it blank do we
// click the magnifier to (re)assign the series number and confirm a picker modal.
async function refetchVoucherNo(page, company) {
  for (let t = 0; t < 3; t++) {
    const v = await readVoucher(page);
    if (v.num && /\d/.test(v.num)) { console.log('  Voucher No = ' + v.num); return true; }
    await page.evaluate(() => {
      const vc = document.querySelector('app-voucher-no'); if (!vc) return;
      const sp = [...vc.querySelectorAll('span.secondary-btn')].find(s => s.querySelector('i.fa-search'));
      if (sp) sp.click(); else { const ic = vc.querySelector('i.fa-search'); if (ic) (ic.closest('span,button,a') || ic).click(); }
    }).catch(() => {});
    await page.waitForTimeout(2000);
    const m = page.locator('modal-container.show').first();
    if (await m.isVisible().catch(() => false)) {
      await m.locator('.List__button').first().click().catch(() => {});
      await page.waitForTimeout(500);
      await page.getByText(company || 'Factory', { exact: true }).first().click({ timeout: 5000 }).catch(() => {});
      await m.getByRole('button', { name: 'Ok' }).click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }
  }
  const fin = await readVoucher(page);
  console.log('  Voucher No after refetch -> ' + (fin.num || '(blank)'));
  return !!(fin.num && /\d/.test(fin.num));
}

// The "Scan Batch" dialog is a SlickGrid. Each row is one available lot; the
// Quantity column must be filled with how much of THIS scan to draw from that lot
// BEFORE Save. Clicking Save with an empty Quantity allocates nothing, so the line
// stays unallocated and the invoice can never leave Draft (root cause of the
// "entered=N/N but still Draft" failures). We read the headers to find the
// Quantity + Batch columns, pick the lot row that matches the scanned batch (or
// the first/only lot), navigate SlickGrid's active cell there with the keyboard
// (robust to horizontal virtualization), type the scanned weight, commit, Save.
async function allocateBatch(page, dlg, bc) {
  const parts = String(bc).split('_');
  const weight = parts[parts.length - 1] || '';
  const batch = parts.slice(1, -1).join('_');   // e.g. "FN0031/01042604"

  const info = await dlg.evaluate((m) => {
    const headers = [...m.querySelectorAll('.slick-header-column')].map(h => (h.textContent || '').trim());
    const rows = [...m.querySelectorAll('.grid-canvas .slick-row')].slice(0, 8).map(r =>
      [...r.querySelectorAll('.slick-cell')].map(c => (c.textContent || '').trim()));
    const btns = [...m.querySelectorAll('button, .List__button, .primary-btn-wicon')].map(b => (b.textContent || '').trim()).filter(Boolean).slice(0, 12);
    return { headers, rows, nRows: m.querySelectorAll('.grid-canvas .slick-row').length, btns };
  }).catch(() => ({ headers: [], rows: [], nRows: 0, btns: [] }));
  console.log('    [batch grid] headers: ' + (info.headers.filter(Boolean).join(' | ') || '?'));
  console.log('    [batch grid] ' + info.nRows + ' row(s)' + (info.rows[0] ? ' e.g. ' + JSON.stringify(info.rows[0]) : '') + ' | btns: ' + info.btns.join(' / '));

  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  const qtyIdx = info.headers.findIndex(h => ['quantity', 'qty'].includes(norm(h)));
  const batchIdx = info.headers.findIndex(h => norm(h).includes('batch'));

  let rowIdx = 0;
  if (batchIdx >= 0 && batch) {
    const key = norm(batch).slice(0, 8);
    const f = info.rows.findIndex(cells => cells[batchIdx] && norm(cells[batchIdx]).includes(key));
    if (f >= 0) rowIdx = f;
  }

  let qtySet = false;
  const qtyCell = () => dlg.locator('.grid-canvas .slick-row').nth(rowIdx).locator('.slick-cell').nth(qtyIdx);
  const cellHasNum = async () => /\d/.test(((await qtyCell().textContent().catch(() => '')) || '').replace(/[^\d.]/g, ''));
  const typeIntoEditor = async () => {
    const editor = dlg.locator('.slick-cell.active input, input.editor-text, .slick-cell.editable input, .slick-cell input').filter({ visible: true }).first();
    if (await editor.count().catch(() => 0)) {
      await editor.fill('').catch(() => {});
      await editor.pressSequentially(String(weight), { delay: 15 }).catch(() => {});
    } else {
      await page.keyboard.type(String(weight), { delay: 15 }).catch(() => {});
    }
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(300);
  };
  if (qtyIdx >= 0 && weight) {
    try {
      const row = dlg.locator('.grid-canvas .slick-row').nth(rowIdx);
      await row.locator('.slick-cell').first().scrollIntoViewIfNeeded().catch(() => {});
      await row.locator('.slick-cell').first().click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(120);
      for (let c = 0; c < qtyIdx; c++) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(40); }
      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForTimeout(120);
      await typeIntoEditor();
      qtySet = await cellHasNum();
      if (!qtySet) {
        await qtyCell().dblclick({ timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(150);
        await typeIntoEditor();
        qtySet = await cellHasNum();
      }
      const now = ((await qtyCell().textContent().catch(() => '')) || '').trim();
      console.log('    [batch grid] entered qty ' + weight + ' (row ' + rowIdx + ', col ' + qtyIdx + ') -> cell now "' + now + '"' + (qtySet ? '' : '  <-- NOT set!'));
    } catch (e) {
      console.log('    [batch grid] qty entry error: ' + String(e.message).split('\n')[0]);
    }
  } else {
    console.log('    [batch grid] ! could not locate Quantity column (qtyIdx=' + qtyIdx + ') or weight (' + weight + ') — headers=' + JSON.stringify(info.headers.filter(Boolean)));
  }

  let saved = false;
  for (const nm of [/^Save ?& ?Add$/i, /^Save$/i, /^Ok$/i, /^Allocate$/i, /^Add$/i]) {
    const b = dlg.getByRole('button', { name: nm }).filter({ visible: true }).first();
    const t = dlg.getByText(nm).filter({ visible: true }).first();
    if (await b.count().catch(() => 0)) { await b.click({ timeout: 4000 }).catch(() => {}); saved = true; }
    else if (await t.count().catch(() => 0)) { await t.click({ timeout: 4000 }).catch(() => {}); saved = true; }
    if (saved) { console.log('    batch allocation saved via ' + nm.source + (qtySet ? ' (qty set)' : ' (NO QTY!)')); break; }
  }
  if (!saved) {
    const prim = dlg.locator('.primary-btn-wicon, .primary-btn, button.btn-primary').filter({ visible: true }).first();
    if (await prim.count().catch(() => 0)) { await prim.click({ timeout: 4000 }).catch(() => {}); saved = true; console.log('    batch allocation saved via primary button' + (qtySet ? ' (qty set)' : ' (NO QTY!)')); }
  }
  if (!saved) { console.log('    ! no Save button — closing'); await dlg.getByText('Close', { exact: true }).first().click({ timeout: 4000 }).catch(() => {}); }
  await page.waitForTimeout(1000);
  return qtySet;
}

async function createFactorySalesInvoice(page, order, { dryRun = true } = {}) {
  const DIAG = String(process.env.FSI_DIAG || '') === '1';
  const soNumber = String(order.soNumber || order.so || '').trim();
  const barcodes = order.barcodes || order.labels || [];

  // 1. Open Factory Sales Invoice (tile, or via the "Search By Page" box).
  // The tile is a VISIBLE <a> link on the Flows page (there are also hidden menu
  // links with the same name, so filter to visible).
  const tile = page.getByRole('link', { name: 'Factory Sales Invoice', exact: true }).filter({ visible: true }).first();
  if (await tile.count().catch(() => 0)) {
    await tile.click({ timeout: 15000 }).catch(() => {});
  } else {
    await page.getByPlaceholder('Search By Page').fill('Factory Sales Invoice').catch(() => {});
    await page.waitForTimeout(1300);
    await page.getByRole('link', { name: 'Factory Sales Invoice', exact: true }).filter({ visible: true }).first().click({ timeout: 10000 }).catch(() => {});
  }
  await page.waitForTimeout(2500);

  // 1b. Voucher Prefix / Location popup (same component as Stock Inward / GGE).
  // The popup surfaces ~3s after the screen opens (later on slow CI runners), so
  // POLL for it instead of assuming a fixed delay. Picking the "Factory" Location
  // is what makes PACT auto-assign the Doc No (AF/26-27/NNN); miss it and every
  // Post fails with "Voucher No cannot be blank". (The Doc No magnifier opens a
  // different "Select Document" picker, so it is NOT a fallback for this.)
  const vp = page.locator('modal-container.show').first();
  let vpSeen = false;
  for (let i = 0; i < 30 && !vpSeen; i++) {                 // up to ~12s
    if (await vp.isVisible().catch(() => false)) { vpSeen = true; break; }
    await page.waitForTimeout(400);
  }
  if (vpSeen) {
    await vp.locator('.List__button').first().click().catch(() => {});   // open the Location dropdown
    await page.waitForTimeout(800);
    const loc = order.location || 'Factory';
    let picked = await page.getByText('Factory', { exact: true }).first().click({ timeout: 5000 }).then(() => true).catch(() => false);
    if (!picked && loc !== 'Factory') picked = await page.getByText(loc, { exact: true }).first().click({ timeout: 5000 }).then(() => true).catch(() => false);
    if (!picked) await vp.locator('.List__name, .List__button, li, option').filter({ visible: true }).first().click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(400);
    await vp.getByRole('button', { name: 'Ok' }).click({ timeout: 6000 }).catch(() => {});
    await vp.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1200);
  } else {
    console.log('  ! Voucher Prefix popup never appeared within ~12s');
  }
  const vchk = await readVoucher(page);
  console.log('  Doc No after prefix = ' + (vchk.num ? ((vchk.prefix || '') + vchk.num) : '(blank)'));
  await page.waitForTimeout(800);

  // 2. Select the SO No. PACT pulls the customer + pending lines from it.
  //    Best-effort: type into the SO field and pick the matching option.
  //    (Selector confirmed/adjusted from the FSI_DIAG dump on first run.)
  if (soNumber) {
    const soField = page.locator('#dcCCNID23').first();
    try {
      // At the Actions viewport (1920x1080) a plain .click() on this field can
      // fail Playwright's actionability check, so focus via fill() (which still
      // triggers PACT's autocomplete) and click the real suggestion option.
      await soField.click({ timeout: 3000 }).catch(() => {});
      await soField.fill('');
      await soField.fill(soNumber);
      await page.waitForTimeout(1800);
      let soOpt = page.locator('.suggestions__list-name', { hasText: soNumber }).filter({ visible: true }).first();
      if (!(await soOpt.count().catch(() => 0))) {
        await soField.fill('');
        await soField.pressSequentially(soNumber, { delay: 25 });
        await page.waitForTimeout(1800);
        soOpt = page.locator('.suggestions__list-name', { hasText: soNumber }).filter({ visible: true }).first();
      }
      await soOpt.click({ timeout: 8000 });
      console.log('  selected SO', soNumber);
    } catch (e) {
      console.log('  SO select (best-effort) failed:', String(e.message).split('\n')[0], '- run once with FSI_DIAG=1 to wire the selector.');
    }
    await page.waitForTimeout(1500);
  }

  if (DIAG) {
    await dumpOuter(page, 'fsi-form.html',
      page.getByRole('tabpanel').filter({ hasText: 'Factory Sales Invoice' }));
    // also dump the whole main region as a fallback
    await dumpOuter(page, 'fsi-main.html', page.locator('body'));
    console.log('  [diag] DONE — read fsi-form.html to confirm the SO No field + grid selectors.');
    return { posted: false, diag: true };
  }

  // 3. Feed each scanned barcode into the Scan field (#SKU) + Enter.
  //    Playwright fires real keyboard events, so Angular's ngModel + Enter
  //    handler run exactly as if a person scanned into the box.
  // 2b. Customer Name is REQUIRED and PACT does NOT auto-fill it from the SO,
  //     so select it here (same typeahead as the SO field). Without this the
  //     Post is silently rejected and the invoice never saves.
  const customer = String(order.customer || order.vendor || '').trim();
  if (customer) {
    try {
      const cust = page.locator('[id="100"]').first();
      await cust.click({ timeout: 3000 }).catch(() => {});
      await cust.fill('');
      await cust.fill(customer);
      await page.waitForTimeout(1500);
      let copt = page.locator('.suggestions__list-name', { hasText: customer }).filter({ visible: true }).first();
      if (!(await copt.count().catch(() => 0))) {
        const short = customer.split(/\s+/).slice(0, 2).join(' ');
        await cust.fill(''); await cust.fill(short); await page.waitForTimeout(1500);
        copt = page.locator('.suggestions__list-name').filter({ visible: true }).first();
      }
      await copt.click({ timeout: 6000 });
      console.log('  selected customer: ' + customer);
    } catch (e) {
      console.log('  customer select failed: ' + String(e.message).split('\n')[0]);
    }
    await page.waitForTimeout(1000);
  } else {
    console.log('  ! no customer provided — Post will likely be rejected (Customer Name required).');
  }

  const scan = page.locator('#SKU').first();
  await scan.waitFor({ state: 'visible', timeout: 15000 })
    .catch(() => console.log('  ! Scan field (#SKU) not visible — is the SO selected?'));

  let entered = 0;
  const skipped = [];
  for (const bc of barcodes) {
    try {
      await scan.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(700);
      await scan.click({ timeout: 5000 }).catch(() => {});   // non-fatal: fill() below focuses even if click's actionability check fails at 1920x1080
      await scan.fill('');
      await scan.pressSequentially(String(bc), { delay: 8 });   // real per-key events
      await scan.press('Enter');
      // PACT clears the Scan field ONLY when it resolved the barcode and added a
      // row. If the field keeps the value, PACT rejected it (out of stock / not
      // on this SO) — record it as skipped and clear so the next scan is clean.
      let cleared = false;
      for (let t = 0; t < 14; t++) {
        await page.waitForTimeout(500);
        if ((await scan.inputValue().catch(() => '')) !== String(bc)) { cleared = true; break; }
      }
      // Batch-allocation dialog: PACT needs the scanned lot CONFIRMED, not closed.
      // Closing it leaves the line with no lot allocated, so the invoice can never
      // leave Draft. Confirm the primary button (which accepts the pre-filled lot),
      // and log the buttons so a wrong guess is diagnosable.
      const dlg = page.locator('modal-container.show').first();
      if (await dlg.isVisible().catch(() => false)) {
        console.log('  batch-allocation dialog for ' + bc);
        await allocateBatch(page, dlg, bc);
      }
      if (cleared) {
        entered++;
        console.log('  added ' + entered + ': ' + bc);
      } else {
        await scan.fill('').catch(() => {});
        skipped.push(bc);
        console.log('  SKIPPED (PACT did not resolve — not in stock / not on SO?): ' + bc);
      }
    } catch (e) {
      skipped.push(bc);
      console.log('  scan error ' + bc + ': ' + String(e.message).split('\n')[0]);
    }
  }

  // 3b. Narration: mark the invoice as auto-posted by the AI worker and record
  //     the Doc No that PACT assigned (audit trail, visible in PACT + the app).
  try {
    const vN = await readVoucher(page);
    const dn = vN.num ? ((vN.prefix || '') + vN.num) : '';
    const narr = 'Entry made by AI' + (dn ? ' - ' + dn : '');
    const nf = page.locator('#CommonNarration').first();
    await nf.click({ timeout: 4000 }).catch(() => {});
    await nf.fill(narr).catch(() => {});
    console.log('  narration = ' + narr);
  } catch (e) { console.log('  narration fill skipped: ' + String(e.message).split('\n')[0]); }

  // 4. Stop before Post unless explicitly told to post (safe by default).
  if (dryRun) {
    await page.screenshot({ path: path.join(__dirname, '..', 'fsi-filled.png'), fullPage: true }).catch(() => {});
    console.log(`  [DRY RUN] Filled ${entered}/${barcodes.length} items. Screenshot fsi-filled.png. Stopping before Post.`);
    return { posted: false, entered, skipped, total: barcodes.length };
  }

  await page.screenshot({ path: path.join(__dirname, '..', 'fsi-before-post.png'), fullPage: true }).catch(() => {});
  // ---- Post, handling PACT's document-level validations adaptively ----
  // Selecting the SO does not fill everything: PACT needs the GST Sale Type set
  // (it NAMES the value in a warning, e.g. InterStateB2B for an out-of-state
  // customer), and changing the Sale Type clears the auto Voucher No, which must
  // be re-fetched. So: click Post, read the warning, fix that field, re-fetch the
  // voucher, retry — up to a few rounds.
  let posted = false, reason = '';
  for (let attempt = 1; attempt <= 6 && !posted; attempt++) {
    page.once('dialog', (d) => d.accept().catch(() => {}));
    const postBtn = page.locator('button[title="Post"]').first();
    await postBtn.click({ timeout: 10000 }).catch(() => postBtn.click({ force: true }).catch(() => {}));
    // Poll right after Post: PACT's validation toast (e.g. "Please select Sale
    // Type(InterStateB2B)") is transient and a single delayed read misses it, so
    // setGstSaleType never runs. Watch for up to ~9s at 300ms steps, clicking the
    // confirm modal ("Do you want to Post?") if it appears, and break the moment
    // the toast shows or the Draft badge clears after confirming.
    let warn = '';
    let confirmClicked = false;
    let success = false;
    const deadline = Date.now() + 9000;
    while (Date.now() < deadline) {
      const cdlg = page.locator('modal-container.show').first();
      if (await cdlg.isVisible().catch(() => false)) {
        const cbtn = cdlg.getByRole('button', { name: /^(Ok|Yes|Post|Confirm|Save|Proceed|Continue)$/i }).filter({ visible: true }).first();
        if (await cbtn.count().catch(() => 0)) await cbtn.click({ timeout: 4000 }).catch(() => {});
        else await cdlg.locator('.List__button, button').filter({ visible: true }).first().click({ timeout: 4000 }).catch(() => {});
        confirmClicked = true;
        await page.waitForTimeout(600);
        continue;
      }
      const wt = await page.getByText(/please select|cannot be blank|is required|mandatory|not valid|invalid|please enter/i)
        .filter({ visible: true }).allInnerTexts().catch(() => []);
      const wj = wt.join(' | ').replace(/\s+/g, ' ').trim();
      if (wj) { warn = wj; break; }
      if (confirmClicked) {
        const dv = await page.getByText('Draft', { exact: true }).filter({ visible: true }).count().catch(() => 0);
        if (dv === 0) { success = true; break; }
      }
      await page.waitForTimeout(300);
    }
    const draftVisible = success ? 0 : await page.getByText('Draft', { exact: true }).filter({ visible: true }).count().catch(() => 0);
    if (draftVisible === 0 && !warn) { posted = true; break; }
    if (!warn) {
      // No known validation toast, yet still Draft — capture whatever PACT is
      // showing (rejection dialog / notification) so the failure isn't a black box.
      const extra = await page.evaluate(() => {
        const bits = [];
        document.querySelectorAll('modal-container.show, .toast, .toast-message, .alert, [class*="notification"], [class*="validation"]').forEach((e) => { const t = (e.innerText || '').replace(/\s+/g, ' ').trim(); if (t) bits.push(t); });
        return bits.join(' | ').slice(0, 240);
      }).catch(() => '');
      if (extra) warn = extra;
    }
    reason = warn.slice(0, 180);
    console.log('  Post attempt ' + attempt + ' blocked: ' + (warn || 'still Draft'));
    const stMatch = warn.match(/Sale ?Type\s*\(([^)]+)\)/i);
    if (stMatch) { await setGstSaleType(page, stMatch[1].trim()); await refetchVoucherNo(page, order.company); await page.waitForTimeout(2000); }
    else if (/voucher\s*no/i.test(warn)) { await refetchVoucherNo(page, order.company); }
    else { await page.waitForTimeout(2500); }  // no named warning yet: fields may still be settling — retry Post
  }
  await page.screenshot({ path: path.join(__dirname, '..', 'fsi-after-post.png'), fullPage: true }).catch(() => {});
  const bodyTxt = posted ? ((await page.locator('body').innerText().catch(() => '')) || '') : '';
  const docMatch = bodyTxt.match(/FSIV[-A-Z0-9\/]*\d+|[A-Z]{1,3}\/\d{2}-\d{2}\/\s*\d+/);
  const docNo = docMatch ? docMatch[0].replace(/\s+/g, '') : '';
  if (posted) console.log('  Post CONFIRMED docNo=' + (docNo || '?'));
  else console.log('  Post NOT confirmed. PACT says: ' + (reason || '(still Draft)'));
  return { posted, docNo, reason: posted ? '' : (reason || 'still Draft'), entered, skipped, total: barcodes.length };
}

module.exports = { createFactorySalesInvoice };
