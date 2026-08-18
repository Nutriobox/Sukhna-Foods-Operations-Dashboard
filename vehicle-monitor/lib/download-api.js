// Fetches the day's raw GPS route for each active vehicle from the OneLap (Traccar)
// API for the SAME 10:00-19:00 window OneLap's export uses, and writes it into the
// per-vehicle spreadsheet transform.js parses (Time, Latitude, Longitude, Speed).
// Also writes downloads/status-<date>.json classifying EVERY device (ran/parked/off).
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const BASE = 'https://web.onelap.in';
const FROM_H = 10, TO_H = 19;          // IST window, matches the OneLap download
const RAN_MIN_KM = 2;                   // moved >= this many km in the window => a real run

function pad(n){ return String(n).padStart(2,'0'); }
function istStamp(ms){
  const d = new Date(ms + 5.5*3600*1000);
  return `${d.getUTCFullYear()}.${pad(d.getUTCMonth()+1)}.${pad(d.getUTCDate())} `+
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
function hav(a,b,c,d){const R=6371000,r=x=>x*Math.PI/180;const dl=r(c-a),dn=r(d-b);const s=Math.sin(dl/2)**2+Math.cos(r(a))*Math.cos(r(c))*Math.sin(dn/2)**2;return 2*R*Math.asin(Math.sqrt(s));}

function writeSourceXlsx(vehicles, outPath){
  const wb = XLSX.utils.book_new(); let added=0;
  for (const v of vehicles){
    if (!v.pings || v.pings.length < 2) continue;
    const aoa=[['Time','Latitude','Longitude','Speed']];
    for (const p of v.pings){ const spd=p.speedKmh<3?0:Math.round(p.speedKmh);
      aoa.push([istStamp(p.t), Number(p.lat.toFixed(6)), Number(p.lng.toFixed(6)), spd]); }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), String(v.name).trim().substring(0,31)); added++;
  }
  if(!added) throw new Error('No vehicles ran in the window.');
  XLSX.writeFile(wb, outPath); return outPath;
}
async function login(user, pass){
  const res = await fetch(BASE+'/api/session',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:user,password:pass})});
  if (res.status!==200) throw new Error('OneLap login failed (HTTP '+res.status+'). Check TRACKER_USER / TRACKER_PASSWORD.');
  const raw=res.headers.get('set-cookie')||'';
  const cookie=raw.split(/,(?=[^;]+=[^;]+)/).map(s=>s.split(';')[0].trim()).filter(s=>s.includes('=')).join('; ');
  let name=''; try{ name=(await res.json()).name; }catch(e){}
  return { cookie, name };
}
async function api(cookie,p,params){
  const url=new URL(BASE+p); Object.entries(params||{}).forEach(([k,v])=>url.searchParams.set(k,v));
  const r=await fetch(url,{headers:{Accept:'application/json',Cookie:cookie}});
  if(!r.ok) throw new Error(p+' -> HTTP '+r.status); return r.json();
}
async function downloadViaApi(outDir){
  const user=process.env.TRACKER_USER, pass=process.env.TRACKER_PASSWORD;
  if(!user||!pass) throw new Error('TRACKER_USER / TRACKER_PASSWORD not set in .env');
  const { cookie, name }=await login(user,pass);
  console.log('Logged into OneLap as', name||'(unknown)');
  const now=new Date();
  let y=now.getFullYear(),mo=now.getMonth(),d=now.getDate();
  if(process.env.REPORT_DATE){const[yy,mm,dd]=process.env.REPORT_DATE.split('-').map(Number);y=yy;mo=mm-1;d=dd;}
  const from=new Date(Date.UTC(y,mo,d,FROM_H,0,0)-5.5*3600*1000).toISOString();  // 10:00 IST
  const to  =new Date(Date.UTC(y,mo,d,TO_H,0,0)-5.5*3600*1000).toISOString();     // 19:00 IST
  console.log('Window (10:00-19:00 IST):', from, '->', to);
  const devices=await api(cookie,'/api/devices');
  const vehicles=[]; const status=[];
  for(const dv of devices){
    const nm=String(dv.name).trim();
    let route=[]; try{ route=await api(cookie,'/api/reports/route',{deviceId:dv.id,from,to}); }catch(e){ route=[]; }
    const pings=route.map(p=>({t:Date.parse(p.fixTime||p.deviceTime),lat:+p.latitude,lng:+p.longitude,speedKmh:(p.speed||0)*1.852})).filter(p=>Number.isFinite(p.t)&&Number.isFinite(p.lat));
    let dist=0; for(let k=0;k+1<pings.length;k++)dist+=hav(pings[k].lat,pings[k].lng,pings[k+1].lat,pings[k+1].lng);
    const km=dist/1000;
    let st;
    if(pings.length<3){ st='off'; }
    else if(km<RAN_MIN_KM){ st='parked'; }
    else { st='ran'; vehicles.push({name:dv.name,pings}); }
    status.push({device:nm, status:st, km:+km.toFixed(1), pings:pings.length});
    console.log(`  ${nm.padEnd(20)} : ${st.toUpperCase()} (${km.toFixed(1)} km, ${pings.length} pings)`);
  }
  const stamp=`${y}-${pad(mo+1)}-${pad(d)}`;
  fs.writeFileSync(path.join(outDir,`status-${stamp}.json`), JSON.stringify({date:stamp,window:'10:00-19:00 IST',devices:status},null,1));
  if(!vehicles.length) throw new Error('No vehicles ran on '+stamp+' (all parked/off).');
  return writeSourceXlsx(vehicles, path.join(outDir,`onelap-${stamp}.xlsx`));
}
module.exports={ downloadViaApi, writeSourceXlsx };
