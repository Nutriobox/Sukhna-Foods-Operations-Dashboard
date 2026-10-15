// B2B Factory Sales Invoice watcher — the AWS equivalent of the NB dispatch
// watcher, but for the Factory Sales Invoice screen in PACT.
//
// WHAT IT DOES
//   Polls Supabase `pact_jobs` for queued B2B invoice jobs (the ones the gun
//   creates via /api/push-fsi — invoice like 'FSOD%'), claims one at a time,
//   writes an order TXT, and runs the PACT DESKTOP agent (fsi_agent.py) which
//   drives the VISIBLE PACT RevenU Windows app → Factory Sales Invoice screen,
//   fills + posts it, then reads back the voucher for the gun.
//
//   This is the same shape as the NB worker: the Node watcher does the Supabase
//   queue plumbing, the Python agent does the desktop automation. You watch it
//   fill the real PACT window on the box and fix any PACT error live.
//
// SAFETY
//   * DRY RUN by default (FSI_DRY_RUN=true): the agent fills the invoice and
//     STOPS before Post, so you can watch the whole thing with zero risk. The
//     job is left 'queued' so a later LIVE run can still post it. Flip
//     FSI_DRY_RUN=false only once you've confirmed it fills correctly.
//   * De-dupes: when it claims one job for an SO, it marks every other queued
//     job for the SAME SO 'superseded' so a triple-submit can't post 3 invoices.
//   * Pre-post guard: before posting it re-checks PACT — if that SO already
//     shows delivered/completed, it marks the job done WITHOUT posting again.
//   * Scope: only touches B2B invoice jobs (FSI_MATCH, default FSOD). It never
//     claims sync jobs or the NB/OMR stock-outward backlog.
//
// RUN (from C:\sukhna-worker, same place run-worker.bat lives):
//   node scripts/fsi-watcher.js
//
// ENV (set in a run-fsi-watcher.bat, copy the SUPABASE_* lines from run-worker.bat):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
//   FSI_DRY_RUN     default 'true'   — 'false' to actually Post
//   FSI_MATCH       default 'FSOD'   — SQL LIKE prefix for B2B invoice numbers
//   FSI_POLL_MS     default '4000'
//   FSI_AGENT_DIR   default 'C:\\pact'        — where fsi_agent.py lives + writes
//   FSI_AGENT       default 'fsi_agent.py'
//   FSI_PY          default 'py'              — Python launcher (or full path)
//   FSI_JOB_TIMEOUT_MS default '300000'
//   DASHBOARD_URL   default 'https://opsdashboard.sukhnafoods.com' (pre-post check)

const { createClient } = require('@supabase/supabase-js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const POLL_MS   = Number(process.env.FSI_POLL_MS || 4000);
const DRY_RUN   = String(process.env.FSI_DRY_RUN ?? 'true').toLowerCase() !== 'false';   // SAFE default
const MATCH     = String(process.env.FSI_MATCH || 'FSOD');
const DASH      = (process.env.DASHBOARD_URL || 'https://opsdashboard.sukhnafoods.com').replace(/\/$/, '');
const MAX_JOB_MS = Number(process.env.FSI_JOB_TIMEOUT_MS || 300000);
const AGENT_DIR = process.env.FSI_AGENT_DIR || 'C:\\pact';
const AGENT     = process.env.FSI_AGENT || 'fsi_agent.py';
const PY        = process.env.FSI_PY || 'py';

const now = () => new Date().toISOString();
const log = (...a) => console.log(now(), ...a);

if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('FATAL: SUPABASE_URL / SUPABASE_SERVICE_KEY not set.'); process.exit(2); }
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

let busy = false;

// The SO number can live in the `invoice` column OR only in payload.soNumber,
// depending on which gun build created the job. Resolve it from both.
function resolvedSo(job) {
  return String((job && job.invoice) || (job && job.payload && job.payload.soNumber) || '').trim();
}
function matchesScope(job) {
  const so = resolvedSo(job).toUpperCase();
  return so.startsWith(MATCH.toUpperCase());
}

