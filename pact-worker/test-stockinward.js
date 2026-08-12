// Test the Stock Inward (dry-run: pulls items from the posted GGE, then stops).
// Requires that a Goods Gate Entry for this bill is ALREADY POSTED in PACT.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { createStockInward } = require('./lib/stock-inward');

(function loadEnv(){
  const p = path.join(__dirname,'.env'); if(!fs.existsSync(p)) return;
  for (const l of fs.readFileSync(p,'utf8').split(/\r?\n/)){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2];}
})();

async function main(){
  const bills = JSON.parse(fs.readFileSync(path.join(__dirname,'bills.sample.json'),'utf8'));
  const dryRun = String(process.env.DRY_RUN||'true').toLowerCase() !== 'false';
  const browser = await chromium.launch({ headless:false });
  const ctx = await browser.newContext({ ignoreHTTPSErrors:true });
  const page = await ctx.newPage();

  console.log('Logging in...');
  await page.goto('http://140.245.255.130:8443/PACTALLUSUREWEB/#/login', { waitUntil:'domcontentloaded', timeout: 60000 });
  await page.getByRole('textbox', { name: 'Enter User Name' }).fill(process.env.PACT_USER);
  await page.getByRole('textbox', { name: 'Password' }).fill(process.env.PACT_PASSWORD);
  await page.getByRole('button', { name: 'Select' }).click();
  await page.waitForTimeout(4000);

  console.log(`Creating Stock Inward for bill ${bills[0].billNo} (dryRun=${dryRun})...`);
  await createStockInward(page, bills[0], { dryRun });

  console.log('Done. Leaving browser open 30s so you can inspect, then signing out.');
  await page.waitForTimeout(30000);
  await page.getByText('Signout', { exact: false }).click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await browser.close();
}
main().catch(e=>{ console.error('ERROR:', e.message); process.exit(1); });
