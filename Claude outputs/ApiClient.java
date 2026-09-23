package com.sukhnafoods.salesorder.net;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import com.sukhnafoods.salesorder.model.Batch;
import com.sukhnafoods.salesorder.model.Inventory;
import com.sukhnafoods.salesorder.model.OrderLine;
import com.sukhnafoods.salesorder.model.ProductStock;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * All network access for the app. Inventory and the shared order are read/written
 * through the dashboard's public endpoints (/api/inventory, /api/order,
 * /api/sync-inventory), so no database keys live in the app. Work runs on a
 * background thread; callbacks are delivered on the main thread.
 */
public final class ApiClient {

    public static final String BASE = "https://opsdashboard.sukhnafoods.com";

    /** value is non-null on success; error is non-null on failure. */
    public interface Cb<T> { void done(T value, String error); }

    // Pool (not single-thread): a long background sync-poll must never block quick
    // reads like loading an order or the requisition list. Bounded so we don't
    // hammer the API. Threads are daemon so they never hold the app open.
    private static final ExecutorService EXEC = Executors.newFixedThreadPool(4, r -> {
        Thread t = new Thread(r, "api-worker");
        t.setDaemon(true);
        return t;
    });
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final String[] MONTHS = {"jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"};

    private ApiClient() {}

    // ---- Public API -------------------------------------------------------

    /** The PACT product master (packaging levels), cached for the session. */
    private static com.sukhnafoods.salesorder.model.ProductMaster MASTER;

    /** Application context, used to read the product master bundled in assets. */
    private static Context APP;

    /** Called once from SukhnaApp so the master can be read without a network. */
    public static void init(Context c) { if (APP == null && c != null) APP = c.getApplicationContext(); }

    public static com.sukhnafoods.salesorder.model.ProductMaster masterOrNull() { return MASTER; }

    /**
     * The product master. It ships INSIDE the app (assets/pact-catalog.json), so
     * packaging levels are always available even with no network and even if the
     * dashboard route is not deployed. The server copy is only used to refresh.
     */
    public static void getProductMaster(Cb<com.sukhnafoods.salesorder.model.ProductMaster> cb) {
        if (MASTER != null) { MAIN.post(() -> cb.done(MASTER, null)); return; }
        run(() -> {
            com.sukhnafoods.salesorder.model.ProductMaster m = null;
            try {
                m = com.sukhnafoods.salesorder.model.ProductMaster.fromJson(
                        new JSONObject(get("/api/product-master")));
                if (m.size() == 0) m = null;
            } catch (Exception ignored) { /* fall back to the bundled copy */ }
            if (m == null) m = bundledMaster();
            MASTER = m;
            return m;
        }, cb);
    }

    /** Reads assets/pact-catalog.json. Never null; empty only if the read fails. */
    private static com.sukhnafoods.salesorder.model.ProductMaster bundledMaster() throws Exception {
        if (APP == null) throw new IllegalStateException("product master unavailable (app not initialised)");
        StringBuilder sb = new StringBuilder();
        try (InputStream in = APP.getAssets().open("pact-catalog.json");
             BufferedReader r = new BufferedReader(new InputStreamReader(in, "UTF-8"))) {
            char[] buf = new char[8192];
            int n;
            while ((n = r.read(buf)) > 0) sb.append(buf, 0, n);
        }
        return com.sukhnafoods.salesorder.model.ProductMaster.fromJson(new JSONObject(sb.toString()));
    }

    /** Forces a re-read (used by "View product master" -> Refresh). */
    public static void reloadProductMaster(Cb<com.sukhnafoods.salesorder.model.ProductMaster> cb) {
        MASTER = null;
        getProductMaster(cb);
    }

    // The inventory snapshot is ~1.6 MB / 8k+ batches. Downloading and parsing it
    // on every screen was the slowness. Cache it in memory: the first load fetches
    // it; every screen after reuses the parsed copy instantly. It only changes on
    // a PACT sync, so a fresh cache is safe; reloadInventory() forces a refresh.
    private static Inventory INV_CACHE;
    private static long INV_AT;
    private static final long INV_STALE_MS = 10 * 60 * 1000L;

