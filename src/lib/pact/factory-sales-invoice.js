// Creates a Factory Sales Invoice in PACT from a list of scanned barcodes.
// Server-side (headless Chromium on GitHub Actions), modeled on stock-inward.js.
//
// The device scans + verifies against inventory; this worker logs in, opens the
// invoice, selects the SO, feeds each barcode into PACT's Scan field (id "SKU"),
// and (unless dryRun) posts. No PC, no phone WebView.
//
// FSI_DIAG=1 opens the invoice + selects the SO, then dumps the form so the
// SO-No / grid selectors can be confirmed from the real page, then stops.
//
// order: { soNumber, company?, barcodes: [ "FG0298_F2B057/25082601_5760", ... ] }

const path = require('path');
const fs = require('fs');

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

async function createFactorySalesInvoice(page, order, { dryRun = true } = {}) {
  const DIAG = String(process.env.FSI_DIAG || '') === '1';
  const soNumber = String(order.soNumber || order.so || '').trim();
  const barcodes = order.barcodes || order.labels || [];

  // 1. Open Factory Sales Invoice (tile, or the "Search By Page" box).
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

  // 1b. Voucher Prefix / Location popup (same component as Stock Inward).
  const vp = page.locator('modal-container.show').first();
  if (await vp.isVisible().catch(() => false)) {
    await vp.locator('.List__button').first().click().catch(() => {});
    await page.waitForTimeout(700);
    await page.getByText(order.company || 'Factory', { exact: true }).first().click({ timeout: 8000 }).catch(() => {});
    await vp.getByRole('button', { name: 'Ok' }).click({ timeout: 6000 }).catch(() => {});
    await vp.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
  }
  await page.waitForTimeout(1500);

  // 2. Select the SO No (pulls customer + pending lines). Best-effort; confirm
  //    the selector from the FSI_DIAG dump on the first real run.
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
      console.log('  SO select (best-effort) failed:', String(e.message).split('\n')[0], '- run once with FSI_DIAG=1 to wire it.');
    }
    await page.waitForTimeout(1500);
  }

  if (DIAG) {
    try {
      const html = await page.content();
      fs.writeFileSync(path.join('/tmp', 'fsi-form.html'), html);
      console.log('  [diag] wrote /tmp/fsi-form.html (' + html.length + ' bytes)');
    } catch (e) { console.log('  [diag] dump failed:', String(e.message).split('\n')[0]); }
    await page.screenshot({ path: path.join('/tmp', 'fsi-diag.png'), fullPage: true }).catch(() => {});
    return { posted: false, diag: true };
  }

  // 3. Feed each barcode into the Scan field (#SKU) + Enter — real key events.
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
      // if a batch-allocation dialog opened, note it (needs handling) and close it
      const dlg = page.locator('modal-container.show').first();
      if (await dlg.isVisible().catch(() => false)) {
        console.log('  needs batch allocation (dialog opened): ' + bc);
        await dlg.getByRole('button', { name: 'Close', exact: false }).first().click({ timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(800);
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

  // 4. Stop before Post unless told to post (safe default).
  if (dryRun) {
    await page.screenshot({ path: path.join('/tmp', 'fsi-filled.png'), fullPage: true }).catch(() => {});
    console.log('  [DRY RUN] Filled ' + entered + '/' + barcodes.length + '. Stopping before Post.');
    return { posted: false, entered, skipped, total: barcodes.length };
  }

  await page.screenshot({ path: path.join('/tmp', 'fsi-before-post.png'), fullPage: true }).catch(() => {});
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
    reason = warn.slice(0, 180);
    console.log('  Post attempt ' + attempt + ' blocked: ' + (warn || 'still Draft'));
    const stMatch = warn.match(/Sale ?Type\s*\(([^)]+)\)/i);
    if (stMatch) { await setGstSaleType(page, stMatch[1].trim()); await refetchVoucherNo(page, order.company); await page.waitForTimeout(2000); }
    else if (/voucher\s*no/i.test(warn)) { await refetchVoucherNo(page, order.company); }
    else { await page.waitForTimeout(2500); }  // no named warning yet: fields may still be settling — retry Post
  }
  await page.screenshot({ path: path.join('/tmp', 'fsi-after-post.png'), fullPage: true }).catch(() => {});
  const bodyTxt = posted ? ((await page.locator('body').innerText().catch(() => '')) || '') : '';
  const docMatch = bodyTxt.match(/FSIV[-A-Z0-9\/]*\d+|[A-Z]{1,3}\/\d{2}-\d{2}\/\s*\d+/);
  const docNo = docMatch ? docMatch[0].replace(/\s+/g, '') : '';
  if (posted) console.log('  Post CONFIRMED docNo=' + (docNo || '?'));
  else console.log('  Post NOT confirmed. PACT says: ' + (reason || '(still Draft)'));
  return { posted, docNo, reason: posted ? '' : (reason || 'still Draft'), entered, skipped, total: barcodes.length };
}

module.exports = { createFactorySalesInvoice };
