const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { login } = require('./lib/login');
const { enterStockInward } = require('./lib/stock-inward');

// Minimal .env loader so we don't need an extra dependency.
(function loadEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
})();

async function main() {
  const billsPath = process.argv[2] || path.join(__dirname, 'bills.sample.json');
  const bills = JSON.parse(fs.readFileSync(billsPath, 'utf8'));
  const headless = String(process.env.HEADLESS).toLowerCase() === 'true';

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  console.log('Logging into PACT...');
  await login(page);
  console.log('Logged in.\n');

  const results = [];
  for (const bill of bills) {
    try {
      console.log(`Entering invoice ${bill.invoice} (${bill.items.length} items)...`);
      const voucher = await enterStockInward(page, bill);
      console.log(`  -> voucher ${voucher}`);
      results.push({ invoice: bill.invoice, status: 'SUCCESS', voucher });
    } catch (e) {
      console.error(`  -> FAILED: ${e.message}`);
      results.push({ invoice: bill.invoice, status: 'FAILED', reason: e.message });
    }
  }

  await context.close();
  await browser.close();
  console.log('\nSummary:');
  console.table(results);
}

main().catch((e) => { console.error(e); process.exit(1); });
