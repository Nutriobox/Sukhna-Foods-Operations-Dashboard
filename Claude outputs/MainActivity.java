package com.sukhnafoods.salesorder;

import android.app.AlertDialog;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.KeyEvent;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import com.sukhnafoods.salesorder.databinding.ActivityMainBinding;
import com.sukhnafoods.salesorder.model.Batch;
import com.sukhnafoods.salesorder.model.ProductMaster;
import com.sukhnafoods.salesorder.model.Inventory;
import com.sukhnafoods.salesorder.model.OrderLine;
import com.sukhnafoods.salesorder.model.ProductStock;
import com.sukhnafoods.salesorder.model.SalesOrderItem;
import com.sukhnafoods.salesorder.net.ApiClient;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Scan-and-dispatch screen for ONE sales order. The table is the sales order:
 * one row per ordered product, with Product code / Product name / GST HSN
 * auto-fetched, plus S.O qty, Pending qty and the running Scanned qty — all in
 * the same UOM. Batch detail lives behind "View inventory".
 */
public class MainActivity extends AppCompatActivity {

    private ActivityMainBinding b;
    private final LineAdapter adapter = new LineAdapter();
    private Inventory inventory;
    private long inventoryLoadedAt = 0L;   // when the full inventory was last downloaded
    private static final long INVENTORY_STALE_MS = 5 * 60 * 1000L;  // resume-refresh only if older than this

    private long soId = 0;
    private String soNumber = null, vendor = null;
    private boolean viewOnly = false;   // read-only view of a submitted order
    private String channel = "B2B";     // "NB" = NutrioBox outlet dispatch (Stock Outward)
    private boolean nbPush = false;      // a Stock-Outward push (not FSI) is in flight

    private boolean completed = false;
    private int restoredCount = 0;
    private int msgDefaultColor = 0xFF444444;   // captured from the theme in onCreate

    private final List<SalesOrderItem> soItems = new ArrayList<>();   // the order's lines
    private String lastScannedCode = "";   // product just scanned — floats to the top of the list
    private List<OrderLine> scans = new ArrayList<>();                // what has been scanned
    private final java.util.List<String> scannedBarcodes = new java.util.ArrayList<>(); // raw labels, to feed PACT
    private final java.util.HashMap<String, Double> localScanned = new java.util.HashMap<>(); // immediate scanned count (code -> packs), covers the server list lag

    private final Handler poll = new Handler(Looper.getMainLooper());
    /** debounce for auto-adding a scan once the wedge stops typing. */
    private final Handler scanDebounce = new Handler(Looper.getMainLooper());
    private Runnable pendingScan;

    // ---- NutrioBox auto-post (Option B) --------------------------------------
    // Every 10 minutes, the items scanned since the last post are dispatched as
    // their own Stock Outward voucher against the same requisition. A per-batch
    // ledger of already-posted packs guarantees no pack is ever dispatched twice;
    // out-of-stock deltas are skipped (never block the post). OFF by default —
    // the operator turns it on per dispatch with the Auto-post button.
    private boolean autoPostOn = true;             // NB auto-post ON — posts scanned items on the 10-min cycle
    private boolean autoPosting = false;           // an auto-post job is currently in flight
    private boolean autoStopped = false;           // an auto-post ended un-confirmed — automation halted for safety
    private int autoPostVouchers = 0;              // successful auto-post vouchers this session
    private final java.util.HashMap<String, Double> postedPacks = new java.util.HashMap<>(); // (codebatch) -> packs already posted
    private java.util.HashMap<String, Double> pendingDeltaPacks = null;  // the delta a manual submit is posting
    private static final long AUTO_POST_MS = 10 * 60 * 1000L;   // 10 minutes
    private boolean autoArmed = false;             // 10-min cycle started (from this order's FIRST scan; later scans do NOT reset it)
    private boolean scanFrozen = false;            // brief pre-auto-post freeze: no scan may register during the snapshot
    private static final int FREEZE_SECS = 4;      // seconds scanning is locked before each auto-post snapshot
    private final Handler autoPost = new Handler(Looper.getMainLooper());
    private final Runnable autoPostTick = new Runnable() {
        @Override public void run() {
            try { autoCycle(); }
            finally { if (isNb() && autoPostOn && !completed && !viewOnly) autoPost.postDelayed(this, AUTO_POST_MS); }
        }
    };