    public static void getInventory(Cb<Inventory> cb) {
        Inventory c = INV_CACHE;
        if (c != null && System.currentTimeMillis() - INV_AT < INV_STALE_MS) { MAIN.post(() -> cb.done(c, null)); return; }
        run(() -> {
            Inventory inv = parseInventory(new JSONObject(get("/api/inventory")));
            INV_CACHE = inv; INV_AT = System.currentTimeMillis();
            return inv;
        }, cb);
    }
    /** Stock for just ONE order's products (tiny payload — fast on a slow floor
     *  network). so = SO number (B2B) or OMR number (prefix "omr:"). */
    public static void getOrderStock(String so, Cb<Inventory> cb) {
        run(() -> {
            String key = (so != null && so.startsWith("omr:")) ? "omr=" + java.net.URLEncoder.encode(so.substring(4), "UTF-8")
                                                               : "so=" + java.net.URLEncoder.encode(so == null ? "" : so, "UTF-8");
            return parseInventory(new JSONObject(get("/api/order-stock?" + key)));
        }, cb);
    }

    /** Force a fresh inventory download (used after a PACT sync). */
    public static void reloadInventory(Cb<Inventory> cb) { INV_CACHE = null; getInventory(cb); }
    /** The cached inventory, or null if not loaded yet. */
    public static Inventory inventoryOrNull() { return INV_CACHE; }
    static void invalidateInventory() { INV_CACHE = null; }

    public static void getOrder(String soNumber, Cb<List<OrderLine>> cb) {
        final String path = "/api/order" + (soNumber != null && !soNumber.isEmpty() ? "?so=" + enc(soNumber) : "");
        run(() -> {
            JSONObject o = new JSONObject(get(path));
            JSONArray arr = o.optJSONArray("lines");
            List<OrderLine> out = new ArrayList<>();
            if (arr != null) for (int i = 0; i < arr.length(); i++) out.add(OrderLine.fromJson(arr.getJSONObject(i)));
            return out;
        }, cb);
    }

    public static void getSalesOrders(Cb<List<com.sukhnafoods.salesorder.model.SalesOrder>> cb) {
        run(() -> {
            JSONObject o = new JSONObject(get("/api/sales-orders"));
            JSONArray arr = o.optJSONArray("orders");
            List<com.sukhnafoods.salesorder.model.SalesOrder> out = new ArrayList<>();
            if (arr != null) for (int i = 0; i < arr.length(); i++) out.add(com.sukhnafoods.salesorder.model.SalesOrder.summary(arr.getJSONObject(i)));
            return out;
        }, cb);
    }

    // ---- NutrioBox: pending outlet material requisitions (same shape as sales orders) ----
    public static void getOutletReqs(Cb<List<com.sukhnafoods.salesorder.model.SalesOrder>> cb) {
        run(() -> {
            JSONObject o = new JSONObject(get("/api/outlet-requisitions"));
            JSONArray arr = o.optJSONArray("orders");
            List<com.sukhnafoods.salesorder.model.SalesOrder> out = new ArrayList<>();
            if (arr != null) for (int i = 0; i < arr.length(); i++) out.add(com.sukhnafoods.salesorder.model.SalesOrder.summary(arr.getJSONObject(i)));
            return out;
        }, cb);
    }
    /** Fetch a pending sales order by its STABLE SO number (not the volatile id). */
    public static void getSalesOrderBySo(String so, Cb<com.sukhnafoods.salesorder.model.SalesOrder> cb) {
        run(() -> {
            JSONObject o = new JSONObject(get("/api/sales-orders?so=" + java.net.URLEncoder.encode(so == null ? "" : so, "UTF-8")));
            JSONObject ord = o.optJSONObject("order");
            if (ord == null) throw new Exception("Order not found");
            return com.sukhnafoods.salesorder.model.SalesOrder.detail(ord);
        }, cb);
    }
    /** Fetch a pending outlet requisition by its STABLE OMR number. */
    public static void getOutletReqBySo(String omr, Cb<com.sukhnafoods.salesorder.model.SalesOrder> cb) {
        run(() -> {
            JSONObject o = new JSONObject(get("/api/outlet-requisitions?so=" + java.net.URLEncoder.encode(omr == null ? "" : omr, "UTF-8")));
            JSONObject ord = o.optJSONObject("order");
            if (ord == null) throw new Exception("Requisition not found");
            return com.sukhnafoods.salesorder.model.SalesOrder.detail(ord);
        }, cb);
    }
    public static void getOutletReq(long id, Cb<com.sukhnafoods.salesorder.model.SalesOrder> cb) {
        run(() -> {
            JSONObject o = new JSONObject(get("/api/outlet-requisitions?id=" + id));
            JSONObject ord = o.optJSONObject("order");
            if (ord == null) throw new Exception("Requisition not found");
            return com.sukhnafoods.salesorder.model.SalesOrder.detail(ord);
        }, cb);
    }
    /** Trigger the NB pending-requisition sync and wait for the worker to finish. */
    public static void runOutletReqSync(SyncProgress progress, Cb<String> onDone) {
        EXEC.execute(() -> {
            try {
                String beforeId = ""; boolean useStatus = true;
                try { RunInfoS b = latestSyncRun("outlet-requisitions"); beforeId = b.present ? b.id : ""; }
                catch (Exception noStatus) { useStatus = false; }
                boolean started = new JSONObject(send("POST", "/api/sync-outlet-requisitions", "")).optBoolean("ok", false);
                if (!started) { MAIN.post(() -> onDone.done(null, "the server could not start the refresh.")); return; }
                if (!useStatus) { MAIN.post(() -> onDone.done("ok", null)); return; }
                final int MAX = 100; final String bId = beforeId;
                for (int i = 0; i < MAX; i++) {
                    Thread.sleep(2500);
                    RunInfoS r;
                    try { r = latestSyncRun("outlet-requisitions"); } catch (Exception e) { continue; }
                    if (r.present && !r.id.equals(bId)) {
                        if ("completed".equalsIgnoreCase(r.status)) {
                            if ("success".equalsIgnoreCase(r.conclusion)) { MAIN.post(() -> onDone.done("ok", null)); return; }
                            final String c = (r.conclusion == null || r.conclusion.isEmpty()) ? "failed" : r.conclusion;
                            MAIN.post(() -> onDone.done(null, "the refresh " + c + " on the server.")); return;
                        }
                        if (progress != null) MAIN.post(() -> progress.update("running on the server"));
                    } else if (progress != null) MAIN.post(() -> progress.update("starting the run"));
                }
                MAIN.post(() -> onDone.done(null, "the refresh is taking longer than usual — the list will update shortly."));
            } catch (Exception e) {
                final String m = friendly(e);
                MAIN.post(() -> onDone.done(null, m));
            }
        });
    }

