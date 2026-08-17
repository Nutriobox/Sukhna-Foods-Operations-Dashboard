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

  // Diagnostic: did the typed values actually register in Angular's form model?
  // (These inputs are `required` and there is no native <form>, so if the model
  // stays invalid the app's login() silently bails and we sit on /login.)
  const fieldState = await page.evaluate(() => {
    const g = (id) => { const e = document.querySelector(id); return e ? { len: (e.value || '').length, dirty: e.className.includes('ng-dirty'), valid: e.className.includes('ng-valid') } : null; };
    return { user: g('#txtUserName'), pass: g('#txtPassword'), hasForm: !!document.querySelector('form') };
  }).catch(() => null);
  console.log('[login] field state after typing:', JSON.stringify(fieldState));

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

  // Primary submit: click the VISIBLE "Log in" button. It is <button id="btnLogn"
  // type="submit">, but the page renders a DUPLICATE hidden copy with the same id
  // — clicking the hidden one silently no-ops and leaves you on /login (that was
  // the bug: the old name-based selector could resolve to the hidden duplicate).
  const loginBtn = page.locator('button#btnLogn:visible').first();
  await loginBtn.click({ timeout: 8000 }).catch(() => {});
  let outcome = await settle(10000);

  if (!outcome) {
    // Fallback 1: submit via Enter in the password field.
    await passBox.press('Enter').catch(() => {});
    outcome = await settle(6000);
  }
  if (!outcome) {
    // Fallback 2: submit the login form in-page (covers headless click quirks and
    // the hidden-duplicate button).
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button#btnLogn'));
      const b = btns.find((x) => x.offsetParent !== null) || btns[0];
      if (!b) return;
      const f = b.closest('form');
      if (f && typeof f.requestSubmit === 'function') f.requestSubmit(b);
      else b.click();
    }).catch(() => {});
    outcome = await settle(6000);
  }

  if (outcome === 'success') {
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(800);
    return;
  }

  let said = outcome && outcome.startsWith('error:') ? outcome.slice(6) : '';
  if (!said) {
    said = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('[role="alert"], .toast, .toast-message, .alert, .error, mat-error, .swal2-popup'))
        .map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
      if (els.length) return els[0];
      const m = (document.body.innerText || '').match(/(invalid|incorrect|wrong|locked|expired|not\s+found|failed|captcha)[^\n]{0,60}/i);
      return m ? m[0].trim() : '';
    }).catch(() => '');
  }
  throw new Error(
    'Login did not complete — still on /login' +
    (said ? ` · PACT said: "${said.slice(0, 160)}"` : ' (no visible error message)') +
    ` · fields=${JSON.stringify(fieldState)}` +
    '. If fields.user.valid is false the typed values did NOT register in the form model; ' +
    'otherwise verify the PACT_USER / PACT_PASSWORD secrets and that the account is not locked.'
  );
}

module.exports = { login };
