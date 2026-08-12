// Logs into OneLap, selects the active (green+yellow) vehicles, sets the report
// date (default: yesterday) from 10:00 to 19:00, runs the Route report, and
// downloads the Excel.
//
// OneLap is an ExtJS app whose numeric IDs shift between sessions. We therefore
// match fields by their STABLE id prefix/suffix (e.g. [id^="datefield-"][id$="-trigger-picker"])
// and never by the changing number.

const path = require('path');

const FROM_TIME = '10:00';
const TO_TIME = '19:00';

// Which day to pull. Default = yesterday. Set REPORT_DATE=YYYY-MM-DD in .env to force a day.
function targetDate() {
  if (process.env.REPORT_DATE) {
    const [y, m, d] = process.env.REPORT_DATE.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d;
}

async function getActiveDevices(page) {
  await page.waitForSelector('.view-color-green, .view-color-yellow, .view-color-red', { timeout: 30000 }).catch(() => {});
  return page.evaluate(() => {
    const names = [];
    document.querySelectorAll('.view-color-green, .view-color-yellow').forEach((cell) => {
      const row = cell.closest('tr, table');
      const nameCell = row && row.querySelector('.x-grid-cell-inner');
      const name = nameCell ? nameCell.textContent.trim() : '';
      if (name && !names.includes(name)) names.push(name);
    });
    return names;
  });
}

// OneLap's From/To fields accept typed values (date shows as YYYY-MM-DD, time as HH:MM).
// Typing straight into the input is far more reliable than clicking the calendar.
async function fillField(page, inputLocator, value) {
  await inputLocator.click();
  await inputLocator.press('Control+a');
  await inputLocator.press('Delete');
  await inputLocator.pressSequentially(value, { delay: 45 }); // real keystrokes so ExtJS registers
  await page.keyboard.press('Enter');                          // commit the typed value
  await page.waitForTimeout(300);
}

async function downloadReport(page, outDir) {
  const user = process.env.TRACKER_USER;
  const password = process.env.TRACKER_PASSWORD;
  if (!user || !password) throw new Error('TRACKER_USER / TRACKER_PASSWORD not set in .env');

  const date = targetDate();
  const day = date.getDate();
  console.log(`Report date: ${date.toDateString()}  (${FROM_TIME} - ${TO_TIME})`);

  // 1. Login
  await page.goto('https://web.onelap.in/', { waitUntil: 'networkidle' });
  await page.getByRole('textbox', { name: 'Phone:' }).fill(user);
  await page.getByRole('textbox', { name: 'Password:' }).fill(password);
  await page.locator('#checkbox-1015-displayEl').click({ timeout: 5000 }).catch(() => {});
  await page.getByRole('button', { name: 'Login' }).click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(5000);

  // 2. Active devices (green + yellow, skip red/offline)
  const devices = await getActiveDevices(page);
  console.log('Active devices:', devices.length ? devices.join(', ') : '(none)');
  if (devices.length === 0) throw new Error('No active devices found.');

  // 3. Open the Route report config
  await page.locator('#reportView-1054-placeholder-title-textEl').click({ timeout: 15000 }).catch(() => {});
  await page.locator('#combo-1059-trigger-picker').click(); // the "Type" dropdown (stable id)
  await page.getByRole('option', { name: 'Route' }).click();
  await page.locator('#button-1061').click({ timeout: 10000 }).catch(() => {});

  // 4. Select the active vehicles
  await page.locator('[id^="tagfield-"][id$="-trigger-picker"]').first().click();
  for (const v of devices) {
    await page.getByRole('option', { name: v, exact: true }).click({ timeout: 8000 }).catch(() => {});
  }
  await page.keyboard.press('Escape').catch(() => {});

  // 5. From/To date + time, typed directly (format = YYYY-MM-DD and HH:MM)
  const iso = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  const dateInputs = page.locator('[id^="datefield-"][id$="-inputEl"]');
  const timeInputs = page.locator('[id^="customTimeField-"][id$="-inputEl"]');
  await fillField(page, dateInputs.nth(0), iso);        // From date
  await fillField(page, timeInputs.nth(0), FROM_TIME);  // From time
  await fillField(page, dateInputs.nth(1), iso);        // To date
  await fillField(page, timeInputs.nth(1), TO_TIME);    // To time

  // 6. Save / generate
  await page.getByTitle('Save').click();

  // 7. Export -> download
  const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
  await page.locator('#button-1064').click();
  const download = await downloadPromise;

  const stamp = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  const filePath = path.join(outDir, `onelap-${stamp}.xlsx`);
  await download.saveAs(filePath);
  return filePath;
}

module.exports = { downloadReport, getActiveDevices };
