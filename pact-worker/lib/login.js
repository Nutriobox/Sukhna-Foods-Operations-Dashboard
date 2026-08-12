// Logs into PACT ERP.
// Selectors below were captured from the REAL login page with Playwright codegen.
async function login(page) {
  const url = process.env.PACT_URL || 'http://140.245.255.130:8443/PACTALLUSUREWEB/#/login';
  const user = process.env.PACT_USER;
  const password = process.env.PACT_PASSWORD;
  if (!user || !password) {
    throw new Error('PACT_USER / PACT_PASSWORD not set. Copy .env.example to .env and fill them in.');
  }

  await page.goto(url, { waitUntil: 'load' });
  await page.getByRole('textbox', { name: 'Enter User Name' }).fill(user);
  await page.getByRole('textbox', { name: 'Password' }).fill(password);
  await page.getByRole('button', { name: 'Select' }).click();

  // Wait for the home screen to appear after login.
  // The Flows/home page shows the company footer — good "we're logged in" signal.
  // TODO(confirm during recording): adjust the text if needed.
  await page.getByText('Company Name', { exact: false }).waitFor({ timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
}

module.exports = { login };
