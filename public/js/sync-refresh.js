/*  Ops Dashboard — cross-tool, cross-tab, cross-device sync notifier (REAL-TIME).
 *
 *  Every tool that displays PACT-backed data includes TWO scripts:
 *
 *    <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *    <script src="/js/sync-refresh.js"></script>
 *
 *  …defines a page-level handler for refreshes:
 *
 *    window.onDataChanged = function(changedReports) {
 *      // changedReports is a subset of ['pm','bom','pf','si','inventory']
 *      // Re-fetch and re-render whichever your tool shows.
 *    };
 *
 *  OR for React/Next.js tools, listens for a DOM event instead (works even
 *  when multiple components want to react to the same change):
 *
 *    window.addEventListener('ops-sync-update', (e) => {
 *      // e.detail.changed is a subset of ['pm','bom','pf','si','inventory']
 *    });
 *
 *  …and OPTIONALLY calls, right after its own ⚡ Sync button completes:
 *
 *    window.OpsSync.broadcast('pm', newSyncedAt);        // or 'inventory', etc.
 *
 *  Behaviour (three layers, defence in depth):
 *   1. SUPABASE REALTIME (primary) — opens a WebSocket to Supabase and
 *      subscribes to INSERT events on public.costing_snapshots AND
 *      public.inventory_snapshots. The moment any PACT worker writes a new
 *      row, every open tool receives a push in ~200–500 ms, regardless of
 *      browser or device.
 *   2. BROADCASTCHANNEL (same-browser latency) — sibling tabs refresh
 *      instantly (<50 ms) without each one having to react to Realtime.
 *   3. SAFETY POLL (last resort) — every 5 min checks /api/product-master,
 *      /api/costing/bom and /api/inventory for a synced_at advance we somehow
 *      missed. Catches cases where the WebSocket silently dropped.
 */
