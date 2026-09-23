package com.sukhnafoods.salesorder;

import android.app.AlertDialog;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;
import androidx.recyclerview.widget.LinearLayoutManager;

import com.sukhnafoods.salesorder.databinding.ActivitySalesOrdersBinding;
import com.sukhnafoods.salesorder.model.SalesOrder;
import com.sukhnafoods.salesorder.net.ApiClient;

import java.util.List;

/** Fetch sales order: the vendors' pending orders with View / Start-to-scan,
 *  plus a "Sync from PACT" button that pulls the latest pending orders live. */
public class SalesOrdersActivity extends AppCompatActivity implements SoAdapter.Listener {

    private ActivitySalesOrdersBinding b;
    private final SoAdapter adapter = new SoAdapter(this);
    private final Handler h = new Handler(Looper.getMainLooper());
    private AlertDialog progress;
    private String signature = "";

    @Override protected void onCreate(Bundle s) {
        super.onCreate(s);
        b = ActivitySalesOrdersBinding.inflate(getLayoutInflater());
        setContentView(b.getRoot());
        b.rvOrders.setLayoutManager(new LinearLayoutManager(this));
        b.rvOrders.setAdapter(adapter);
        b.btnSyncSo.setOnClickListener(v -> syncFromPact());

        b.etSoSearch.addTextChangedListener(new android.text.TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int a, int c, int d) {}
            @Override public void onTextChanged(CharSequence s, int a, int c, int d) { adapter.setQuery(s.toString()); updateCount(); }
            @Override public void afterTextChanged(android.text.Editable s) {}
        });

        // Vendor dropdown: pick a vendor to filter the orders (first entry = all).
        b.spVendor.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(android.widget.AdapterView<?> p, android.view.View v, int pos, long id) {
                selectedVendor = (pos <= 0 || pos > vendorValues.size()) ? "" : vendorValues.get(pos - 1);
                adapter.setVendorFilter(selectedVendor);
                updateCount();
            }
            @Override public void onNothingSelected(android.widget.AdapterView<?> p) {}
        });
    }

    private boolean syncing = false;
    private boolean autoRefreshDone = false;
    private String selectedVendor = "";
    private java.util.List<String> vendorValues = new java.util.ArrayList<>();  // raw vendor names, aligned to dropdown rows 1..n

    private void populateVendorDropdown() {
        java.util.LinkedHashMap<String, Integer> counts = adapter.vendorCounts();
        vendorValues = new java.util.ArrayList<>(counts.keySet());
        java.util.List<String> display = new java.util.ArrayList<>();
        display.add("All vendors · " + adapter.totalCount() + " orders");
        for (String v : vendorValues) display.add(v + "  (" + counts.get(v) + ")");
        android.widget.ArrayAdapter<String> a = new android.widget.ArrayAdapter<>(this, android.R.layout.simple_spinner_item, display);
        a.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        b.spVendor.setAdapter(a);
        // keep the previously chosen vendor selected across reloads
        int idx = 0;
        if (!selectedVendor.isEmpty()) { int i = vendorValues.indexOf(selectedVendor); if (i >= 0) idx = i + 1; else selectedVendor = ""; }
        b.spVendor.setSelection(idx);
    }

    private void updateCount() {
        int shown = adapter.visibleCount(), total = adapter.totalCount();
        if (total == 0) { b.tvSoStatus.setText(syncing ? "Pulling the latest orders from PACT…" : "No pending orders yet. Tap “Sync from PACT” to refresh."); return; }
        b.tvSoStatus.setText(shown == total
                ? total + " sales order" + (total == 1 ? "" : "s")
                : "Showing " + shown + " of " + total + " orders");
    }

    @Override protected void onResume() {
        super.onResume();
        load();                       // show the cached list instantly
        if (!autoRefreshDone) {       // then pull the latest from PACT in the background, once
            autoRefreshDone = true;
            refreshFromPact(true);
        }
    }

    private void load() {
        b.tvSoStatus.setText("Loading pending orders…");
        ApiClient.getSalesOrders((orders, err) -> {
            if (orders == null) { b.tvSoStatus.setText("Couldn't load orders" + (err != null ? ": " + err : "")); return; }
            signature = sigOf(orders);
            adapter.setOrders(withCompleted(orders));
            populateVendorDropdown();
            updateCount();
        });
    }

    private void syncFromPact() { refreshFromPact(false); }

    /** Pull the latest pending orders from PACT in the BACKGROUND - the cached
     *  list stays usable while it runs, and the list updates when it finishes. */
    private void refreshFromPact(boolean auto) {
        if (syncing) return;
        syncing = true;
        b.btnSyncSo.setEnabled(false);
        b.btnSyncSo.setText("Refreshing…");
        b.tvSoStatus.setText("Refreshing the latest orders from PACT… you can keep using the list below.");
        // Wait for the AWS worker to FINISH the pull (via /api/sync-status), then
        // load the fresh list once and report the count - clear feedback even when
        // the pending list is unchanged (nothing new / nothing dispatched).
        ApiClient.runSalesOrderSync(
                stage -> b.tvSoStatus.setText("Refreshing the latest orders from PACT — " + stage + "… you can keep using the list below."),
                (okMsg, err) -> {
                    if (okMsg == null) {                 // failed or timed out - keep the current list, load once
                        endRefresh();
                        load();
                        if (!auto) toast(err != null ? err : "Couldn't finish the refresh.");
                        return;
                    }
                    ApiClient.getSalesOrders((orders, e2) -> {
                        endRefresh();
                        if (orders != null) {
                            signature = sigOf(orders);
                            adapter.setOrders(withCompleted(orders));
                            populateVendorDropdown();
                            updateCount();
                            toast("Synced — " + orders.size() + " pending order" + (orders.size() == 1 ? "" : "s") + ".");
                        } else {
                            load();
                        }
                    });
                });
    }

    private void endRefresh() {
        syncing = false;
        b.btnSyncSo.setEnabled(true);
        b.btnSyncSo.setText("Sync from PACT");
        updateCount();
    }


    /** Adds locally-completed orders (that have a saved snapshot) to the pending
     *  list, so a submitted order stays visible and its scans can be viewed even
     *  after PACT drops it from the pending feed. */
    private List<SalesOrder> withCompleted(List<SalesOrder> pending) {
        List<SalesOrder> out = new java.util.ArrayList<>(pending);
        java.util.Set<String> have = new java.util.HashSet<>();
        for (SalesOrder o : pending) if (o.soNumber != null) have.add(o.soNumber);
        for (String so : ScanDraftStore.listSnapshotSoNumbers(this)) {
            if (so == null || so.isEmpty() || have.contains(so)) continue;
            // NB outlet requisitions (OMR-...) belong to the NutrioBox screen, not the
            // B2B "Fetch sales order" list. The completed-snapshot store is shared across
            // both channels, so filter them out here.
            if (so.toUpperCase(java.util.Locale.ROOT).startsWith("OMR")) continue;
            SalesOrder s = new SalesOrder();
            s.soNumber = so; s.status = "done";
            ScanDraftStore.Draft d = ScanDraftStore.loadSnapshot(this, so);
            if (d != null && !d.lines.isEmpty()) {
                s.vendor = d.lines.get(0).vendor == null ? "" : d.lines.get(0).vendor;
                java.util.Set<String> prods = new java.util.HashSet<>();
                for (com.sukhnafoods.salesorder.model.OrderLine l : d.lines)
                    prods.add((l.productCode == null ? "" : l.productCode) + "|" + (l.productName == null ? "" : l.productName));
                s.itemCount = prods.size();
            }
            out.add(s);
        }
        // Belt-and-suspenders: whatever the source (server list OR completed snapshot),
        // the B2B screen must never show NutrioBox outlet requisitions. Drop anything
        // whose number is an OMR requisition or whose vendor is a NutrioBox outlet.
        java.util.Iterator<SalesOrder> it = out.iterator();
        while (it.hasNext()) {
            SalesOrder o = it.next();
            String so = o.soNumber == null ? "" : o.soNumber.toUpperCase(java.util.Locale.ROOT).trim();
            String vn = o.vendor == null ? "" : o.vendor.toLowerCase(java.util.Locale.ROOT).trim();
            if (so.startsWith("OMR") || so.contains("OMR-AF") || vn.startsWith("nutrio")) it.remove();
        }
        return out;
    }

    private static String sigOf(List<SalesOrder> orders) {
        StringBuilder sb = new StringBuilder(orders.size() + "|");
        for (SalesOrder o : orders) sb.append(o.id).append(':').append(o.soNumber).append(';');
        return sb.toString();
    }

    @Override public void onView(SalesOrder o) {
        // View = the order and its items on the clean, read-only detail screen —
        // for pending AND completed orders alike. For a completed order the detail
        // screen locks scanning and shows delivered = ordered / pending = 0, so we
        // never drop into the scan screen's (empty) completed snapshot.
        boolean completed = ScanDraftStore.isCompleted(this, o.soNumber)
                || "completed".equalsIgnoreCase(o.status) || "done".equalsIgnoreCase(o.status);
        startActivity(new Intent(this, SalesOrderDetailActivity.class)
                .putExtra("ID", o.id).putExtra("SO_NUMBER", o.soNumber).putExtra("VENDOR", o.vendor)
                .putExtra("COMPLETED", completed));
    }

    @Override public void onReopen(SalesOrder o) {
        // Completed orders are LOCKED - reopening/rescanning is not allowed.
        toast(o.soNumber + " is completed and locked — it can't be reopened.");
    }

    @Override public void onScan(SalesOrder o) {
        // Never let a completed order be scanned again (guards against double-dispatch).
        if (ScanDraftStore.isCompleted(this, o.soNumber)) {
            toast(o.soNumber + " is completed and locked — rescanning is not allowed.");
            return;
        }
        startActivity(new Intent(this, OrderInventoryActivity.class)
                .putExtra("ID", o.id).putExtra("SO_NUMBER", o.soNumber).putExtra("VENDOR", o.vendor));
    }

    private void showProgress(String msg) {
        TextView t = new TextView(this);
        t.setPadding(48, 40, 48, 40); t.setTextSize(15); t.setText(msg);
        progress = new AlertDialog.Builder(this).setView(t).setCancelable(false).create();
        progress.show();
    }
    private void dismissProgress() { if (progress != null) { progress.dismiss(); progress = null; } }
    private void toast(String m) { android.widget.Toast.makeText(this, m, android.widget.Toast.LENGTH_LONG).show(); }
}
