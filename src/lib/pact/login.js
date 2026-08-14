// Logs into PACT ERP.
// Selectors below were captured from the REAL login page with Playwright codegen.
async function login(page) {
  const url = process.env.PACT_URL || 'http://140.245.255.130:8443/PACTALLUSUREWEB/#/login';
  const user = process.env.PACT_USER;
  const password = process.env.PACT_PASSWORD || process.env.PACT_PASS;
  if (!user || !password) {
    throw new Error('PACT_USER / PACT_PASSWORD not set. Copy .env.example to .env and fill them in.');
  }

  await page.goto(url, { waitUntil: 'load' });

  const userBox = page.getByRole('textbox', { name: 'Enter User Name' });
  const passBox = page.getByRole('textbox', { name: 'Password' });
  await userBox.waitFor({ state: 'visible', timeout: 30000 });

  // Type char-by-char so Angular's form model registers the input. A plain
  // fill() sets the DOM value but does not fire the per-keystroke events the
  // form binds to, so in headless the login can submit empty and silently
  // stay on #/login (works headed only because focus/blur happen naturally).
  await userBox.click();
  await userBox.fill('');
  await userBox.pressSequentially(String(user), { delay: 30 });
  await passBox.click();
  await passBox.fill('');
  await passBox.pressSequentially(String(password), { delay: 30 });
  await passBox.blur().catch(() => {});
  await page.waitForTimeout(400);

  await page.getByRole('button', { name: 'Select' }).click();

  // Login has succeeded once the SPA routes away from the #/login hash.
  const offLogin = () => page.waitForFunction(
    () => !String(location.hash || '').toLowerCase().includes('/login'),
    null,
    { timeout: 25000 }
  );
  try {
    await offLogin();
  } catch {
    // Fallback: submit the form with Enter, then re-check.
    await passBox.press('Enter').catch(() => {});
    try {
      await page.waitForFunction(
        () => !String(location.hash || '').toLowerCase().includes('/login'),
        null,
        { timeout: 15000 }
      );
    } catch {
      let hint = '';
      try { hint = (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim().slice(0, 300); } catch {}
      throw new Error('Login did not complete — still on /login. On-screen text: ' + (hint || '(none)'));
    }
  }

  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1000);
}

module.exports = { login };
