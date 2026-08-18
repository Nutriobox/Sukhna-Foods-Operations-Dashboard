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

// Normalize a company name for tolerant matching: lowercase, strip punctuation
// and common legal/entity suffixes so "Asha Ram & Sons Pvt. Ltd." matches a PACT
// master entry stored as "Asha Ram & Sons" (or "ASHA RAM AND SONS").
function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(pvt|private|ltd|limited|llp|co|company|inc|corp|corporation|and|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Pick a vendor from the type-ahead suggestions using tolerant matching, so a
// bill's "Pvt. Ltd." suffix (or minor spelling differences) doesn't cause a
// false "not found". If nothing matches well, throw an error listing the exact
// suggestions PACT offered — so one run tells "wrong spelling" from "missing".
async function pickVendorSuggestion(page, vendorName) {
  const dd = page.locator('.List__dropdown--suggestions');
  await dd.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  const opts = dd.locator('.suggestions__list-name');
  const n = await opts.count().catch(() => 0);
  const wanted = normName(vendorName);
  const wantTokens = wanted.split(' ').filter(Boolean);
  const texts = [];
  let best = -1, bestScore = 0;
  for (let i = 0; i < n; i++) {
    const raw = ((await opts.nth(i).innerText().catch(() => '')) || '').trim();
    texts.push(raw);
    const cand = normName(raw);
    let score = 0;
    if (cand && (wanted.includes(cand) || cand.includes(wanted))) {
      score = 1;
    } else {
      const ct = new Set(cand.split(' ').filter(Boolean));
      const overlap = wantTokens.filter((x) => ct.has(x)).length;
      score = wantTokens.length ? overlap / wantTokens.length : 0;
    }
    if (score > bestScore) { bestScore = score; best = i; }
  }
  if (best >= 0 && bestScore >= 0.6) {
    console.log(`  vendor match: "${texts[best]}" (score ${bestScore.toFixed(2)}) for "${vendorName}"`);
    await opts.nth(best).click({ timeout: 8000 });
    return;
  }
  throw new Error(`Vendor "${vendorName}" not matched in PACT's supplier master. PACT offered: [${texts.slice(0, 8).join(' | ') || 'no suggestions'}]. Add the supplier in PACT or correct its name, then retry.`);
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
    await page.waitForTimeout(1050);

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
  await page.waitForTimeout(1050);

  // 2. "Voucher Prefix" popup -> pick the Location, click Ok
  const location = bill.company || DEFAULT_COMPANY; // e.g. "Factory"
  const vp = page.locator('modal-container.show').first();
  await vp.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  if (await vp.isVisible().catch(() => false)) {
    await vp.locator('.List__button').first().click().catch(() => {}); // open the Location dropdown
    await page.waitForTimeout(500);
    await vp.locator('#Name').click().catch(() => {});
    await page.getByText(location, { exact: true }).first().click({ timeout: 8000 });
    await vp.getByRole('button', { name: 'Ok' }).click({ timeout: 5000 });
    await vp.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
  }
  await page.waitForTimeout(1050);

  // 3. Vendor (type-ahead lookup #100). Type char-by-char so the type-ahead
  //    actually fires, then pick from the suggestions dropdown. A plain fill()
  //    sets the value without firing the events the dropdown needs.
  const vendorField = page.locator('[id="100"]').first();
  await vendorField.click();
  await vendorField.fill('');
  await vendorField.pressSequentially(String(bill.vendorSearch || bill.vendor.slice(0, 4)), { delay: 60 });
  await page.waitForTimeout(500);
  await pickVendorSuggestion(page, bill.vendor);

  // 4. Bill number
  await page.locator('#BillNo').first().fill(String(bill.billNo));
  await page.locator('#BillNo').first().press('Enter').catch(() => {});
  await page.waitForTimeout(350);

  // 4b. Bill Date (required) — click the field to open its calendar and pick today
  await page.locator('#BillDate').first().click().catch(() => {});
  await page.waitForTimeout(550);
  const billDay = String((new Date()).getDate());
  await page.getByText(billDay, { exact: true }).first().click({ timeout: 6000 })
    .catch((e) => console.log('  bill-date step:', String(e.message).split('\n')[0]));
  await page.waitForTimeout(400);

  // 5. Line items — one grid row each
  for (let i = 0; i < bill.items.length; i++) {
    const it = bill.items[i];
    // product name — scope strictly to the ProductName column (via its stable
    // aria-describedby suffix) so we open THAT column's lookup editor and never a
    // neighbouring column's (e.g. Warehouse). The editor's input id is not stable
    // across environments, so we locate it inside the editable ProductName cell.
    const prodCell = page.locator('.slick-cell[aria-describedby$="ProductName"]').nth(i);
    const prodEditor = () => page.locator('.slick-cell[aria-describedby$="ProductName"].editable input').first();
    const editorVisible = () => prodEditor().isVisible().catch(() => false);
    await prodCell.scrollIntoViewIfNeeded().catch(() => {});
    await prodCell.click();
    await page.waitForTimeout(350);
    if (!(await editorVisible())) { await prodCell.dblclick().catch(() => {}); await page.waitForTimeout(350); }
    if (!(await editorVisible())) { await prodCell.click().catch(() => {}); await page.keyboard.press('Enter').catch(() => {}); await page.waitForTimeout(350); }

    // Type char-by-char into the ProductName editor to fire the suggestions
    // dropdown, then pick the matching product.
    const search = prodEditor();
    await search.click().catch(() => {});
    await page.waitForTimeout(300);
    await search.pressSequentially(String(it.search || it.name), { delay: 70 });
    await page.waitForTimeout(500);
    await pickSuggestion(page, it.name).catch(() => {
      throw new Error(`Product "${it.name}" (line ${i + 1}) not found in PACT's item master. Check the product mapping, then retry.`);
    });
    await page.locator('#revwebbody').press('Enter').catch(() => {});
    await page.waitForTimeout(300);

    // purchase unit level (L1/L2/L3). The "Purchase Unit Level" column's internal
    // name is "Value"; it holds a persistent <select> in each row — target that
    // select directly (getByRole('combobox') matched the wrong widget before).
    if (it.unitLevel) {
      const ulCell = page.locator('.slick-cell[aria-describedby$="Value"]').nth(i);
      await ulCell.scrollIntoViewIfNeeded().catch(() => {});
      await ulCell.click();            // activate the cell so its <select> renders
      await page.waitForTimeout(300);
      const ulSelect = ulCell.locator('select').first();
      await ulSelect.selectOption(it.unitLevel)
        .catch((e) => console.log(`    [item ${i + 1}] unit-level select failed: ${String(e.message).split('\n')[0]}`));
      await page.waitForTimeout(350);
    }

    // quantity -> the Purchase Qty column (internal name dcNum9). It's a numeric
    // cell whose text editor (input.PactTextBoxEditor) only opens on DOUBLE-click.
    const qtyCell = page.locator('.slick-cell[aria-describedby$="dcNum9"]').nth(i);
    await qtyCell.scrollIntoViewIfNeeded().catch(() => {});
    await qtyCell.dblclick().catch(() => {});
    await page.waitForTimeout(300);
    const qtyInput = page.locator('.slick-cell.editable input.PactTextBoxEditor, input.PactTextBoxEditor').first();
    await qtyInput.fill(String(it.qty)).catch((e) => console.log(`    [item ${i + 1}] qty fill failed: ${String(e.message).split('\n')[0]}`));
    await qtyInput.press('Enter').catch(() => {});
    await page.waitForTimeout(350);
  }

  // 5b. Delivery Date (required before Post) — open its calendar and pick today
  try {
    const ddLabel = page.getByText('Delivery Date', { exact: false }).first();
    await ddLabel.locator('xpath=following::*[contains(@class,"List__button") or contains(@class,"fa-calendar")][1]').click({ timeout: 8000 });
    await page.waitForTimeout(500);
    const today = String((new Date()).getDate());
    await page.getByText(today, { exact: true }).first().click({ timeout: 6000 });
    await page.waitForTimeout(350);
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
  await page.waitForTimeout(850);
  await page.waitForTimeout(1050);
  await page.screenshot({ path: path.join('/tmp', 'gge-before-post.png'), fullPage: true }).catch(() => {});
  // capture the draft's Doc No BEFORE posting (this becomes the posted GRN)
  let grn = '';
  try {
    const num = await page.locator('#TxtVoucherNo').first().inputValue();
    if (num) grn = `GRN-26-27/${String(num).replace(/^.*\//, '').trim()}`;
  } catch {}
  try { require('fs').writeFileSync(require('path').join(__dirname, '..', 'last-grn.txt'), grn); } catch {}
  await page.locator('button[title="Post"]').first().click();
  await page.waitForTimeout(1750);
  console.log('  GGE posted. GRN =', grn || '(NOT captured — check #TxtVoucherNo)');
  return { posted: true, grn };
}

module.exports = { createGoodsGateEntry, pickVendorSuggestion, pickSuggestion, normName };
