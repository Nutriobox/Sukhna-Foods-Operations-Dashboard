const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: false
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    serviceWorkers: 'block'
  });
  await context.routeFromHAR('C:\\Users\\hp\\Documents\\GitHub\\Sukhna-Foods-Operations-Dashboard\\pact-outlet-pending.har');
  const page = await context.newPage();
  await page.goto('http://140.245.255.130:8443/PACTALLUSUREWEB/#/login');
  await page.getByRole('textbox', { name: 'Enter User Name' }).fill('carahul');
  await page.getByRole('textbox', { name: 'Password' }).click();
  await page.getByRole('textbox', { name: 'Password' }).fill('123');
  await page.getByRole('button', { name: 'Select' }).click();
  await page.getByRole('listitem', { name: 'BI' }).locator('i').click();
  await page.getByRole('link', { name: 'List of Reports' }).click();
  await page.getByRole('textbox', { name: 'Search...' }).click();
  await page.getByRole('textbox', { name: 'Search...' }).fill('pending outlet requisit quantity');
  await page.getByRole('button').filter({ hasText: /^$/ }).click();
  await page.getByText('Pending Outlet Requisition').dblclick();
  await page.locator('app-pactdatepicker').filter({ hasText: 'From Value' }).getByRole('button').click();
  await page.getByRole('button', { name: '›' }).click();
  await page.getByRole('button', { name: '›' }).click();
  await page.getByRole('button', { name: '›' }).click();
  await page.getByRole('button', { name: '›' }).click();
  await page.getByText('4', { exact: true }).first().click();
  await page.locator('app-pactdatepicker:nth-child(5) > .Pact_TimerControl > div > .List__button').click();
  await page.getByText('5', { exact: true }).first().click();
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