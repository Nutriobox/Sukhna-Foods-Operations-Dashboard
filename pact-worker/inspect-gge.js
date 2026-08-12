// Logs into PACT, opens Goods Gate Entry, and captures the popup dialog so we can
// see its real structure. Produces gge-modal.png + gge-modal.html + gge-buttons.json
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(function loadEnv(){
  const p = path.join(__dirname,'.env'); if(!fs.existsSync(p)) return;
  for (const l of fs.readFileSync(p,'utf8').split(/\r?\n/)){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2];}
})();

async function main(){
  const browser = await chromium.launch({ headless:false });
  const ctx = await browser.newContext({ ignoreHTTPSErrors:true });
  const page = await ctx.newPage();

  await page.goto('http://140.245.255.130:8443/PACTALLUSUREWEB/#/login', { waitUntil:'load' });
  await page.getByRole('textbox', { name: 'Enter User Name' }).fill(process.env.PACT_USER);
  await page.getByRole('textbox', { name: 'Password' }).fill(process.env.PACT_PASSWORD);
  await page.getByRole('button', { name: 'Select' }).click();
  await page.waitForTimeout(4000);

  console.log('Opening Goods Gate Entry...');
  await page.getByRole('link', { name: 'Goods Gate Entry', exact: true }).click();
  await page.waitForTimeout(5000); // let the popup render

  await page.screenshot({ path: path.join(__dirname,'gge-modal.png'), fullPage:true });
  fs.writeFileSync(path.join(__dirname,'gge-modal.html'), await page.content());

  // Dump the visible dialog's buttons, inputs, and list buttons
  const info = await page.evaluate(() => {
    const vis = (el)=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0;};
    const out = { buttons:[], inputs:[], listButtons:[], dialogs:[] };
    document.querySelectorAll('modal-container, app-document-number, .modal.show').forEach(m=>{ if(vis(m)) out.dialogs.push(m.tagName.toLowerCase()+'.'+(m.className||'').slice(0,40)); });
    document.querySelectorAll('button').forEach(b=>{ if(vis(b)) out.buttons.push((b.textContent||'').trim().slice(0,30)); });
    document.querySelectorAll('input').forEach(i=>{ if(vis(i)) out.inputs.push({id:i.id,name:i.getAttribute('name')||'',ph:i.getAttribute('placeholder')||''}); });
    document.querySelectorAll('.List__button').forEach(l=>{ if(vis(l)) out.listButtons.push((l.textContent||'').trim().slice(0,30)); });
    return out;
  });
  fs.writeFileSync(path.join(__dirname,'gge-buttons.json'), JSON.stringify(info,null,2));
  console.log('Saved gge-modal.png, gge-modal.html, gge-buttons.json');
  console.log('Visible dialogs:', info.dialogs);
  console.log('Visible buttons:', info.buttons);
  await page.waitForTimeout(2000);
  await browser.close();
}
main().catch(e=>{console.error(e);process.exit(1);});