    private final Runnable pollTask = new Runnable() {
        @Override public void run() { refreshScans(); poll.postDelayed(this, 3000); }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        b = ActivityMainBinding.inflate(getLayoutInflater());
        setContentView(b.getRoot());
        msgDefaultColor = b.tvMsg.getCurrentTextColor();

        soNumber = getIntent().getStringExtra("SO_NUMBER");
        vendor = getIntent().getStringExtra("VENDOR");
        viewOnly = getIntent().getBooleanExtra("VIEW_COMPLETED", false);
        soId = getIntent().getLongExtra("ID", 0);
        channel = getIntent().getStringExtra("CHANNEL");
        if (channel == null || channel.isEmpty()) channel = "B2B";
        if (soNumber != null && !soNumber.isEmpty()) {
            b.tvTitle.setText("Sales Order — " + soNumber + (vendor != null && !vendor.isEmpty() ? "  (" + vendor + ")" : ""));
        }

        b.rv.setLayoutManager(new LinearLayoutManager(this));
        b.rv.setAdapter(adapter);
        adapter.setOnDeleteBatch(row -> confirmDeleteBatch(row));   // ✕ on a scanned batch row

        b.btnSync.setOnClickListener(v -> syncFromPact());
        b.btnClear.setOnClickListener(v -> confirmClearOrder());
        b.btnFillPact.setOnClickListener(v -> fillInPact());
        b.btnFillPact.setEnabled(false);   // Submit goes live only after the first successful scan
        b.btnSave.setOnClickListener(v -> saveNow(true));
        // The top button row now carries a Clear-order button (was the auto-post toggle).
        if (b.btnClearTop != null) b.btnClearTop.setOnClickListener(v -> confirmClearOrder());

        // Guard against the swipe-right / edge back-gesture silently leaving this
        // scan screen (it used to drop back to the order's inventory screen). While
        // there are scans in progress, ask before leaving; otherwise go back normally.
        getOnBackPressedDispatcher().addCallback(this, new androidx.activity.OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                if (viewOnly || completed) { finish(); return; }
                boolean any = scans != null && !scans.isEmpty();
                new AlertDialog.Builder(MainActivity.this)
                    .setTitle("Leave this scan screen?")
                    .setMessage(any
                        ? "You are still scanning this order. Your scanned items are saved, but leaving stops scanning here. Leave anyway?"
                        : "Leave this order and go back?")
                    .setNegativeButton("Stay", null)
                    .setPositiveButton("Leave", (d, w) -> finish())
                    .show();
            }
        });

        // Keyboard must NOT auto-open here. It appears only when the user taps the
        // "Scan a barcode" box; the hardware scanner works without it.
        b.etScan.setShowSoftInputOnFocus(false);
        b.etScan.setOnClickListener(v -> {
            b.etScan.setShowSoftInputOnFocus(true);
            b.etScan.requestFocus();
            android.view.inputmethod.InputMethodManager imm =
                    (android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
            if (imm != null) imm.showSoftInput(b.etScan, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT);
        });

        b.etScan.setOnEditorActionListener((tv, actionId, ev) -> {
            if (actionId == EditorInfo.IME_ACTION_DONE || actionId == EditorInfo.IME_ACTION_GO) {
                submitScan(b.etScan.getText().toString());
                return true;
            }
            return false;
        });
        // The scan is added on its own — no button. A keyboard-wedge scanner
        // injects the whole code in a burst; if it ends with a newline we submit
        // at once, otherwise we wait for a short quiet gap (the scanner has
        // stopped typing) and submit then. Manual typing is submitted the same
        // way, so the flow is identical whether scanned or typed.
        b.etScan.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int a, int c, int d) {}
            @Override public void onTextChanged(CharSequence s, int a, int c, int d) {}
            @Override public void afterTextChanged(Editable s) {
                if (pendingScan != null) scanDebounce.removeCallbacks(pendingScan);
                final String v = s.toString();
                if (v.isEmpty()) return;
                if (v.charAt(v.length() - 1) == '\n') { submitScan(v); return; }
                pendingScan = () -> {
                    String cur = b.etScan.getText().toString();
                    if (!cur.isEmpty() && cur.equals(v)) submitScan(cur);   // unchanged = burst finished
                };
                scanDebounce.postDelayed(pendingScan, 350);
            }
        });

        restoreDraft();     // crash-safety: show saved work before the network replies
        if (viewOnly) enterViewOnly();
        // The packaging levels decide every UOM on this screen, so redraw once
        // they arrive (they are cached for the rest of the session).
        ApiClient.getProductMaster((m, err) -> rebuild());
        loadInventory();
        loadSoItems();
        refreshScans();
    }

    @Override protected void onResume() {
        super.onResume();
        // Local-first scan list: no periodic server poll — it would clobber freshly
        // scanned, not-yet-synced lines and reintroduce lag. Pull server truth only
        // when we have nothing local yet (first open, or resuming a fresh screen).
        if (!viewOnly && scans.isEmpty()) refreshScans();
        registerScanReceiver();
        // The keyboard-wedge scanner delivers keystrokes to whatever has focus, so
        // the scan box must hold focus — but with the soft keyboard suppressed, so
        // it only appears when the box is tapped.
        b.etScan.setShowSoftInputOnFocus(false);
        armScan();
        if (soItems.isEmpty()) loadSoItems();      // recover if the first load failed
        // The full inventory is large (thousands of batches) and only changes on an
        // explicit PACT sync, so don't re-download it on every return — only when it
        // has gone stale. This keeps the scan screen fast on repeated resumes.
        if (inventory != null && System.currentTimeMillis() - inventoryLoadedAt > INVENTORY_STALE_MS)
            loadInventory();
        startAutoPostTimer();   // resume the 10-min NB auto-post ticker if enabled
    }

    @Override protected void onPause() {
        super.onPause();
        poll.removeCallbacks(pollTask);
        autoPost.removeCallbacks(autoPostTick);   // stop firing new auto-posts while off-screen
        saveNow(false);
        if (scanReceiver != null) { try { unregisterReceiver(scanReceiver); } catch (Exception ignore) {} }
    }

    @Override protected void onDestroy() {
        super.onDestroy();
        // Cancel any in-flight poll / scan callbacks so a push or refresh started
        // on THIS order can never fire into a different order opened afterwards.
        poll.removeCallbacksAndMessages(null);
        scanDebounce.removeCallbacksAndMessages(null);
        autoPost.removeCallbacksAndMessages(null);
    }

    /** Give (and keep) keyboard focus on the scan box so a scanner registers WITHOUT
     *  tapping it first — but never pop the soft keyboard (that only opens on tap). */
    private void armScan() {
        if (b == null || b.etScan == null || viewOnly || pushing || completed || scanFrozen) return;
        b.etScan.post(() -> {
            if (b == null || b.etScan == null) return;
            b.etScan.setShowSoftInputOnFocus(false);
            b.etScan.requestFocus();
            android.view.inputmethod.InputMethodManager imm =
                (android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
            if (imm != null) imm.hideSoftInputFromWindow(b.etScan.getWindowToken(), 0);
        });
    }

    @Override public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) armScan();   // re-arm the scan box whenever this screen regains focus
    }

    // ---- Loading -----------------------------------------------------------

    /** The sales order's own lines — these ARE the table. */
    private void loadSoItems() { loadSoItems(0); }

    /** The sales order's own lines. Retries a few times so a momentary network
     *  blip doesn't leave the table stuck on "Couldn't load". */
    private void loadSoItems(int tries) {
        if (viewOnly) return;
        if (soNumber == null || soNumber.isEmpty()) { b.tvEmpty.setText("No sales order selected."); return; }
        ApiClient.Cb<com.sukhnafoods.salesorder.model.SalesOrder> onSo = (so, err) -> {
            if (so == null) {
                if (tries < 4) {                    // transient failure — keep trying
                    b.tvEmpty.setText("Loading the order\u2019s items\u2026");
                    poll.postDelayed(() -> loadSoItems(tries + 1), 2000);
                    return;
                }
                b.tvEmpty.setText("Couldn't load the order" + (err != null ? ": " + err : "")
                        + " \u2014 check the connection and reopen the order.");
                return;
            }
            soItems.clear();
            soItems.addAll(so.items);
            rebuild();
        };
        if (isNb()) ApiClient.getOutletReqBySo(soNumber, onSo); else ApiClient.getSalesOrderBySo(soNumber, onSo);
    }

    private boolean isNb() { return "NB".equals(channel); }
    /** Stock key: NutrioBox pulls per-OMR stock; B2B per-SO. */
    private String stockKey() { return isNb() ? "omr:" + soNumber : soNumber; }

    private int invRefreshPolls = 0;   // bounded silent re-pulls while a background sync runs

    private void loadInventory() { loadInventory(0); }

    /** Auto-load this order's live stock (fast per-order read). Retries a few
     *  times on a transient failure so the screen never sticks on "not loading". */
    private void loadInventory(int tries) {
        if (viewOnly) return;
        ApiClient.getOrderStock(stockKey(), (inv, err) -> {
            if (inv == null) {
                if (tries < 4) { poll.postDelayed(() -> loadInventory(tries + 1), 2000); return; }
                msg("Couldn't load inventory: " + (err == null ? "no data" : err));
                return;
            }
            applyInventory(inv);
            // Keep stock current automatically: if the snapshot is stale, kick a
            // background PACT sync and silently re-pull it shortly, so the operator
            // never has to wait on the "Sync inventory from PACT" button.
            if (ApiClient.autoSyncIfStale(inv.syncedAt) || inv.batches == 0) scheduleInvRefresh();
            else invRefreshPolls = 0;
        });
    }

    private void applyInventory(Inventory inv) {
        inventory = inv;
        inventoryLoadedAt = System.currentTimeMillis();
        String synced = inv.syncedAt == null ? "" : "  · synced " + inv.syncedAt.replace("T", " ");
        if (synced.length() > 25) synced = synced.substring(0, 25);
        b.tvChip.setText("Live inventory: " + inv.products + " products · " + inv.batches + " batches" + synced);
        rebuild();           // inventory supplies product code / HSN / UOM
        revalidateBatches(); // re-check saved batches against the fresh stock
    }

    /** While a background inventory sync is running, re-pull this order's stock
     *  every 30s (bounded) until it comes back fresh, updating the table silently. */
    private void scheduleInvRefresh() {
        if (invRefreshPolls >= 5) { invRefreshPolls = 0; return; }
        invRefreshPolls++;
        poll.postDelayed(() -> {
            if (viewOnly || isFinishing()) return;
            ApiClient.getOrderStock(stockKey(), (inv, err) -> {
                if (inv == null) { scheduleInvRefresh(); return; }
                applyInventory(inv);
                long age = ApiClient.snapshotAgeMs(inv.syncedAt);
                boolean fresh = age >= 0 && age < 20 * 60 * 1000L && inv.batches > 0;
                if (fresh) invRefreshPolls = 0; else scheduleInvRefresh();
            });
        }, 30000);
    }

    private void refreshScans() {
        if (viewOnly) return;                 // read-only snapshot must not be overwritten
        ApiClient.getOrder(soNumber, (lines, err) -> {
            if (lines == null) return;   // keep the current view
            scans = lines;
            rebuild();
        });
    }

    // ---- Building the table -------------------------------------------------

    /** true once the table has been drawn at least once. */
    private boolean tableStarted = false;

    // Screen-level scan capture: a keyboard-wedge scanner sends key events to
    // whatever has focus. If the user hasn't tapped the Scan box, those events
    // would be lost — so when the box is NOT focused we accumulate them here and
    // submit on Enter, so a scan always registers just by being on this page.
    private final StringBuilder keyBuf = new StringBuilder();
    private long lastKeyAt = 0;

    @Override public boolean dispatchKeyEvent(KeyEvent e) {
        if (scanFrozen && e.getKeyCode() != KeyEvent.KEYCODE_BACK) return true;   // swallow scanner keys during the 4-sec freeze
        if (pushing) return super.dispatchKeyEvent(e);   // frozen while a PACT post is in flight
        // When the box has focus, let the normal TextWatcher path handle typing.
        if (b != null && b.etScan != null && b.etScan.hasFocus()) return super.dispatchKeyEvent(e);
        if (e.getAction() == KeyEvent.ACTION_DOWN) {
            int code = e.getKeyCode();
            long now = System.currentTimeMillis();
            if (now - lastKeyAt > 400) keyBuf.setLength(0);   // a fresh scan, not a continuation
            lastKeyAt = now;
            if (code == KeyEvent.KEYCODE_ENTER || code == KeyEvent.KEYCODE_NUMPAD_ENTER) {
                if (keyBuf.length() > 0) { String v = keyBuf.toString(); keyBuf.setLength(0); submitScan(v); }
                return true;
            }
            int ch = e.getUnicodeChar();
            if (ch != 0) { keyBuf.append((char) ch); return true; }
        }
        return super.dispatchKeyEvent(e);
    }

    /** Display order: the item just scanned floats to the TOP, still-pending items
     *  follow, and fully-scanned items sink to the BOTTOM. Line numbers keep their
     *  original position so an item stays recognisable as it moves. */
    private java.util.List<SalesOrderItem> orderedItems() {
        java.util.List<SalesOrderItem> active = new java.util.ArrayList<>();
        java.util.List<SalesOrderItem> pending = new java.util.ArrayList<>();
        java.util.List<SalesOrderItem> done = new java.util.ArrayList<>();
        for (SalesOrderItem it : soItems) {
            String code = (it.code != null && !it.code.isEmpty()) ? it.code : lookupCode(it.name);
            boolean complete = it.qty <= 0 || scannedFor(code, it.name) + 1e-9 >= it.qty;
            boolean isActive = !complete && lastScannedCode != null && !lastScannedCode.isEmpty()
                    && (lastScannedCode.equalsIgnoreCase(code) || (it.code != null && lastScannedCode.equalsIgnoreCase(it.code)));
            if (complete) done.add(it);
            else if (isActive) active.add(it);
            else pending.add(it);
        }
        java.util.List<SalesOrderItem> out = new java.util.ArrayList<>(soItems.size());
        out.addAll(active); out.addAll(pending); out.addAll(done);
        return out;
    }

    /** Builds one row per ordered product and folds in the scanned totals. */
    private void rebuild() {
        List<LineAdapter.Row> rows = new ArrayList<>();
        for (SalesOrderItem it : orderedItems()) {
            int prodNo = soItems.indexOf(it) + 1;
            String code = (it.code != null && !it.code.isEmpty()) ? it.code : lookupCode(it.name);
            // The order is written in the product's PRINT LEVEL unit (Carton/Pkt/…)
            String su = UomConvert.salesUnit(code, it.name);
            String uom = !su.isEmpty() ? su : ((it.unit != null && !it.unit.isEmpty()) ? it.unit : lookupUnit(code));
            String hsn = (it.hsn != null && !it.hsn.isEmpty()) ? it.hsn : lookupHsn(code);
            double productScanned = scannedFor(code, it.name);
            java.util.List<OrderLine> batches = scannedBatchLines(code, it.name);

            // Head row: product name/code + Pending / S.O qty, plus the first batch.
            LineAdapter.Row head = new LineAdapter.Row();
            head.head = true; head.numLabel = String.valueOf(prodNo);
            head.name = it.name; head.code = code; head.hsn = hsn; head.uom = uom;
            head.soQty = it.ordered; head.pendingQty = it.qty; head.productScanned = productScanned;
            head.remainQty = Math.max(0, it.qty - productScanned);   // Pending column counts down as items are scanned
            if (!batches.isEmpty()) { head.scannedQty = batches.get(0).quantity; fillBatchCols(head, code, batches.get(0)); }
            else head.scannedQty = 0;   // nothing scanned yet — batch columns stay blank
            head.delCode = code; head.canDelete = !batches.isEmpty();
            rows.add(head);
            // One extra line per additional batch (Pending / S.O qty left blank).
            for (int i = 1; i < batches.size(); i++) {
                OrderLine bn = batches.get(i);
                LineAdapter.Row sub = new LineAdapter.Row();
                sub.head = false; sub.numLabel = ""; sub.uom = uom;
                sub.scannedQty = bn.quantity;
                fillBatchCols(sub, code, bn);
                sub.delCode = code; sub.canDelete = true;
                rows.add(sub);
            }
        }
        adapter.setRows(rows);
        // Only the FIRST build starts at column 1. Re-running this on every
        // rebuild is what threw the table back to the left while the user was
        // reading the tax columns.
        if (!tableStarted) {
            tableStarted = true;
            b.tableScroll.post(b.tableScroll::resetToStart);
        }
        b.tvEmpty.setVisibility(rows.isEmpty() ? View.VISIBLE : View.GONE);
        if (rows.isEmpty() && !soItems.isEmpty()) b.tvEmpty.setText("No pending items on this order.");

        double scanned = 0;
        for (LineAdapter.Row r : rows) scanned += r.scannedQty;
        b.tvLines.setText("Lines: " + soItems.size());
        b.tvTotal.setText("   Scanned: " + LineAdapter.fmt(scanned));
        b.btnClear.setVisibility(scans.isEmpty() ? View.GONE : View.VISIBLE);
        if (!pushing) b.btnFillPact.setEnabled(!completed && !scans.isEmpty());   // Submit lives after the first scan

        saveNow(false);            // autosave after every change
        checkCompleted(rows);
        if (b.etScan != null && !b.etScan.hasFocus()) armScan();   // re-arm only if focus was lost (don't disturb active typing)
    }

    /**
     * Fills the PACT line columns. Warehouse, units, price, batch and dates come
     * from the batch actually scanned (or, before scanning, the FEFO batch the
     * app would pick). Value is computed. The tax/discount columns stay blank —
     * PACT does not expose them in the data we sync yet.
     */
    /** Distinct batches scanned for a product, in scan order, each with its
     *  summed quantity — one display line per batch. */
    private java.util.List<OrderLine> scannedBatchLines(String code, String name) {
        java.util.LinkedHashMap<String, OrderLine> byBatch = new java.util.LinkedHashMap<>();
        String n = norm(name);
        for (OrderLine l : scans) {
            boolean hit = (code != null && !code.isEmpty() && code.equalsIgnoreCase(l.productCode))
                    || (!n.isEmpty() && n.equals(norm(l.productName)));
            if (!hit) continue;
            String key = (l.batchNumber == null ? "" : l.batchNumber.trim());
            OrderLine agg = byBatch.get(key);
            if (agg == null) {
                agg = new OrderLine();
                agg.productCode = l.productCode; agg.productName = l.productName;
                agg.batchNumber = l.batchNumber; agg.warehouse = l.warehouse;
                agg.mfgDate = l.mfgDate; agg.expiryDate = l.expiryDate; agg.unit = l.unit;
                agg.quantity = 0;
                byBatch.put(key, agg);
            }
            agg.quantity += (l.quantity > 0 ? l.quantity : 1);
        }
        return new java.util.ArrayList<>(byBatch.values());
    }

    /** Fill a row's batch columns (warehouse / batch / mfg / exp) from ONE
     *  scanned batch, preferring the live-stock batch record for fresh data. */
    private void fillBatchCols(LineAdapter.Row r, String code, OrderLine scanLine) {
        ProductStock st = stockOf(code);
        Batch bt = null;
        if (scanLine.batchNumber != null && !scanLine.batchNumber.isEmpty() && st != null && st.batches != null)
            for (Batch x : st.batches) if (x.batchNumber != null && x.batchNumber.equalsIgnoreCase(scanLine.batchNumber)) { bt = x; break; }
        if (bt != null) {
            r.warehouse = bt.warehouse; r.units = bt.unit; r.unitPrice = bt.rate;
            r.batchNo = bt.batchNumber; r.mfgDate = bt.mfg; r.expDate = bt.expiry;
        } else {
            r.warehouse = scanLine.warehouse; r.units = scanLine.unit;
            r.batchNo = scanLine.batchNumber; r.mfgDate = scanLine.mfgDate; r.expDate = scanLine.expiryDate;
        }
    }

    private void fillPactColumns(LineAdapter.Row r, String code, SalesOrderItem it) {
        OrderLine scanned = latestScanFor(code, it.name);
        ProductStock st = stockOf(code);
        Batch bt = null;
        boolean fromScan = false;
        if (scanned != null && scanned.batchNumber != null && !scanned.batchNumber.isEmpty() && st != null) {
            for (Batch x : st.batches) if (x.batchNumber.equalsIgnoreCase(scanned.batchNumber)) { bt = x; fromScan = true; break; }
        }
        if (bt == null && st != null && st.batches != null && !st.batches.isEmpty()) bt = st.batches.get(0);

        if (bt != null) {
            r.warehouse = bt.warehouse;
            r.units = bt.unit;
            r.unitPrice = bt.rate;
        }
        // Batch identity belongs to the label that was actually scanned. Until
        // this line is scanned these three columns stay empty -- showing the
        // FEFO batch the app *would* pick read as if it had already been picked.
        if (fromScan) {
            r.batchNo = bt.batchNumber;
            r.mfgDate = bt.mfg;
            r.expDate = bt.expiry;
        } else if (scanned != null && scanned.batchNumber != null && !scanned.batchNumber.isEmpty()) {
            r.batchNo = scanned.batchNumber;      // scanned, but no longer in stock
        }
        // "Units" = the sales UOM from the master; "Sales Units" spells out its size.
        double scale = UomConvert.scale(code, it.name);
        String su2 = UomConvert.salesUnit(code, it.name);
        r.units = su2.isEmpty() ? "—" : su2;
        String baseUnit = (bt != null && bt.unit != null && !bt.unit.isEmpty()) ? bt.unit : "Gms";
        r.salesUnits = scale > 0 ? (LineAdapter.fmt(scale) + " " + baseUnit) : "—";
        r.salesUnitLevel = UomConvert.printLevel(code, it.name);

        // PACT's batch rate is per BASE unit (per Gm), but every quantity in this
        // app is a pack — so the rate must be scaled by the pack size before it
        // can be shown as a unit price or multiplied out into a value.
        double baseRate = parseNum(r.unitPrice);
        Double packSize = scale > 0 ? scale : null;
        if (baseRate > 0 && packSize != null) {
            double packPrice = baseRate * packSize;
            r.unitPrice = String.format(Locale.ROOT, "%.2f", packPrice);   // per pack
            if (r.scannedQty > 0) r.value = String.format(Locale.ROOT, "%.2f", packPrice * r.scannedQty);
        } else if (baseRate <= 0) {
            r.unitPrice = "";
        }

        if (scanned != null) {
            if (scanned.salesUnitLevel != null && !scanned.salesUnitLevel.isEmpty()) r.salesUnitLevel = scanned.salesUnitLevel;
            if (scanned.gstTaxType != null && !scanned.gstTaxType.isEmpty()) r.gstTaxType = scanned.gstTaxType;
            if (scanned.salesRate != null && !scanned.salesRate.isEmpty()) r.salesRate = scanned.salesRate;
        }
        if (r.salesRate == null || r.salesRate.isEmpty()) {
            String rate = it.rate == null ? "" : it.rate.trim();          // unit price from the sales order
            if (!rate.isEmpty()) r.salesRate = rate;
        }
        r.refNo = soNumber == null ? "" : soNumber;
        // discPer / discAmt / taxableAmount / tax / SGST / CGST / IGST and their
        // amounts are intentionally left blank until PACT supplies them.
    }

    private static double parseNum(String s) {
        if (s == null) return 0;
        try { return Double.parseDouble(s.replace(",", "").trim()); } catch (Exception e) { return 0; }
    }

    /** The most recent scan recorded against this product, or null. */
    private OrderLine latestScanFor(String code, String name) {
        OrderLine hit = null;
        String n = norm(name);
        for (OrderLine l : scans) {
            boolean match = (code != null && !code.isEmpty() && code.equalsIgnoreCase(l.productCode))
                    || (!n.isEmpty() && n.equals(norm(l.productName)));
            if (match) hit = l;      // keep the last one
        }
        return hit;
    }

    // ---- Autosave / restore / completion ------------------------------------

    /** Mirrors the current scans to device storage. announce=true shows a toast. */
    private void saveNow(boolean announce) {
        if (soNumber == null || soNumber.isEmpty()) {
            if (announce) toast("Nothing to save — no sales order open.");
            return;
        }
        ScanDraftStore.save(this, soNumber, scans);
        if (announce) {
            toast(scans.isEmpty() ? "Saved (nothing scanned yet)." : "Saved " + scans.size() + " scanned line(s) on this device.");
            banner("Saved on this device. If the app closes or crashes, this order will come back exactly as it is now.");
        }
    }

    /** Brings back work saved before a crash / close, until the server answers. */
    /** Read-only view of a SUBMITTED order: show the saved scanned snapshot and
     *  lock every control so nothing can be scanned, cleared or resubmitted. */
    private void enterViewOnly() {
        completed = true;
        ScanDraftStore.Draft d = ScanDraftStore.loadSnapshot(this, soNumber);
        scans = (d != null && !d.isEmpty()) ? d.lines : new ArrayList<>();
        renderScansReadOnly();
        try {
            b.etScan.setEnabled(false);
            b.btnFillPact.setEnabled(false); b.btnFillPact.setVisibility(View.GONE);
            b.btnSave.setEnabled(false); b.btnSave.setText("Completed");
            b.btnClear.setVisibility(View.GONE);
            b.btnSync.setEnabled(false);
        } catch (Throwable ignore) {}
        banner(scans.isEmpty()
                ? "No saved scan snapshot for " + (soNumber == null ? "this order" : soNumber) + "."
                : "Submitted order " + (soNumber == null ? "" : soNumber) + " \u2014 scanned items (read-only).");
    }

    /** Builds the table straight from the scanned lines (grouped product -> batch),
     *  independent of the pending sales order, which no longer exists once posted. */
    private void renderScansReadOnly() {
        java.util.LinkedHashMap<String, java.util.List<OrderLine>> byProduct = new java.util.LinkedHashMap<>();
        for (OrderLine l : scans) {
            String k = (l.productCode == null ? "" : l.productCode) + "\u0001" + (l.productName == null ? "" : l.productName);
            byProduct.computeIfAbsent(k, x -> new java.util.ArrayList<>()).add(l);
        }
        java.util.List<LineAdapter.Row> rows = new java.util.ArrayList<>();
        int n = 0;
        for (java.util.Map.Entry<String, java.util.List<OrderLine>> e : byProduct.entrySet()) {
            n++;
            java.util.LinkedHashMap<String, OrderLine> byBatch = new java.util.LinkedHashMap<>();
            for (OrderLine l : e.getValue()) {
                String bk = l.batchNumber == null ? "" : l.batchNumber.trim();
                OrderLine a = byBatch.get(bk);
                if (a == null) { a = new OrderLine(); a.productCode = l.productCode; a.productName = l.productName;
                    a.batchNumber = l.batchNumber; a.warehouse = l.warehouse; a.mfgDate = l.mfgDate; a.expiryDate = l.expiryDate; a.unit = l.unit; a.quantity = 0; byBatch.put(bk, a); }
                a.quantity += (l.quantity > 0 ? l.quantity : 1);
            }
            java.util.List<OrderLine> batches = new java.util.ArrayList<>(byBatch.values());
            OrderLine first = e.getValue().get(0);
            String code = first.productCode;
            String su = UomConvert.salesUnit(code, first.productName);
            String uom = !su.isEmpty() ? su : (first.unit != null ? first.unit : "");
            double total = 0; for (OrderLine b2 : batches) total += b2.quantity;
            for (int i = 0; i < batches.size(); i++) {
                OrderLine bn = batches.get(i);
                LineAdapter.Row r = new LineAdapter.Row();
                r.head = (i == 0); r.numLabel = (i == 0) ? String.valueOf(n) : ""; r.uom = uom;
                if (i == 0) { r.name = first.productName; r.code = code; r.pendingQty = total; r.soQty = total; r.productScanned = total; r.remainQty = 0; }
                r.scannedQty = bn.quantity;
                r.warehouse = bn.warehouse == null ? "" : bn.warehouse;
                r.batchNo = bn.batchNumber == null ? "" : bn.batchNumber;
                r.mfgDate = bn.mfgDate == null ? "" : bn.mfgDate;
                r.expDate = bn.expiryDate == null ? "" : bn.expiryDate;
                rows.add(r);
            }
        }
        adapter.setRows(rows);
        b.tvLines.setText("Lines: " + byProduct.size());
        double tot = 0; for (OrderLine l : scans) tot += l.quantity;
        b.tvTotal.setText("   Scanned: " + LineAdapter.fmt(tot));
        b.tvEmpty.setVisibility(rows.isEmpty() ? View.VISIBLE : View.GONE);
        if (rows.isEmpty()) b.tvEmpty.setText("No scanned items saved for this order.");
    }

    private void restoreDraft() {
        if (soNumber == null || soNumber.isEmpty()) return;
        if (ScanDraftStore.isCompleted(this, soNumber)) {
            completed = true;
            banner("This order is already completed.");
            return;
        }
        ScanDraftStore.Draft d = ScanDraftStore.load(this, soNumber);
        if (d == null || d.isEmpty()) return;
        scans = d.lines;
        restoredCount = d.lines.size();
        rebuild();
        banner("Restored " + d.lines.size() + " scanned line(s) saved on this device. Re-checking batches against inventory…");
    }

    /**
     * After inventory reloads, confirm every restored/scanned batch still exists
     * in stock. A batch can disappear between sessions (consumed or re-synced),
     * and dispatching against it would be wrong — so it is called out.
     */
    private void revalidateBatches() {
        if (inventory == null || scans.isEmpty()) return;
        List<String> bad = new ArrayList<>();
        for (OrderLine l : scans) {
            if (l.batchNumber == null || l.batchNumber.isEmpty()) continue;
            ProductStock st = stockOf(l.productCode);
            boolean ok = false;
            if (st != null && st.batches != null)
                for (Batch bt : st.batches) if (bt.batchNumber != null && bt.batchNumber.equalsIgnoreCase(l.batchNumber)) { ok = true; break; }
            if (!ok) {
                String nm = (l.productName == null || l.productName.isEmpty()) ? l.productCode : l.productName;
                String entry = nm + " · batch " + l.batchNumber;
                if (!bad.contains(entry)) bad.add(entry);
            }
        }
        if (bad.isEmpty()) {
            if (restoredCount > 0) {
                banner("Restored " + restoredCount + " scanned line(s). All batches re-checked against the latest inventory — all still valid.");
                restoredCount = 0;
            }
            return;
        }
        StringBuilder sb = new StringBuilder("Re-check: " + bad.size() + " scanned batch(es) are no longer in inventory — please re-scan them:");
        for (int i = 0; i < bad.size() && i < 5; i++) sb.append("\n• ").append(bad.get(i));
        if (bad.size() > 5) sb.append("\n…and ").append(bad.size() - 5).append(" more");
        banner(sb.toString());
    }

    /** Marks the order done once every line's pending quantity has been scanned. */
    private void checkCompleted(List<LineAdapter.Row> rows) {
        if (rows.isEmpty() || completed) return;
        boolean all = true;
        int outstanding = 0;
        for (SalesOrderItem it : soItems) {
            if (it.qty <= 0) continue;                          // nothing outstanding on this product
            outstanding++;
            String code = (it.code != null && !it.code.isEmpty()) ? it.code : lookupCode(it.name);
            if (scannedFor(code, it.name) + 1e-9 < it.qty) { all = false; break; }
        }
        // Never prompt on an order nobody has scanned against.
        if (!all || outstanding == 0 || scans.isEmpty()) return;
        // All pending items are scanned — the order is READY TO SUBMIT. It is NOT
        // completed yet: completion happens only after PACT confirms the post
        // (onPostSuccess). Keep Submit live so the operator can post it.
        if (!pushing && !completed) {
            banner("All items scanned — tap Submit to post this order to PACT.");
            b.btnFillPact.setEnabled(true);
        }
    }

    private void banner(String m) {
        if (m == null || m.isEmpty()) { b.tvBanner.setVisibility(View.GONE); return; }
        b.tvBanner.setText(m);
        b.tvBanner.setVisibility(View.VISIBLE);
    }

    private void toast(String m) { android.widget.Toast.makeText(this, m, android.widget.Toast.LENGTH_LONG).show(); }

    /** Total already scanned for this product, across all its batches. */
    private double scannedFor(String code, String name) {
        double total = 0;
        String n = norm(name);
        for (OrderLine l : scans) {
            boolean hit = (code != null && !code.isEmpty() && code.equalsIgnoreCase(l.productCode))
                    || (!n.isEmpty() && n.equals(norm(l.productName)));
            if (hit) total += l.quantity;
        }
        // `scans` is refreshed from the server, so it lags a scan or two during
        // rapid scanning. Honour the local immediate counter too and take whichever
        // is higher, so a fast repeat can't slip past the pending-qty check before
        // the list catches up.
        String key = (code != null && !code.isEmpty()) ? code.toUpperCase(Locale.ROOT) : n;
        Double loc = localScanned.get(key);
        return (loc != null && loc > total) ? loc : total;
    }

    // ---- Inventory lookups (product code / HSN / UOM) -----------------------

    /** Finds the stock product code for an ordered product name. */
    private String lookupCode(String name) {
        if (inventory == null || name == null) return "";
        String n = norm(name);
        if (n.isEmpty()) return "";
        for (Map.Entry<String, ProductStock> e : inventory.byCode.entrySet())
            if (norm(e.getValue().name).equals(n)) return e.getKey();
        for (Map.Entry<String, ProductStock> e : inventory.byCode.entrySet()) {
            String s = norm(e.getValue().name);
            if (!s.isEmpty() && (s.contains(n) || n.contains(s))) return e.getKey();
        }
        return "";
    }

    private String lookupHsn(String code) {
        ProductStock st = stockOf(code);
        return (st != null && st.hsn != null) ? st.hsn : "";
    }

    private String lookupUnit(String code) {
        ProductStock st = stockOf(code);
        if (st != null && st.batches != null && !st.batches.isEmpty()) {
            String u = st.batches.get(0).unit;
            if (u != null && !u.equals("—")) return u;
        }
        return "";
    }

    private ProductStock stockOf(String code) {
        if (inventory == null || code == null || code.isEmpty()) return null;
        return inventory.byCode.get(code);
    }

    private static String norm(String s) {
        if (s == null) return "";
        return s.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", " ").trim().replaceAll("\\s+", " ");
    }

    /** True when the batch expiry date has already passed. Unknown/unparseable -> not expired. */
    private static boolean isExpired(String exp) {
        if (exp == null) return false;
        String e = exp.trim();
        if (e.isEmpty() || e.equals("—") || e.equals("-")) return false;
        java.util.Date d = null;
        String[] fmts = { "dd/MMM/yyyy", "d/MMM/yyyy", "yyyy-MM-dd", "dd-MM-yyyy", "dd/MM/yyyy" };
        for (String f : fmts) {
            try {
                java.text.SimpleDateFormat sdf = new java.text.SimpleDateFormat(f, java.util.Locale.ENGLISH);
                sdf.setLenient(false);
                d = sdf.parse(e);
                break;
            } catch (Exception ignore) {}
        }
        if (d == null) return false;
        java.util.Calendar t = java.util.Calendar.getInstance();
        t.set(java.util.Calendar.HOUR_OF_DAY, 0); t.set(java.util.Calendar.MINUTE, 0);
        t.set(java.util.Calendar.SECOND, 0); t.set(java.util.Calendar.MILLISECOND, 0);
        return d.before(t.getTime());   // expiry day itself is still valid
    }

    // ---- Scanning -----------------------------------------------------------

    private void submitScan(String raw) {
        try { submitScanInner(raw); } finally { armScan(); }   // always re-arm after a scan: focus back on the box, keyboard hidden
    }

    private void submitScanInner(String raw) {
        String s = raw == null ? "" : raw.replace("\n", "").trim();
        b.etScan.setText("");
        b.etScan.setShowSoftInputOnFocus(false);
        b.etScan.requestFocus();      // stay armed for the next scan
        if (s.isEmpty()) return;
        if (scanFrozen) { return; }   // 4-sec pre-auto-post freeze: drop the scan, nothing registers
        if (completed) { msg("This order is completed — scanning is closed."); return; }
        if (pushing) { msg("Submitting to PACT — please wait for PACT to reply."); return; }
        if (inventory == null) { msg("Load inventory first — tap Sync inventory from PACT."); return; }

        BarcodeParser.Result p = BarcodeParser.parse(s);
        String matched = inventory.resolveCode(s, p.code, p.batch);
        ProductStock stock = matched != null ? inventory.byCode.get(matched) : null;
        showScanDiag(s, p, matched, stock);
        if (stock == null) {
            String hint = p.code != null && !p.code.equals(s) ? " (read product code: " + p.code + ")" : "";
            msg("“" + (p.code == null ? s : p.code) + "” is not in the synced inventory" + hint
                    + ". Tap “Sync inventory from PACT” if this product is new.");
            return;
        }

        // The scan must belong to this sales order — otherwise it isn't dispatchable here.
        SalesOrderItem soLine = matchOrderLine(matched, stock.name);
        if (soLine == null) {
            msg("“" + (stock.name.isEmpty() ? matched : stock.name) + "” is not on this sales order — not added.");
            return;
        }

        // Resolve the specific batch this scan refers to: the label's batch when
        // present, else prefer a batch sitting in the product's ideal warehouse,
        // else FEFO. Then GATE on warehouse — only batches whose present warehouse
        // equals the product-master ideal warehouse are dispatchable.
        String idealWh = idealWarehouseFor(matched, stock.name);
        Batch target = null;
        if (stock.batches != null && !stock.batches.isEmpty()) {
            if (p.batch != null) {
                // A batch number can now sit in several warehouses; prefer the ideal one.
                if (!idealWh.isEmpty())
                    for (Batch x : stock.batches)
                        if (x.batchNumber.equalsIgnoreCase(p.batch) && x.warehouse != null
                                && whEq(idealWh, x.warehouse)) { target = x; break; }
                if (target == null)
                    for (Batch x : stock.batches) if (x.batchNumber.equalsIgnoreCase(p.batch)) { target = x; break; }
            }
            if (target == null && !idealWh.isEmpty())
                for (Batch x : stock.batches) if (x.warehouse != null && whEq(idealWh, x.warehouse)) { target = x; break; }
            if (target == null) target = stock.batches.get(0);
        }
        // VALIDATION (1): the scanned batch must exist in the synced inventory.
        if (p.batch == null || target == null || target.batchNumber == null
                || !target.batchNumber.equalsIgnoreCase(p.batch)) {
            blockScan("Batch not in inventory for " + (stock.name.isEmpty() ? matched : stock.name)
                    + " — scanned batch " + (p.batch == null ? "(none on the label)" : p.batch)
                    + " does not match any synced batch. Re-sync or check the label. This scan was NOT added.");
            return;
        }
        // VALIDATION (2): present warehouse must equal the product-master ideal warehouse.
        if (!idealWh.isEmpty() && target != null && target.warehouse != null
                && !whEq(idealWh, target.warehouse)) {
            blockScan("Wrong warehouse for " + (stock.name.isEmpty() ? matched : stock.name)
                    + " \u2014 batch " + target.batchNumber + " is in \u201c" + target.warehouse
                    + "\u201d but this product dispatches only from \u201c" + idealWh
                    + "\u201d. This scan was NOT added.");
            return;
        }

        // VALIDATION (3): the batch must not be expired.
        if (isExpired(target.expiry)) {
            blockScan("Batch " + target.batchNumber + " for " + (stock.name.isEmpty() ? matched : stock.name)
                    + " is EXPIRED (" + target.expiry + "). This scan was NOT added.");
            return;
        }
        // VALIDATION (4): scanned quantity must not exceed the sales-order pending quantity.
        double addPacks = (p.quantity != null && p.quantity > 0) ? p.quantity : 1;
        double already = scannedFor(matched, stock.name);
        String suP = UomConvert.salesUnit(matched, stock.name);
        if (already + addPacks > soLine.qty + 1e-6) {
            blockScan("Quantity exceeds pending for " + (stock.name.isEmpty() ? matched : stock.name)
                    + " — pending " + UomConvert.fmtPacks(soLine.qty) + (suP.isEmpty() ? "" : " " + suP)
                    + ", already scanned " + UomConvert.fmtPacks(already) + ", this scan " + UomConvert.fmtPacks(addPacks)
                    + ". This scan was NOT added.");
            return;
        }

        // Per-batch stock: never scan more of THIS batch than exists in the ideal
        // warehouse. The product-total guard below misses this when OTHER batches
        // have stock — PACT then cannot allocate the lot and the post fails ("Added
        // 0 of N"). So cap each batch by its own available quantity.
        if (target != null) {
            Double bp = UomConvert.toSalesUnits(target.available, matched, stock.name);
            double batchAvail = (bp != null) ? bp : target.available;
            double batchDone = 0;
            String tb = target.batchNumber == null ? "" : target.batchNumber;
            for (OrderLine l : scans)
                if (matched != null && matched.equalsIgnoreCase(l.productCode)
                        && !tb.isEmpty() && tb.equalsIgnoreCase(l.batchNumber)) batchDone += l.quantity;
            double thisPacks = (p.quantity != null && p.quantity > 0) ? p.quantity : 1;
            if (batchDone + thisPacks > batchAvail + 1e-6) {
                String su2 = UomConvert.salesUnit(matched, stock.name);
                blockScan("Only " + UomConvert.fmtPacks(batchAvail) + (su2.isEmpty() ? "" : " " + su2)
                        + " of batch " + tb + " for " + (stock.name.isEmpty() ? matched : stock.name)
                        + " is in stock" + (batchDone > 0 ? " (" + UomConvert.fmtPacks(batchDone) + " already scanned)" : "")
                        + " \u2014 the rest is a different batch, so PACT can\u2019t dispatch this lot. This scan was NOT added.");
                return;
            }
        }

        // Inventory guard: never scan more of a product than is actually in stock.
        double newPacks = (p.quantity != null && p.quantity > 0) ? p.quantity : 1;
        double availPacks = availablePacks(matched, stock.name);
        double donePacks = scannedFor(matched, stock.name);
        if (donePacks + newPacks > availPacks + 1e-6) {
            String su = UomConvert.salesUnit(matched, stock.name);
            String iw = idealWarehouseFor(matched, stock.name);
            blockScan("Only " + UomConvert.fmtPacks(availPacks) + (su.isEmpty() ? "" : " " + su) + " of "
                    + (stock.name.isEmpty() ? matched : stock.name)
                    + (iw.isEmpty() ? " in stock" : " are in the ideal warehouse (" + iw + ")")
                    + " and " + UomConvert.fmtPacks(donePacks) + " already scanned"
                    + (iw.isEmpty() ? "" : " \u2014 any more would be from another warehouse and can\u2019t be dispatched")
                    + ". This scan was NOT added."
                    + (availPacks <= 0 ? " Tap \u201cSync inventory from PACT\u201d if stock just arrived." : ""));
            return;
        }

        // Count this scan immediately (before the server round-trip) so the next
        // rapid scan sees the true running total.
        {
            String lk = (matched != null && !matched.isEmpty()) ? matched.toUpperCase(Locale.ROOT) : norm(stock.name);
            localScanned.merge(lk, (p.quantity != null && p.quantity > 0) ? p.quantity : 1, Double::sum);
            lastScannedCode = (matched != null) ? matched : "";
        }
        // First scan of this order arms the 10-minute auto-post cycle. Fixed cadence
        // from this moment — later scans do NOT reset it.
        if (isNb() && autoPostOn && !autoArmed && !viewOnly && !completed) {
            autoArmed = true;
            startAutoPostTimer();
        }
        Batch bch = target;   // the gated batch (label batch, else ideal-warehouse FEFO)
        OrderLine l = new OrderLine();
        l.productCode = matched;
        l.productName = !stock.name.isEmpty() ? stock.name : matched;
        l.hsn = lookupHsn(matched);
        l.salesUnitLevel = "L1"; l.gstTaxType = "GST"; l.salesRate = "—";
        l.quantity = p.quantity != null && p.quantity > 0 ? p.quantity : 1;
        l.warehouse = bch != null ? bch.warehouse : "—";
        l.unit = bch != null ? bch.unit : "—";
        l.unitPrice = bch != null ? bch.rate : "—";
        l.batchNumber = bch != null ? bch.batchNumber : "";
        l.mfgDate = bch != null ? bch.mfg : "—";
        l.expiryDate = bch != null ? bch.expiry : "—";
        l.soNumber = soNumber != null ? soNumber : "";
        l.vendor = vendor != null ? vendor : "";

        // PACT matches on its OWN product code, which can differ from the label
        // (PACT stores FGO503 with a letter O while the label prints FG0503). The
        // app already resolved the real code, so send THAT to PACT, keeping the
        // scanned batch + weight so PACT still picks the right lot.
        // (PACT barcodes are aggregated by product+batch at submit time — see pactBarcodes().)
        // LOCAL-FIRST registration: update the on-device scan list immediately so the
        // 4 validations and the running totals are correct instantly, with NO server
        // round-trip in the scan path. One aggregated line per (product, batch) — the
        // same key the server merges on. The server write runs in the background and
        // its id folds back in (needed for deletes) when it replies.
        double addQty = l.quantity > 0 ? l.quantity : 1;
        OrderLine agg = localLineFor(matched, l.batchNumber);
        if (agg == null) { scans.add(l); agg = l; }
        else { agg.quantity += addQty; }
        final OrderLine stored = agg;
        scheduleRebuild();   // debounced LOCAL redraw (no network) — instant and burst-safe
        ApiClient.postScan(l, "app", (srv, err) -> {
            if (srv == null) { msg("Scan saved on this device — the server hasn't confirmed it yet."); return; }
            if (srv.id > 0) stored.id = srv.id;   // adopt the server id so this batch can be deleted
        });
    }

    /** The on-device aggregated scan line for this (product, batch), or null. */
    private OrderLine localLineFor(String code, String batch) {
        String bn = batch == null ? "" : batch.trim();
        for (OrderLine l : scans) {
            if (code == null || !code.equalsIgnoreCase(l.productCode)) continue;
            String lb = l.batchNumber == null ? "" : l.batchNumber.trim();
            if (bn.equalsIgnoreCase(lb)) return l;
        }
        return null;
    }

    private Runnable refreshPending;
    /** Coalesce table refreshes: during rapid scanning each scan reschedules a single
     *  refresh ~450ms after the LAST scan, instead of rebuilding the whole table on
     *  every scan (which blocks the main thread and drops fast scans). The 3-second
     *  poll and the immediate local counter keep the screen honest in between. */
    private void scheduleRefresh() {
        if (refreshPending != null) scanDebounce.removeCallbacks(refreshPending);
        refreshPending = () -> refreshScans();
        scanDebounce.postDelayed(refreshPending, 450);
    }

    private Runnable rebuildPending;
    /** Debounced LOCAL table redraw (no network): coalesces a fast scan burst into one
     *  rebuild ~120ms after the last scan. The scan DATA is updated synchronously in
     *  submitScanInner, so the 4 validations are correct instantly — only the redraw
     *  waits, which keeps rapid scanning smooth. */
    private void scheduleRebuild() {
        if (rebuildPending != null) scanDebounce.removeCallbacks(rebuildPending);
        rebuildPending = this::rebuild;
        scanDebounce.postDelayed(rebuildPending, 120);
    }

    /** Warehouse-name compare that ignores case, spaces and punctuation, so
     *  "N.B Cold Room", "NB Coldroom" and "nb cold-room" all compare equal.
     *  Empty ideal ("" — master has none) never matches, so the caller can tell
     *  "no ideal defined" apart from a real match. */
    private static String whNorm(String s) {
        return s == null ? "" : s.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]", "");
    }
    private static boolean whEq(String a, String b) {
        String na = whNorm(a);
        return !na.isEmpty() && na.equals(whNorm(b));
    }

    /** Net weight (base units, e.g. Gms) of ONE pack of this scanned line, from
     *  the product master: the size of the scanned sales unit, else the master
     *  scale. 0 when the master can't tell us. */
    private double perPackWeight(OrderLine l) {
        ProductMaster m = ApiClient.masterOrNull();
        if (m == null || l == null) return 0;
        ProductMaster.Product pr = m.find(l.productCode, l.productName);
        if (pr == null) return 0;
        // The pack's net weight is the base units (e.g. Gms) in ONE sales unit —
        // that is the master scale (Vada Pao: 1 Container = 560 Gms). This equals
        // the net weight printed on the label, so N scans -> N * scale grams.
        if (pr.scale > 0) return pr.scale;
        if (l.unit != null && !l.unit.isEmpty())
            for (ProductMaster.Level lv : pr.levels.values())
                if (lv.unit != null && lv.unit.equalsIgnoreCase(l.unit) && lv.size > 0) return lv.size;
        return 0;
    }

    /** The barcodes to send to PACT: one per (product code, batch), with the net
     *  weight summed across every scan of that product+batch — so 5 scans of a
     *  560 Gms pack become "CODE_BATCH_2800", not five 560 lines. Built from the
     *  saved scans so it is correct even after the app was closed and reopened. */
    private java.util.List<String> pactBarcodes() {
        java.util.LinkedHashMap<String, Double> packs = new java.util.LinkedHashMap<>();
        java.util.LinkedHashMap<String, OrderLine> sample = new java.util.LinkedHashMap<>();
        for (OrderLine l : scans) {
            if (l.productCode == null || l.productCode.isEmpty()) continue;
            String batch = l.batchNumber == null ? "" : l.batchNumber.trim();
            if (batch.isEmpty()) continue;
            String key = l.productCode + "\u0001" + batch;
            packs.merge(key, l.quantity > 0 ? l.quantity : 1, Double::sum);
            sample.putIfAbsent(key, l);
        }
        java.util.List<String> out = new java.util.ArrayList<>();
        for (java.util.Map.Entry<String, Double> e : packs.entrySet()) {
            int sep = e.getKey().indexOf('\u0001');
            String code = e.getKey().substring(0, sep), batch = e.getKey().substring(sep + 1);
            double perPack = perPackWeight(sample.get(e.getKey()));
            double total = perPack > 0 ? perPack * e.getValue() : e.getValue();
            out.add(code + "_" + batch + "_" + fmtW(total));
        }
        return out;
    }
    private static String fmtW(double w) {
        return (Math.abs(w - Math.rint(w)) < 1e-9) ? String.valueOf((long) Math.rint(w)) : String.valueOf(w);
    }

    /** The ordered line this scanned product belongs to, or null. */
    private SalesOrderItem matchOrderLine(String code, String stockName) {
        // 1) exact product-code match (the reliable key).
        for (SalesOrderItem it : soItems)
            if (it.code != null && !it.code.isEmpty() && it.code.equalsIgnoreCase(code)) return it;
        // 2) exact normalised-name match, for order lines that carry no code.
        String a = norm(stockName);
        if (!a.isEmpty())
            for (SalesOrderItem it : soItems) if (norm(it.name).equals(a)) return it;
        // No fuzzy 'contains' fallback — it let products that are NOT on the order
        // slip through by partially matching another line's name.
        return null;
    }

    private void showScanDiag(String raw, BarcodeParser.Result p, String matched, ProductStock stock) {
        String parsed = "code=" + (p.code == null ? "—" : p.code)
                + "  batch=" + (p.batch == null ? "—" : p.batch)
                + "  qty=" + (p.quantity == null ? "1 pack" : p.quantity)
                + (p.packWeight != null ? "  net=" + LineAdapter.fmt(p.packWeight) : "");
        String outcome = matched != null
                ? "✓ matched " + matched + (stock != null && !stock.name.isEmpty() ? " · " + stock.name : "")
                : "✗ no match in inventory";
        try { b.tvScanDiag.setText("Scanned: " + raw + "\n" + parsed + "\n" + outcome); } catch (Throwable ignore) {}
    }

    // ---- View inventory (this order's items, batch by batch) ----------------

    private void showOrderInventory() {
        if (inventory == null) { msg("Load inventory first — tap Sync inventory from PACT."); return; }
        if (soItems.isEmpty()) { msg("The order's items are still loading."); return; }

        final List<SoBatchAdapter.Row> all = new ArrayList<>();
        for (SalesOrderItem it : soItems) {
            String code = (it.code != null && !it.code.isEmpty()) ? it.code : lookupCode(it.name);
            String uom = (it.unit != null && !it.unit.isEmpty()) ? it.unit : lookupUnit(code);
            ProductStock st = stockOf(code);
            if (st == null || st.batches == null || st.batches.isEmpty()) {
                SoBatchAdapter.Row r = new SoBatchAdapter.Row();
                r.name = it.name; r.soQty = it.ordered; r.pendingQty = it.qty;
                r.batch = "No stock"; r.batchQty = 0; r.uom = uom;
                r.batchPacks = 0d; r.stockUnit = ""; r.packSize = UomConvert.scale(code, it.name);
                    r.salesUnit = UomConvert.salesUnit(code, it.name);
                    r.baseUnit = UomConvert.baseUnit(code, it.name);
                all.add(r);
                continue;
            }
            for (Batch bt : st.batches) {          // already FEFO-sorted
                SoBatchAdapter.Row r = new SoBatchAdapter.Row();
                r.name = it.name; r.soQty = it.ordered; r.pendingQty = it.qty;
                r.batch = bt.batchNumber; r.batchQty = bt.available;
                r.stockUnit = bt.unit;
                r.batchPacks = UomConvert.toSalesUnits(bt.available, code, it.name);
                r.packSize = UomConvert.scale(code, it.name);
                    r.salesUnit = UomConvert.salesUnit(code, it.name);
                    r.baseUnit = UomConvert.baseUnit(code, it.name);
                r.uom = uom.isEmpty() ? bt.unit : uom;
                all.add(r);
            }
        }

        View v = getLayoutInflater().inflate(R.layout.dialog_inventory, null);
        RecyclerView rv = v.findViewById(R.id.rvInv);
        EditText search = v.findViewById(R.id.etSearch);
        rv.setLayoutManager(new LinearLayoutManager(this));
        SoBatchAdapter ia = new SoBatchAdapter();
        rv.setAdapter(ia);
        ia.setRows(all);
        search.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int a, int c, int d) {}
            @Override public void onTextChanged(CharSequence s, int a, int c, int d) {
                String q = s.toString().trim().toLowerCase(Locale.ROOT);
                if (q.isEmpty()) { ia.setRows(all); return; }
                List<SoBatchAdapter.Row> f = new ArrayList<>();
                for (SoBatchAdapter.Row r : all)
                    if (r.name.toLowerCase(Locale.ROOT).contains(q) || r.batch.toLowerCase(Locale.ROOT).contains(q)) f.add(r);
                ia.setRows(f);
            }
            @Override public void afterTextChanged(Editable s) {}
        });
        new AlertDialog.Builder(this)
                .setTitle("Order items in stock (" + soItems.size() + " items · " + all.size() + " batches)")
                .setView(v)
                .setPositiveButton("Close", null)
                .show();
    }

    // ---- PACT sync ----------------------------------------------------------

    private void syncFromPact() {
        b.btnSync.setEnabled(false);
        msg("Syncing from PACT\u2026 waiting for the run to finish (about 2 min).");
        ApiClient.runSync(
                stage -> msg("Syncing from PACT \u2014 " + stage + "\u2026 (about 2 min, please wait)."),
                (okMsg, err) -> {
                    b.btnSync.setEnabled(true);
                    if (err != null) { msg("Sync failed: " + err); return; }
                    msg("Inventory synced from PACT.");
                    loadInventory();
                });
    }

    private void pollInventoryForChange(String before, int tries) {
        poll.postDelayed(() -> ApiClient.getInventory((inv, err) -> {
            boolean changed = inv != null && inv.syncedAt != null && !inv.syncedAt.equals(before) && inv.batches > 0;
            if (changed) {
                inventory = inv;
                inventoryLoadedAt = System.currentTimeMillis();
                String synced = inv.syncedAt.replace("T", " ");
                if (synced.length() > 19) synced = synced.substring(0, 19);
                b.tvChip.setText("Live inventory: " + inv.products + " products · " + inv.batches + " batches  · synced " + synced);
                msg(""); b.btnSync.setEnabled(true); rebuild();
            } else if (tries < 30) pollInventoryForChange(before, tries + 1);
            else { b.btnSync.setEnabled(true); msg("Sync is taking longer than usual — reopen this screen in a moment."); }
        }), 2000);
    }

    /**
     * Hands the scanned labels to PACT — entirely on the server. Posts the order
     * to the dashboard, which runs a REAL headless browser: it logs into PACT,
     * opens the Factory Sales Invoice for this SO and enters every scanned label.
     * No PC and no phone browser are involved. This runs in DRY RUN — the invoice
     * is filled for review but NOT posted — so it is always safe to tap. The
     * operator then opens PACT, checks the invoice and Posts it.
     */
    private boolean pushing = false;

    private void fillInPact() {
        if (isNb()) { fillStockOutwardDelta(); return; }
        if (pushing) { msg("Already sending to PACT — please wait…"); return; }
        if (scans.isEmpty()) { msg("Scan some items first — then Submit them to PACT."); return; }
        // Cap each scanned batch at what is actually in stock, so an over-scanned batch
        // no longer makes PACT reject the WHOLE invoice — it dispatches what it can.
        NbDelta d = cappedBarcodes();
        if (d.barcodes.isEmpty()) {
            new AlertDialog.Builder(this).setTitle("Nothing in stock to dispatch")
                .setMessage("None of the scanned items are available in stock right now:" + d.oos
                    + "\n\nTap “Sync inventory from PACT” and re-scan once stock is available.")
                .setPositiveButton("OK", null).show();
            return;
        }
        scannedBarcodes.clear();
        scannedBarcodes.addAll(d.barcodes);
        final int n = d.barcodes.size();
        final String who = (soNumber == null || soNumber.isEmpty()) ? "this order" : soNumber;
        final String oosNote = d.oosKeys.isEmpty() ? "" :
            "\n\nOver-scanned / out-of-stock, adjusted so PACT accepts the post:" + d.oos;
        new AlertDialog.Builder(this)
                .setTitle("Submit to PACT")
                .setMessage("POST " + n + " scanned item(s) for " + who + " to PACT?" + oosNote + "\n\n"
                        + "This fills AND POSTS a real Factory Sales Invoice in PACT — it moves stock "
                        + "and cannot be undone from the app.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Submit", (dd, w) -> startFsiPush())
                .show();
    }

    /** Barcodes for Submit with each (code,batch) CAPPED at its available stock, so an
     *  over-scanned batch dispatches what exists instead of getting the whole invoice
     *  rejected. Flags any batch that was capped or dropped. */
    private NbDelta cappedBarcodes() {
        java.util.LinkedHashMap<String, Double> scanned = new java.util.LinkedHashMap<>();
        java.util.LinkedHashMap<String, OrderLine> sample = new java.util.LinkedHashMap<>();
        for (OrderLine l : scans) {
            if (l.productCode == null || l.productCode.isEmpty()) continue;
            String batch = l.batchNumber == null ? "" : l.batchNumber.trim();
            if (batch.isEmpty()) continue;
            String key = l.productCode + "" + batch;
            scanned.merge(key, l.quantity > 0 ? l.quantity : 1, Double::sum);
            sample.putIfAbsent(key, l);
        }
        NbDelta out = new NbDelta();
        for (java.util.Map.Entry<String, Double> e : scanned.entrySet()) {
            String key = e.getKey();
            String[] kp = key.split("", 2);
            String code = kp[0], batch = kp.length > 1 ? kp[1] : "";
            OrderLine sm = sample.get(key);
            String nm = (sm != null && sm.productName != null && !sm.productName.isEmpty()) ? sm.productName : code;
            double scannedPacks = e.getValue();
            double avail = batchAvailablePacks(code, nm, batch);
            double postable = Math.min(scannedPacks, Math.max(0, avail));
            if (postable <= 1e-6) {
                out.oosKeys.add(key);
                out.oos.append("\n• ").append(nm).append(" — batch ").append(batch)
                       .append(": 0 in stock, ").append(UomConvert.fmtPacks(scannedPacks)).append(" scanned — skipped");
                continue;
            }
            if (scannedPacks - postable > 1e-6) {
                out.oosKeys.add(key);
                out.oos.append("\n• ").append(nm).append(" — batch ").append(batch)
                       .append(": posting ").append(UomConvert.fmtPacks(postable)).append(" (")
                       .append(UomConvert.fmtPacks(scannedPacks - postable)).append(" over stock, skipped)");
            }
            double perPack = perPackWeight(sm);
            double weight = perPack > 0 ? perPack * postable : postable;
            out.barcodes.add(code + "_" + batch + "_" + fmtW(weight));
            out.packs.put(key, postable);
        }
        return out;
    }

    private void startFsiPush() {
        freezeForPost(true);
        banner("Submitting " + scannedBarcodes.size() + " item(s) to PACT… the app is locked until PACT replies.");
        // LIVE: the server fills the invoice AND posts it in PACT for real.
        ApiClient.pushFsi(soNumber, vendor, scannedBarcodes, /*dryRun=*/ false, (jobId, err) -> {
            if (err != null || jobId == null || jobId.isEmpty()) {
                finishFsiPushError("Couldn't submit to PACT: " + (err == null ? "no job id" : err) + ". Your scans are saved.");
                return;
            }
            banner("PACT is posting the invoice… waiting for PACT's reply (job " + shortId(jobId) + ")");
            pollFsiJob(jobId, 0);
        });
    }

    /** NutrioBox dispatch: hand the scanned labels to PACT as a Stock Outward to
     *  Outlet document. DRY RUN — the document is FILLED for review but NOT posted,
     *  so it is always safe. The operator opens PACT, checks it and Posts it. */
    /** NutrioBox Submit (delta-aware). Posts only the UNPOSTED, in-stock packs, so a
     *  manual Submit after any auto-posts never re-dispatches what already went out.
     *  This manual Submit is the FINAL post and completes the order. */
    private void fillStockOutwardDelta() {
        if (pushing) { msg("Already sending to PACT \u2014 please wait\u2026"); return; }
        if (autoPosting) { msg("An auto-post is in progress \u2014 wait a few seconds, then tap Submit again."); return; }
        if (autoStopped) {   // an auto-post ended un-confirmed \u2014 the operator must verify PACT before any further post
            new AlertDialog.Builder(this).setTitle("Auto-post was halted \u2014 verify first")
                .setMessage("The last auto-post's outcome is unknown, so it may already have dispatched some items. "
                    + "Open PACT and check the latest Stock Outward voucher for this outlet. Submit now ONLY if you have confirmed those items did NOT already post \u2014 otherwise they could be dispatched twice.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("I checked PACT \u2014 Submit", (x, y) -> { autoStopped = false; fillStockOutwardDelta(); })
                .show();
            return;
        }
        if (scans.isEmpty()) { msg("Scan some items first \u2014 then Submit them to PACT."); return; }
        NbDelta d = computeDelta();
        if (d.barcodes.isEmpty()) {
            if (!postedPacks.isEmpty()) {   // everything scanned was already auto-posted
                String extra = d.oosKeys.isEmpty() ? "" :
                    "\n\nStill out of stock, NOT dispatched:" + d.oos + "\nRestock and re-submit for these.";
                new AlertDialog.Builder(this).setTitle("Already posted to PACT")
                    .setMessage("Every scanned item has already been posted"
                        + (autoPostVouchers > 0 ? " across " + autoPostVouchers + " auto-post voucher(s)" : "")
                        + ". Mark this dispatch completed?" + extra)
                    .setNegativeButton("Keep scanning", null)
                    .setPositiveButton("Complete", (x, y) -> completeDispatchNoPost())
                    .show();
                return;
            }
            new AlertDialog.Builder(this).setTitle("Nothing in stock to dispatch")
                .setMessage("None of the scanned items are available in the dispatch warehouse right now:" + d.oos
                    + "\n\nTap \u201cSync inventory from PACT\u201d and re-scan once stock is available.")
                .setPositiveButton("OK", null).show();
            return;
        }
        pendingDeltaPacks = d.packs;
        if (d.oosKeys.isEmpty()) { confirmStockOutward(d.barcodes); return; }
        new AlertDialog.Builder(this).setTitle(d.oosKeys.size() + " item(s) out of stock \u2014 skipped")
            .setMessage("These scanned item(s) are no longer available in the dispatch warehouse and will NOT be dispatched:" + d.oos
                + "\n\nSubmit the remaining " + d.barcodes.size() + " item(s) to PACT?")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Submit the rest", (dl, w) -> confirmStockOutward(d.barcodes))
            .show();
    }

    /** The diff of current scans against what has already been posted. */
    private static class NbDelta {
        final java.util.List<String> barcodes = new java.util.ArrayList<>();
        final java.util.HashMap<String, Double> packs = new java.util.HashMap<>();   // (code+batch) -> packs in this delta
        final java.util.Set<String> oosKeys = new java.util.HashSet<>();
        final StringBuilder oos = new StringBuilder();
    }

    /** For each (code,batch): deltaPacks = scanned - alreadyPosted; skip when nothing
     *  new. Skip (and flag) when the delta can't be fully dispatched from current
     *  stock \u2014 conservatively counting already-posted packs as gone even if the
     *  snapshot hasn't re-synced \u2014 so we never dispatch more of a batch than exists. */
    private NbDelta computeDelta() {
        java.util.LinkedHashMap<String, Double> scanned = new java.util.LinkedHashMap<>();
        java.util.LinkedHashMap<String, OrderLine> sample = new java.util.LinkedHashMap<>();
        for (OrderLine l : scans) {
            if (l.productCode == null || l.productCode.isEmpty()) continue;
            String batch = l.batchNumber == null ? "" : l.batchNumber.trim();
            if (batch.isEmpty()) continue;
            String key = l.productCode + "" + batch;
            scanned.merge(key, l.quantity > 0 ? l.quantity : 1, Double::sum);
            sample.putIfAbsent(key, l);
        }
        NbDelta out = new NbDelta();
        for (java.util.Map.Entry<String, Double> e : scanned.entrySet()) {
            String key = e.getKey();
            Double ap = postedPacks.get(key);
            double already = ap != null ? ap : 0;
            double deltaPacks = e.getValue() - already;
            if (deltaPacks <= 1e-6) continue;               // nothing new for this batch
            String[] kp = key.split("", 2);
            String code = kp[0], batch = kp.length > 1 ? kp[1] : "";
            OrderLine sm = sample.get(key);
            String nm = (sm != null && sm.productName != null && !sm.productName.isEmpty()) ? sm.productName : code;
            double avail = batchAvailablePacks(code, nm, batch);
            double realAvail = avail - already;             // packs we already posted have left stock
            if (deltaPacks > realAvail + 1e-6) {            // can't fully dispatch the new packs \u2014 skip whole delta
                out.oosKeys.add(key);
                out.oos.append("\n\u2022 ").append(nm).append(" \u2014 batch ").append(batch)
                       .append(" (need ").append(UomConvert.fmtPacks(deltaPacks))
                       .append(", in stock ").append(UomConvert.fmtPacks(Math.max(0, realAvail))).append(")");
                continue;
            }
            double perPack = perPackWeight(sm);
            double weight = perPack > 0 ? perPack * deltaPacks : deltaPacks;
            out.barcodes.add(code + "_" + batch + "_" + fmtW(weight));
            out.packs.put(key, deltaPacks);
        }
        return out;
    }

    // ---- Auto-post ticker ---------------------------------------------------

    private void startAutoPostTimer() {
        if (!isNb()) return;
        autoPost.removeCallbacks(autoPostTick);
        // The cycle only runs once scanning has begun: 10 minutes from the first scan.
        if (autoPostOn && !viewOnly && !completed && !scans.isEmpty()) {
            autoArmed = true;
            autoPost.postDelayed(autoPostTick, AUTO_POST_MS);
        }
    }

        /** An auto-post ended without a confirmed success. A stock move must never be
     *  repeated blindly, so pause auto-posting and ask the operator to verify the
     *  last voucher in PACT before anything else posts. */
    private void haltAuto(String why) {
        autoPosting = false;
        autoStopped = true;
        autoPostOn = false;                 // paused until the operator confirms
        autoPost.removeCallbacks(autoPostTick);
        banner("\u26A0 AUTO-POST PAUSED. " + why
            + "  Open PACT and check the last Stock Outward voucher for this outlet before anything else posts, so nothing is dispatched twice.");
        if (isFinishing() || viewOnly || completed) return;
        new AlertDialog.Builder(this)
            .setTitle("Auto-post paused \u2014 verify in PACT")
            .setMessage("The last auto-post could not be confirmed, so it MAY or may not have posted. "
                + "Open PACT and check the latest Stock Outward voucher for this outlet.\n\n"
                + "Resume auto-posting only if you have confirmed those items did NOT already post \u2014 otherwise they could be dispatched twice.")
            .setNegativeButton("Keep paused", null)
            .setPositiveButton("I checked \u2014 resume", (d, w) -> resumeAuto())
            .show();
    }

    /** Operator verified PACT after a pause: clear the halt and restart the ticker. */
    private void resumeAuto() {
        autoStopped = false;
        autoPostOn = true;
        startAutoPostTimer();
        banner("Auto-post resumed \u2014 the newly-scanned in-stock items will post at the next 10-minute cycle.");
    }

    /** The 10-minute cycle: autosave, refresh this order's stock from PACT, then
     *  auto-post the newly-scanned in-stock items. */
    private void autoCycle() {
        if (!isNb() || !autoPostOn) return;
        if (viewOnly || completed) return;
        if (pushing || autoPosting || scanFrozen) return;   // never overlap a manual/auto post or another freeze
        if (scans.isEmpty()) return;
        if (computeDelta().barcodes.isEmpty()) return;       // nothing new to post this cycle — skip the freeze entirely
        saveNow(false);        // 1) autosave
        loadInventory();       // 2) refresh stock (kicks a background PACT sync if stale)
        beginAutoPostFreeze(); // 3) lock scanning for a 4-sec countdown, then post the delta
    }

    /** Lock scanning for FREEZE_SECS with a visible countdown so NO new scan can be
     *  registered while the delta snapshot is taken. After the countdown: unfreeze,
     *  hand scanning back to the operator, and post the snapshot in the background.
     *  This stops a scan landing ambiguously between this voucher and the next. */
    private void beginAutoPostFreeze() {
        if (scanFrozen) return;
        scanFrozen = true;
        setScanBlockedUi(true);
        freezeCountdown(FREEZE_SECS);
    }

    private void freezeCountdown(int n) {
        if (viewOnly || completed) { scanFrozen = false; setScanBlockedUi(false); return; }
        if (n > 0) {
            banner("⏸ Auto-post starting — scanning LOCKED for " + n + " sec… do NOT scan.");
            poll.postDelayed(() -> freezeCountdown(n - 1), 1000);
            return;
        }
        // Countdown finished: no scan came in during the freeze, so the delta is clean.
        scanFrozen = false;
        setScanBlockedUi(false);
        armScan();                       // hand scanning back to the operator
        banner("Posting this batch to PACT… you can resume scanning now.");
        tryAutoPost();                   // snapshot the delta + post it in the background
    }

    /** Enable/disable the scan box for the brief pre-post freeze only. Does NOT touch
     *  the `pushing` full-lock that a manual Submit uses. */
    private void setScanBlockedUi(boolean blocked) {
        if (b == null || b.etScan == null) return;
        b.etScan.setEnabled(!blocked && !completed && !viewOnly);
    }

    /** Fired by the 10-min ticker: post the newly-scanned, in-stock packs as their
     *  own voucher, WITHOUT freezing the screen \u2014 scanning continues throughout. */
    private void tryAutoPost() {
        if (!isNb() || !autoPostOn) return;
        if (autoStopped) return;                                       // halted after an un-confirmed post — never auto-retry a stock move
        if (viewOnly || completed || pushing || autoPosting) return;   // never overlap a manual push or another auto-post
        if (scans.isEmpty()) return;
        NbDelta d = computeDelta();
        if (d.barcodes.isEmpty()) return;                              // nothing new in stock to post
        startAutoPost(d);
    }

    private void startAutoPost(NbDelta d) {
        autoPosting = true;
        final java.util.HashMap<String, Double> justPosted = d.packs;
        final int nItems = d.barcodes.size();
        banner("Auto-posting " + nItems + " new item(s) to PACT\u2026 (you can keep scanning)");
        ApiClient.pushStockOutward(soNumber, vendor, new java.util.ArrayList<>(d.barcodes), /*dryRun=*/ false, (jobId, err) -> {
            if (err != null || jobId == null || jobId.isEmpty()) {
                autoPosting = false;
                banner("Auto-post couldn't start (will retry next cycle): " + (err == null ? "no job id" : err));
                return;
            }
            pollAutoPost(jobId, 0, justPosted, nItems);
        });
    }

    /** Background poll for one auto-post voucher. Does NOT freeze the UI. On success
     *  the posted packs are added to the ledger so they are never sent again. */
    private void pollAutoPost(String jobId, int tries, java.util.HashMap<String, Double> justPosted, int nItems) {
        poll.postDelayed(() -> ApiClient.getPactJob(jobId, (st, err) -> {
            if (st == null) {
                if (tries < 90) pollAutoPost(jobId, tries + 1, justPosted, nItems);
                else haltAuto("Auto-post: no reply from PACT for job " + shortId(jobId) + ". It MAY or may not have posted.");
                return;
            }
            if (st.isDone()) {
                // CONFIRMED post only: record the packs so they are never sent again, and keep auto-posting.
                for (java.util.Map.Entry<String, Double> e : justPosted.entrySet())
                    postedPacks.merge(e.getKey(), e.getValue(), Double::sum);
                autoPostVouchers++;
                autoPosting = false;
                String inv = (st.invoice != null && !st.invoice.isEmpty()) ? st.invoice
                           : (st.message != null ? firstLine(st.message) : "");
                banner("Auto-posted " + nItems + " item(s)" + (inv == null || inv.isEmpty() ? "" : " \u2014 " + inv)
                        + ".  Auto-post vouchers so far: " + autoPostVouchers + ".  Keep scanning \u2014 the rest posts automatically; tap Submit when the dispatch is finished.");
            } else if (st.isFailed()) {
                // Not a confirmed success. It could have posted anyway, so NEVER auto-retry a stock move.
                haltAuto("Auto-post did not confirm: "
                        + (st.message == null || st.message.isEmpty() ? "see the dashboard" : firstLine(st.message)));
            } else if (tries < 90) {
                pollAutoPost(jobId, tries + 1, justPosted, nItems);
            } else {
                haltAuto("Auto-post is taking longer than usual (job " + shortId(jobId) + "). It MAY or may not have posted.");
            }
        }), 2000);
    }

    /** Manual "Complete" when everything scanned was already auto-posted: mark the
     *  dispatch done without sending anything more to PACT. */
    private void completeDispatchNoPost() {
        autoPost.removeCallbacks(autoPostTick);
        completed = true;
        ScanDraftStore.saveSnapshot(this, soNumber, scans);
        ScanDraftStore.markCompleted(this, soNumber);
        b.etScan.setEnabled(false);
        b.btnFillPact.setEnabled(false);
        b.btnClear.setEnabled(false);
        b.btnSave.setEnabled(false);
        b.btnSave.setText("Completed");
        banner("Dispatch COMPLETED \u2014 all scanned items were already posted to PACT"
                + (autoPostVouchers > 0 ? " (" + autoPostVouchers + " auto-post voucher(s))" : "") + ".");
    }

    /** Legacy non-delta Submit \u2014 replaced by fillStockOutwardDelta(); kept unreferenced. */
    private void fillStockOutwardLegacyUnused() {
        if (pushing) { msg("Already sending to PACT \u2014 please wait\u2026"); return; }
        java.util.List<String> all = pactBarcodes();
        if (all.isEmpty()) { msg("Scan some items first \u2014 then Submit them to PACT."); return; }
        // Re-check every scanned batch against the LATEST inventory. An item whose batch
        // is no longer available in the dispatch warehouse would be rejected by PACT and
        // block the whole post, so it is dropped here with one clear message.
        java.util.LinkedHashMap<String, Double> packs = new java.util.LinkedHashMap<>();
        java.util.LinkedHashMap<String, OrderLine> sample = new java.util.LinkedHashMap<>();
        for (OrderLine l : scans) {
            if (l.productCode == null || l.productCode.isEmpty()) continue;
            String batch = l.batchNumber == null ? "" : l.batchNumber.trim();
            if (batch.isEmpty()) continue;
            String key = l.productCode + "\u0001" + batch;
            packs.merge(key, l.quantity > 0 ? l.quantity : 1, Double::sum);
            sample.putIfAbsent(key, l);
        }
        java.util.Set<String> oosKeys = new java.util.HashSet<>();
        StringBuilder oos = new StringBuilder();
        for (java.util.Map.Entry<String, Double> e : packs.entrySet()) {
            String[] kp = e.getKey().split("\u0001", 2);
            OrderLine sm = sample.get(e.getKey());
            String nm = (sm != null && sm.productName != null) ? sm.productName : kp[0];
            double avail = batchAvailablePacks(kp[0], nm, kp.length > 1 ? kp[1] : "");
            if (avail + 1e-6 < e.getValue()) {
                oosKeys.add(e.getKey());
                oos.append("\n\u2022 ").append(nm).append(" \u2014 batch ").append(kp.length > 1 ? kp[1] : "?")
                   .append(" (need ").append(UomConvert.fmtPacks(e.getValue())).append(", in stock ").append(UomConvert.fmtPacks(Math.max(0, avail))).append(")");
            }
        }
        java.util.List<String> good = new java.util.ArrayList<>();
        for (String bc : all) {
            int i = bc.indexOf('_'), j = bc.lastIndexOf('_');
            String key = (i > 0 && j > i) ? (bc.substring(0, i) + "\u0001" + bc.substring(i + 1, j)) : bc;
            if (!oosKeys.contains(key)) good.add(bc);
        }
        if (oosKeys.isEmpty()) { confirmStockOutward(good); return; }
        if (good.isEmpty()) {
            new AlertDialog.Builder(this).setTitle("All scanned items are out of stock")
                .setMessage("None of the scanned items are available in the dispatch warehouse right now, so nothing can be dispatched:" + oos
                    + "\n\nTap \u201cSync inventory from PACT\u201d and re-scan once stock is available.")
                .setPositiveButton("OK", null).show();
            return;
        }
        new AlertDialog.Builder(this).setTitle(oosKeys.size() + " item(s) out of stock \u2014 skipped")
            .setMessage("These scanned item(s) are no longer available in the dispatch warehouse and will NOT be dispatched:" + oos
                + "\n\nSubmit the remaining " + good.size() + " item(s) to PACT?")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Submit the rest", (d, w) -> confirmStockOutward(good))
            .show();
    }

    private void confirmStockOutward(java.util.List<String> barcodes) {
        scannedBarcodes.clear();
        scannedBarcodes.addAll(barcodes);
        if (scannedBarcodes.isEmpty()) { msg("Nothing to submit."); return; }
        if (pushing) { msg("Already sending to PACT \u2014 please wait\u2026"); return; }
        final int n = scannedBarcodes.size();
        final String who = (soNumber == null || soNumber.isEmpty()) ? "this requisition" : soNumber;
        new AlertDialog.Builder(this)
                .setTitle("Submit to PACT (Stock Outward)")
                .setMessage("POST " + n + " scanned item(s) for " + who
                        + (vendor == null || vendor.isEmpty() ? "" : " (" + vendor + ")") + " to PACT?\n\n"
                        + "This fills AND POSTS a real Stock Outward to Outlet document in PACT — it moves stock "
                        + "and cannot be undone from the app. Post only when the dispatch is fully checked.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Submit", (d, w) -> startStockOutwardPush())
                .show();
    }

    private void startStockOutwardPush() {
        nbPush = true;
        freezeForPost(true);
        banner("Posting " + scannedBarcodes.size() + " item(s) to PACT\u2026 the app is locked until PACT replies.");
        ApiClient.pushStockOutward(soNumber, vendor, scannedBarcodes, /*dryRun=*/ false, (jobId, err) -> {
            if (err != null || jobId == null || jobId.isEmpty()) {
                finishFsiPushError("Couldn't submit to PACT: " + (err == null ? "no job id" : err) + ". Your scans are saved.");
                return;
            }
            banner("PACT is preparing the Stock Outward document\u2026 (job " + shortId(jobId) + ")");
            pollFsiJob(jobId, 0);
        });
    }

    /** PACT confirmed the Stock Outward post: blank the table and mark the dispatch completed. */
    private void onStockOutwardPrepared(ApiClient.JobStatus st) {
        nbPush = false;
        completed = true;
        autoPost.removeCallbacks(autoPostTick);   // this manual Submit is the final post
        if (pendingDeltaPacks != null) {          // record what this submit posted, then done
            for (java.util.Map.Entry<String, Double> e : pendingDeltaPacks.entrySet())
                postedPacks.merge(e.getKey(), e.getValue(), Double::sum);
            pendingDeltaPacks = null;
        }
        ScanDraftStore.saveSnapshot(this, soNumber, scans);   // keep a read-only copy for View
        ScanDraftStore.markCompleted(this, soNumber);
        String inv = (st != null && st.invoice != null && !st.invoice.isEmpty()) ? st.invoice
                   : (st != null && st.message != null ? firstLine(st.message) : "");
        scannedBarcodes.clear();
        localScanned.clear();
        scans = new ArrayList<>();
        pushing = false;
        b.etScan.setEnabled(false);
        b.btnFillPact.setEnabled(false);
        b.btnSync.setEnabled(true);
        b.btnClear.setEnabled(false);
        b.btnSave.setEnabled(false);
        b.btnSave.setText("Completed");
        banner("POSTED to PACT" + (inv == null || inv.isEmpty() ? "" : " \u2014 " + inv) + ". This dispatch is now COMPLETED.");
        rebuild();
    }

    /** Polls the push status until it finishes or times out (~3 min). */
    private void pollFsiJob(String jobId, int tries) {
        poll.postDelayed(() -> ApiClient.getPactJob(jobId, (st, err) -> {
            if (st == null) {                        // transient network hiccup — keep trying
                if (tries < 45) pollFsiJob(jobId, tries + 1);
                else finishFsiPushError("Still waiting on PACT — check PACT/dashboard. Your scans are saved. (job " + shortId(jobId) + ")");
                return;
            }
            if (st.isDone()) {
                if (nbPush) onStockOutwardPrepared(st); else onPostSuccess(st);
            } else if (st.isFailed()) {
                finishFsiPushError("PACT rejected the post: "
                        + (st.message == null || st.message.isEmpty() ? "see the dashboard" : firstLine(st.message))
                        + ". Your scans are saved — fix and Submit again.");
            } else if (tries < 45) {
                pollFsiJob(jobId, tries + 1);        // queued / processing
            } else {
                finishFsiPushError("Taking longer than usual — check PACT/dashboard. Your scans are saved. (job " + shortId(jobId) + ")");
            }
        }), 2000);
    }

    /** Lock (or unlock) the whole screen while a PACT post is in flight. */
    private void freezeForPost(boolean frozen) {
        pushing = frozen;
        b.etScan.setEnabled(!frozen && !completed);
        b.btnSync.setEnabled(!frozen);
        b.btnClear.setEnabled(!frozen && !completed);
        b.btnSave.setEnabled(!frozen && !completed);
        b.btnFillPact.setEnabled(!frozen && !completed && !scans.isEmpty());
    }

    /** PACT replied with an error (or we gave up): unfreeze and keep the saved scans on screen. */
    private void finishFsiPushError(String message) {
        nbPush = false;
        pendingDeltaPacks = null;   // manual submit failed — recompute the delta fresh next time
        freezeForPost(false);
        banner(message);
        refreshScans();           // bring the saved scans back on screen
    }

    /** PACT confirmed the post: blank the scanned table and mark the order completed. */
    private void onPostSuccess(ApiClient.JobStatus st) {
        completed = true;
        ScanDraftStore.saveSnapshot(this, soNumber, scans);   // keep a read-only copy for View
        ScanDraftStore.markCompleted(this, soNumber);
        String inv = (st != null && st.invoice != null && !st.invoice.isEmpty()) ? st.invoice
                   : (st != null && st.message != null ? firstLine(st.message) : "");
        String q = (soNumber != null && !soNumber.isEmpty()) ? "?so=" + android.net.Uri.encode(soNumber) : "?all=1";
        ApiClient.delete(q, (ok, err) -> {
            scannedBarcodes.clear();
            localScanned.clear();
            scans = new ArrayList<>();
            pushing = false;
            b.etScan.setEnabled(false);
            b.btnFillPact.setEnabled(false);
            b.btnSync.setEnabled(true);
            b.btnClear.setEnabled(false);
            b.btnSave.setEnabled(false);
            b.btnSave.setText("Completed");
            banner("POSTED to PACT" + (inv.isEmpty() ? "" : " — " + inv) + ". This order is now COMPLETED.");
            rebuild();            // table now blank
        });
    }

    private static String shortId(String id) { return id == null ? "" : (id.length() > 8 ? id.substring(0, 8) : id); }

    private static String firstLine(String s) {
        if (s == null) return "";
        int i = s.indexOf('\n');
        return (i > 0 ? s.substring(0, i) : s).trim();
    }

    /** Clear order with a yes/no confirmation (footer button and top button). */
    private void confirmClearOrder() {
        if (scans == null || scans.isEmpty()) { msg("Nothing to clear."); return; }
        new AlertDialog.Builder(this)
            .setTitle("Clear this order?")
            .setMessage("Remove all " + scans.size() + " scanned line(s) from this order on this device? This cannot be undone."
                + (postedPacks.isEmpty() ? "" : " Any items already auto-posted to PACT are NOT undone."))
            .setNegativeButton("No", null)
            .setPositiveButton("Yes, clear", (d, w) -> clearOrder())
            .show();
    }

    /** Delete one scanned batch (all scans for this product+batch), after confirming. */
    private void confirmDeleteBatch(LineAdapter.Row r) {
        if (r == null || r.delCode == null || r.delCode.isEmpty() || r.batchNo == null || r.batchNo.isEmpty()) return;
        if (pushing || autoPosting) { msg("A post is in progress \u2014 wait a moment, then delete."); return; }
        final String code = r.delCode, batch = r.batchNo.trim();
        final String nm = (r.name != null && !r.name.isEmpty()) ? r.name : code;
        java.util.List<Long> ids = new java.util.ArrayList<>();
        double packs = 0;
        for (OrderLine l : scans) {
            String lb = l.batchNumber == null ? "" : l.batchNumber.trim();
            if (code.equalsIgnoreCase(l.productCode) && batch.equalsIgnoreCase(lb)) {
                if (l.id > 0) ids.add(l.id);
                packs += (l.quantity > 0 ? l.quantity : 1);
            }
        }
        if (ids.isEmpty()) { msg("Nothing to delete for that batch."); return; }
        final double fp = packs;
        final boolean wasPosted = postedPacks.containsKey(code + "" + batch);
        new AlertDialog.Builder(this)
            .setTitle("Delete from " + nm + "?")
            .setMessage(nm + ": batch " + batch + " has " + UomConvert.fmtPacks(fp) + " scanned.\nRemove just the last pack, or all of them?"
                + (wasPosted ? "\n\nNote: some of this batch was already auto-posted to PACT and will NOT be undone." : ""))
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Remove 1", (d, w) -> deleteBatchByIds(code, batch, java.util.Collections.singletonList(ids.get(ids.size() - 1))))
            .setNeutralButton("Remove all", (d, w) -> deleteBatchByIds(code, batch, ids))
            .show();
    }

    private void deleteBatchByIds(String code, String batch, java.util.List<Long> ids) {
        final int n = ids.size();
        final int[] left = { ids.size() };
        for (Long id : ids) {
            ApiClient.delete("?id=" + id, (ok, err) -> {
                if (--left[0] <= 0) {
                    localScanned.remove(code.toUpperCase(Locale.ROOT));   // clear the anti-lag counter; server is now truth
                    banner("Removed " + n + " pack" + (n == 1 ? "" : "s") + " of " + code + " batch " + batch + ".");
                    refreshScans();
                }
            });
        }
    }

    private void clearOrder() {
        if (scans.isEmpty()) return;
        String q = (soNumber != null && !soNumber.isEmpty()) ? "?so=" + android.net.Uri.encode(soNumber) : "?all=1";
        final boolean hadPosted = !postedPacks.isEmpty();
        ApiClient.delete(q, (ok, err) -> {
            ScanDraftStore.clear(this, soNumber);
            ScanDraftStore.reopen(this, soNumber);
            scannedBarcodes.clear();
            localScanned.clear();
            postedPacks.clear();          // reset the auto-post ledger — fresh scan starts clean
            pendingDeltaPacks = null;
            autoPostVouchers = 0;
            autoArmed = false;            // the next first scan re-arms the 10-min cycle
            scanFrozen = false;
            autoPost.removeCallbacks(autoPostTick);
            completed = false;
            b.etScan.setEnabled(true);
            b.btnSave.setEnabled(true); b.btnSave.setText("Save");
            banner(hadPosted
                ? "Order cleared on this device. Note: any Stock Outward vouchers already auto-posted to PACT are NOT undone — cancel those in PACT if they should not stand."
                : "");
            refreshScans();
        });
    }

    // ---- Honeywell scan-intent (in addition to keyboard-wedge) --------------

    private BroadcastReceiver scanReceiver;
    private static final String[] SCAN_ACTIONS = {
            "com.sukhnafoods.salesorder.SCAN",
            "com.honeywell.aidc.action.BARCODE_READ",
            "com.honeywell.scanner.action.BARCODE_READ",
            "android.intent.ACTION_DECODE_DATA",
            "com.symbol.datawedge.api.RESULT_ACTION",
    };
    private static final String[] SCAN_EXTRAS = {
            "data", "barcode_string", "com.honeywell.aidc.ExtraData",
            "com.symbol.datawedge.data_string", "scanData", "barcode",
    };

    private void registerScanReceiver() {
        scanReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                if (intent == null) return;
                for (String key : SCAN_EXTRAS) {
                    String val = intent.getStringExtra(key);
                    if (val != null && !val.trim().isEmpty()) { submitScan(val); return; }
                }
            }
        };
        IntentFilter filter = new IntentFilter();
        for (String a : SCAN_ACTIONS) filter.addAction(a);
        ContextCompat.registerReceiver(this, scanReceiver, filter, ContextCompat.RECEIVER_EXPORTED);
    }

    private void msg(String m) {
        if (m == null || m.isEmpty()) { b.tvMsg.setVisibility(View.GONE); return; }
        b.tvMsg.setText(m);
        b.tvMsg.setTextColor(msgDefaultColor);
        b.tvMsg.setVisibility(View.VISIBLE);
    }

    /** Total packs (sales units) of a product available across all its batches. */
    private double availablePacks(String code, String name) {
        ProductStock st = stockOf(code);
        if (st == null || st.batches == null) return 0;
        String ideal = idealWarehouseFor(code, name);
        double total = 0;
        for (Batch bt : st.batches) {
            // Only stock in the product's ideal warehouse is dispatchable.
            if (!ideal.isEmpty() && bt.warehouse != null && !whEq(ideal, bt.warehouse)) continue;   // ideal-warehouse stock only
            Double pk = UomConvert.toSalesUnits(bt.available, code, name);
            total += (pk != null ? pk : 0);
        }
        return total;
    }

    /** Dispatchable packs of ONE specific batch in the product's ideal warehouse. */
    private double batchAvailablePacks(String code, String name, String batch) {
        ProductStock st = stockOf(code);
        if (st == null || st.batches == null || batch == null || batch.isEmpty()) return 0;
        String ideal = idealWarehouseFor(code, name);
        double total = 0;
        for (Batch bt : st.batches) {
            if (bt.batchNumber == null || !bt.batchNumber.equalsIgnoreCase(batch.trim())) continue;
            if (!ideal.isEmpty() && bt.warehouse != null && !whEq(ideal, bt.warehouse)) continue;
            Double pk = UomConvert.toSalesUnits(bt.available, code, name);
            total += (pk != null ? pk : 0);
        }
        return total;
    }

    /** The product-master ideal warehouse for this product, or "" if none. */
    private String idealWarehouseFor(String code, String name) {
        ProductMaster m = ApiClient.masterOrNull();
        if (m == null) return "";
        ProductMaster.Product pr = m.find(code, name);
        return (pr != null && pr.idealWarehouse != null) ? pr.idealWarehouse.trim() : "";
    }

    /** A scan refused because it would exceed available stock: shown in red, not added. */
    private void blockScan(String reason) {
        b.etScan.setText("");
        b.etScan.requestFocus();
        b.tvMsg.setText(reason);
        b.tvMsg.setTextColor(0xFFD32F2F);   // red
        b.tvMsg.setVisibility(View.VISIBLE);
    }
}
