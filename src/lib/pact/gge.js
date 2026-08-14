// Creates a Goods Gate Entry (GGE) in PACT from a bill.
// Built from inward-recording.ts. First pass — expect to refine selectors after
// a dry-run test. DRY_RUN stops right before Post so nothing is committed.
//
// PACT is an Angular app; grid cells expose stable role selectors
// (getByRole('gridcell', { description: '...' })), which we prefer over CSS chains.

const path = require('path');

const DEFAULT_COMPANY = 'Factory';

// PACT's type-ahead lookups (vendor #100, product #10, etc.) render matches in a
// dropdown `.List__dropdown--suggestions`, each option being a
// `.suggestions__list-name` element holding the item's name. Click the matching
// option; fall back to a plain text match if the dropdown markup differs.
async function pickSuggestion(page, name) {
  const dd = page.locator('.List__dropdown--suggestions');
  await dd.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  const inDd = dd.locator('.suggestions__list-name', { hasText: name }).first();
  if (await inDd.isVisible().catch(() => false)) { await inDd.click({ timeout: 8000 }); return; }
  const anyOpt = page.locator('.suggestions__list-name', { hasText: name }).first();
  if (await anyOpt.isVisible().catch(() => false)) { await anyOpt.click({ timeout: 8000 }); return; }
  await page.getByText(name, { exact: false }).first().click({ timeout: 8000 });
}

