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
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY  (+ the scrapers need PACT_USER,
// PACT_PASS/PACT_PASSWORD, PACT_URL, SUPABASE_URL, SUPABASE_SERVICE_KEY).
// Run from the repo root:  node worker.js

const { spawn } = require('child_process');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const POLL_MS = Number(process.env.WORKER_POLL_MS || 5000);
const ROOT = __dirname;

const SCRIPTS = {
  'inventory': 'scripts/sync-inventory.js',
  'sales-orders': 'scripts/sync-sales-orders.js',
  'outlet-requisitions': 'scripts/sync-outlet-requisitions.js',
};

const now = () => new Date().toISOString();
const log = (...a) => console.log(now(), ...a);

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('FATAL: SUPABASE_URL / SUPABASE_SERVICE_KEY not set. Fill .env.');
  process.exit(2);
}
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

let busy = false;

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

function runScript(rel, jobId) {
  return new Promise((resolve) => {
    const abs = path.join(ROOT, rel);
    log('running', rel, 'for job', jobId);
    const child = spawn(process.execPath, [abs], { cwd: ROOT, env: process.env });
    const tail = [];
    const cap = (buf) => { String(buf).split(/\r?\n/).forEach((l) => { if (l) { tail.push(l); if (tail.length > 80) tail.shift(); } }); };
    child.stdout.on('data', (b) => { cap(b); process.stdout.write(b); });
    child.stderr.on('data', (b) => { cap(b); process.stderr.write(b); });
    child.on('close', (code) => resolve({ code, logTail: tail.join('\n').slice(-3500) }));
    child.on('error', (e) => resolve({ code: 1, logTail: 'spawn error: ' + e.message }));
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
  busy = true;
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
    busy = false;
  }
}

log('PACT sync worker started. poll=' + POLL_MS + 'ms  scripts=' + Object.keys(SCRIPTS).join(','));
setInterval(tick, POLL_MS);
tick();
