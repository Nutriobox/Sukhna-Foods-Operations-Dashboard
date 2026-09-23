const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: false
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    serviceWorkers: 'block'
  });
  await context.routeFromHAR('C:\\Users\\hp\\Documents\\GitHub\\Sukhna-Foods-Operations-Dashboard\\pact-outlet-req.har');
  const page = await context.newPage();
  await page.goto('http://140.245.255.130:8443/PACTALLUSUREWEB/#/login');
  await page.getByRole('textbox', { name: 'Enter User Name' }).fill('carahul');
  await page.getByRole('textbox', { name: 'Password' }).click();
  await page.getByRole('textbox', { name: 'Password' }).fill('123');
  await page.getByRole('button', { name: 'Select' }).click();
  await page.getByRole('link', { name: 'Outlet Material Requisition' }).first().click();
  await page.locator('.col-xl-6 > app-pactlistbox > app-plistview > .Control_flex > div > .List__button').click();
  await page.getByText('Factory', { exact: true }).click();
  await page.getByRole('button', { name: ' Ok' }).click();
  await page.locator('app-plistview > .Control_flex > div > .List__button').first().click();
  await page.getByText('Frozen').click();
  await page.locator('div:nth-child(2) > app-pactlistbox > app-plistview > .Control_flex > div > .List__button').click();
  await page.getByText('NutrioBox ( DLF Phase 2)').click();
  await page.getByRole('gridcell', { description: 'Product Name', exact: true }).first().click();
  await page.locator('[id="10"]').click();
  await page.locator('[id="10"]').fill('Paneer Peri');
  await page.getByText('Paneer Peri-Peri-8 Pcs (6*1 cm)', { exact: true }).click();
  await page.getByRole('gridcell').nth(5).click();
  await page.getByRole('gridcell', { name: '1.00' }).click();
  await page.getByRole('gridcell', { name: '1.00' }).locator('input[type="text"]').fill('2');
  await page.getByRole('gridcell', { name: '1.00' }).locator('input[type="text"]').press('Enter');
  await page.getByRole('gridcell', { name: '1.00' }).click();
  await page.locator('[id="10"]').fill('Whole Wheat Chick');
  await page.getByRole('gridcell', { name: '1.00' }).locator('input[type="text"]').fill('2');
  await page.getByRole('gridcell', { description: 'Product Name', exact: true }).nth(2).click();
  await page.locator('[id="10"]').fill('Alfredo ');
  await page.getByText('Alfredo Sauce (20 Pkt/Bunch)').click();
  await page.getByRole('gridcell', { description: 'Base Qty', exact: true }).nth(2).click();
  await page.getByRole('gridcell', { name: '1.00' }).locator('input[type="text"]').fill('5');
  await page.getByRole('gridcell', { description: 'Product Name', exact: true }).nth(3).click();
  await page.locator('[id="10"]').fill('Avocado');
  await page.locator('[id="10"]').click();
  await page.locator('[id="10"]').fill('Avocado()');
  await page.locator('[id="10"]').press('ArrowLeft');
  await page.locator('[id="10"]').fill('Avocado(3)');
  await page.locator('[id="10"]').click();
  await page.locator('[id="10"]').fill('');
  await page.getByRole('button', { name: ' Post' }).click();
  await page.close();

  // ---------------------
  await context.close();
  await browser.close();
})();