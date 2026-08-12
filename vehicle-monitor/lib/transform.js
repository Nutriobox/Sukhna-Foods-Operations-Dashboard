// Turns the tracker's raw GPS report into your Vehicle Movement Monitoring rows.
// Real engine: parse pings -> detect stops -> split into trips -> sample location
// at +30/+60/+90/+120 min -> geocode -> compute travel & dwell time -> remarks.
//
// Fill OUTLET_MASTER with your outlets/depot (name + GPS) to get outlet names.
// Until then, locations fall back to Google road names (or raw coords if no key).

const XLSX = require('xlsx');
const { reverseGeocode } = require('./geocode');

// ---------------- CONFIG YOU FILL ----------------
// Coords: in Google Maps, right-click a place and click the "lat, lng" to copy.
const OUTLET_MASTER = [
  { name: 'NutrioBox (NOIDA Sec 63) - Depot', lat: 28.622065, lng: 77.378595 },
  { name: 'NutrioBox (Karkardooma)',          lat: 28.647022, lng: 77.301812 },
  { name: 'NutrioBox (Shivalik)',             lat: 28.534033, lng: 77.206580 },
  { name: 'NutrioBox (Dwarka)',               lat: 28.590219, lng: 77.063095 },
  { name: 'NutrioBox (Janakpuri East)',       lat: 28.629161, lng: 77.091315 },
  { name: 'NutrioBox (Prashant Vihar)',       lat: 28.712555, lng: 77.135933 },
  { name: 'NutrioBox (DLF Phase 2, Gurugram)',lat: 28.481197, lng: 77.085821 },
  { name: 'NutrioBox (Advant Navis, Sec 142)',lat: 28.501322, lng: 77.409636 },
  { name: 'NutrioBox (Sector 15, Gurgaon)',   lat: 28.457898, lng: 77.044700 },
  { name: 'NutrioBox (Rajinder Nagar)',        lat: 28.638266, lng: 77.180401 },
];
const RADIUS_M   = 300;               // a stop within this many metres of an outlet = that outlet
const STOP_MIN   = 5;                 // stationary >= this many minutes counts as a stop
const INTERVALS  = [30, 60, 90, 120]; // minutes after dispatch to record location
const MIN_TRIP_M = 500;               // ignore 'trips' shorter than this (depot yard shuffling)
// -------------------------------------------------

