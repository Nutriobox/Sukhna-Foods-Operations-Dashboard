const { chromium } = require('playwright');
const fs=require('fs'); const path=require('path');
const { login } = require('./lib/login');
const { createFactorySalesInvoice } = require('./lib/factory-sales-invoice');   // WIRED worker
(function(){const p=path.join(__dirname,'.env');if(!fs.existsSync(p))return;for(const l of fs.readFileSync(p,'utf8').split(/\r?\n/)){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2];}})();
(async()=>{
  const b=await chromium.launch({headless:true,executablePath:'/sessions/rcw-01xbmtm1xh6b1gitjlueetfa/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',args:['--window-size=1920,1080','--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
  const c=await b.newContext({ignoreHTTPSErrors:true,viewport:{width:1920,height:1080}}); const page=await c.newPage(); page.setDefaultTimeout(20000);
  await login(page); console.log('logged in');
  const order={soNumber:'FSOD-26-27/72',company:'Factory',customer:'Biryani By Kilo',barcodes:['FGO503_F2B034/31082603_7500','FG0298_F2B057/25082601_5760','FGO741_FNO739/07082601._14400']};
  const r=await createFactorySalesInvoice(page,order,{dryRun:false});
  console.log('RESULT:', JSON.stringify(r));
  await c.close(); await b.close();
})().catch(e=>{console.error('ERR',e.message.split(String.fromCharCode(10))[0]);process.exit(1);});
