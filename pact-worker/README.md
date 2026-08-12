# PACT Worker

Playwright automation that logs into PACT ERP and enters verified bills as
**Stock Inward** vouchers. Runs on any machine with Node.js — no laptop needs to
stay on once this is deployed to the cloud (Vercel).

## Status
- [x] Login (captured from the real PACT login page)
- [x] Run loop over bills + per-bill success/fail summary
- [x] Read-back-verify-then-save structure (scaffolded)
- [ ] Stock Inward entry steps  <-- needs ONE codegen recording to fill in
- [ ] Voucher-number capture      <-- comes from the same recording

## Input contract
Each bill is JSON produced from the dashboard's `src/lib/pact.ts` (resolveLine):

    {
      "vendor":   "supplier name",
      "invoice":  "invoice number",
      "dateFull": "26-Jul-2026",
      "items": [
        { "product": "PACT product name", "unit": "Pcs", "qty": 100, "rate": 12.5 }
      ]
    }

## Run it (local test)
    cd pact-worker
    npm install
    npx playwright install chromium
    copy .env.example .env      # then edit .env with the real password
    node run.js                 # uses bills.sample.json
    node run.js my-bills.json   # or point it at your own file

## Finish the Stock Inward steps
Record ONE real entry, then paste the steps into lib/stock-inward.js where the
TODO(record) lines are:

    npx playwright codegen --ignore-https-errors "http://140.245.255.130:8443/PACTALLUSUREWEB/#/login" -o inward-recording.ts