// One-time startup diagnostic: show exactly what's queued and what matches scope.
async function logQueue() {
  const { data, error } = await sb.from('pact_jobs')
    .select('id,invoice,status,payload,created_at')
    .eq('status', 'queued').order('created_at', { ascending: true }).limit(200);
  if (error) { log('queue check error:', error.message); return; }
  const rows = data || [];
  log('queued jobs in table:', rows.length);
  for (const j of rows) {
    log('   queued', j.id,
      'invoice=' + JSON.stringify(j.invoice),
      'soNumber=' + JSON.stringify(j.payload && j.payload.soNumber),
      matchesScope(j) ? '<= MATCHES scope' : '');
  }
}

// Claim the oldest queued B2B invoice job (atomic: only one worker can win it).
async function claimNextJob() {
  const { data, error } = await sb
    .from('pact_jobs')
    .select('id,invoice,status,payload,created_at')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) { log('poll error:', error.message); return null; }
  const job = (data || []).filter(matchesScope)[0];
  if (!job) return null;

  const upd = await sb.from('pact_jobs')
    .update({ status: 'processing', updated_at: now() })
    .eq('id', job.id).eq('status', 'queued')
    .select('id');
  if (upd.error) { log('claim error:', upd.error.message); return null; }
  if (!upd.data || upd.data.length === 0) return null; // someone else took it
  return job;
}

// Mark every OTHER still-queued job for the same SO as superseded, so a
// double/triple submit of one order can never post more than one invoice.
async function supersedeSiblings(job) {
  const so = resolvedSo(job);
  if (!so) return;
  const { data, error } = await sb.from('pact_jobs')
    .select('id,invoice,status,payload')
    .eq('status', 'queued').neq('id', job.id).limit(200);
  if (error) { log('supersede warn:', error.message); return; }
  const sibs = (data || []).filter((j) => resolvedSo(j) === so).map((j) => j.id);
  if (!sibs.length) return;
  const upd = await sb.from('pact_jobs')
    .update({ status: 'superseded', updated_at: now(), error: 'Superseded — another job for this SO is being posted.' })
    .in('id', sibs).eq('status', 'queued').select('id');
  if (upd.error) { log('supersede warn:', upd.error.message); return; }
  if (upd.data && upd.data.length) log('superseded', upd.data.length, 'duplicate job(s) for', so);
}

