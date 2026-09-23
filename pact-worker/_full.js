const { chromium } = require('playwright');
const fs=require('fs'); const path=require('path');
const { login } = require('./lib/login');
(function(){const p=path.join(__dirname,'.env');if(!fs.existsSync(p))return;for(const l of fs.readFileSync(p,'utf8').split(/\r?\n/)){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2];}})();
const CR=String.fromCharCode(10);
(async()=>{
  const b=await chromium.launch({headless:true,args:['--window-size=1920,1080','--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
  const c=await b.newContext({ignoreHTTPSErrors:true,viewport:{width:1920,height:1080}}); const page=await c.newPage(); page.setDefaultTimeout(20000);
  await login(page); console.log('logged in');
  await page.getByRole('link',{name:'Factory Sales Invoice',exact:true}).filter({visible:true}).first().click({timeout:15000}).catch(()=>{}); await page.waitForTimeout(2500);
  const vp=page.locator('modal-container.show').first();
  if(await vp.isVisible().catch(()=>false)){await vp.locator('.List__button').first().click().catch(()=>{});await page.waitForTimeout(700);await page.getByText('Factory',{exact:true}).first().click({timeout:8000}).catch(()=>{});await vp.getByRole('button',{name:'Ok'}).click({timeout:6000}).catch(()=>{});await vp.waitFor({state:'hidden',timeout:10000}).catch(()=>{});}
  await page.waitForTimeout(1500);
  const so=page.locator('#dcCCNID23').first(); await so.click({timeout:3000}).catch(()=>{}); await so.fill(''); await so.fill('FSOD-26-27/72'); await page.waitForTimeout(1800);
  await page.locator('.suggestions__list-name',{hasText:'FSOD-26-27/72'}).filter({visible:true}).first().click({timeout:8000}).catch(()=>{}); await page.waitForTimeout(1500);
  const cust=page.locator('[id="100"]').first(); await cust.click({timeout:3000}).catch(()=>{}); await cust.fill('Biryani By Kilo'); await page.waitForTimeout(1500);
  await page.locator('.suggestions__list-name').filter({visible:true}).first().click({timeout:5000}).catch(()=>{}); await page.waitForTimeout(1200);
  const scan=page.locator('#SKU').first();
  for(const bc of ['FGO503_F2B034/31082603_7500','FG0298_F2B057/25082601_5760','FGO741_FNO739/07082601._14400']){
    await scan.click({timeout:5000}).catch(()=>{}); await scan.fill(''); await scan.pressSequentially(bc,{delay:8}); await scan.press('Enter');
    for(let t=0;t<12;t++){await page.waitForTimeout(500); if((await scan.inputValue().catch(()=>''))!==bc)break;}
  }
  console.log('scanned');
  // sale type
  const cands=page.getByText('GST',{exact:true}); const n=await cands.count();
  for(let i=0;i<n;i++){await cands.nth(i).click({timeout:2500}).catch(()=>{}); await page.waitForTimeout(400); if(await page.locator('#dcCCNID64').first().isVisible().catch(()=>false))break;}
  const st=page.locator('#dcCCNID64').first(); await st.click({timeout:4000}).catch(()=>{}); await st.fill(''); await st.fill('InterStateB2B'); await page.waitForTimeout(1200);
  const opt=page.locator('.suggestions__list-name',{hasText:'InterStateB2B'}).filter({visible:true}).first();
  if(await opt.count().catch(()=>0)){await opt.click({timeout:4000}).catch(()=>{});} else {await st.press('Enter').catch(()=>{});}
  await page.waitForTimeout(1200);
  // re-fetch voucher number: click the search magnifier near Doc No
  await page.evaluate(()=>{const lbl=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&/^Doc No/i.test((e.textContent||'').trim()));if(!lbl)return;let box=lbl.parentElement;for(let i=0;i<3;i++)box=box&&box.parentElement;const btn=box&&box.querySelector('i.fa-search,[class*=search]');if(btn)btn.click();});
  await page.waitForTimeout(2500);
  const m2=page.locator('modal-container.show').first();
  if(await m2.isVisible().catch(()=>false)){await m2.locator('.List__button').first().click().catch(()=>{});await page.waitForTimeout(500);await page.getByText('Factory',{exact:true}).first().click({timeout:5000}).catch(()=>{});await m2.getByRole('button',{name:'Ok'}).click({timeout:5000}).catch(()=>{});await page.waitForTimeout(1500);}
  console.log('voucher re-fetched');
  // POST
  page.once('dialog',d=>d.accept().catch(()=>{}));
  await page.locator('button[title="Post"]').first().click({timeout:10000}).catch(()=>page.locator('button[title="Post"]').first().click({force:true}).catch(()=>{}));
  await page.waitForTimeout(4500);
  const draft=await page.getByText('Draft',{exact:true}).filter({visible:true}).count().catch(()=>0);
  const warn=(await page.getByText(/please select|cannot be blank|is required|mandatory|success|posted/i).filter({visible:true}).allInnerTexts().catch(()=>[])).join(' | ').replace(/\s+/g,' ').slice(0,180);
  console.log('AFTER POST -> draftBadge:',draft,'| msg:',JSON.stringify(warn));
  await page.screenshot({path:path.join(__dirname,'finalpost.png'),fullPage:true}).catch(()=>{});
  await c.close(); await b.close();
})().catch(e=>{console.error('ERR',e.message.split(CR)[0]);process.exit(1);});
