// One-off helper: logs into OneLap and captures the device list so we can see
// how "green" (online) devices are marked. Produces device-list.png + device-list.html.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(function loadEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
})();

async function main() {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  await page.goto('https://web.onelap.in/', { waitUntil: 'networkidle' });
  await page.getByRole('textbox', { name: 'Phone:' }).fill(process.env.TRACKER_USER);
  await page.getByRole('textbox', { name: 'Password:' }).fill(process.env.TRACKER_PASSWORD);
  await page.locator('#checkbox-1015-displayEl').click({ timeout: 5000 }).catch(() => {});
  await page.getByRole('button', { name: 'Login' }).click();
  await page.waitForLoadState('networkidle');

  console.log('Logged in. Waiting for the device list to load...');
  await page.waitForTimeout(7000); // let the left device list render

  await page.screenshot({ path: path.join(__dirname, 'device-list.png'), fullPage: true });
  fs.writeFileSync(path.join(__dirname, 'device-list.html'), await page.content());
  console.log('Saved device-list.png and device-list.html in the vehicle-monitor folder.');

  await page.waitForTimeout(2000);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