    public static void getSalesOrder(long id, Cb<com.sukhnafoods.salesorder.model.SalesOrder> cb) {
        run(() -> {
            JSONObject o = new JSONObject(get("/api/sales-orders?id=" + id));
            JSONObject ord = o.optJSONObject("order");
            if (ord == null) throw new Exception("Order not found");
            return com.sukhnafoods.salesorder.model.SalesOrder.detail(ord);
        }, cb);
    }

    public static void getInvoices(Cb<List<com.sukhnafoods.salesorder.model.Invoice>> cb) {
        run(() -> {
            JSONObject o = new JSONObject(get("/api/invoices"));
            JSONArray arr = o.optJSONArray("invoices");
            List<com.sukhnafoods.salesorder.model.Invoice> out = new ArrayList<>();
            if (arr != null) for (int i = 0; i < arr.length(); i++) out.add(com.sukhnafoods.salesorder.model.Invoice.fromJson(arr.getJSONObject(i)));
            return out;
        }, cb);
    }

    /** Save a scan. The server MERGES by (soNumber + product + batch) and returns the
     *  stored line WITH its id and running quantity, so the app can adopt the id for
     *  deletes without a full refresh. The callback gets that line, or null on failure. */
    public static void postScan(OrderLine l, String source, Cb<OrderLine> cb) {
        JSONObject b = new JSONObject();
        try {
            b.put("productCode", l.productCode); b.put("productName", l.productName); b.put("hsn", l.hsn);
            b.put("warehouse", l.warehouse); b.put("salesUnitLevel", l.salesUnitLevel); b.put("unit", l.unit);
            b.put("quantity", l.quantity); b.put("unitPrice", l.unitPrice); b.put("salesRate", l.salesRate);
            b.put("gstTaxType", l.gstTaxType); b.put("batchNumber", l.batchNumber); b.put("mfgDate", l.mfgDate);
            b.put("expiryDate", l.expiryDate); b.put("soNumber", l.soNumber); b.put("vendor", l.vendor); b.put("source", source);
        } catch (Exception ignore) {}
        run(() -> {
            JSONObject o = new JSONObject(send("POST", "/api/order", b.toString()));
            if (!o.optBoolean("ok", false)) return null;
            JSONObject ln = o.optJSONObject("line");
            return ln != null ? OrderLine.fromJson(ln) : null;
        }, cb);
    }

