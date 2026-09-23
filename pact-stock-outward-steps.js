const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: false
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    serviceWorkers: 'block'
  });
  await context.routeFromHAR('C:\\Users\\hp\\Documents\\GitHub\\Sukhna-Foods-Operations-Dashboard\\pact-stock-outward.har');
  const page = await context.newPage();
  await page.goto('http://140.245.255.130:8443/PACTALLUSUREWEB/#/login');
  await page.getByRole('textbox', { name: 'Enter User Name' }).fill('carahul');
  await page.getByRole('textbox', { name: 'Password' }).click();
  await page.getByRole('textbox', { name: 'Password' }).fill('123');
  await page.getByRole('button', { name: 'Select' }).click();
  await page.getByRole('link', { name: 'Stock Outward to Outlet' }).click();
  await page.locator('.col-xl-6 > app-pactlistbox > app-plistview > .Control_flex > div > .List__button').click();
  await page.getByText('Factory', { exact: true }).click();
  await page.getByRole('button', { name: ' Ok' }).click();
  await page.locator('app-plistview > .Control_flex > div > .List__button').first().click();
  await page.getByText('NutrioBox ( DLF Phase 2)').click();
  await page.locator('div:nth-child(6) > app-pactlistbox > app-plistview > .Control_flex > div > .List__button').click();
  await page.getByText('Frozen').click();
  await page.getByRole('textbox', { name: 'Scan' }).click();
  await page.locator('div:nth-child(9) > app-pactlistbox > app-plistview > .Control_flex > div > .List__button').click();
  await page.locator('pact-listview').getByText('OMR-AF/26-27/1017').click();
  await page.getByRole('textbox', { name: 'Outlet ReqNo' }).click();
  await page.getByRole('textbox', { name: 'Outlet ReqNo' }).click();
  await page.getByRole('textbox', { name: 'Outlet ReqNo' }).press('ArrowRight');
  await page.getByRole('textbox', { name: 'Outlet ReqNo' }).press('ArrowRight');
  await page.getByRole('textbox', { name: 'Outlet ReqNo' }).press('ArrowRight');
  await page.getByRole('textbox', { name: 'Outlet ReqNo' }).press('ArrowRight');
  await page.getByRole('textbox', { name: 'Outlet ReqNo' }).press('ArrowRight');
  await page.getByRole('textbox', { name: 'Outlet ReqNo' }).press('ArrowRight');
  await page.getByRole('textbox', { name: 'Outlet ReqNo' }).press('ArrowRight');
  await page.getByRole('textbox', { name: 'Outlet ReqNo' }).press('ArrowRight');
  await page.getByRole('textbox', { name: 'Outlet ReqNo' }).fill('');
  await page.locator('pact-listview').getByText('OMR-AF/26-27/1063').click();
  await page.getByRole('textbox', { name: 'Outlet ReqNo' }).click();
  await page.getByRole('textbox', { name: 'Outlet ReqNo' }).press('ArrowRight');
  await page.getByRole('textbox', { name: 'Outlet ReqNo' }).press('ArrowRight');
  await page.getByRole('textbox', { name: 'Outlet ReqNo' }).press('ArrowRight');
  await page.getByRole('textbox', { name: 'Outlet ReqNo' }).press('ArrowRight');
  await page.getByRole('textbox', { name: 'Outlet ReqNo' }).press('ArrowRight');
  await page.getByRole('textbox', { name: 'Outlet ReqNo' }).press('ArrowRight');
  await page.getByRole('textbox', { name: 'Outlet ReqNo' }).press('ArrowRight');
  await page.getByRole('textbox', { name: 'Outlet ReqNo' }).press('ArrowRight');
  await page.getByRole('textbox', { name: 'Outlet ReqNo' }).fill('OMR-AF/26-27/106');
  await page.getByRole('textbox', { name: 'Outlet ReqNo' }).click();
  await page.getByRole('textbox', { name: 'Outlet ReqNo' }).press('ArrowRight');
  await page.getByRole('textbox', { name: 'Outlet ReqNo' }).press('ArrowRight');
  await page.getByRole('textbox', { name: 'Outlet ReqNo' }).press('ArrowRight');
  await page.getByRole('textbox', { name: 'Outlet ReqNo' }).press('ArrowRight');
  await page.getByRole('textbox', { name: 'Outlet ReqNo' }).press('ArrowRight');
  await page.getByRole('textbox', { name: 'Outlet ReqNo' }).press('ArrowRight');
  await page.getByRole('textbox', { name: 'Outlet ReqNo' }).press('ArrowRight');
  await page.getByRole('textbox', { name: 'Outlet ReqNo' }).fill('OMR-AF/26-27/1794');
  await page.locator('pact-listview').getByText('OMR-AF/26-27/1794').click();
  await page.getByRole('textbox', { name: 'Scan' }).click();
  await page.close();

  // ---------------------
  await context.close();
  await browser.close();
})();