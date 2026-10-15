// B2B Factory Sales Invoice watcher — the AWS equivalent of the NB dispatch
// watcher, but for the Factory Sales Invoice screen in PACT.
//
// WHAT IT DOES
//   Polls Supabase `pact_jobs` for queued B2B invoice jobs (the ones the gun
//   creates via /api/push-fsi — invoice like 'FSOD%'), claims one at a time,
//   opens PACT in a VISIBLE browser on this machine, fills + posts the Factory
//   Sales Invoice, and writes the voucher/status back for the gun to read.
//
//   This replaces the old GitHub Actions path (push-fsi-to-pact.yml +
//   scripts/run-fsi-job.js). Same posting code (src/lib/pact/*), now running on
//   AWS where you can watch it and fix a PACT error live — exactly like NB.
//
// SAFETY
//   * Runs in DRY RUN by default (FSI_DRY_RUN=true): it fills the invoice and
//     STOPS before Post, so you can watch the whole thing with zero risk.
//     Flip FSI_DRY_RUN=false only when you've confirmed it fills correctly.
//   * De-dupes: when it claims one job for an SO, it marks every other queued
//     job for the SAME SO 'superseded' so a triple-submit can't post 3 invoices.
//   * Pre-post guard: before posting it re-checks PACT — if that SO already
//     shows delivered/completed, it marks the job done WITHOUT posting again.
//   * Scope: only touches B2B invoice jobs (FSI_MATCH, default ^FSOD). It never
//     claims sync jobs or the NB/OMR stock-outward backlog.
//
// RUN (from the repo root, same place scripts/run-fsi-job.js is run):
//   node scripts/fsi-watcher.js
//
// ENV (.env at repo root):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY, PACT_USER, PACT_PASSWORD (or PACT_PASS),
//   PACT_URL
//   FSI_DRY_RUN     default 'true'  — 'false' to actually Post
//   FSI_HEADLESS    default 'false' — visible browser so you can watch it
//   FSI_POLL_MS     default '4000'
//   FSI_MATCH       default 'FSOD'  — SQL LIKE prefix for B2B invoice numbers
//   DASHBOARD_URL   default 'https://opsdashboard.sukhnafoods.com' (pre-post check)

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const { login } = require('../src/lib/pact/login');
const { createFactorySalesInvoice } = require('../src/lib/pact/factory-sales-invoice');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const POLL_MS   = Number(process.env.FSI_POLL_MS || 4000);
const DRY_RUN   = String(process.env.FSI_DRY_RUN ?? 'true').toLowerCase() !== 'false';   // SAFE default
const HEADLESS  = String(process.env.FSI_HEADLESS ?? 'false').toLowerCase() === 'true';  // VISIBLE default
const MATCH     = String(process.env.FSI_MATCH || 'FSOD');
const DASH      = (process.env.DASHBOARD_URL || 'https://opsdashboard.sukhnafoods.com').replace(/\/$/, '');
const MAX_JOB_MS = Number(process.env.FSI_JOB_TIMEOUT_MS || 300000);

const now = () => new Date().toISOString();
const log = (...a) => console.log(now(), ...a);

if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('FATAL: SUPABASE_URL / SUPABASE_SERVICE_KEY not set.'); process.exit(2); }
if (!process.env.PACT_PASSWORD && process.env.PACT_PASS) process.env.PACT_PASSWORD = process.env.PACT_PASS;
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

let busy = false;