    public static void patch(long id, JSONObject fields, Cb<Boolean> cb) {
        try { fields.put("id", id); } catch (Exception ignore) {}
        run(() -> new JSONObject(send("PATCH", "/api/order", fields.toString())).optBoolean("ok", false), cb);
    }

    public static void delete(String query, Cb<Boolean> cb) {
        run(() -> new JSONObject(send("DELETE", "/api/order" + query, null)).optBoolean("ok", false), cb);
    }

    public static void triggerSync(Cb<Boolean> cb) {
        run(() -> new JSONObject(send("POST", "/api/sync-inventory", "")).optBoolean("ok", false), cb);
    }

    // ---- Automatic inventory freshness -------------------------------------
    // The per-order stock the scan screens show comes from the last PACT
    // inventory snapshot. To keep it current WITHOUT the operator tapping the
    // slow "Sync inventory from PACT" button, the scan screens call
    // autoSyncIfStale() on open: if the snapshot is old, it fires a background
    // PACT sync (debounced across the whole app) and the screen silently
    // re-pulls stock a little later.
    private static volatile long INV_SYNC_KICKED_AT = 0L;
    private static final long AUTO_STALE_MS   = 20 * 60 * 1000L;  // refresh stock older than 20 min
    private static final long KICK_DEBOUNCE_MS = 3 * 60 * 1000L;  // don't re-fire within 3 min

    /** Kick a background PACT inventory sync if the snapshot is stale. Fire-and-
     *  forget and debounced app-wide. Returns true if a sync was started. */
    public static boolean autoSyncIfStale(String syncedAtIso) {
        long age = snapshotAgeMs(syncedAtIso);
        long now = System.currentTimeMillis();
        if (age >= 0 && age < AUTO_STALE_MS) return false;             // still fresh
        if (now - INV_SYNC_KICKED_AT < KICK_DEBOUNCE_MS) return false; // one is already running
        INV_SYNC_KICKED_AT = now;
        EXEC.execute(() -> { try { send("POST", "/api/sync-inventory", ""); } catch (Exception ignore) {} });
        return true;
    }

