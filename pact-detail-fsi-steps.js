const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: false
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    serviceWorkers: 'block'
  });
  await context.routeFromHAR('C:\\Users\\hp\\Documents\\GitHub\\Sukhna-Foods-Operations-Dashboard\\pact-detail-fsi.har');
  const page = await context.newPage();
  await page.goto('http://140.245.255.130:8443/PACTALLUSUREWEB/#/login');
  await page.getByRole('textbox', { name: 'Enter User Name' }).fill('carahul');
  await page.getByRole('textbox', { name: 'Password' }).click();
  await page.getByRole('textbox', { name: 'Password' }).fill('123');
  await page.getByRole('button', { name: 'Select' }).click();
  await page.getByRole('listitem', { name: 'BI' }).locator('i').click();
  await page.getByRole('link', { name: 'List of Reports' }).click();
  await page.getByRole('textbox', { name: 'Search...' }).click();
  await page.getByRole('textbox', { name: 'Search...' }).fill('factory sales invoice');
  await page.getByRole('textbox', { name: 'Search...' }).press('Enter');
  await page.getByText('Detail Factory Sales Invoices').dblclick();
  await page.locator('app-pactdatepicker').filter({ hasText: 'From Value' }).getByRole('button').click();
  await page.getByRole('button', { name: '›' }).dblclick();
  await page.getByRole('button', { name: '›' }).click();
  await page.locator('app-costcenterfilter:nth-child(2) > .CCFilter_div > .CCFilter').click();
  await page.getByRole('button', { name: 'OK' }).click();
  await page.getByRole('button', { name: ' Export' }).click();
  await page.getByText('Grid XLS').click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const download = await downloadPromise;
  await page.close();

  // ---------------------
  await context.close();
  await browser.close();
})();