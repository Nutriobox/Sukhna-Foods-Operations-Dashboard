// Logs into PACT ERP.
// Selectors were captured from the REAL login page (verified live): the visible
// "Log in" button's accessible name is actually "Select", and the page offers
// English/Arabic language radios. Credentials come from PACT_USER / PACT_PASSWORD.
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
  await userBox.waitFor({ state: 'visible', timeout: 20000 });

  // Force English so field labels / routing are deterministic regardless of the
  // saved default language.
  await page.getByRole('radio', { name: 'English' }).check().catch(() => {});

  // Type char-by-char so Angular's form model registers each keystroke. A plain
  // fill() sets the DOM value but does not fire the per-key events the form binds
  // to, so in headless the login can submit empty and silently stay on #/login.
  await userBox.click();
  await userBox.fill('');
  await userBox.pressSequentially(String(user), { delay: 25 });
  await passBox.click();
  await passBox.fill('');
  await passBox.pressSequentially(String(password), { delay: 25 });
  await passBox.blur().catch(() => {});
  await page.waitForTimeout(300);

  // Error toast / alert selectors PACT (PACTSOFT / Angular) may use on a bad login.
  const ERR_SEL = [
    '.toast-message', '.toast-error', '#toast-container .toast', '.Toastify__toast--error',
    '.mat-snack-bar-container', 'snack-bar-container', '.alert-danger',
    '.swal2-html-container', '.swal2-title',
  ].join(', ');

  // Resolve 'success' once we leave the #/login route, or 'error:<text>' when an
  // error toast appears — whichever happens first, within `ms`.
  const settle = (ms) => Promise.race([
    page.waitForFunction(
      () => !String(location.hash || '').toLowerCase().includes('/login'),
      null,
      { timeout: ms }
    ).then(() => 'success').catch(() => null),
    page.waitForSelector(ERR_SEL, { timeout: ms })
      .then(async (el) => 'error:' + ((await el.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim())
      .catch(() => null),
  ]);

  // Primary submit: click the login button (accessible name "Select").
  await page.getByRole('button', { name: 'Select' }).click().catch(() => {});
  let outcome = await settle(12000);

  if (!outcome) {
    // Fallback for builds that only submit on Enter. (One extra attempt only, to
    // avoid hammering the account into a lockout.)
    await passBox.press('Enter').catch(() => {});
    outcome = await settle(8000);
  }

  if (outcome === 'success') {
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(800);
    return;
  }

  const said = outcome && outcome.startsWith('error:') ? outcome.slice(6) : '';
  throw new Error(
    'Login did not complete — still on /login' +
    (said ? ` · PACT said: "${said.slice(0, 160)}"` : ' (no error toast detected)') +
    '. Verify the PACT_USER / PACT_PASSWORD GitHub secrets, and that the PACT account is not locked from repeated failed attempts.'
  );
}

module.exports = { login };