    /** Age of a snapshot ISO time (e.g. 2026-09-05T09:25:23.861+00:00), in ms; -1 if unknown. */
    public static long snapshotAgeMs(String iso) {
        if (iso == null || iso.length() < 19) return -1;
        try {
            java.text.SimpleDateFormat f = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.ROOT);
            f.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
            long t = f.parse(iso.substring(0, 19)).getTime();
            return System.currentTimeMillis() - t;
        } catch (Exception e) { return -1; }
    }

    /** Progress callback for runSync (stage text for the UI). */
    public interface SyncProgress { void update(String stage); }

    private static class RunInfo { boolean present; long id; String status = "", conclusion = ""; }

    /** The latest sync-inventory GitHub run (throws if the status endpoint is unavailable). */
    private static RunInfo latestSyncRun() throws Exception {
        JSONObject o = new JSONObject(get("/api/sync-status"));
        RunInfo r = new RunInfo();
        JSONObject run = o.optJSONObject("run");
        if (run != null) {
            r.present = true;
            r.id = run.optLong("id", 0);
            r.status = run.optString("status", "");
            r.conclusion = run.optString("conclusion", "");
        }
        return r;
    }

    /**
     * Trigger the PACT inventory sync and wait for the REAL GitHub run to finish.
     * onDone.done("ok", null) fires ONLY once the newly-started run is completed
     * AND its conclusion is success; onDone.done(null, msg) on failure/timeout.
     * Falls back to strict snapshot-change detection if /api/sync-status is not
     * available (older server deploy).
     */
    public static void runSync(SyncProgress progress, Cb<String> onDone) {
        EXEC.execute(() -> {
            try {
                // Baseline: the inventory snapshot's current sync timestamp.
                String beforeSynced = null;
                try { JSONObject inv = new JSONObject(get("/api/inventory")); beforeSynced = inv.isNull("syncedAt") ? null : inv.optString("syncedAt", null); }
                catch (Exception ignore) {}

                boolean started = new JSONObject(send("POST", "/api/sync-inventory", "")).optBoolean("ok", false);
                if (!started) { MAIN.post(() -> onDone.done(null, "the server could not start the sync.")); return; }

                // The worker refreshes the snapshot on success, so a NEW syncedAt
                // (with batches present) means the sync finished — regardless of
                // how the run is identified server-side. Reliable and simple.
                final int MAX = 130;   // 130 x 2.5s ≈ 5.4 min
                for (int i = 0; i < MAX; i++) {
                    Thread.sleep(2500);
                    try {
                        JSONObject inv = new JSONObject(get("/api/inventory"));
                        String synced = inv.isNull("syncedAt") ? null : inv.optString("syncedAt", null);
                        int batches = inv.optInt("batches", 0);
                        boolean changed = synced != null && batches > 0
                                && (beforeSynced == null || !synced.equals(beforeSynced));
                        if (changed) { INV_CACHE = null; MAIN.post(() -> onDone.done("ok", null)); return; }
                        if (progress != null) MAIN.post(() -> progress.update("running on the server"));
                    } catch (Exception ignore) {}
                }
                MAIN.post(() -> onDone.done(null, "the sync is taking longer than usual \u2014 tap Sync again in a moment."));
            } catch (Exception e) {
                final String m = friendly(e);
                MAIN.post(() -> onDone.done(null, m));
            }
        });
    }

    /** Kick off the PACT "Pending Sales Order Quantity" sync (refreshes pending_sales_orders). */
    public static void triggerSalesOrderSync(Cb<Boolean> cb) {
        run(() -> new JSONObject(send("POST", "/api/sync-sales-orders", "")).optBoolean("ok", false), cb);
    }

    /** Latest sync job of a given type ("sales-orders" | "inventory"), by string id. */
    private static class RunInfoS { boolean present; String id = "", status = "", conclusion = ""; }

    private static RunInfoS latestSyncRun(String type) throws Exception {
        JSONObject o = new JSONObject(get("/api/sync-status?type=" + type));
        RunInfoS r = new RunInfoS();
        JSONObject run = o.optJSONObject("run");
        if (run != null) {
            r.present = true;
            r.id = run.optString("id", "");
            r.status = run.optString("status", "");
            r.conclusion = run.optString("conclusion", "");
        }
        return r;
    }

    /**
     * Trigger the pending-sales-order sync and wait for the AWS worker to FINISH
     * (via /api/sync-status?type=sales-orders), instead of waiting for the list
     * to change. onDone.done("ok", null) fires once our run completes with
     * success; onDone.done(null, msg) on failure/timeout. This gives clear
     * feedback even when the refreshed list is identical to before.
     */
    public static void runSalesOrderSync(SyncProgress progress, Cb<String> onDone) {
        EXEC.execute(() -> {
            try {
                String beforeId = "";
                boolean useStatus = true;
                try { RunInfoS b = latestSyncRun("sales-orders"); beforeId = b.present ? b.id : ""; }
                catch (Exception noStatus) { useStatus = false; }

                boolean started = new JSONObject(send("POST", "/api/sync-sales-orders", "")).optBoolean("ok", false);
                if (!started) { MAIN.post(() -> onDone.done(null, "the server could not start the refresh.")); return; }

                if (!useStatus) { MAIN.post(() -> onDone.done("ok", null)); return; }  // old server: no status endpoint

                final int MAX = 80;               // 80 x 2.5s = up to ~3.3 min
                final String bId = beforeId;
                for (int i = 0; i < MAX; i++) {
                    Thread.sleep(2500);
                    RunInfoS r;
                    try { r = latestSyncRun("sales-orders"); }
                    catch (Exception e) { continue; }
                    if (r.present && !r.id.equals(bId)) {                 // OUR newly-started run
                        if ("completed".equalsIgnoreCase(r.status)) {
                            if ("success".equalsIgnoreCase(r.conclusion)) { MAIN.post(() -> onDone.done("ok", null)); return; }
                            final String c = (r.conclusion == null || r.conclusion.isEmpty()) ? "failed" : r.conclusion;
                            MAIN.post(() -> onDone.done(null, "the sync " + c + " on the server.")); return;
                        }
                        if (progress != null) MAIN.post(() -> progress.update("running on the server"));
                    } else if (progress != null) MAIN.post(() -> progress.update("starting the run"));
                }
                MAIN.post(() -> onDone.done(null, "the refresh is taking longer than usual — the list will update shortly."));
            } catch (Exception e) {
                final String m = friendly(e);
                MAIN.post(() -> onDone.done(null, m));
            }
        });
    }

    /**
     * Hands a finished, scanned order to the server, which fills the Factory
     * Sales Invoice in PACT using a real headless browser -- no PC and no phone
     * browser in the loop. Returns the job id so the caller can poll
     * {@link #getPactJob}. dryRun=true fills the invoice but STOPS before Post,
     * so it is always safe to run.
     */
    /** Latest snapshot of the "Detail Factory Sales Invoices" report. */
    public static void getDetailFsi(Cb<com.sukhnafoods.salesorder.model.DetailFsi> cb) {
        run(() -> com.sukhnafoods.salesorder.model.DetailFsi.fromJson(new JSONObject(get("/api/detail-fsi"))), cb);
    }

    /** NutrioBox past-dispatch invoices snapshot (grouped by Outlet No / SOT). */
    public static void getNbInvoices(Cb<com.sukhnafoods.salesorder.model.DetailFsi> cb) {
        run(() -> com.sukhnafoods.salesorder.model.DetailFsi.fromJson(new JSONObject(get("/api/nb-invoices"))), cb);
    }

    /** One invoice's product lines, fetched on demand (B2B: /api/detail-fsi?inv=, NB: /api/nb-invoices?inv=). */
    public static void getInvoiceLines(boolean nb, String inv, Cb<com.sukhnafoods.salesorder.model.DetailFsi> cb) {
        run(() -> {
            String path = (nb ? "/api/nb-invoices?inv=" : "/api/detail-fsi?inv=") + enc(inv == null ? "" : inv);
            return com.sukhnafoods.salesorder.model.DetailFsi.fromJson(new JSONObject(get(path)));
        }, cb);
    }

    /**
     * Trigger a fresh "Detail Factory Sales Invoices" pull (today 00:00 -> now)
     * and wait for the AWS worker to finish (via /api/sync-status?type=detail-fsi).
     * onDone.done("ok", null) on success; onDone.done(null, msg) on failure/timeout.
     */
    public static void runDetailFsiSync(SyncProgress progress, Cb<String> onDone) {
        EXEC.execute(() -> {
            try {
                String beforeId = ""; boolean useStatus = true;
                try { RunInfoS b = latestSyncRun("detail-fsi"); beforeId = b.present ? b.id : ""; }
                catch (Exception noStatus) { useStatus = false; }
                boolean started = new JSONObject(send("POST", "/api/sync-detail-fsi", "")).optBoolean("ok", false);
                if (!started) { MAIN.post(() -> onDone.done(null, "the server could not start the pull.")); return; }
                if (!useStatus) { MAIN.post(() -> onDone.done("ok", null)); return; }
                final int MAX = 100; final String bId = beforeId;
                for (int i = 0; i < MAX; i++) {
                    Thread.sleep(2500);
                    RunInfoS r;
                    try { r = latestSyncRun("detail-fsi"); } catch (Exception e) { continue; }
                    if (r.present && !r.id.equals(bId)) {
                        if ("completed".equalsIgnoreCase(r.status)) {
                            if ("success".equalsIgnoreCase(r.conclusion)) { MAIN.post(() -> onDone.done("ok", null)); return; }
                            final String c = (r.conclusion == null || r.conclusion.isEmpty()) ? "failed" : r.conclusion;
                            MAIN.post(() -> onDone.done(null, "the report pull " + c + " on the server.")); return;
                        }
                        if (progress != null) MAIN.post(() -> progress.update("running on the server"));
                    } else if (progress != null) MAIN.post(() -> progress.update("starting the run"));
                }
                MAIN.post(() -> onDone.done(null, "the report is taking longer than usual \u2014 try again shortly."));
            } catch (Exception e) {
                final String m = friendly(e);
                MAIN.post(() -> onDone.done(null, m));
            }
        });
    }

    public static void pushFsi(String soNumber, String customer, List<String> barcodes, boolean dryRun, Cb<String> cb) {
        JSONObject body = new JSONObject();
        try {
            JSONArray bc = new JSONArray();
            if (barcodes != null) for (String s : barcodes) if (s != null && !s.trim().isEmpty()) bc.put(s.trim());
            JSONObject order = new JSONObject();
            order.put("soNumber", soNumber == null ? "" : soNumber);
            if (customer != null && !customer.trim().isEmpty()) order.put("customer", customer.trim());
            order.put("barcodes", bc);
            body.put("order", order);
            body.put("dryRun", dryRun);
        } catch (Exception ignore) {}
        run(() -> {
            JSONObject o = new JSONObject(send("POST", "/api/push-fsi", body.toString()));
            if (!o.optBoolean("ok", false)) throw new Exception(o.optString("error", "Push failed"));
            return o.optString("jobId", "");
        }, cb);
    }

    /** NutrioBox dispatch: enqueue a Stock Outward to Outlet push for an outlet
     *  requisition (OMR). Same job pipeline as {@link #pushFsi} but the worker
     *  drives the Stock Outward document instead of a Factory Sales Invoice. */
    public static void pushStockOutward(String omr, String outlet, List<String> barcodes, boolean dryRun, Cb<String> cb) {
        JSONObject body = new JSONObject();
        try {
            JSONArray bc = new JSONArray();
            if (barcodes != null) for (String s : barcodes) if (s != null && !s.trim().isEmpty()) bc.put(s.trim());
            JSONObject order = new JSONObject();
            order.put("omr", omr == null ? "" : omr);
            if (outlet != null && !outlet.trim().isEmpty()) order.put("outlet", outlet.trim());
            order.put("barcodes", bc);
            body.put("order", order);
            body.put("dryRun", dryRun);
        } catch (Exception ignore) {}
        run(() -> {
            JSONObject o = new JSONObject(send("POST", "/api/push-stock-outward", body.toString()));
            if (!o.optBoolean("ok", false)) throw new Exception(o.optString("error", "Push failed"));
            return o.optString("jobId", "");
        }, cb);
    }

    /** One status read for a Factory Sales Invoice push. */
    public static final class JobStatus {
        public final String status, message, invoice, updatedAt;
        JobStatus(String s, String m, String i, String u) { status = s; message = m; invoice = i; updatedAt = u; }
        public boolean isDone()     { return "done".equalsIgnoreCase(status); }
        public boolean isFailed()   { return "failed".equalsIgnoreCase(status); }
        public boolean isFinished() { return isDone() || isFailed(); }
    }

    /** Polls the server for a push's status (see {@link #pushFsi}). */
    public static void getPactJob(String jobId, Cb<JobStatus> cb) {
        final String path = "/api/pact-job?id=" + enc(jobId);
        run(() -> {
            JSONObject o = new JSONObject(get(path));
            return new JobStatus(o.optString("status", ""), o.optString("message", ""),
                    o.optString("invoice", ""), o.optString("updatedAt", ""));
        }, cb);
    }

    // ---- Internals --------------------------------------------------------

    /**
     * Turns network plumbing errors into something a person on the floor can act
     * on. Losing Wi-Fi is by far the most common failure on a handheld scanner,
     * and "Unable to resolve host" tells the operator nothing useful.
     */
    private static String friendly(Exception e) {
        String raw = e.getMessage() == null ? e.toString() : e.getMessage();
        String low = raw.toLowerCase(java.util.Locale.ROOT);
        if (e instanceof java.net.UnknownHostException
                || low.contains("unable to resolve host")
                || low.contains("no address associated")) {
            return "No internet connection. Check the device's Wi-Fi, then try again.";
        }
        if (e instanceof java.net.SocketTimeoutException || low.contains("timeout") || low.contains("timed out")) {
            return "The server took too long to respond. Check the connection and try again.";
        }
        if (e instanceof java.net.ConnectException || low.contains("failed to connect")) {
            return "Couldn't reach the server. Check the device's Wi-Fi, then try again.";
        }
        if (e instanceof javax.net.ssl.SSLException || low.contains("ssl")) {
            return "Secure connection failed. Check the device's date/time and Wi-Fi, then try again.";
        }
        return raw;
    }

    private interface Work<T> { T run() throws Exception; }

    private static <T> void run(Work<T> work, Cb<T> cb) {
        EXEC.execute(() -> {
            try {
                final T v = work.run();
                MAIN.post(() -> cb.done(v, null));
            } catch (Exception e) {
                final String msg = friendly(e);
                MAIN.post(() -> cb.done(null, msg));
            }
        });
    }

    private static String enc(String s) { try { return java.net.URLEncoder.encode(s, "UTF-8"); } catch (Exception e) { return s; } }

    private static String get(String path) throws Exception { return send("GET", path, null); }

    private static String send(String method, String path, String body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(BASE + path).openConnection();
        try {
            c.setRequestMethod(method);
            c.setConnectTimeout(15000);
            c.setReadTimeout(60000);
            c.setRequestProperty("Accept", "application/json");
            if (body != null) {
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                try (OutputStream os = c.getOutputStream()) { os.write(body.getBytes("UTF-8")); }
            }
            int code = c.getResponseCode();
            InputStream in = (code >= 200 && code < 300) ? c.getInputStream() : c.getErrorStream();
            String text = readAll(in);
            if (code < 200 || code >= 300) throw new Exception("HTTP " + code + ": " + (text.length() > 160 ? text.substring(0, 160) : text));
            return text;
        } finally {
            c.disconnect();
        }
    }

    private static String readAll(InputStream in) throws Exception {
        if (in == null) return "";
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(in, "UTF-8"))) {
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
        }
        return sb.toString();
    }

    private static Inventory parseInventory(JSONObject json) {
        JSONArray rows = json.optJSONArray("data");
        Map<String, String> names = new LinkedHashMap<>();
        Map<String, String> hsns = new LinkedHashMap<>();
        Map<String, List<Batch>> grouped = new LinkedHashMap<>();
        if (rows != null) {
            for (int i = 0; i < rows.length(); i++) {
                JSONObject r = rows.optJSONObject(i);
                if (r == null) continue;
                String code = r.optString("code").trim();
                if (code.isEmpty()) continue;
                if (names.get(code) == null || names.get(code).isEmpty()) names.put(code, r.optString("name", ""));
                if (hsns.get(code) == null || hsns.get(code).isEmpty()) hsns.put(code, r.optString("hsn", ""));
                String exp = r.optString("exp", "-");
                Batch b = new Batch(
                        r.optString("batch", "-"), r.optString("warehouse", "-"), r.optString("unit", "-"),
                        r.optDouble("qty", 0), r.optString("rate", ""), r.optString("mfg", "-"), exp, parseDate(exp));
                List<Batch> list = grouped.get(code);
                if (list == null) { list = new ArrayList<>(); grouped.put(code, list); }
                list.add(b);
            }
        }
        final long now = System.currentTimeMillis();
        Map<String, ProductStock> index = new LinkedHashMap<>();
        for (Map.Entry<String, List<Batch>> e : grouped.entrySet()) {
            List<Batch> list = e.getValue();
            Collections.sort(list, new Comparator<Batch>() {
                @Override public int compare(Batch a, Batch b) {
                    int ea = a.expiryTs < now ? 1 : 0, eb = b.expiryTs < now ? 1 : 0;
                    if (ea != eb) return Integer.compare(ea, eb);
                    return Long.compare(a.expiryTs, b.expiryTs);
                }
            });
            ProductStock ps = new ProductStock(names.get(e.getKey()) == null ? "" : names.get(e.getKey()), list);
            ps.hsn = hsns.get(e.getKey()) == null ? "" : hsns.get(e.getKey());
            index.put(e.getKey(), ps);
        }
        // batch number -> product code, so scanning a batch barcode resolves to its product
        Map<String, String> batchToCode = new LinkedHashMap<>();
        for (Map.Entry<String, List<Batch>> e : grouped.entrySet())
            for (Batch b : e.getValue()) {
                String bn = b.batchNumber == null ? "" : b.batchNumber.trim().toUpperCase(java.util.Locale.ROOT);
                if (!bn.isEmpty() && !bn.equals("-") && !batchToCode.containsKey(bn)) batchToCode.put(bn, e.getKey());
            }
        int batches = 0;
        for (List<Batch> l : grouped.values()) batches += l.size();
        return new Inventory(index, batchToCode, json.optInt("products", index.size()), json.optInt("batches", batches),
                json.isNull("syncedAt") ? null : json.optString("syncedAt", null));
    }

    /** "09/May/2027" -> epoch millis; far future when unparseable so it sorts last. */
    public static long parseDate(String s) {
        if (s == null) return Long.MAX_VALUE;
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("(\\d{1,2})[/-]([A-Za-z]{3,})[/-](\\d{2,4})").matcher(s);
        if (!m.find()) return Long.MAX_VALUE;
        int day; int year;
        try { day = Integer.parseInt(m.group(1)); year = Integer.parseInt(m.group(3)); } catch (Exception e) { return Long.MAX_VALUE; }
        if (year < 100) year += 2000;
        int mon = -1;
        String mm = m.group(2).substring(0, 3).toLowerCase();
        for (int i = 0; i < MONTHS.length; i++) if (MONTHS[i].equals(mm)) { mon = i; break; }
        if (mon < 0) return Long.MAX_VALUE;
        Calendar cal = Calendar.getInstance();
        cal.clear(); cal.set(year, mon, day);
        return cal.getTimeInMillis();
    }
}
