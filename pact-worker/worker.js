// Always-on PACT sync worker (replaces the one lost when the old EC2 was
// terminated). Polls Supabase `pact_jobs` for queued SYNC jobs and runs the
// matching scraper, updating the job status the dashboard/app poll for:
//
//   payload.__sync = "inventory"            -> node scripts/sync-inventory.js
//   payload.__sync = "sales-orders"         -> node scripts/sync-sales-orders.js
//   payload.__sync = "outlet-requisitions"  -> node scripts/sync-outlet-requisitions.js
//
// It ONLY claims sync jobs (invoice like 'sync:%'); bill-push jobs are left for
// GitHub Actions. Status flow:  queued -> processing -> done | failed.
//
// RELIABILITY: every job runs under a hard timeout (a hung headless Chromium is
// killed, child tree and all), and a watchdog force-exits the whole process if
// it ever wedges — the service wrapper (worker-service.bat) then restarts a
// clean worker. This prevents the "busy stuck true forever" freeze where the
// process stays alive but silently stops picking up jobs.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY  (+ the scrapers need PACT_USER,
// PACT_PASS/PACT_PASSWORD, PACT_URL, SUPABASE_URL, SUPABASE_SERVICE_KEY).
// Run from the repo root:  node worker.js

const { spawn } = require('child_process');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const POLL_MS = Number(process.env.WORKER_POLL_MS || 5000);
const MAX_JOB_MS = Number(process.env.WORKER_JOB_TIMEOUT_MS || 300000);   // hard cap per job (5 min)
const WATCHDOG_MS = Number(process.env.WORKER_WATCHDOG_MS || 420000);      // wedge cutoff (7 min)
const ROOT = path.join(__dirname, '..'); // repo root (scripts/ live one level up from pact-worker/)

const SCRIPTS = {
  'inventory': 'scripts/sync-inventory.js',
  'sales-orders': 'scripts/sync-sales-orders.js',
  'outlet-requisitions': 'scripts/sync-outlet-requisitions.js',
  'outlet-outward': 'scripts/sync-outlet-outward.js',   // Stock Outlet Outward (Transfer Location) -> Purchase tab
  // Live Factory-Costing reports (enqueued by /api/sync-costing and the scheduler below)
  'costing-pf': 'scripts/sync-costing-pf.js',
  'costing-pm': 'scripts/sync-costing-pm.js',
  'costing-bom': 'scripts/sync-costing-bom.js',
  'costing-si': 'scripts/sync-costing-si.js',
};

const now = () => new Date().toISOString();
const log = (...a) => console.log(now(), ...a);

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('FATAL: SUPABASE_URL / SUPABASE_SERVICE_KEY not set. Fill .env.');
  process.exit(2);
}
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

let busy = false;
let busySince = 0;   // when the current tick started working (0 = idle)

async function claimNextJob() {
  // oldest queued sync job first
  const { data, error } = await sb
    .from('pact_jobs')
    .select('id,invoice,status,payload,updated_at')
    .eq('status', 'queued')
    .like('invoice', 'sync:%')
    .order('updated_at', { ascending: true })
    .limit(1);
  if (error) { log('poll error:', error.message); return null; }
  const job = data && data[0];
  if (!job) return null;

  // atomic claim: only succeeds if it is still queued (guards double-processing)
  const upd = await sb
    .from('pact_jobs')
    .update({ status: 'processing', updated_at: now() })
    .eq('id', job.id)
    .eq('status', 'queued')
    .select('id');
  if (upd.error) { log('claim error:', upd.error.message); return null; }
  if (!upd.data || upd.data.length === 0) return null; // someone else took it
  return job;
}

function syncType(job) {
  const p = job.payload || {};
  if (p.__sync && SCRIPTS[p.__sync]) return p.__sync;
  // fall back to the invoice tag "sync:<type>"
  const tag = String(job.invoice || '').replace(/^sync:/, '');
  return SCRIPTS[tag] ? tag : null;
}

// Kill a child process and its whole tree (headless Chromium spawns sub-procs).
function killTree(child) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { child.kill('SIGKILL'); } }
  } catch (e) { /* best effort */ }
}

function runScript(rel, jobId) {
  return new Promise((resolve) => {
    const abs = path.join(ROOT, rel);
    log('running', rel, 'for job', jobId);
    const child = spawn(process.execPath, [abs], { cwd: ROOT, env: process.env });
    const tail = [];
    let settled = false;
    const cap = (buf) => { String(buf).split(/\r?\n/).forEach((l) => { if (l) { tail.push(l); if (tail.length > 80) tail.shift(); } }); };
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };
    child.stdout.on('data', (b) => { cap(b); process.stdout.write(b); });
    child.stderr.on('data', (b) => { cap(b); process.stderr.write(b); });
    child.on('close', (code) => finish({ code, logTail: tail.join('\n').slice(-3500) }));
    child.on('error', (e) => finish({ code: 1, logTail: 'spawn error: ' + e.message }));
    // Hard timeout: kill a hung job so the worker never freezes on it.
    const timer = setTimeout(() => {
      log('job', jobId, rel, 'TIMEOUT after', MAX_JOB_MS + 'ms — killing child tree');
      killTree(child);
      finish({ code: 124, logTail: (tail.join('\n') + '\nWORKER: killed after ' + MAX_JOB_MS + 'ms timeout').slice(-3500) });
    }, MAX_JOB_MS);
  });
}

