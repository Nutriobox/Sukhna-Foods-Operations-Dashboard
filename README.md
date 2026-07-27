# Sukhna Foods · Operations Dashboard

Invoice operations console for **Sukhna Foods / Nutriobox**.
Live URL: **https://sukhna-foods-operations-dashboard.vercel.app**

Scanned bills arrive by email → get auto-extracted → are validated by three
offline checks → and land in a Gmail-style inbox where each bill can be reviewed,
uploaded to Pact item-by-item, or voided.

- **Framework:** Next.js 14 (App Router, TypeScript) — deploys to Vercel with zero config
- **Database:** Supabase (Postgres) — one `bills` table
- **Validation:** pure arithmetic + string match in `src/lib/validate.ts` (no AI, no internet)

It runs **out of the box on the 10 seed bills** before Supabase is connected, so you
can see it working immediately, then wire the database when ready.

---

## 1. Run it locally

You need **Node.js 18+** (download from https://nodejs.org — pick the LTS installer).

Open a terminal in this folder and run:

```bash
npm install
npm run dev
```

Then open **http://localhost:3000**. It works right away on the built-in seed data.
No Supabase needed for this step.

---

## 2. Create the Supabase database

1. Go to https://supabase.com → **New project**. Pick a name (e.g. `sukhna-ops`),
   a strong database password, and a region close to India (e.g. Mumbai / Singapore).
2. When it's ready, open **SQL Editor → New query**, paste the contents of
   **`supabase/schema.sql`**, and click **Run**. This creates the `bills` table.
3. New query again → paste **`supabase/seed.sql`** → **Run**. This loads the 10 bills.
4. Open **Project Settings → API** and copy two values:
   - **Project URL** (looks like `https://abcd1234.supabase.co`)
   - **anon public** key (a long token — safe for the browser, protected by RLS)

> The scanned images currently ship in `public/scans/`. Later you can move them to a
> Supabase **Storage** bucket called `scans` and point each bill's `scan_url` at it —
> there's a commented line for the bucket at the bottom of `schema.sql`.

---

## 3. Connect the app to Supabase

Copy the example env file and fill in your two values:

```bash
cp .env.local.example .env.local
```

Edit `.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL=https://YOUR-ref.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...your-anon-key...
```

Restart `npm run dev`. The inbox now reads from Supabase, and Upload/Void actions
persist to the database (the footer will say "connected to Supabase").

---

## 4. Deploy to Vercel

1. Put this folder in a **GitHub** repository (create a repo on github.com, then
   push this folder to it). If you're not comfortable with git, a developer can do
   this in two minutes, or you can drag-and-drop upload in the GitHub UI.
2. Go to https://vercel.com → **Add New → Project** → import that GitHub repo.
   Vercel auto-detects Next.js; leave the build settings as-is.
3. Before deploying, open **Environment Variables** and add the same keys from
   `.env.local`:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `NEXT_PUBLIC_BUYER_GST` = `09AANCA9064A1ZL`
   - `NEXT_PUBLIC_BUYER_NAME` = `Allsure Services Pvt Ltd`
   - (Phase 2 only) `SUPABASE_SERVICE_ROLE_KEY` and `INGEST_SECRET`
4. Click **Deploy**. In ~1 minute you get a live `*.vercel.app` URL.

---

## 5. Point the domain: operationsdashboard.sukhnafoods.com

1. In your Vercel project → **Settings → Domains → Add** →
   type `operationsdashboard.sukhnafoods.com` → **Add**.
2. Vercel shows a DNS record to create. It will be a **CNAME**:
   - **Type:** CNAME
   - **Name / Host:** `operationsdashboard`
   - **Value / Target:** `cname.vercel-dns.com`
3. Log in to wherever **sukhnafoods.com** DNS is managed (your domain registrar —
   GoDaddy, Cloudflare, etc.) and add that CNAME record on the `sukhnafoods.com` zone.
4. Back in Vercel, wait for it to verify (usually minutes, up to a couple of hours).
   Vercel issues the HTTPS certificate automatically. Done.

---

## 6. Phase 2 — the email → extraction pipeline (not yet built)

The front end and database are live; the automated intake is the next project. The
flow will be:

1. A bill is scanned and emailed to **mis@nutriobox.com**.
2. A small service reads that mailbox, sends each attachment to an AI vision model
   for extraction (the same extraction we've been doing by hand), and shapes the
   result to match the `bills` row format.
3. It `POST`s the bill(s) to **`/api/ingest`** (already scaffolded in
   `src/app/api/ingest/route.ts`) with the header `x-ingest-secret: <INGEST_SECRET>`.
   The route upserts them into Supabase and they appear in the inbox.

The mailbox reader + extraction worker is the part still to build (options: a Vercel
Cron + a mail API like Postmark/SendGrid inbound, or a Supabase Edge Function).

---

## Project structure

```
operationsdashboard/
├─ src/
│  ├─ app/
│  │  ├─ page.tsx            # renders the dashboard (seed data initially)
│  │  ├─ layout.tsx          # html shell + global styles
│  │  ├─ globals.css         # the full design system
│  │  └─ api/ingest/route.ts # Phase-2 webhook for extracted bills
│  ├─ components/
│  │  ├─ Dashboard.tsx       # the whole UI (list, KPIs, 2-tab modal, actions)
│  │  └─ icons.tsx           # inline SVG icon set
│  └─ lib/
│     ├─ bills.json          # the 10 seed bills (single source of truth)
│     ├─ types.ts            # Bill / Item / Check types
│     ├─ validate.ts         # the 3 offline checks
│     ├─ format.ts           # ₹ Indian formatting
│     ├─ data.ts             # seed + Supabase row mapping
│     └─ supabaseClient.ts   # browser client (null until configured)
├─ public/
│  ├─ logo.png               # Nutriobox logo
│  └─ scans/1.jpg … 10.jpg   # scanned bill images
├─ supabase/
│  ├─ schema.sql             # create the bills table + RLS
│  ├─ seed.sql               # the 10 bills (generated)
│  └─ gen-seed.mjs           # regenerate seed.sql from bills.json
├─ .env.local.example
└─ package.json
```

## The three validation checks (offline)

Implemented in `src/lib/validate.ts`, marked on every bill:

1. **Item math** — for each line, `Net = Qty × Price` (skipped as *N/A* for lump-sum
   charges with no unit price).
2. **Buyer** — billed to `Allsure Services Pvt Ltd` **and** GSTIN `09AANCA9064A1ZL`.
3. **Totals reconcile** — `sum(item Net) = Taxable`, `sum(item GST) = Total GST`,
   and `Grand Total = Taxable + GST + printed round-off`.

A bill is **OK** only if all three pass; otherwise it's flagged **Needs review** and
its **Upload to Pact** is blocked. (Bill 5, Maa Pet, fails check 3 because of an EPR
Processing Charge that sits outside the line items — exactly what this catches.)

## Security note

The Supabase RLS policies in `schema.sql` are **permissive** so the prototype works
immediately. Before real production, put the app behind Supabase Auth (or restrict
the policies) so only signed-in staff can read/update bills.
