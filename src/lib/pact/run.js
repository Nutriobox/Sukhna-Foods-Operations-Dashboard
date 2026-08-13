// Orchestrates a full PACT push for one bill: login -> Goods Gate Entry (post)
// -> Stock Inward (link the GGE, allocate batches, post). Runs headless in a
// Vercel serverless function. Returns { ok, grn, error, log }.
const { launchBrowser } = require('./browser');
const { login } = require('./login');
const { createGoodsGateEntry } = require('./gge');
const { createStockInward } = require('./stock-inward');

async function pushBillToPact(bill, { dryRun = false } = {}) {
  const log = [];
  const say = (m) => { log.push(m); console.log(m); };
  let browser;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    say('Logging into PACT...');
    await login(page);

    say(`Goods Gate Entry for ${bill.vendor} / ${bill.billNo} (${bill.items.length} items)...`);
    const gge = await createGoodsGateEntry(page, bill, { dryRun });
    const grn = gge && gge.grn ? gge.grn : '';
    say(`GGE done. GRN = ${grn || '(not captured)'}`);

    if (!dryRun && !grn) throw new Error('GGE posted but GRN was not captured — cannot link Stock Inward.');

    say('Stock Inward (linking GGE, allocating batches)...');
    const si = await createStockInward(page, bill, { dryRun, targetGrn: grn });
    say(`Stock Inward done (posted=${si && si.posted}).`);

    await context.close();
    return { ok: true, grn, dryRun, log };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e), log };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { pushBillToPact };
