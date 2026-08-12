// Creates a Stock Inward in PACT that LINKS to the already-posted Goods Gate Entry.
// Built from stockinward-recording.ts. Incremental: this pass opens Stock Inward,
// sets vendor + bill, and pulls the GGE items via the Link tab, then (dry-run)
// screenshots and stops before the per-item qty/batch/Post.

const path = require('path');

async function createStockInward(page, bill, { dryRun = true } = {}) {
  // 1. Open Stock Inward (via the Flows menu if the link isn't showing)
  const link = page.getByRole('link', { name: 'Stock Inward', exact: true }).first();
  if (!(await link.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Flows' }).click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  await link.click({ timeout: 20000 });
  await page.waitForTimeout(2000);

  // 1b. Voucher Prefix / Location popup (same as GGE), if it appears
  const vp = page.locator('modal-container.show').first();
  if (await vp.isVisible().catch(() => false)) {
    await vp.locator('.List__button').first().click().catch(() => {});
    await page.waitForTimeout(700);
    await page.getByText(bill.company || 'Factory', { exact: true }).first().click({ timeout: 8000 }).catch(() => {});
    await vp.getByRole('button', { name: 'Ok' }).click({ timeout: 5000 }).catch(() => {});
    await vp.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
  }
  await page.waitForTimeout(1200);

  // 2. Vendor
  const tab = page.getByRole('tabpanel').filter({ hasText: 'Stock Inward' });
  await tab.locator('[id="100"]').first().click();
  await tab.locator('[id="100"]').first().fill(bill.vendorSearch || bill.vendor.slice(0, 4));
  await page.getByText(bill.vendor, { exact: false }).first().click({ timeout: 8000 });
  await page.waitForTimeout(800);

  // 3. Bill number
  await tab.locator('#BillNo').first().fill(String(bill.billNo));
  await tab.locator('#BillNo').first().press('Enter').catch(() => {});
  await page.waitForTimeout(800);

  // 4. Link -> tick the GGE in the Pending List (pulls its items in).
  //    The checkbox id (lchk1_0) shifts each session, so target the app-check-list checkbox.
  await page.getByRole('tab', { name: 'Link' }).click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const ggeCheckbox = page.locator('app-check-list input[type="checkbox"]').first();
  await ggeCheckbox.check({ timeout: 8000 })
    .catch((e) => console.log('  link checkbox failed:', String(e.message).split('\n')[0]));
  await page.waitForTimeout(2000);
  // A "Link Info" dialog opens listing the GGE's items -> Select All -> Ok
  await page.getByText('Select All', { exact: true }).click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // 5. Approve Qty — fill down the grid column (one value per linked row)
  await page.getByRole('gridcell', { description: 'Approve Qty', exact: true }).first().click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(600);
  for (let i = 0; i < bill.items.length; i++) {
    const aq = bill.items[i].approveQty ?? bill.items[i].qty;
    await page.locator('.PactTextBoxEditor').fill(String(aq)).catch(() => {});
    const key = i < bill.items.length - 1 ? 'ArrowDown' : 'Enter';
    await page.locator('.PactTextBoxEditor').press(key).catch(() => {});
    await page.waitForTimeout(350);
  }

  // 6. Per-item: base Quantity + Batch (latest) for each linked row
  for (let i = 0; i < bill.items.length; i++) {
    const it = bill.items[i];
    // base quantity (pieces)
    const qCell = page.getByRole('gridcell', { description: 'Quantity', exact: true }).nth(i);
    if (await qCell.isVisible().catch(() => false)) {
      await qCell.click().catch(() => {});
      await page.locator('.PactTextBoxEditor').fill(String(it.baseQty ?? it.qty)).catch(() => {});
      await page.locator('.PactTextBoxEditor').press('Enter').catch(() => {});
      await page.waitForTimeout(400);
    }
    // batch: pick the latest (first real option) from the batch dropdown
    const bCell = page.getByRole('gridcell', { description: 'Batch Number', exact: true }).nth(i);
    if (await bCell.isVisible().catch(() => false)) {
      await bCell.click().catch(() => {});
      await page.locator('.slick-cell .input_cntrl').first().selectOption({ index: 1 }).catch(() => {});
      await page.waitForTimeout(400);
    }
  }

  if (dryRun) {
    await page.screenshot({ path: path.join(__dirname, '..', 'stockinward-filled.png'), fullPage: true }).catch(() => {});
    console.log('  [DRY RUN] Stock Inward — linked + Approve Qty + base Quantity + Batch done. Screenshot saved. Stopping before Post.');
    return { posted: false };
  }

  // 7. Post the Stock Inward (only when DRY_RUN=false)
  await page.getByRole('button', { name: 'Post', exact: false }).first().click({ timeout: 10000 });
  await page.waitForTimeout(2000);
  // confirm any dialog
  page.once('dialog', (d) => d.accept().catch(() => {}));
  await page.getByRole('button', { name: 'Post', exact: false }).first().click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(3000);
  console.log('  Stock Inward posted.');
  return { posted: true };
}

module.exports = { createStockInward };