// Claim the oldest queued B2B invoice job (atomic: only one worker can win it).
async function claimNextJob() {
  const { data, error } = await sb
    .from('pact_jobs')
    .select('id,invoice,status,payload,created_at')
    .eq('status', 'queued')
    .like('invoice', MATCH + '%')
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) { log('poll error:', error.message); return null; }
  const job = data && data[0];
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
  const so = job.invoice;
  if (!so) return;
  const { data, error } = await sb.from('pact_jobs')
    .update({ status: 'superseded', updated_at: now(), error: 'Superseded — another job for this SO is being posted.' })
    .eq('status', 'queued').eq('invoice', so).neq('id', job.id)
    .select('id');
  if (error) { log('supersede warn:', error.message); return; }
  if (data && data.length) log('superseded', data.length, 'duplicate job(s) for', so);
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
    // every ordered line already fully delivered => nothing left to post
    return items.every((it) => Number(it.delivered || 0) >= Number(it.ordered || it.qty || 0) && Number(it.ordered || it.qty || 0) > 0);
  } catch (e) { log('pre-post check warn:', e && e.message); return false; }
}

async function setStatus(jobId, patch) {
  const { error } = await sb.from('pact_jobs').update({ ...patch, updated_at: now() }).eq('id', jobId);
  if (error) log('status update failed:', error.message);
}

async function processJob(job) {
  const order = job.payload || {};
  const so = order.soNumber || job.invoice;
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

  const RUN = [];
  const cap = (...a) => { RUN.push(a.map(String).join(' ')); };
  const browser = await chromium.launch({ headless: HEADLESS, args: ['--window-size=1680,1000', '--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: null });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const origLog = console.log;
  console.log = (...a) => { try { RUN.push(a.map(String).join(' ')); } catch {} origLog(now(), ...a); };

  const killTimer = setTimeout(() => { log('job', job.id, 'TIMEOUT — closing browser'); browser.close().catch(() => {}); }, MAX_JOB_MS);

  try {
    await login(page);
    cap('Logged in.');
    const r = await createFactorySalesInvoice(page, order, { dryRun: DRY_RUN });
    const filled = `Filled ${(r && r.entered) || 0}/${(r && r.total) || 0} item(s)` +
      (r && r.skipped && r.skipped.length ? `, ${r.skipped.length} skipped (not in stock)` : '');

    if (DRY_RUN) {
      log('DRY RUN complete for', so, '—', filled, '(not posted).');
      await setStatus(job.id, { status: 'queued', error: `DRY RUN — ${filled}. Re-queued (not posted). Set FSI_DRY_RUN=false to post.` });
      // NOTE: left 'queued' on purpose so a later LIVE run can still post it.
      return;
    }

    if (!(r && r.posted)) {
      throw new Error('Invoice NOT posted: ' + ((r && r.reason) || 'still Draft'));
    }
    const summary = `${filled} — POSTED${r && r.docNo ? ' as ' + r.docNo : ''}`;
    log('POSTED', so, '->', (r && r.docNo) || '(voucher unknown)');
    await setStatus(job.id, { status: 'done', invoice: (r && r.docNo) || so, error: summary });

    // Record posted invoice for "View Past Sales Invoice"
    try {
      const items = (order.barcodes || []).map((bc) => {
        const p = String(bc).split('_');
        return { code: p[0] || '', batch: p[1] || '', weight: p[2] || '', barcode: String(bc) };
      });
      await sb.from('sales_invoices').insert({
        vendor_name: order.customer || order.vendor || null,
        invoice_number: (r && r.docNo) || null,
        invoice_date: new Date().toISOString().slice(0, 10),
        amount: null, items,
      });
    } catch (e) { log('sales_invoices insert warn:', e && e.message); }
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    log('JOB FAILED', so, '-', msg.slice(0, 160));
    await setStatus(job.id, { status: 'failed', error: (msg + '\n--- log ---\n' + RUN.slice(-40).join('\n')).slice(0, 3800) });
  } finally {
    console.log = origLog;
    clearTimeout(killTimer);
    // In headed mode, pause briefly so a watching operator can read the result.
    if (!HEADLESS) await page.waitForTimeout(2500).catch(() => {});
    await browser.close().catch(() => {});
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

log(`B2B FSI watcher started. poll=${POLL_MS}ms  match=${MATCH}%  dryRun=${DRY_RUN}  headless=${HEADLESS}`);
setInterval(tick, POLL_MS);
tick();
