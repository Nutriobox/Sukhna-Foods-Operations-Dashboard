// Orchestrates a full PACT push for one bill: login -> Goods Gate Entry (post)
// -> Stock Inward (link the GGE, allocate batches, post). Runs headless in a
// Vercel serverless function. Returns { ok, grn, error, log, pageInfo? }.
const { launchBrowser } = require('./browser');
const { login } = require('./login');
const { createGoodsGateEntry } = require('./gge');
const { createStockInward } = require('./stock-inward');

async function pushBillToPact(bill, { dryRun = false } = {}) {
  const log = [];
  const say = (m) => { log.push(m); console.log(m); };
  const consoleErrs = [];
  const pageErrs = [];
  const failed = [];
  let browser, page;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({ ignoreHTTPSErrors: true, bypassCSP: true });
    page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(String(m.text()).slice(0, 200)); });
    page.on('pageerror', (e) => pageErrs.push(String(e && e.message ? e.message : e).slice(0, 200)));
    page.on('requestfailed', (r) => failed.push(`${r.failure()?.errorText || '?'} ${r.url()}`.slice(0, 200)));

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
    let pageInfo = { consoleErrs: consoleErrs.slice(0, 12), pageErrs: pageErrs.slice(0, 12), failed: failed.slice(0, 12) };
    try {
      if (page) {
        pageInfo.url = page.url();
        pageInfo.title = await page.title().catch(() => '');
        pageInfo.inputs = await page.locator('input').count().catch(() => -1);
        pageInfo.bodyHtmlLen = (await page.evaluate(() => document.documentElement.outerHTML).catch(() => '')).length;
        pageInfo.bodyText = (await page.evaluate(() => document.body ? document.body.innerText : '(no body)').catch(() => '')).replace(/\s+/g, ' ').slice(0, 400);
        const shot = await page.screenshot({ type: 'jpeg', quality: 30 }).catch(() => null);
        if (shot) pageInfo.screenshotB64 = shot.toString('base64').slice(0, 120000);
      }
    } catch {}
    return { ok: false, error: String(e && e.message ? e.message : e), log, pageInfo };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { pushBillToPact };
