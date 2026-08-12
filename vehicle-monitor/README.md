# Vehicle Monitor

Daily automation: download the tracker vendor's Excel, clean it, convert
lat/long to road/lane names (Google Geocoding), write your summary Excel, and
upload to Supabase. Runs on Node.js — deploy to Vercel Cron so no laptop stays on.

## Pipeline
  Playwright (login + download)  ->  Node (clean + map)  ->  Google Geocoding
  ->  Node (write Excel)         ->  Supabase            ->  Vercel portal

## Status
- [x] Geocoding lat/long -> road name (COMPLETE, needs a Google API key)
- [x] Orchestration / run loop / Excel write
- [ ] Tracker portal login + download   <-- needs ONE codegen recording
- [ ] Column mapping + cleaning rules    <-- needs a sample tracker Excel + your target template
- [ ] Supabase table schema              <-- needs the table definition

## Run it (local test)
    cd vehicle-monitor
    npm install
    npx playwright install chromium
    copy .env.example .env    # fill in real values
    node run.js

## Record the portal login + download
    npx playwright codegen "https://YOUR-tracker-portal-url"
