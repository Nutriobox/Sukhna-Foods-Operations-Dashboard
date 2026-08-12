// Creates a Goods Gate Entry (GGE) in PACT from a bill.
// Built from inward-recording.ts. First pass — expect to refine selectors after
// a dry-run test. DRY_RUN stops right before Post so nothing is committed.
//
// PACT is an Angular app; grid cells expose stable role selectors
// (getByRole('gridcell', { description: '...' })), which we prefer over CSS chains.

const path = require('path');

const DEFAULT_COMPANY = 'Factory';

async function createGoodsGateEntry(page, bill, { dryRun = true } = {}) {
  // 1. Open the Goods Gate Entry screen (open the Flows menu first if the link isn't showing)
  const ggeLink = page.getByRole('link', { name: 'Goods Gate Entry', exact: true }).first();
  if (!(await ggeLink.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Flows' }).click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  await ggeLink.click({ timeout: 20000 });
  await page.waitForTimeout(1500);

  // 2. "Voucher Prefix" popup -> pick the Location, click Ok
  const location = bill.company || DEFAULT_COMPANY; // e.g. "Factory"
  const vp = page.locator('modal-container.show').first();
  await vp.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  if (await vp.isVisible().catch(() => false)) {
    await vp.locator('.List__button').first().click().catch(() => {}); // open the Location dropdown
    await page.waitForTimeout(700);
    await vp.locator('#Name').click().catch(() => {});
    await page.getByText(location, { exact: true }).first().click({ timeout: 8000 });
    await vp.getByRole('button', { name: 'Ok' }).click({ timeout: 5000 });
    await vp.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
  }
  await page.waitForTimeout(1500);

  // 3. Vendor (type-ahead search box id=100, then click the matching name)
  const vendorField = page.locator('[id="100"]').first();
  await vendorField.click();
  await vendorField.fill(bill.vendorSearch || bill.vendor.slice(0, 4));
  await page.getByText(bill.vendor, { exact: false }).first().click({ timeout: 8000 });

  // 4. Bill number
  await page.locator('#BillNo').first().fill(String(bill.billNo));
  await page.locator('#BillNo').first().press('Enter').catch(() => {});
  await page.waitForTimeout(500);

  // 5. Line items — one grid row each
  for (let i = 0; i < bill.items.length; i++) {
    const it = bill.items[i];
    // product name
    await page.getByRole('gridcell', { description: 'Product Name', exact: true }).nth(i).click();
    await page.locator('[id="10"]').fill(it.search || it.name);
    await page.getByText(it.name, { exact: false }).first().click({ timeout: 8000 });
    await page.locator('#revwebbody').press('Enter').catch(() => {});
    await page.waitForTimeout(400);

    // purchase unit level (L1/L2/L3) -> a <select> appears inside the clicked cell
    if (it.unitLevel) {
      await page.getByRole('gridcell', { description: 'Purchase Unit Level', exact: true }).nth(i).click();
      await page.waitForTimeout(500);
      await page.getByRole('combobox').last()
        .selectOption(it.unitLevel)
        .catch((e) => console.log(`    [item ${i+1}] unit-level select failed: ${String(e.message).split('\n')[0]}`));
      await page.waitForTimeout(400);
    }

    // quantity -> the Purchase Qty column cell
    await page.getByRole('gridcell', { description: 'Purchase Qty', exact: true }).nth(i).click();
    await page.waitForTimeout(400);
    await page.locator('.PactTextBoxEditor').fill(String(it.qty)).catch((e) => console.log(`    [item ${i+1}] qty fill failed: ${String(e.message).split('\n')[0]}`));
    await page.locator('.PactTextBoxEditor').press('Enter').catch(() => {});
    await page.waitForTimeout(500);
  }

  if (dryRun) {
    await page.screenshot({ path: path.join(__dirname, '..', 'gge-filled.png'), fullPage: true }).catch(() => {});
    console.log('  [DRY RUN] GGE filled — screenshot saved as gge-filled.png. Stopping before Post.');
    return { posted: false };
  }
  await page.getByRole('button', { name: ' Post' }).click();
  await page.waitForTimeout(1500);
  console.log('  GGE posted.');
  return { posted: true };
}

module.exports = { createGoodsGateEntry };