async function setStatus(jobId, status, logText) {
  // status is the field the app/dashboard poll — this must succeed.
  const { error } = await sb.from('pact_jobs').update({ status, updated_at: now() }).eq('id', jobId);
  if (error) { log('status update failed:', error.message); return; }
  // run_log is best-effort: the column may not exist on every deployment.
  if (logText) {
    const r = await sb.from('pact_jobs').update({ run_log: String(logText).slice(0, 6000) }).eq('id', jobId);
    if (r.error) log('(run_log not stored:', r.error.message + ')');
  }
}

async function tick() {
  if (busy) return;
  busy = true; busySince = Date.now();
  try {
    const job = await claimNextJob();
    if (!job) return;
    const type = syncType(job);
    if (!type) {
      log('job', job.id, 'has unknown sync type; marking failed');
      await setStatus(job.id, 'failed', 'unknown __sync type');
      return;
    }
    log('claimed job', job.id, '->', type);
    const { code, logTail } = await runScript(SCRIPTS[type], job.id);
    if (code === 0) {
      log('job', job.id, type, 'DONE');
      await setStatus(job.id, 'done', logTail);
    } else {
      log('job', job.id, type, 'FAILED code=' + code);
      await setStatus(job.id, 'failed', logTail);
    }
  } catch (e) {
    log('tick error:', e && e.message ? e.message : e);
  } finally {
    busy = false; busySince = 0;
  }
}

log('PACT sync worker started. poll=' + POLL_MS + 'ms  jobTimeout=' + MAX_JOB_MS + 'ms  scripts=' + Object.keys(SCRIPTS).join(','));
setInterval(tick, POLL_MS);
tick();

// Watchdog: if a single tick stays busy well past the job timeout, the process
// is wedged (e.g. a hung Supabase call). Exit so worker-service.bat restarts a
// clean worker rather than the process sitting alive-but-frozen forever.
setInterval(() => {
  if (busy && busySince && (Date.now() - busySince > WATCHDOG_MS)) {
    log('WATCHDOG: worker wedged for ' + Math.round((Date.now() - busySince) / 1000) + 's — exiting for restart');
    process.exit(1);
  }
}, 30000);


// ---------------------------------------------------------------------------
// Scheduled costing syncs (the "scheduled" half of on-demand + scheduled).
// Enabled with COSTING_CRON=1. Enqueues the same pact_jobs rows the
// /api/sync-costing button uses, on each report's natural cadence:
//   Stock Inward  every COSTING_SI_HOURS hours   (default 3)
//   Process Flow  daily at COSTING_PF_HOUR IST   (default 20 = 8pm)
//   Product Master + BOM  daily at COSTING_MASTER_HOUR IST (default 4 = 4am)
// Times are IST (worker box is usually UTC). In-memory guards prevent repeats;
// a worker restart may enqueue at most one extra job — harmless.
if (String(process.env.COSTING_CRON || '') === '1') {
  const SI_HOURS = Number(process.env.COSTING_SI_HOURS || 3);
  const PF_HOUR = Number(process.env.COSTING_PF_HOUR || 20);
  const MASTER_HOUR = Number(process.env.COSTING_MASTER_HOUR || 4);    // 4 = PM + BOM daily at 04:00 IST
  const ist = () => new Date(Date.now() + 5.5 * 3600 * 1000);
  const dayKey = (d) => d.toISOString().slice(0, 10);
  const PM_HOURLY = Number(process.env.COSTING_PM_HOURLY || 0);        // 0 = off (PM only on the daily 4 AM run + manual Sync); set to 1 to also refresh PM every hour at :07
  const PM_MIN = Math.min(59, Math.max(0, Number(process.env.COSTING_PM_MIN || 7)));  // minute of each hour to fire
  let lastSI = Date.now();          // wait a full interval before the first SI pull
  let lastPFDay = '', lastMasterDay = '';
  let lastPmHourKey = '';           // 'YYYY-MM-DD:HH' guard so we fire once per hour

  async function enqueueCosting(reports) {
    const jobs = reports.map((k) => ({
      id: (require('crypto').randomUUID && require('crypto').randomUUID()) || (Date.now() + '-' + k),
      invoice: `sync:costing-${k}`, status: 'queued', dry_run: false,
      payload: { __sync: `costing-${k}`, report: k },
    }));
    const { error } = await sb.from('pact_jobs').insert(jobs);
    if (error) log('[costing-cron] enqueue failed:', error.message);
    else log('[costing-cron] queued', reports.join(','));
  }

  async function cronTick() {
    try {
      const d = ist(), h = d.getUTCHours(), today = dayKey(d);
      if (Date.now() - lastSI >= SI_HOURS * 3600 * 1000) { lastSI = Date.now(); await enqueueCosting(['si']); }
      if (h === PF_HOUR && lastPFDay !== today) { lastPFDay = today; await enqueueCosting(['pf']); }
      if (h === MASTER_HOUR && lastMasterDay !== today) { lastMasterDay = today; await enqueueCosting(['pm', 'bom']); }
      // Hourly PM refresh (unified product-master for every tool) — minute PM_MIN of each hour.
      if (PM_HOURLY && d.getUTCMinutes() === PM_MIN) {
        const key = today + ':' + h;
        if (lastPmHourKey !== key) { lastPmHourKey = key; await enqueueCosting(['pm']); }
      }
    } catch (e) { log('[costing-cron] tick error:', e && e.message ? e.message : e); }
  }
  log('Costing scheduler ON  (SI every ' + SI_HOURS + 'h, PF @' + PF_HOUR + ':00 IST, PM+BOM @' + MASTER_HOUR + ':00 IST'
      + (PM_HOURLY ? ', PM also hourly @ :' + String(PM_MIN).padStart(2,'0') + ' past the hour' : '')
      + ')');
  setInterval(cronTick, 60 * 1000);
}


