// Opens the OneLap Route report config and dumps the form's fields (ids, labels,
// positions) + a screenshot + HTML, so we can target each box precisely.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(function loadEnv(){
  const p = path.join(__dirname, '.env'); if(!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p,'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if(m&&!process.env[m[1]]) process.env[m[1]]=m[2];
  }
})();

async function main(){
  const browser = await chromium.launch({ headless:false });
  const ctx = await browser.newContext({ ignoreHTTPSErrors:true });
  const page = await ctx.newPage();

  await page.goto('https://web.onelap.in/', { waitUntil:'networkidle' });
  await page.getByRole('textbox',{name:'Phone:'}).fill(process.env.TRACKER_USER);
  await page.getByRole('textbox',{name:'Password:'}).fill(process.env.TRACKER_PASSWORD);
  await page.locator('#checkbox-1015-displayEl').click({timeout:5000}).catch(()=>{});
  await page.getByRole('button',{name:'Login'}).click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(5000);

  // Open the report config the same way the recording did
  await page.locator('#reportView-1054-placeholder-title-textEl').click({timeout:15000}).catch(()=>{});
  await page.locator('[id^="combo-"][id$="-trigger-picker"]').first().click().catch(()=>{});
  await page.getByRole('option',{name:'Route'}).click({timeout:8000}).catch(()=>{});
  await page.locator('#button-1061').click({timeout:10000}).catch(()=>{});
  await page.waitForTimeout(2500);

  // Collect every visible form field with its id, label, placeholder, position
  const fields = await page.evaluate(() => {
    const out = [];
    const els = document.querySelectorAll('input, [id*="datefield"], [id*="customTimeField"], [id*="tagfield"], [id*="combo"], [id*="datepicker"]');
    els.forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      let label = '';
      const field = el.closest('.x-field, table');
      const lbl = field && field.querySelector('.x-form-item-label, label, .x-form-item-label-inner');
      if (lbl) label = lbl.textContent.trim();
      out.push({ id: el.id||'', tag: el.tagName, type: el.getAttribute('type')||'',
                 name: el.getAttribute('name')||'', ph: el.getAttribute('placeholder')||'',
                 value: (el.value||'').slice(0,30), label, x: Math.round(r.x), y: Math.round(r.y) });
    });
    return out.sort((a,b)=> a.y-b.y || a.x-b.x);
  });
  fs.writeFileSync(path.join(__dirname,'report-fields.json'), JSON.stringify(fields, null, 2));
  await page.screenshot({ path: path.join(__dirname,'report-form.png'), fullPage:true });
  fs.writeFileSync(path.join(__dirname,'report-form.html'), await page.content());
  console.log('Saved report-fields.json, report-form.png, report-form.html');
  console.log('Fields found:', fields.length);
  await page.waitForTimeout(2000);
  await browser.close();
}
main().catch(e=>{console.error(e);process.exit(1);});
