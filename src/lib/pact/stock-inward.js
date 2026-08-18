// Creates a Stock Inward in PACT. Rebuilt to mirror the user's Playwright
// recording (pact-recording.js) of the CURRENT PACT screen:
//   - No "Link GGE" step (removed from PACT).
//   - Product is entered manually into the grid.
//   - Qty typed into the row -> Enter, Enter opens the "Generate Batch Numbers"
//     box -> set Manufactured date -> Save & Add -> pick the created batch ->
//     set its quantity -> Save -> Post (+ Extra Fields date if PACT asks).

const path = require('path');
const { pickVendorSuggestion } = require('./gge');

// "18/08/2026" -> "18"  (day-of-month, no leading zero) for the calendar picker.
const dayOf = (dmy) => { const m = /^(\d{1,2})/.exec(String(dmy || '')); return m ? String(parseInt(m[1], 10)) : ''; };

async function createStockInward(page, bill, { dryRun = true } = {}) {
  const tab = page.getByRole('tabpanel').filter({ hasText: 'Stock Inward' });

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

  // 4. Add each product row, then create/allocate its batch.
  for (let i = 0; i < bill.items.length; i++) {
    const it = bill.items[i];
    const search = String(it.search || it.name || '').trim();
    const qty = it.qty;
    const unitLevel = it.unitLevel || 'L1';
    const mfgDay = dayOf(it.batch && it.batch.mfgDate);
    console.log(`  item[${i + 1}] "${search}" qty=${qty} level=${unitLevel} mfgDay=${mfgDay || '(none)'}`);

    // 4a. Product Name cell -> type a few chars -> Enter to pick the first match.
    await page.getByRole('gridcell', { description: 'Product Name', exact: true }).nth(i)
      .click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(400);
    const pinput = page.locator('[id="10"]').first();
    await pinput.fill(search.slice(0, 8)).catch(async () => { await page.keyboard.type(search.slice(0, 8)).catch(() => {}); });
    await page.waitForTimeout(700);
    await pinput.press('Enter').catch(() => {});
    await page.waitForTimeout(800);

    // 4b. Purchase Unit Level dropdown -> select (L1).
    const lvlSel = page.locator('.slick-cell > .input_cntrl').first();
    await lvlSel.selectOption(unitLevel).catch(() => {});
    await lvlSel.press('Enter').catch(() => {});
    await page.waitForTimeout(500);

    // 4c. Quantity -> type it, then Enter, Enter -> opens the batch box.
    const qed = page.locator('.PactTextBoxEditor, .slick-cell.editable input, input.editor-text').first();
    await qed.fill(String(qty)).catch(async () => { await page.keyboard.type(String(qty)).catch(() => {}); });
    await qed.press('Enter').catch(() => {});
    await page.waitForTimeout(400);
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(1100);

    // 4d. "Generate Batch Numbers" dialog.
    const dlg = page.locator('modal-container.show').last();
    if (!(await dlg.isVisible().catch(() => false))) {
      console.log(`  batch[${i + 1}]: dialog did NOT open`);
      continue;
    }

    // Set the Manufactured date. Try typing DMY into the picker input first;
    // otherwise open the calendar and click the day (recording's method).
    const mfgDmy = (it.batch && it.batch.mfgDate) || '';
    let dateSet = false;
    if (mfgDmy) {
      const dinput = dlg.locator('app-pactextradatepicker input, input#MfgDate, input[id*="Mfg" i]').first();
      if (await dinput.isVisible().catch(() => false) && !(await dinput.getAttribute('readonly').catch(() => null))) {
        await dinput.fill('').catch(() => {});
        await dinput.pressSequentially(mfgDmy, { delay: 25 }).catch(() => {});
        await page.waitForTimeout(300);
        dateSet = true;
      }
      if (!dateSet && mfgDay) {
        await dlg.locator('app-pactextradatepicker .List__button').first().click({ timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(500);
        await dlg.getByText(mfgDay, { exact: true }).first().click({ timeout: 4000 })
          .catch(async () => { await page.getByText(mfgDay, { exact: true }).first().click({ timeout: 4000 }).catch(() => {}); });
        await page.waitForTimeout(400);
        dateSet = true;
      }
    }
    console.log(`  batch[${i + 1}] manufactured date set=${dateSet} (${mfgDmy || 'n/a'})`);

    // Save & Add -> creates the batch line.
    await dlg.getByText('Save & Add', { exact: false }).first().click({ timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(1000);

    // Pick the created batch number (last option in the grid dropdown).
    await dlg.getByRole('gridcell', { description: 'Batch Number', exact: true }).first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
    const bsel = dlg.locator('.slick-cell > .input_cntrl, .slick-cell select').first();
    const nOpt = await bsel.locator('option').count().catch(() => 0);
    if (nOpt > 1) {
      await bsel.selectOption({ index: nOpt - 1 }).catch(() => {});
      console.log(`  batch[${i + 1}] picked batch option ${nOpt - 1} of ${nOpt}`);
    } else {
      console.log(`  batch[${i + 1}] batch dropdown had ${nOpt} option(s)`);
    }
    await page.waitForTimeout(400);

    // Set the batch Quantity.
    await dlg.getByRole('gridcell', { description: 'Quantity', exact: true }).first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
    const bqed = dlg.locator('.PactTextBoxEditor, .slick-cell input, input.editor-text').first();
    await bqed.fill(String(qty)).catch(() => {});
    await bqed.press('Enter').catch(() => {});
    await page.waitForTimeout(400);

    // Save & close the batch dialog (the "Save" button, not "Save & Add").
    await dlg.getByRole('button', { name: /^\s*Save\s*$/ }).last().click({ timeout: 6000 }).catch(() => {});
    await dlg.waitFor({ state: 'hidden', timeout: 8000 }).catch(() => console.log(`  batch[${i + 1}] dialog did not close after Save`));
    await page.waitForTimeout(600);
    console.log(`  batch[${i + 1}] done`);
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
  console.log('  Stock Inward post attempted.');
  return { posted: true };
}

module.exports = { createStockInward };
