// Server-side runner: create Factory Sales Invoice(s) in PACT from scanned orders.
// Usage:  node run-fsi.js [orders.json]
//   DRY_RUN=true  (default) fills everything but STOPS before Post (safe).
//   DRY_RUN=false actually posts.
//   FSI_DIAG=1    dumps the invoice form (fsi-form.html) and stops.
//   HEADLESS=true run without a visible browser (for servers / GitHub Actions).

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { login } = require('./lib/login');
const { createFactorySalesInvoice } = require('./lib/factory-sales-invoice');

// Minimal .env loader (same as run.js).
(function loadEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
})();

async function main() {
  const ordersPath = process.argv[2] || path.join(__dirname, 'fsi.sample.json');
  const parsed = JSON.parse(fs.readFileSync(ordersPath, 'utf8'));
  const orders = Array.isArray(parsed) ? parsed : [parsed];
  const headless = String(process.env.HEADLESS).toLowerCase() === 'true';
  const dryRun = String(process.env.DRY_RUN).toLowerCase() !== 'false'; // safe default: dry run

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  console.log('Logging into PACT...');
  await login(page);
  console.log('Logged in.\n');

  const results = [];
  for (const order of orders) {
    try {
      console.log(`Factory Sales Invoice for SO ${order.soNumber} (${(order.barcodes || []).length} items)...`);
      const r = await createFactorySalesInvoice(page, order, { dryRun });
      results.push({ so: order.soNumber, status: r.posted ? 'POSTED' : (r.diag ? 'DIAG' : 'FILLED(dry)'), ...r });
    } catch (e) {
      console.error(`  -> FAILED: ${e.message}`);
      results.push({ so: order.soNumber, status: 'FAILED', reason: e.message });
    }
  }

  await context.close();
  await browser.close();
  console.log('\nSummary:');
  console.table(results);
}

main().catch((e) => { console.error(e); process.exit(1); });
