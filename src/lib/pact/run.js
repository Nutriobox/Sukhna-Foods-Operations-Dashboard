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
  let netCheck = {};
  try {
    const testUrl = process.env.PACT_URL || 'http://140.245.255.130:8443/PACTALLUSUREWEB/#/login';
    const base = testUrl.split('#')[0];
    try {
      const t0 = Date.now();
      const r = await fetch(base, { signal: AbortSignal.timeout(15000) });
      const body = await r.text();
      netCheck = { ok: true, status: r.status, ms: Date.now() - t0, len: body.length, head: body.slice(0, 160).replace(/\s+/g, ' ') };
    } catch (e) { netCheck = { ok: false, error: String(e && e.message ? e.message : e) }; }

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

    // Stock Inward no longer links the GGE (that step was removed in PACT); it
    // enters the product manually, so a missing GRN is not fatal.
    if (!grn) say('No GRN captured — continuing (Stock Inward enters items manually).');

    say('Stock Inward (manual entry, batch allocation)...');
    const si = await createStockInward(page, bill, { dryRun });
    say(`Stock Inward done (posted=${si && si.posted}).`);

    await context.close();
    return { ok: true, grn, dryRun, log, netCheck };
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
    return { ok: false, error: String(e && e.message ? e.message : e), log, pageInfo, netCheck };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { pushBillToPact };
