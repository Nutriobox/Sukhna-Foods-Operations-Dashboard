// Creates a Stock Inward in PACT that LINKS to the already-posted Goods Gate Entry.
// Built from stockinward-recording.ts.
//
// DIAG mode: when env SI_DIAG=1, after linking + Approve Qty it dumps the grid
// HTML (si-grid.html) and, on the first item, opens the Batch dialog and dumps
// it (batch-dialog.html), then stops. Those files let us wire the batch step.

const path = require('path');
const fs = require('fs');
const { pickVendorSuggestion } = require('./gge');

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

async function createStockInward(page, bill, { dryRun = true, targetGrn: grnOpt = '' } = {}) {
  const DIAG = String(process.env.SI_DIAG || '') === '1';

  // 1. Open Stock Inward (via the Flows menu if the link isn't showing)
  const link = page.getByRole('link', { name: 'Stock Inward', exact: true }).first();
  if (!(await link.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Flows' }).click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1050);
  }
  await link.click({ timeout: 20000 });
  await page.waitForTimeout(1400);

  // 1b. Voucher Prefix / Location popup (same as GGE), if it appears
  const vp = page.locator('modal-container.show').first();
  if (await vp.isVisible().catch(() => false)) {
    await vp.locator('.List__button').first().click().catch(() => {});
    await page.waitForTimeout(500);
    await page.getByText(bill.company || 'Factory', { exact: true }).first().click({ timeout: 8000 }).catch(() => {});
    await vp.getByRole('button', { name: 'Ok' }).click({ timeout: 5000 }).catch(() => {});
    await vp.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
  }
  await page.waitForTimeout(850);

  // 2. Vendor
  const tab = page.getByRole('tabpanel').filter({ hasText: 'Stock Inward' });
  const siVendor = tab.locator('[id="100"]').first();
  await siVendor.click();
  await siVendor.fill('');
  // Type char-by-char so the type-ahead fires, then match tolerantly (same as GGE).
  await siVendor.pressSequentially(String(bill.vendorSearch || bill.vendor.slice(0, 4)), { delay: 60 });
  await page.waitForTimeout(500);
  await pickVendorSuggestion(page, bill.vendor);
  await page.waitForTimeout(550);

  // 3. Bill number
  await tab.locator('#BillNo').first().fill(String(bill.billNo));
  await tab.locator('#BillNo').first().press('Enter').catch(() => {});
  await page.waitForTimeout(550);

  // 4. Link -> tick the specific GGE (from last-grn.txt) to pull its items in.
  await page.getByRole('tab', { name: 'Link' }).click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1050);
  let targetGrn = grnOpt || process.env.TARGET_GRN || '';
  if (!targetGrn) { try { targetGrn = fs.readFileSync(path.join('/tmp', 'last-grn.txt'), 'utf8').trim(); } catch {} }
  console.log('  linking GGE:', targetGrn || '(none set — using first)');

  let ggeCheckbox;
  if (targetGrn) {
    const row = page.locator(`app-check-list div:has(label:text-is("${targetGrn}"))`).first();
    if (await row.isVisible().catch(() => false)) {
      ggeCheckbox = row.locator('input[type="checkbox"]').first();
    } else {
      console.log('  ! target GRN not in pending list — using first as fallback.');
      ggeCheckbox = page.locator('app-check-list input[type="checkbox"]').first();
    }
  } else {
    ggeCheckbox = page.locator('app-check-list input[type="checkbox"]').first();
  }
  await ggeCheckbox.check({ timeout: 8000 })
    .catch((e) => console.log('  link checkbox failed:', String(e.message).split('\n')[0]));
  await page.waitForTimeout(1400);
  await page.getByText('Select All', { exact: true }).click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(2100);

  // 5. Approve the received quantity for each item.
  //    After linking the GGE the approve-grid rows show Receipt Qty (e.g. 800),
  //    Rejected Qty (defaults to the FULL qty), and Approve Qty (computed =
  //    Receipt − Rejected, hence 0 and NOT directly editable). So the real fix is
  //    to ZERO the "Rejected Qty" cell — Approve Qty then auto-fills to the full
  //    received qty. We still try to set Approve Qty directly as a fallback in
  //    case this environment lets you edit it.

  // Map header-label -> aria-describedby suffix from the product row, and log the
  // whole row's {label: value} so one run confirms the column semantics.
  const rowMap = await page.evaluate(() => {
    const hdr = {};
    document.querySelectorAll('.slick-header-column').forEach(h => { hdr[h.id] = (h.innerText || '').trim(); });
    const row = [...document.querySelectorAll('.slick-row')].find(r => (r.innerText || '').trim().length > 3);
    if (!row) return { map: {}, dump: [] };
    const map = {}; const dump = [];
    row.querySelectorAll('.slick-cell').forEach(c => {
      const db = c.getAttribute('aria-describedby') || '';
      const label = hdr[db] || '';
      const suffix = db.replace(/^slickgrid_\d+/, '');
      const text = (c.innerText || '').trim();
      if (label) { map[label] = suffix; dump.push([label, text]); }
    });
    return { map, dump };
  }).catch(() => ({ map: {}, dump: [] }));
  console.log('  [approveGrid row]', JSON.stringify(rowMap.dump));
  const sufFor = (labels) => { for (const l of labels) if (rowMap.map[l]) return rowMap.map[l]; return ''; };
  const rejectSuf = sufFor(['Rejected Qty', 'Reject Qty', 'Rejected Quantity', 'Rejected']);
  const approveSuf = sufFor(['Approve Qty', 'Approved Qty', 'Approve Quantity', 'Accepted Qty']);
  const receiptSuf = sufFor(['Receipt Qty', 'Receipt Quantity', 'Received Qty', 'Recd Qty', 'Recpt Qty']);
  console.log('  [approveGrid] rejectSuf =', rejectSuf || '(none)', ' approveSuf =', approveSuf || '(none)', ' receiptSuf =', receiptSuf || '(none)');

  const rowCell = (idx, suf) => page.locator('.slick-row').nth(idx)
    .locator(`.slick-cell[aria-describedby$="${suf}"]`).first();

  // Read the numeric text currently shown in a row/column cell (e.g. Receipt Qty).
  const readCellNum = async (idx, suf) => {
    if (!suf) return null;
    const t = await rowCell(idx, suf).innerText().catch(() => '');
    const n = parseFloat(String(t).replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  // Robustly type `value` into a slick numeric cell: click (select), then if no
  // editor opened, double-click; fill the editable input; commit with Enter.
  async function setCell(cell, value, tag) {
    await cell.scrollIntoViewIfNeeded().catch(() => {});
    await cell.click({ timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(300);
    let ed = page.locator('.slick-cell.editable input, .slick-cell.editable textarea, input.PactTextBoxEditor, input.editor-text').first();
    if (!(await ed.isVisible({ timeout: 1500 }).catch(() => false))) {
      await cell.dblclick({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(300);
      ed = page.locator('.slick-cell.editable input, .slick-cell.editable textarea, input.PactTextBoxEditor, input.editor-text').first();
    }
    if (await ed.isVisible({ timeout: 1000 }).catch(() => false)) {
      await ed.fill('').catch(() => {});
      await ed.fill(String(value)).catch(async () => { await page.keyboard.type(String(value)).catch(() => {}); });
      await page.keyboard.press('Enter').catch(() => {});
      console.log(`  ${tag}: set ${value}`);
    } else {
      console.log(`  ${tag}: no editor opened (cell may be read-only/computed)`);
    }
    await page.waitForTimeout(300);
  }

  for (let i = 0; i < bill.items.length; i++) {
    // Approve Qty must equal Receipt Qty. Prefer the value PACT already shows in
    // the Receipt Qty cell (exact match); fall back to the bill's receipt qty.
    const receiptFromGrid = await readCellNum(i, receiptSuf);
    const aq = receiptFromGrid ?? bill.items[i].approveQty ?? bill.items[i].qty;
    console.log(`  approve[${i + 1}] target = ${aq} (receiptGrid=${receiptFromGrid})`);
    // Primary: type the Approve Qty straight into its cell (= Receipt Qty).
    if (approveSuf) await setCell(rowCell(i, approveSuf), aq, `approve[${i + 1}]`);
    // If Approve Qty is still 0 (some builds compute it as Receipt - Rejected),
    // zero the Rejected Qty cell so Approve auto-fills, then set Approve again.
    const nowApprove = await readCellNum(i, approveSuf);
    if (!nowApprove || nowApprove < (aq || 0) - 0.0001) {
      if (rejectSuf) await setCell(rowCell(i, rejectSuf), 0, `reject[${i + 1}]`);
      if (approveSuf) await setCell(rowCell(i, approveSuf), aq, `approve[${i + 1}]`);
    }
  }

  // Log the row again so one run shows whether Approve Qty is now non-zero.
  const afterRow = await page.evaluate(() => {
    const hdr = {};
    document.querySelectorAll('.slick-header-column').forEach(h => { hdr[h.id] = (h.innerText || '').trim(); });
    const row = [...document.querySelectorAll('.slick-row')].find(r => (r.innerText || '').trim().length > 3);
    if (!row) return [];
    return [...row.querySelectorAll('.slick-cell')].map(c => {
      const db = c.getAttribute('aria-describedby') || ''; return [hdr[db] || '', (c.innerText || '').trim()];
    }).filter(x => x[0]);
  }).catch(() => []);
  console.log('  [approveGrid row AFTER]', JSON.stringify(afterRow));

  // ---- DIAGNOSTIC: dump grid + batch dialog, then stop ------------------------
  if (DIAG) {
    console.log('  [diag] dumping Stock Inward grid …');
    // whole tabpanel (contains the slick grid with all column descriptions)
    await dumpOuter(page, 'si-grid.html', page.getByRole('tabpanel').filter({ hasText: 'Stock Inward' }));

    // list every gridcell description present (compact, printed to console)
    try {
      const descs = await page.getByRole('gridcell').evaluateAll((els) =>
        Array.from(new Set(els.map((e) => e.getAttribute('aria-describedby') || e.getAttribute('description') || e.getAttribute('aria-label') || '').filter(Boolean))));
      console.log('  [diag] gridcell descriptors:', JSON.stringify(descs).slice(0, 800));
    } catch (e) { console.log('  [diag] descriptors failed:', String(e.message).split('\n')[0]); }

    // Attempt A: click the Batch Number cell of row 0
    console.log('  [diag] Attempt A: click Batch Number cell …');
    const bCell = page.getByRole('gridcell', { description: 'Batch Number', exact: true }).nth(0);
    await bCell.scrollIntoViewIfNeeded().catch(() => {});
    await bCell.click({ timeout: 8000 }).catch((e) => console.log('  [diag] batch cell click failed:', String(e.message).split('\n')[0]));
    await page.waitForTimeout(1250);
    let modal = page.locator('modal-container.show');
    let n = await modal.count().catch(() => 0);
    console.log('  [diag] modal-container.show count after batch click =', n);
    if (n > 0) {
      await dumpOuter(page, 'batch-dialog.html', modal.last());
    } else {
      // Attempt B: fill base Quantity + Enter, then click Batch Number
      console.log('  [diag] Attempt B: base Quantity + Enter, then Batch cell …');
      for (const d of ['Quantity', 'Qty', 'Base Qty', 'Base Quantity']) {
        const c = page.getByRole('gridcell', { description: d, exact: true }).nth(0);
        if (await c.count().catch(() => 0)) {
          console.log('  [diag] found base-qty column description =', d);
          await c.click({ timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(350);
          const ed = page.locator('.PactTextBoxEditor');
          if (await ed.count().catch(() => 0)) { await ed.press('Enter').catch(() => {}); }
          await page.waitForTimeout(550);
          break;
        }
      }
      await bCell.click({ timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(1250);
      n = await modal.count().catch(() => 0);
      console.log('  [diag] modal count after Attempt B =', n);
      if (n > 0) await dumpOuter(page, 'batch-dialog.html', modal.last());
    }
    console.log('  [diag] DONE — read si-grid.html and batch-dialog.html.');
    return { posted: false, diag: true };
  }
  // ---------------------------------------------------------------------------

  // 6. Per-item batch allocation.
  //    Trigger: click the "Base Qty" grid cell -> Enter opens "Generate Batch Numbers".
  //    Then create a batch: Mfg date, Expiry date, Qty (pre-filled = full base qty),
  //    Save & Add -> Save. Dates come from the bill line (it.batch) or a safe default.
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  const NOW = new Date();
  const DEF_MFG = fmt(NOW);
  const DEF_EXP = fmt(new Date(NOW.getFullYear() + 5, NOW.getMonth(), NOW.getDate()));

  async function typeDate(el, value) {
    await el.click().catch(() => {});
    await page.waitForTimeout(300);
    await el.fill('').catch(() => {});
    await el.pressSequentially(value, { delay: 30 }).catch(() => {});
    await page.waitForTimeout(300);
  }

  for (let i = 0; i < bill.items.length; i++) {
    const it = bill.items[i];
    const b = it.batch || {};
    const mfg = b.mfgDate || DEF_MFG;   // Manufactured Date from the dashboard entry

    const openModal = () => page.locator('modal-container.show').last();
    const isOpen = async () => openModal().isVisible().catch(() => false);

    // 6a. Open "Generate Batch Numbers": focus this row's Approve Qty cell and
    //     press Enter 3 times (the exact manual sequence).
    if (approveSuf) {
      const ac = rowCell(i, approveSuf);
      await ac.scrollIntoViewIfNeeded().catch(() => {});
      await ac.click({ timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(300);
    }
    for (let k = 0; k < 3 && !(await isOpen()); k++) {
      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForTimeout(700);
    }

    // Fallback: if Enter didn't open it, click Base Qty / Batch No cell + Enter.
    if (!(await isOpen())) {
      const baseSuf = sufFor(['Base Qty', 'Base Quantity']);
      const batchSuf = sufFor(['Batch No', 'Batch Number', 'Batch']);
      for (const suf of [baseSuf, batchSuf]) {
        if (!suf || (await isOpen())) continue;
        await rowCell(i, suf).click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(300);
        await page.keyboard.press('Enter').catch(() => {});
        await page.waitForTimeout(900);
      }
    }

    if (!(await isOpen())) {
      console.log(`  batch[${i + 1}]: Generate Batch Numbers dialog did NOT open`);
      continue;
    }
    const dlg = openModal();
    console.log(`  batch[${i + 1}] dialog opened`);

    // one-time diagnostic dump of the pristine dialog
    if (i === 0) {
      try {
        const html = await dlg.evaluate((el) => el.outerHTML);
        require('fs').writeFileSync(require('path').join(__dirname, '..', 'batch-open.html'), html);
        console.log(`  [diag] wrote batch-open.html (${html.length} bytes)`);
      } catch (e) { console.log('  [diag] dump failed:', String(e.message).split('\n')[0]); }
    }

    // 6b. Create the batch: set Manufactured Date from the dashboard entry.
    //     Expiry Date and Qty auto-fill in PACT, so leave them untouched.
    let mfgField = dlg.locator('#MfgDate, #MfgryDate, #ManufacturingDate, input[id*="Mfg" i]').first();
    if (!(await mfgField.count().catch(() => 0))) mfgField = dlg.locator('input[placeholder*="Manufact" i], input[name*="Mfg" i]').first();
    await typeDate(mfgField, mfg);
    console.log(`  batch[${i + 1}] set Manufactured Date = ${mfg}`);

    // 6c. Save & Add (adds this batch line; qty pre-filled from Receipt/Base qty).
    await dlg.getByText('Save & Add', { exact: false }).first()
      .click({ timeout: 6000 })
      .catch((e) => console.log(`  batch[${i + 1}] Save & Add: ${String(e.message).split('\n')[0]}`));
    await page.waitForTimeout(1000);
    const added = (await dlg.getByText(/Added:.*of.*for/).first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (added) console.log(`  batch[${i + 1}] ${added}`);

    // 6d. A second "Save" button appears — click it to commit and close the dialog.
    let saveBtn = dlg.getByRole('button', { name: 'Save', exact: true }).last();
    if (!(await saveBtn.count().catch(() => 0))) saveBtn = dlg.locator('button.primary-btn-wicon:has(i.fa-floppy-disk)').first();
    await saveBtn.click({ timeout: 6000 }).catch((e) => console.log(`  batch[${i + 1}] Save: ${String(e.message).split('\n')[0]}`));
    await dlg.waitFor({ state: 'hidden', timeout: 8000 }).catch(() => console.log(`  batch[${i + 1}] dialog did not close after Save`));
    await page.waitForTimeout(600);
    console.log(`  batch[${i + 1}] done (mfg=${mfg})`);
  }

  if (dryRun) {
    await page.screenshot({ path: path.join('/tmp', 'stockinward-filled.png'), fullPage: true }).catch(() => {});
    console.log('  [DRY RUN] Stock Inward filled. Screenshot saved. Stopping before Post.');
    return { posted: false };
  }

  // 7. Post the Stock Inward (only when DRY_RUN=false)
  await page.screenshot({ path: path.join('/tmp', 'stockinward-before-post.png'), fullPage: true }).catch(() => {});

  // Commit any still-open grid editor before posting (blur it) so the row saves.
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);

  // Capture the SI grid state so a failure tells us whether Approve Qty and the
  // batch actually landed (visible in the Supabase error, no GitHub log needed).
  const preState = await page.evaluate(() => {
    const hdr = {};
    document.querySelectorAll('.slick-header-column').forEach(h => { hdr[h.id] = (h.innerText || '').trim(); });
    const row = [...document.querySelectorAll('.slick-row')].find(r => (r.innerText || '').trim().length > 3);
    const vals = {};
    if (row) row.querySelectorAll('.slick-cell').forEach(c => { const l = hdr[c.getAttribute('aria-describedby')]; if (l) vals[l] = (c.innerText || '').trim(); });
    const modalOpen = !!document.querySelector('modal-container.show');
    const posts = [...document.querySelectorAll('button[title="Post"]')].map(b => { const r = b.getBoundingClientRect(); return { vis: r.width > 0 && r.height > 0, cls: (b.className || '').slice(0, 30) }; });
    return { vals, modalOpen, posts };
  }).catch(() => ({}));
  const preSummary = `preState=${JSON.stringify(preState).slice(0, 400)}`;
  console.log('  [pre-post]', preSummary);

  page.once('dialog', (d) => d.accept().catch(() => {}));

  // There can be several button[title="Post"] in the DOM (the hidden GGE tab plus
  // the Stock Inward tab). Click the VISIBLE one, scrolling it into view first.
  const postBtn = page.locator('button[title="Post"]:visible').first();
  try {
    await postBtn.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
    await postBtn.click({ timeout: 10000 });
  } catch (e) {
    // fallback: last Post button, forced
    const fb = page.locator('button[title="Post"]').last();
    await fb.scrollIntoViewIfNeeded().catch(() => {});
    await fb.click({ timeout: 6000, force: true }).catch(() => {
      throw new Error(`Stock Inward Post button not clickable. ${preSummary}. orig=${String(e.message).split('\n')[0]}`);
    });
  }
  await page.waitForTimeout(2100);
  // some builds show a confirmation Post; click a visible one again if present
  await page.locator('button[title="Post"]:visible').first().click({ timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(2100);
  await page.screenshot({ path: path.join('/tmp', 'stockinward-after-post.png'), fullPage: true }).catch(() => {});
  console.log('  Stock Inward post attempted.');
  return { posted: true };
}

module.exports = { createStockInward };
