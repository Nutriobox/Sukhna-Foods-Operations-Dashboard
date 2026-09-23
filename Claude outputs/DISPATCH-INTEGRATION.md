# Scan → TXT → EC2 → one PACT voucher — integration guide

This adds the dispatch pipeline the app was missing: on **Submit**, the app builds
the order's TXT, saves it on the device, and uploads it to a cloud inbox; the
always-on **PACT-desktop worker** fills *Stock Outward to Outlet* and posts **one
voucher**; the voucher comes back for a popup.

It is **additive and safety-gated** — nothing posts to PACT from this new path
until we explicitly *arm* it after a supervised test, so it cannot create a wrong
or duplicate voucher.

Files delivered (all in this folder, and committed into the repo):

| File | Goes to | What it does |
|---|---|---|
| `DispatchUploader.java` | `app/src/main/java/com/sukhnafoods/salesorder/` | builds the TXT, saves it on the device, uploads it |
| `dispatch-inbox-route.ts` | `src/app/api/dispatch-inbox/route.ts` | queues the job into Supabase |
| `dispatch-status-route.ts` | `src/app/api/dispatch-status/route.ts` | lets the app read back the voucher |
| `dispatch-jobs-setup.sql` | run once in Supabase | creates `public.dispatch_jobs` |
| `dispatch_watcher.py` | `C:\pact\` on the PACT-desktop box | drains the queue, posts one voucher |

---

## 1. App (you build/flash)

1. Add `DispatchUploader.java` (already committed).
2. In `MainActivity.confirmStockOutward(...)`, on the **Submit** button, also fire the upload.
   Change:

   ```java
   .setPositiveButton("Submit", (d, w) -> startStockOutwardPush());
   ```
   to:
   ```java
   .setPositiveButton("Submit", (d, w) -> {
       // NEW: send the dispatch TXT to the cloud inbox (the PACT-desktop worker posts it)
       DispatchUploader.dispatch(this, soNumber, vendor, "Frozen",
           new java.util.ArrayList<>(scannedBarcodes),
           (jobId, err) -> toast(err == null
               ? "Dispatch sent (" + jobId + ")"
               : "Dispatch upload failed: " + err));
       startStockOutwardPush();   // keep the current path FOR NOW (see cut-over below)
   });
   ```
   That's the whole change to make the TXT appear **on the device and on the cloud** when you Submit.

3. (Later) The 3-second voucher popup: after Submit, poll `DispatchUploader.pollStatus(this, soNumber, cb)`
   every ~5s; when `status == "posted"`, show your full-screen popup with `voucher`.

## 2. Dashboard (deploy to Vercel)

1. Add the two routes (already committed under `src/app/api/dispatch-inbox/` and `.../dispatch-status/`).
2. Run `dispatch-jobs-setup.sql` once in the Supabase SQL editor.
3. Deploy the dashboard. Uses the **same** `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` env you already have — no new secrets.

## 3. PACT-desktop worker (the Windows PACT box)

1. Copy `dispatch_watcher.py` to `C:\pact\` (next to `pact_agent.py`).
2. Create `C:\pact\dispatch.env`:
   ```
   SUPABASE_URL=https://lezcgmnmcpgbecqtuqsg.supabase.co
   SUPABASE_SERVICE_KEY=<the service key>
   ```
3. Register it as a scheduled task **in the interactive Administrator session** (so pywinauto can drive PACT),
   same pattern as `PACT-Launch`. It only uses Python's standard library — no extra installs.
4. **Do NOT create `C:\pact\ARM_DISPATCH` yet.** While that file is absent the worker stays completely
   dormant and never touches PACT — so it can run safely alongside your current post path.

## 4. Cut-over + supervised test (do this together, once)

1. Confirm the app change is flashed and a Submit produces a TXT on the device **and** a `dispatch_jobs`
   row (status `queued`).
2. Pick **one fresh, not-yet-posted** order.
3. Remove `startStockOutwardPush();` from the app's Submit (so the app no longer posts directly),
   **or** just verify the current path didn't already post that order — the two must never both post.
4. `type nul > C:\pact\ARM_DISPATCH` to arm the worker, watch it post **one** voucher, and confirm in PACT.
5. Once it posts cleanly a few times, the EC2 path is the sole poster and it's hands-off.

**Golden rule:** exactly one thing posts to PACT. During the transition the worker is disarmed (dormant);
at cut-over you remove the app's direct push and arm the worker — never both at once.
