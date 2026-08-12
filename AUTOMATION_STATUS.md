# Automation Status — Vehicle Monitor & PACT Worker

_Snapshot of what's built, what's learned, and what remains._

## 1. Vehicle Monitor  (`vehicle-monitor/`)  —  DONE & WORKING
Daily OneLap → trip-summary automation.

- Logs into OneLap (web.onelap.in), selects the **active (green+yellow) vehicles**,
  sets the report to a chosen date 10:00–19:00, downloads the Route Excel.
- Parses the GPS pings, detects stops, splits the day into trips, samples location
  at +30/+60/+90/+120 min, geocodes lat/long to road names (Google Geocoding API),
  labels stops against the 10 NutrioBox outlets, computes travel/dwell time + remarks.
- Writes the Vehicle Movement summary Excel.
- Verified end-to-end on live data (e.g. 11-Aug produced 13 trips with outlet names).

Run: `cd vehicle-monitor && node run.js`  (defaults to yesterday; `REPORT_DATE=YYYY-MM-DD` to force a day)
Remaining: schedule (7 PM) + upload to Supabase/portal (deployment layer).

## 2. PACT Worker  (`pact-worker/`)  —  PARTIAL
Goods Gate Entry + Stock Inward automation into PACT ERP (Angular app on Oracle Cloud).

- **Login + Voucher-Prefix/Location dialog** — working.
- **Goods Gate Entry** — WORKING in dry-run: location, vendor, bill no, all line items
  with unit level (L2/L3) + purchase qty. (Still needs: Delivery Date.)
- **Stock Inward** — PARTIAL: opens, vendor/bill, links the posted GGE (Link → Select All → Ok,
  items pull in), Approve Qty, base Quantity + Batch(latest) drafted, Post drafted.
  NOT yet verified: batch/quantity steps + the Post (blocked by PACT login 500 during testing).

Run (dry-run, safe): `cd pact-worker && node test-gge.js`  /  `node test-stockinward.js`
`DRY_RUN=true` in .env stops before Post; set `false` for a real voucher (only when verified).

## 3. Key learnings
- **PACT** is an Angular app; grid cells expose stable `getByRole('gridcell',{description})`
  selectors, but dialog field ids (lchk, datefield, tagfield, combo) shift per session —
  target by role/label/attribute-prefix, not the numbers.
- **OneLap** is ExtJS; the report-form field ids shift too — matched by `[id^=...][id$=...]`.
  Date/time fields are read-only-ish: type char-by-char + Enter (fill() reverts).
- **PACT hosting**: public on Oracle Cloud (reachable over internet) → Vercel worker is viable
  IF PACT doesn't IP-whitelist. Confirm with vendor. Also needs a dedicated automation login
  (shared CARahul login hit session-limit 500s from repeated test logins).

## 4. To deploy on Vercel (next)
Playwright does NOT run on Vercel with the plain `playwright` package. To host as a Vercel
API route (`/api/push-to-pact`, `/api/vehicle-report`) the worker must be refactored to
`playwright-core` + `@sparticuz/chromium`, Node runtime, `maxDuration` raised, and write
outputs to Supabase (not local files). The Next.js dashboard itself already deploys to Vercel.
