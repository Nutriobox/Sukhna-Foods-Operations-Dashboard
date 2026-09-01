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
  const vp = page.locator('modal-container.show').first();
  if (await vp.isVisible().catch(() => false)) {
    await vp.locator('.List__button').first().click().catch(() => {});
    await page.waitForTimeout(700);
    await page.getByText(order.company || 'Factory', { exact: true }).first().click({ timeout: 8000 }).catch(() => {});
    await vp.getByRole('button', { name: 'Ok' }).click({ timeout: 6000 }).catch(() => {});
    await vp.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
  }
  await page.waitForTimeout(1500);

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

  // 4. Stop before Post unless explicitly told to post (safe by default).
  if (dryRun) {
    await page.screenshot({ path: path.join(__dirname, '..', 'fsi-filled.png'), fullPage: true }).catch(() => {});
    console.log(`  [DRY RUN] Filled ${entered}/${barcodes.length} items. Screenshot fsi-filled.png. Stopping before Post.`);
    return { posted: false, entered, skipped, total: barcodes.length };
  }

  await page.screenshot({ path: path.join(__dirname, '..', 'fsi-before-post.png'), fullPage: true }).catch(() => {});
  page.once('dialog', (d) => d.accept().catch(() => {}));
  await page.locator('button[title="Post"]').first().click({ timeout: 10000 });
  await page.waitForTimeout(3000);
  await page.locator('button[title="Post"]').first().click({ timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(__dirname, '..', 'fsi-after-post.png'), fullPage: true }).catch(() => {});
  console.log('  Factory Sales Invoice post attempted.');
  return { posted: true, entered, skipped, total: barcodes.length };
}

module.exports = { createFactorySalesInvoice };