async function createGoodsGateEntry(page, bill, { dryRun = true } = {}) {
  // 1. Open the Goods Gate Entry screen.
  // In a headless/large viewport the nav can render differently, so try several
  // ways to reach the link: open the Flows menu, wait for the link to attach,
  // scroll it into view, then fall back to a plain-text match.
  const ggeLink = page.getByRole('link', { name: 'Goods Gate Entry', exact: true }).first();
  const ggeText = page.getByText('Goods Gate Entry', { exact: true }).first();

  async function openGge() {
    // If it's already clickable, click it.
    if (await ggeLink.isVisible().catch(() => false)) {
      await ggeLink.scrollIntoViewIfNeeded().catch(() => {});
      await ggeLink.click({ timeout: 15000 });
      return true;
    }
    // Otherwise open the Flows menu (try button, link, or plain text) and retry.
    await page.getByRole('button', { name: 'Flows' }).click({ timeout: 6000 })
      .catch(() => page.getByRole('link', { name: 'Flows', exact: false }).first().click({ timeout: 6000 })
      .catch(() => page.getByText('Flows', { exact: true }).first().click({ timeout: 6000 }).catch(() => {})));
    await page.waitForTimeout(1500);

    // Wait for the link (or its text) to appear, then click whichever exists.
    await ggeLink.waitFor({ state: 'attached', timeout: 12000 }).catch(() => {});
    if (await ggeLink.count().catch(() => 0)) {
      await ggeLink.scrollIntoViewIfNeeded().catch(() => {});
      await ggeLink.click({ timeout: 12000 });
      return true;
    }
    if (await ggeText.count().catch(() => 0)) {
      await ggeText.scrollIntoViewIfNeeded().catch(() => {});
      await ggeText.click({ timeout: 12000 });
      return true;
    }
    return false;
  }

  if (!(await openGge())) {
    throw new Error("Could not find/open the 'Goods Gate Entry' link on the PACT home screen (see failure screenshot).");
  }
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

  // 3. Vendor (type-ahead lookup #100). Type char-by-char so the type-ahead
  //    actually fires, then pick from the suggestions dropdown. A plain fill()
  //    sets the value without firing the events the dropdown needs.
  const vendorField = page.locator('[id="100"]').first();
  await vendorField.click();
  await vendorField.fill('');
  await vendorField.pressSequentially(String(bill.vendorSearch || bill.vendor.slice(0, 4)), { delay: 60 });
  await pickSuggestion(page, bill.vendor);

  // 4. Bill number
  await page.locator('#BillNo').first().fill(String(bill.billNo));
  await page.locator('#BillNo').first().press('Enter').catch(() => {});
  await page.waitForTimeout(500);

  // 4b. Bill Date (required) — click the field to open its calendar and pick today
  await page.locator('#BillDate').first().click().catch(() => {});
  await page.waitForTimeout(800);
  const billDay = String((new Date()).getDate());
  await page.getByText(billDay, { exact: true }).first().click({ timeout: 6000 })
    .catch((e) => console.log('  bill-date step:', String(e.message).split('\n')[0]));
  await page.waitForTimeout(600);

  // 5. Line items — one grid row each
  for (let i = 0; i < bill.items.length; i++) {
    const it = bill.items[i];
    // product name — activate the Product Name cell so its lookup editor opens.
    // The editor is a `list_grid_input` inside the active/editable grid cell; its
    // id is NOT stable across environments (seen as #10, #1, ...), so match by
    // class/position, never a hard id, and exclude the vendor field (#100). In
    // headless a single programmatic click sometimes only selects the cell, so
    // escalate to double-click / Enter until the editor appears.
    const prodCell = page.getByRole('gridcell', { description: 'Product Name', exact: true }).nth(i);
    const activeEditor = page.locator('.slick-cell.editable input.list_grid_input').first();
    const editorVisible = () => activeEditor.isVisible().catch(() => false);
    await prodCell.click();
    await page.waitForTimeout(500);
    if (!(await editorVisible())) { await prodCell.dblclick().catch(() => {}); await page.waitForTimeout(500); }
    if (!(await editorVisible())) { await prodCell.click().catch(() => {}); await page.keyboard.press('Enter').catch(() => {}); await page.waitForTimeout(500); }

    // Resolve the search box (active editable cell first, else any grid lookup
    // that isn't the vendor), type char-by-char to fire the suggestions
    // dropdown, then pick the matching product.
    let search = activeEditor;
    if (!(await search.isVisible().catch(() => false))) {
      search = page.locator('input.list_grid_input:not([id="100"])').last();
    }
    await search.click().catch(() => {});
    await page.waitForTimeout(300);
    await search.pressSequentially(String(it.search || it.name), { delay: 70 });
    await page.waitForTimeout(600);
    await pickSuggestion(page, it.name);
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

  // 5b. Delivery Date (required before Post) — open its calendar and pick today
  try {
    const ddLabel = page.getByText('Delivery Date', { exact: false }).first();
    await ddLabel.locator('xpath=following::*[contains(@class,"List__button") or contains(@class,"fa-calendar")][1]').click({ timeout: 8000 });
    await page.waitForTimeout(700);
    const today = String((new Date()).getDate());
    await page.getByText(today, { exact: true }).first().click({ timeout: 6000 });
    await page.waitForTimeout(500);
  } catch (e) { console.log('  delivery-date step:', String(e.message).split('\n')[0]); }

  if (dryRun) {
    await page.screenshot({ path: path.join('/tmp', 'gge-filled.png'), fullPage: true }).catch(() => {});
    console.log('  [DRY RUN] GGE filled — screenshot saved as gge-filled.png. Stopping before Post.');
    return { posted: false };
  }
  // Commit the last grid cell BEFORE posting (click a neutral field so the active
  // editor blurs and the grid saves — otherwise Post drops the uncommitted row).
  await page.locator('#BillNo').first().click().catch(() => {});
  await page.keyboard.press('Tab').catch(() => {});
  await page.waitForTimeout(1200);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join('/tmp', 'gge-before-post.png'), fullPage: true }).catch(() => {});
  // capture the draft's Doc No BEFORE posting (this becomes the posted GRN)
  let grn = '';
  try {
    const num = await page.locator('#TxtVoucherNo').first().inputValue();
    if (num) grn = `GRN-26-27/${String(num).replace(/^.*\//, '').trim()}`;
  } catch {}
  try { require('fs').writeFileSync(require('path').join(__dirname, '..', 'last-grn.txt'), grn); } catch {}
  await page.locator('button[title="Post"]').first().click();
  await page.waitForTimeout(2500);
  console.log('  GGE posted. GRN =', grn || '(NOT captured — check #TxtVoucherNo)');
  return { posted: true, grn };
}

module.exports = { createGoodsGateEntry };
