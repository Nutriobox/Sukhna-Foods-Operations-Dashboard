// Test just the Goods Gate Entry, in DRY-RUN (stops before Post — nothing committed).
// Run:  node test-gge.js       (dry run, safe)
//       set DRY_RUN=false in .env to actually post.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { createGoodsGateEntry } = require('./lib/gge');

(function loadEnv(){
  const p = path.join(__dirname, '.env'); if(!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p,'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if(m&&!process.env[m[1]]) process.env[m[1]]=m[2];
  }
})();

async function main(){
  const bills = JSON.parse(fs.readFileSync(path.join(__dirname,'bills.sample.json'),'utf8'));
  const dryRun = String(process.env.DRY_RUN||'true').toLowerCase() !== 'false';
  const user = process.env.PACT_USER, pass = process.env.PACT_PASSWORD;
  if(!user||!pass){ throw new Error('Set PACT_USER / PACT_PASSWORD in .env'); }

  const browser = await chromium.launch({ headless:false });
  const ctx = await browser.newContext({ ignoreHTTPSErrors:true });
  const page = await ctx.newPage();

  console.log('Logging in...');
  await page.goto('http://140.245.255.130:8443/PACTALLUSUREWEB/#/login', { waitUntil:'domcontentloaded', timeout: 60000 });
  await page.getByRole('textbox', { name: 'Enter User Name' }).fill(user);
  await page.getByRole('textbox', { name: 'Password' }).fill(pass);
  await page.getByRole('button', { name: 'Select' }).click();
  await page.waitForTimeout(4000);

  console.log(`Creating GGE for bill ${bills[0].billNo} (dryRun=${dryRun})...`);
  await createGoodsGateEntry(page, bills[0], { dryRun });

  console.log('Done. Leaving browser open 30s so you can inspect, then signing out.');
  await page.waitForTimeout(30000);
  await page.getByText('Signout', { exact: false }).click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await browser.close();
}
main().catch(e=>{ console.error('ERROR:', e.message); process.exit(1); });