// Ask the dashboard what PACT currently shows for this SO. Returns true if the
// order is already posted/delivered (so we must NOT post it again).
async function alreadyPosted(soNumber) {
  try {
    const r = await fetch(`${DASH}/api/sales-orders?so=${encodeURIComponent(soNumber)}`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return false;
    const j = await r.json();
    const o = j && j.order;
    if (!o) return false;
    if (String(o.status || '').toLowerCase() === 'completed') return true;
    const items = o.items || [];
    if (!items.length) return false;
    return items.every((it) => Number(it.delivered || 0) >= Number(it.ordered || it.qty || 0) && Number(it.ordered || it.qty || 0) > 0);
  } catch (e) { log('pre-post check warn:', e && e.message); return false; }
}

async function setStatus(jobId, patch) {
  const { error } = await sb.from('pact_jobs').update({ ...patch, updated_at: now() }).eq('id', jobId);
  if (error) log('status update failed:', error.message);
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function tailFile(p, n) {
  try {
    const t = fs.readFileSync(p, 'utf8').trim().split('\n');
    return t.slice(-n).join('\n');
  } catch { return ''; }
}

// Run the PACT desktop agent for this order and resolve with its result JSON.
function runAgent(orderTxtPath, doPost) {
  return new Promise((resolve) => {
    const args = [AGENT, 'dispatch', '--txt', path.basename(orderTxtPath)];
    if (doPost) args.push('--post');
    log('spawn:', PY, args.join(' '), '(cwd', AGENT_DIR + ')');
    const child = spawn(PY, args, { cwd: AGENT_DIR, windowsHide: false });
    let done = false;
    const finish = (res) => { if (!done) { done = true; resolve(res); } };
    const killTimer = setTimeout(() => {
      log('agent TIMEOUT — killing'); try { child.kill(); } catch {}
      finish({ status: 'failed', voucher: '', note: 'Agent timed out.' });
    }, MAX_JOB_MS);
    child.stdout && child.stdout.on('data', (b) => process.stdout.write(b));
    child.stderr && child.stderr.on('data', (b) => process.stderr.write(b));
    child.on('error', (e) => { clearTimeout(killTimer); finish({ status: 'failed', voucher: '', note: 'spawn error: ' + (e && e.message) }); });
    child.on('close', (code) => {
      clearTimeout(killTimer);
      const res = readJsonSafe(path.join(AGENT_DIR, 'pact_result.json'))
                  || { status: 'failed', voucher: '', note: 'No pact_result.json (exit ' + code + ').' };
      res._log = tailFile(path.join(AGENT_DIR, 'fsi_dispatch.txt'), 40) + '\n' + tailFile(path.join(AGENT_DIR, 'fsi_post.txt'), 20);
      finish(res);
    });
  });
}

async function processJob(job) {
  const order = job.payload || {};
  const so = resolvedSo(job);
  const customer = order.customer || order.vendor || '';
  log('claimed', job.id, '->', so, DRY_RUN ? '(DRY RUN)' : '(LIVE POST)');

  await supersedeSiblings(job);

  if (!order.barcodes || !order.barcodes.length) {
    await setStatus(job.id, { status: 'failed', error: 'No barcodes in job payload.' });
    return;
  }

  // Guard: if PACT already shows this SO posted/delivered, do not post again.
  if (await alreadyPosted(so)) {
    log(so, 'already posted/delivered in PACT — skipping (no re-post).');
    await setStatus(job.id, { status: 'done', invoice: so, error: 'Already posted/delivered in PACT — not re-posted.' });
    return;
  }

  // Write the order TXT the agent reads.
  const txtPath = path.join(AGENT_DIR, 'fsi_order.txt');
  const bodyLines = [
    `Order: ${so}`,
    customer ? `Customer: ${customer}` : '',
    ...order.barcodes.map((b) => String(b)),
  ].filter(Boolean);
  try {
    fs.writeFileSync(txtPath, bodyLines.join('\r\n') + '\r\n', 'utf8');
    // clear stale agent outputs so we never read last run's result
    for (const f of ['pact_result.json', 'pact_progress.json']) {
      try { fs.unlinkSync(path.join(AGENT_DIR, f)); } catch {}
    }
  } catch (e) {
    await setStatus(job.id, { status: 'failed', error: 'Could not write order TXT: ' + (e && e.message) });
    return;
  }

  const res = await runAgent(txtPath, !DRY_RUN);

  if (DRY_RUN) {
    log('DRY RUN complete for', so, '— filled (not posted).');
    await setStatus(job.id, {
      status: 'queued',
      error: `DRY RUN — filled, not posted. Review the PACT window / after_fsi_dispatch.png. Set FSI_DRY_RUN=false to post.`,
    });
    // left 'queued' on purpose so a later LIVE run can post it.
    return;
  }

  if (res.status === 'posted') {
    const voucher = res.voucher || so;
    log('POSTED', so, '->', res.voucher || '(voucher unknown)');
    await setStatus(job.id, { status: 'done', invoice: voucher, error: ('POSTED' + (res.note ? ' — ' + res.note : '')).slice(0, 300) });

    // Record posted invoice for "View Past Sales Invoice"
    try {
      const items = (order.barcodes || []).map((bc) => {
        const p = String(bc).split('_');
        return { code: p[0] || '', batch: p[1] || '', weight: p[2] || '', barcode: String(bc) };
      });
      await sb.from('sales_invoices').insert({
        vendor_name: order.customer || order.vendor || null,
        invoice_number: res.voucher || null,
        invoice_date: new Date().toISOString().slice(0, 10),
        amount: null, items,
      });
    } catch (e) { log('sales_invoices insert warn:', e && e.message); }
  } else {
    const msg = (res.note || 'Invoice NOT posted') + (res._log ? '\n--- log ---\n' + res._log : '');
    log('JOB FAILED', so, '-', (res.note || '').slice(0, 160));
    await setStatus(job.id, { status: 'failed', error: msg.slice(0, 3800) });
  }
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const job = await claimNextJob();
    if (job) await processJob(job);
  } catch (e) {
    log('tick error:', e && e.message ? e.message : e);
  } finally { busy = false; }
}

log(`B2B FSI watcher started. poll=${POLL_MS}ms  match=${MATCH}%  dryRun=${DRY_RUN}  agent=${PY} ${AGENT} @ ${AGENT_DIR}`);
logQueue().finally(() => { setInterval(tick, POLL_MS); tick(); });
