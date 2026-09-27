# Factory Costing Dashboard — Live PACT Sync

Real-time (on-demand + scheduled) sync of the 4 PACT reports the costing
dashboard runs on, replacing the manual "export 4 Excels and upload each" step.
Manual upload still works as a fallback.

## How it works

Same proven pipeline as the inventory sync:

```
/api/sync-costing  --enqueue-->  Supabase pact_jobs  --polled by-->  pact-worker/worker.js
        ^                                                                   |
        | (button / cron)                                     runs scripts/sync-costing-<k>.js
        |                                                     (login to PACT, replay the report's
        |                                                      ReportDataSet API, build rows)
        |                                                                   |
   costing/index.html  <--GET /api/costing/<k>--  Supabase costing_snapshots <--writes--
```

- `<k>` is one of **pm** (Product Master), **bom** (Stage-wise BOM), **pf**
  (Process Flow), **si** (Stock Inward).
- Each snapshot is stored as the **same array-of-arrays** (header row + data
  rows) the dashboard's Excel parser already consumes, so the page feeds it
  straight into its existing `detectType()/parseXX()` — no new parsing.
- The dashboard **auto-pulls on load** and on the new **⚡ Live Sync** button
  (which also triggers a fresh PACT pull, then re-pulls as the worker finishes).

## Files added / changed

| File | What |
|------|------|
| `pact_costing_tables.sql` | Supabase table `costing_snapshots` (run once) |
| `src/app/api/sync-costing/route.ts` | Enqueue a sync (POST button, GET cron) |
| `src/app/api/costing/[report]/route.ts` | Serve the latest snapshot to the page |
| `scripts/lib/costing-report.js` | Shared runner (login → replay → write snapshot) |
| `scripts/sync-costing-{pm,bom,pf,si}.js` | One config per report (BODY_B64 + COLMAP) |
| `scripts/extract-costing-body.js` | HAR → BODY_B64 + real column keys |
| `record-costing.bat` | Records a report so the sync can replay it |
| `pact-worker/worker.js` | Dispatches `costing-*` jobs + optional scheduler |
| `public/costing/index.html` | Auto-pull + ⚡ Live Sync button (manual upload kept) |

## One-time setup

1. **Create the table.** Supabase → SQL Editor → paste `pact_costing_tables.sql` → Run.
2. **Worker env** (same box that already runs `worker.js`): `PACT_USER`,
   `PACT_PASS`, `PACT_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`.
   Use the **dedicated PACT automation login**, not the shared CARahul login
   (repeated logins on a shared user hit PACT's session-limit 500s).
3. **App env** on Vercel (already set for inventory): `SUPABASE_URL` +
   `SUPABASE_SERVICE_KEY`.
4. **Deploy the code:** run `deploy-costing-live.bat`, or `git push` — Vercel
   redeploys the site and the two new API routes. Deploy the updated
   `worker.js` + `scripts/` to the AWS worker box the usual way.

## Activate each report (needs live PACT — do on the AWS/office network)

The scripts ship with an **empty `BODY_B64`** — until it's filled, a sync writes
a "not recorded yet" failure and the dashboard just keeps its existing data.
For each of pm, bom, pf, si:

1. `record-costing.bat pm`  → log in, open the report, **Export**, close browser.
2. `node scripts\extract-costing-body.js pact-costing-pm.har`
   → prints **BODY_B64** and the real **Tables[0] column keys**.
3. Paste BODY_B64 into `scripts\sync-costing-pm.js`. Check the printed keys
   against `COLMAP` in that file — if any column logs `UNRESOLVED` when it runs,
   add the real key to that column's candidate list.
4. Repeat for `bom`, `pf`, `si`. Commit + redeploy the worker.

## Test

- One report:  `node scripts/sync-costing-pm.js`  (env set) → check Supabase
  `costing_snapshots` has a fresh `status='ok'` row, then open the dashboard and
  click **⚡ Live Sync**.
- End to end:  `POST /api/sync-costing` (the button) → worker logs
  `claimed job … -> costing-…` → snapshot row appears → dashboard refreshes.

## Scheduling (the "scheduled" half)

On the worker box set `COSTING_CRON=1`. Defaults (all IST):
- Stock Inward every `COSTING_SI_HOURS` (3) hours
- Process Flow daily at `COSTING_PF_HOUR` (20:00)
- Product Master + BOM daily at `COSTING_MASTER_HOUR` (21:00)

Alternative (no worker cron): a Vercel Cron hitting
`GET /api/sync-costing?report=all` — set `CRON_SECRET` and pass `?secret=…`.
(Vercel Hobby limits crons to once/day and 2 total; the worker scheduler has no
such limit and is preferred since the worker is always on.)

## Troubleshooting

- **Dashboard shows old data / "no data yet":** snapshot missing or `failed`.
  Check `costing_snapshots` for that report's newest row and its `error`.
- **`Bearer token` error:** the automation login failed or PACT changed — re-check creds.
- **A column is wrong/blank:** the worker log prints `[colmap] … -> (UNRESOLVED)`;
  add the real key (from `extract-costing-body.js`) to `COLMAP`.
- **PACT report layout changed:** re-record that one report (`record-costing.bat <k>`)
  and refresh its BODY_B64.
- **Manual fallback:** the old "🔄 Sync PACT Reports" upload still works anytime.