// ---------------------------------------------------------------------------
// Scheduled inventory sync — pre-warms the BatchWise snapshot so the scanner's
// Active Inventory screen shows fresh stock INSTANTLY instead of waiting ~2 min
// for a live pull. Enabled with INVENTORY_CRON=1; cadence INVENTORY_SYNC_MIN
// minutes (default 15, min 5). Skips a tick if an inventory sync is already
// queued/processing, so slow runs never pile up.
if (String(process.env.INVENTORY_CRON || '') === '1') {
  const EVERY_MS = Math.max(5, Number(process.env.INVENTORY_SYNC_MIN || 15)) * 60 * 1000;
  let lastInv = 0;
  async function invTick() {
    try {
      if (Date.now() - lastInv < EVERY_MS) return;
      const { data: pend } = await sb.from('pact_jobs')
        .select('id').eq('invoice', 'sync:inventory').in('status', ['queued', 'processing']).limit(1);
      if (pend && pend.length) { lastInv = Date.now(); return; }
      lastInv = Date.now();
      const { error } = await sb.from('pact_jobs').insert({
        id: (require('crypto').randomUUID && require('crypto').randomUUID()) || (Date.now() + '-inv'),
        invoice: 'sync:inventory', status: 'queued', dry_run: false, payload: { __sync: 'inventory' },
      });
      if (error) log('[inventory-cron] enqueue failed:', error.message);
      else log('[inventory-cron] queued inventory sync');
    } catch (e) { log('[inventory-cron] tick error:', e && e.message ? e.message : e); }
  }
  log('Inventory scheduler ON  (every ' + (EVERY_MS / 60000) + ' min)');
  setInterval(invTick, 60 * 1000);
  setTimeout(invTick, 30 * 1000); // first pre-warm shortly after boot
}

// ---------------------------------------------------------------------------
// Scheduled outlet-outward sync — pulls the PACT "Stock Outlet Outward
// (Transfer Location)" BI report that feeds the Purchase tab's GRN list on
// opsdashboard.sukhnafoods.com. Enabled with OUTLET_OUTWARD_CRON=1; cadence
// OUTLET_OUTWARD_SYNC_MIN minutes (default 60 = hourly). Skips a tick if a
// previous outlet-outward sync is still queued or processing so a slow run
// (big 30-day pulls can take ~2 min) never piles up.
if (String(process.env.OUTLET_OUTWARD_CRON || '') === '1') {
  const EVERY_MS = Math.max(10, Number(process.env.OUTLET_OUTWARD_SYNC_MIN || 60)) * 60 * 1000;
  let lastOutward = 0;
  async function outwardTick() {
    try {
      if (Date.now() - lastOutward < EVERY_MS) return;
      const { data: pend } = await sb.from('pact_jobs')
        .select('id').eq('invoice', 'sync:outlet-outward').in('status', ['queued', 'processing']).limit(1);
      if (pend && pend.length) { lastOutward = Date.now(); return; }
      lastOutward = Date.now();
      const { error } = await sb.from('pact_jobs').insert({
        id: (require('crypto').randomUUID && require('crypto').randomUUID()) || (Date.now() + '-outward'),
        invoice: 'sync:outlet-outward', status: 'queued', dry_run: false, payload: { __sync: 'outlet-outward' },
      });
      if (error) log('[outlet-outward-cron] enqueue failed:', error.message);
      else log('[outlet-outward-cron] queued outlet-outward sync');
    } catch (e) { log('[outlet-outward-cron] tick error:', e && e.message ? e.message : e); }
  }
  log('Outlet-Outward scheduler ON  (every ' + (EVERY_MS / 60000) + ' min)');
  setInterval(outwardTick, 60 * 1000);
  setTimeout(outwardTick, 45 * 1000); // first pull shortly after boot
}
