// Fetches the day's raw GPS route for each active vehicle straight from the OneLap
// (Traccar) API and writes it into the SAME per-vehicle spreadsheet that
// transform.js already parses (columns: Time, Latitude, Longitude, Speed).
// This replaces the fragile ExtJS portal download (button clicks) with stable API calls.
const XLSX = require('xlsx');
const path = require('path');
const BASE = 'https://web.onelap.in';

function pad(n){ return String(n).padStart(2,'0'); }
// epoch ms -> "YYYY.MM.DD HH:MM:SS" in IST (matches transform.js parseTime)
function istStamp(ms){
  const d = new Date(ms + 5.5*3600*1000);
  return `${d.getUTCFullYear()}.${pad(d.getUTCMonth()+1)}.${pad(d.getUTCDate())} `+
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// Build the source workbook from already-fetched route data (pure, unit-testable).
// vehicles = [{ name, pings: [{ t:epochMs, lat, lng, speedKmh }] }]
function writeSourceXlsx(vehicles, outPath){
  const wb = XLSX.utils.book_new();
  let added = 0;
  for (const v of vehicles){
    if (!v.pings || v.pings.length < 2) continue;
    const aoa = [['Time','Latitude','Longitude','Speed']];
    for (const p of v.pings){
      const spd = p.speedKmh < 3 ? 0 : Math.round(p.speedKmh); // floor jitter so parked pings register as stops
      aoa.push([ istStamp(p.t), Number(p.lat.toFixed(6)), Number(p.lng.toFixed(6)), spd ]);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, ws, String(v.name).trim().substring(0,31));
    added++;
  }
  if (!added) throw new Error('No active vehicles with route data.');
  XLSX.writeFile(wb, outPath);
  return outPath;
}

async function login(user, pass){
  const res = await fetch(BASE+'/api/session', {
    method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body: new URLSearchParams({ email:user, password:pass }),
  });
  if (res.status !== 200) throw new Error('OneLap login failed (HTTP '+res.status+'). Check TRACKER_USER / TRACKER_PASSWORD in .env');
  const raw = res.headers.get('set-cookie') || '';
  const cookie = raw.split(/,(?=[^;]+=[^;]+)/).map(s=>s.split(';')[0].trim()).filter(s=>s.includes('=')).join('; ');
  let name = '';
  try { name = (await res.json()).name; } catch(e){}
  return { cookie, name };
}
async function api(cookie, p, params){
  const url = new URL(BASE + p);
  Object.entries(params||{}).forEach(([k,v]) => url.searchParams.set(k, v));
  const r = await fetch(url, { headers: { Accept:'application/json', Cookie: cookie } });
  if (!r.ok) throw new Error(p + ' -> HTTP ' + r.status);
  return r.json();
}

async function downloadViaApi(outDir){
  const user = process.env.TRACKER_USER, pass = process.env.TRACKER_PASSWORD;
  if (!user || !pass) throw new Error('TRACKER_USER / TRACKER_PASSWORD not set in .env');
  const { cookie, name } = await login(user, pass);
  console.log('Logged into OneLap as', name || '(unknown)');

  const now = new Date();
  let y = now.getFullYear(), mo = now.getMonth(), d = now.getDate();
  if (process.env.REPORT_DATE){ const [yy,mm,dd] = process.env.REPORT_DATE.split('-').map(Number); y=yy; mo=mm-1; d=dd; }
  const istMidnightUTC = Date.UTC(y, mo, d) - 5.5*3600*1000;      // 00:00 IST of target day
  const from = new Date(istMidnightUTC).toISOString();
  const to   = process.env.REPORT_DATE ? new Date(istMidnightUTC + 24*3600*1000 - 1000).toISOString() : now.toISOString();
  console.log('Window:', from, '->', to);

  const devices = await api(cookie, '/api/devices');
  const vehicles = [];
  for (const dv of devices){
    const summ = await api(cookie, '/api/reports/summary', { deviceId: dv.id, from, to });
    const km = (summ[0] && summ[0].distance) ? summ[0].distance/1000 : 0;
    if (km < 3){ console.log('  skip', String(dv.name).trim(), `(${km.toFixed(1)} km — no run)`); continue; }
    const route = await api(cookie, '/api/reports/route', { deviceId: dv.id, from, to });
    const pings = route.map(p => ({
      t: Date.parse(p.fixTime || p.deviceTime),
      lat: +p.latitude, lng: +p.longitude, speedKmh: (p.speed||0)*1.852,
    })).filter(p => Number.isFinite(p.t) && Number.isFinite(p.lat));
    console.log('  ', String(dv.name).trim(), `${km.toFixed(1)} km, ${pings.length} pings`);
    vehicles.push({ name: dv.name, pings });
  }
  const stamp = from.substring(0,10);
  return writeSourceXlsx(vehicles, path.join(outDir, `onelap-${stamp}.xlsx`));
}

module.exports = { downloadViaApi, writeSourceXlsx };