function haversine(aLat, aLng, bLat, bLng) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function parseTime(s) {
  const m = String(s).match(/(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}
const hhmm = (d) => d ? String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0') : '';
function dur(ms) {
  const min = Math.round(ms / 60000);
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}
function nearestOutlet(lat, lng) {
  let best = null, bestD = Infinity;
  for (const o of OUTLET_MASTER) {
    const d = haversine(lat, lng, o.lat, o.lng);
    if (d < bestD) { bestD = d; best = o; }
  }
  return (best && bestD <= RADIUS_M) ? best.name : null;
}

function parseVehicleSheet(ws) {
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  const h = aoa.findIndex((r) => r.some((c) => String(c).trim() === 'Latitude'));
  if (h < 0) return [];
  const col = {};
  aoa[h].forEach((c, i) => { col[String(c).trim()] = i; });
  const pings = [];
  for (let r = h + 1; r < aoa.length; r++) {
    const row = aoa[r];
    const t = parseTime(row[col['Time']]);
    const lat = parseFloat(row[col['Latitude']]);
    const lng = parseFloat(row[col['Longitude']]);
    if (!t || isNaN(lat) || isNaN(lng)) continue;
    const speed = parseFloat(String(row[col['Speed']]).replace(/[^\d.]/g, '')) || 0;
    pings.push({ t, lat, lng, speed });
  }
  return pings;
}
function detectStops(pings) {
  const stops = []; let i = 0;
  while (i < pings.length) {
    if (pings[i].speed === 0) {
      let j = i;
      while (j + 1 < pings.length && pings[j + 1].speed === 0) j++;
      const min = (pings[j].t - pings[i].t) / 60000;
      if (min >= STOP_MIN) stops.push({ start: pings[i].t, end: pings[j].t, min, lat: pings[i].lat, lng: pings[i].lng });
      i = j + 1;
    } else i++;
  }
  return stops;
}
function sampleAt(pings, when) {
  let best = null, bestD = Infinity;
  for (const p of pings) { const d = Math.abs(p.t - when); if (d < bestD) { bestD = d; best = p; } }
  return best;
}
async function label(lat, lng, apiKey) {
  const o = nearestOutlet(lat, lng);
  if (o) return o;
  if (apiKey) { const g = await reverseGeocode(lat, lng, apiKey); if (g.road) return g.road; if (g.locality) return g.locality; }
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}
function remark(travelMs) {
  const min = travelMs / 60000;
  for (const t of INTERVALS) if (min <= t) return `Outlet reached before ${t < 60 ? t + ' min' : (t/60) + ' hr'}`.replace('1.5 hr','1 hr 30 min');
  return 'Outlet reached after 2 hr';
}

// Returns an array of target rows (objects keyed by target column).
async function buildSummary(sourcePath, apiKey) {
  const wb = XLSX.readFile(sourcePath);
  const rows = [];
  let sr = 0;
  for (const sheetName of wb.SheetNames) {
    const pings = parseVehicleSheet(wb.Sheets[sheetName]);
    if (pings.length < 2) continue;
    const stops = detectStops(pings);
    for (let k = 0; k + 1 < stops.length; k++) {
      const a = stops[k], b = stops[k + 1];
      const dispatch = a.end, arrive = b.start;
      const travelMs = arrive - dispatch;
      if (travelMs <= 0) continue;
      if (haversine(a.lat, a.lng, b.lat, b.lng) < MIN_TRIP_M) continue; // drop non-trips
      const legPings = pings.filter((p) => p.t >= dispatch && p.t <= arrive);
      if (legPings.length < 2) continue;

      sr++;
      const row = {
        'Sr No.': sr,
        'Vehicle No.': sheetName.trim(),
        'Driver Name': '',
        'Attendant Name': '',
        'Start Destination': await label(a.lat, a.lng, apiKey),
        'Finished Destination': await label(b.lat, b.lng, apiKey),
        'Dispatch Time': hhmm(dispatch),
      };
      const cols = [
        ['After 30 Min Location', 'Time '],
        ['After 1 Hr Location', 'Time'],
        ['After 1 Hr 30 Min Location', 'Time '],
        ['After 2 Hr Location', 'Time'],
      ];
      for (let n = 0; n < INTERVALS.length; n++) {
        const when = new Date(dispatch.getTime() + INTERVALS[n] * 60000);
        if (when <= arrive) {
          const p = sampleAt(legPings, when);
          row[cols[n][0]] = await label(p.lat, p.lng, apiKey);
          row[cols[n][1]] = hhmm(when);
        } else { row[cols[n][0]] = ''; row[cols[n][1]] = ''; }
      }
      row['Outlet Reached Location'] = row['Finished Destination'];
      row['Total Travel Time '] = dur(travelMs);
      row['Time Spent at Outlet'] = dur(b.min * 60000);
      row['Remarks'] = remark(travelMs);
      rows.push(row);
    }
  }
  return rows;
}

const TARGET_COLUMNS = ['Sr No.','Vehicle No.','Driver Name','Attendant Name','Start Destination',
  'Finished Destination','Dispatch Time','After 30 Min Location','Time ','After 1 Hr Location','Time',
  'After 1 Hr 30 Min Location','Time ','After 2 Hr Location','Time','s','Time ','Outlet Reached Location',
  'Total Travel Time ','Time Spent at Outlet','Remarks'];

function writeTargetExcel(rows, outPath) {
  const ws = XLSX.utils.json_to_sheet(rows, { header: TARGET_COLUMNS });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Vehicle Movement');
  XLSX.writeFile(wb, outPath);
  return outPath;
}

module.exports = { buildSummary, writeTargetExcel };
