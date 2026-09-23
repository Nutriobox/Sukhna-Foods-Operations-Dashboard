# Dispatch Issue Report — Order OMR-AF/26-27/1867 (Nutriobox, Prashant Vihar)

**Date:** 8 September 2026
**Order:** OMR-AF/26-27/1867 — 68 line-items, Factory → Nutriobox (Prashant Vihar)
**Outcome:** 61 in-stock items dispatched successfully; 7 items held (out of stock / missing rate)

---

## Summary

The Prashant Vihar dispatch appeared to "not submit." In reality the order was reaching PACT, but a large document with a few out-of-stock items was being **silently refused** by PACT. We identified the exact blocking items, dispatched everything that was in stock, and built a permanent fix so this cannot happen silently again.

---

## Errors faced and how each was solved

### 1. "Submit not working / not submitting"
- **What was seen:** Tapping Submit only showed "All items scanned…" or "Taking longer than usual — check PACT/dashboard." Nothing appeared to post.
- **Actual cause:** Submit *was* working and queuing the job. Order 1867 is large (68 items); filling that many items into PACT takes several minutes — longer than the app's wait timer, so the app gave up while the worker was still filling.
- **Solution:**
  - Confirmed the job was genuinely running server-side.
  - Sped up the app's status polling and lengthened the wait for big orders (v3.9.40).
  - Fixed the job queue so dispatch jobs run **ahead of** background sync jobs instead of waiting behind them.

### 2. PACT silently refused to Post (root cause)
- **What happened:** The document filled correctly — correct outlet (Nutriobox Prashant Vihar), correct Outlet ReqNo, ~65 of 68 lines — but clicking Post did nothing. It stayed **Draft with no error message**, and nothing dispatched.
- **Actual cause:** **Out-of-stock items.** When an item's exact batch isn't in the N.B Cold Room stock, PACT cannot allocate it, and that line sits in the document **unallocated**. An unallocated line silently blocks the **entire** Post. Small orders posted fine because every batch was in stock; this large order had several that were not.
- **Solution:** Identified exactly which items were out of stock, excluded them, and **posted the 61 in-stock items successfully**. Built an automatic guard in the app (see "Permanent fix").

### 3. Could not confirm whether it had posted (detection)
- **Cause:** The worker's success-check ran only 16 seconds and could not read the document number on a 65-line document, so it reported "uncertain."
- **Solution:** Rewrote the detector to read real success signals (grid clearing / Net Total → 0), extended the window, and made it **never blind-retry** — eliminating any double-dispatch risk. Verified via PACT's own report that nothing double-posted.

### 4. Zero-value line (Malabari Gravy, FGO569)
- **Cause:** That product has **no rate set in PACT** (unit price and value both 0.00). Initially suspected as the blocker; removing it alone did not fix the post (the out-of-stock items were the real cause), but it is a genuine data gap.
- **Solution:** Excluded it from this dispatch and flagged it — a rate must be added in PACT's product master.

---

## Items NOT dispatched (still pending on 1867)

Restock these batches in the N.B Cold Room (and set a rate for Malabari Gravy), then dispatch them against 1867 in a quick follow-up scan.

| Product | Code | Batch | Qty |
|---|---|---|---|
| Chicken Tikka (40 Gms/12 Pcs) | FG0068 | FN0068/21082601 | 16 |
| Tomato Concasse (20 Pkt/Bunch) | FG0021 | FN0021/27082601 | 6 |
| Whole Wheat Chicken Momos (32g/16 Pcs) | FG0045 | FN0045/19082601 | 24 |
| That Brown Girl (300ML) | FG0003 | FN0003/02092601 | 6 |
| Pizza Base (150 Gms/4 Pcs) | FG0069 | FN0069/05092601 | 12 |
| Mozzarella Cheese (raw material) | RM0045 | RC0045/03092601 | 8 |
| Malabari Gravy (8 Pkt/Bunch) — *no rate in PACT* | FGO569 | FN0569/20082601 | 4 |

---

## Permanent fix (now in app v3.9.40)

At Submit, the app re-checks every scanned item against current stock. Any item that is out of stock in the dispatch warehouse is **dropped with one clear popup listing it (product + batch)**, and only the in-stock items are posted. It can only *exclude* items — it never wrongly dispatches — so this order type will never silently fail again.

**Operator note:** tap **"Sync inventory from PACT"** before submitting a large order, so the stock check is current.

---

## Related fixes made the same day (all NutrioBox dispatch)

- **Outlet resolution:** the system now always dispatches to the correct Nutriobox outlet (read from the requisition), instead of defaulting to "Factory." (This is what had blocked the earlier Shivalik order, 1866, which then posted successfully.)
- **Queue priority:** operator dispatches jump ahead of background syncs.
- **App improvements (v3.9.40):** "View inventory" button removed from the scan screen; NutrioBox past-invoice detail reworked (Units after product name, new Variance = Ordered − Dispatched column, tighter layout); scan box keeps focus after each refresh; faster status polling; Submit isolated per order.