(function () {
  'use strict';

  var CHANNEL        = 'ops-dashboard-sync-v1';
  // 2026-10-29 (Satvik: "sync from other laptop doesn't show up"): dropped
  // the safety poll from 5 min to 45 s so even if Realtime is DOA on a given
  // laptop, cross-device changes land within a minute instead of five.
  var SAFETY_POLL_MS = 45 * 1000;
  var FIRST_POLL_MS  = 15 * 1000;

  // ─── 1. BroadcastChannel (same-browser instant) ──────────────────────────
  var bc = null;
  try { bc = new BroadcastChannel(CHANNEL); } catch (e) { /* older browsers */ }

  var last = { pm: null, bom: null, pf: null, si: null, inventory: null };
  var realtimeStatus = 'init';

  function fireChange(changed) {
    if (!changed || !changed.length) return;
    // Legacy window.onDataChanged handler (static HTML tools)
    if (typeof window.onDataChanged === 'function') {
      try { window.onDataChanged(changed); }
      catch (e) { console.warn('[OpsSync] onDataChanged threw:', e); }
    }
    // DOM event — any number of React components can listen without colliding
    try {
      window.dispatchEvent(new CustomEvent('ops-sync-update', { detail: { changed: changed.slice() } }));
    } catch (e) { /* older browsers */ }
  }

  function broadcast(reportKey, newSyncedAt, via) {
    if (reportKey in last && newSyncedAt) last[reportKey] = newSyncedAt;
    if (bc) {
      var payload = { type: 'data-updated', changed: [reportKey], by: via || 'self', at: {} };
      payload.at[reportKey] = newSyncedAt || last[reportKey];
      try { bc.postMessage(payload); } catch (e) { /* ignore */ }
    }
  }

  if (bc) {
    bc.onmessage = function (e) {
      var m = e && e.data;
      if (!m || m.type !== 'data-updated' || !Array.isArray(m.changed)) return;
      if (m.at) {
        for (var k in m.at) if (m.at[k]) last[k] = m.at[k];
      }
      fireChange(m.changed);
    };
  }

  // ─── 2. Supabase Realtime (primary cross-device push) ────────────────────
  async function startRealtime() {
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      console.warn('[OpsSync] supabase-js not loaded — Realtime disabled, safety poll will handle changes.');
      realtimeStatus = 'no-sdk';
      return;
    }
    var cfg;
    try {
      var r = await fetch('/api/sync-config', { cache: 'no-store' });
      cfg = await r.json();
    } catch (e) {
      console.warn('[OpsSync] /api/sync-config failed — Realtime disabled.', e);
      realtimeStatus = 'no-config';
      return;
    }
    if (!cfg || !cfg.url || !cfg.anonKey) {
      console.warn('[OpsSync] /api/sync-config returned no credentials — Realtime disabled.');
      realtimeStatus = 'no-config';
      return;
    }

    var client;
    try {
      client = window.supabase.createClient(cfg.url, cfg.anonKey, {
        realtime: { params: { eventsPerSecond: 2 } },
      });
    } catch (e) {
      console.warn('[OpsSync] createClient failed:', e);
      realtimeStatus = 'client-err';
      return;
    }

    // One channel, both tables — one subscription event covers both pipelines
    var ch = client.channel('ops_sync_all');

    // Costing snapshots: pm, bom, pf, si
    ch.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'costing_snapshots' },
      function (payload) {
        var row = payload && payload.new;
        if (!row || !row.report || !row.synced_at) return;
        var report = String(row.report).toLowerCase();
        if (!(report in last)) return;
        if (last[report] && row.synced_at <= last[report]) return;
        last[report] = row.synced_at;
        console.log('[OpsSync] Realtime INSERT received:', report, row.synced_at);
        fireChange([report]);
        broadcast(report, row.synced_at, 'realtime');
      }
    );

    // Inventory snapshots: live stock levels per batch per warehouse
    ch.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'inventory_snapshots' },
      function (payload) {
        var row = payload && payload.new;
        if (!row || !row.synced_at) return;
        // Only fire for successful inventory syncs (ignore failed ones)
        if (row.status && String(row.status).toLowerCase() !== 'ok') return;
        if (last.inventory && row.synced_at <= last.inventory) return;
        last.inventory = row.synced_at;
        console.log('[OpsSync] Realtime INSERT received: inventory', row.synced_at);
        fireChange(['inventory']);
        broadcast('inventory', row.synced_at, 'realtime');
      }
    );

    // Reconnect logic — WebSockets drop (sleep, lock screen, flaky WiFi,
    // Supabase keepalive timeout) and supabase-js's auto-reconnect sometimes
    // misses CHANNEL_ERROR / CLOSED. Without this, a laptop that was awake
    // when the subscription dropped silently stops seeing other laptops'
    // syncs forever. Reconnect with exponential backoff on CLOSED /
    // CHANNEL_ERROR / TIMED_OUT, and also kick a reconnect when the tab
    // regains focus so a sleeping laptop catches up the moment it wakes.
    var reconnectAttempt = 0;
    var reconnectTimer   = null;
    function scheduleReconnect(reason) {
      if (reconnectTimer) return;
      reconnectAttempt++;
      var delay = Math.min(30000, 1000 * Math.pow(2, reconnectAttempt - 1));
      console.warn('[OpsSync] Reconnecting Realtime in ' + delay + 'ms (' + reason + ', attempt ' + reconnectAttempt + ')');
      reconnectTimer = setTimeout(function () {
        reconnectTimer = null;
        try { ch.unsubscribe(); } catch (e) { /* ignore */ }
        try { client.removeChannel(ch); } catch (e) { /* ignore */ }
        startRealtime();
      }, delay);
    }
    ch.subscribe(function (status) {
      realtimeStatus = status;
      if (status === 'SUBSCRIBED') {
        reconnectAttempt = 0;
        console.log('[OpsSync] Realtime subscribed — listening for costing_snapshots + inventory_snapshots INSERTs.');
      }
      else if (status === 'CHANNEL_ERROR') { console.warn('[OpsSync] Realtime channel error — reconnecting.'); scheduleReconnect('CHANNEL_ERROR'); }
      else if (status === 'TIMED_OUT')     { console.warn('[OpsSync] Realtime timed out — reconnecting.');     scheduleReconnect('TIMED_OUT'); }
      else if (status === 'CLOSED')        { console.warn('[OpsSync] Realtime channel closed — reconnecting.'); scheduleReconnect('CLOSED'); }
    });

    window.OpsSync._client  = client;
    window.OpsSync._channel = ch;
  }

  // Tab regained focus / became visible: a laptop that was asleep almost
  // certainly dropped its WebSocket. Force a resubscribe AND a safety-poll
  // pass right now so the UI catches up without waiting on the 45 s timer.
  function onWakeOrFocus() {
    if (realtimeStatus !== 'SUBSCRIBED') {
      console.log('[OpsSync] Tab active, Realtime not healthy (' + realtimeStatus + ') — rebooting subscription.');
      try { if (window.OpsSync && window.OpsSync._channel) window.OpsSync._channel.unsubscribe(); } catch (e) {}
      try { if (window.OpsSync && window.OpsSync._client  && window.OpsSync._channel) window.OpsSync._client.removeChannel(window.OpsSync._channel); } catch (e) {}
      startRealtime();
    }
    safetyPoll();
  }
  window.addEventListener('focus', onWakeOrFocus);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') onWakeOrFocus();
  });

  // ─── 3. Safety poll (every 5 min — catches missed Realtime drops) ────────
  async function safetyPoll() {
    try {
      var urls = {
        pm:        '/api/product-master',
        bom:       '/api/costing/bom',
        inventory: '/api/inventory',
      };
      var keys = Object.keys(urls);
      var results = await Promise.all(keys.map(function (k) {
        return fetch(urls[k], { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .catch(function () { return null; });
      }));
      var changed = [];
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i], j = results[i];
        var at = j && j.synced_at;
        if (!at) continue;
        if (last[k] === null) { last[k] = at; continue; }
        if (at !== last[k]) {
          last[k] = at;
          changed.push(k);
        }
      }
      if (changed.length) {
        console.log('[OpsSync] Safety poll caught change Realtime missed:', changed);
        for (var i2 = 0; i2 < changed.length; i2++) broadcast(changed[i2], last[changed[i2]], 'safety-poll');
        fireChange(changed);
      }
    } catch (e) { /* fail silent */ }
  }

  // ─── Public API ──────────────────────────────────────────────────────────
  window.OpsSync = {
    broadcast: function (reportKey, newSyncedAt) {
      broadcast(reportKey, newSyncedAt, 'self');
    },
    _state: function () {
      return { last: Object.assign({}, last), realtime: realtimeStatus };
    },
    _client:  null,
    _channel: null,
  };

  startRealtime();
  setTimeout(safetyPoll, FIRST_POLL_MS);
  setInterval(safetyPoll, SAFETY_POLL_MS);
})();
