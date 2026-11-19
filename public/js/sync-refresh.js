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
  //
  // 2026-11-19 (Supabase "Realtime Connection Count Exceeded": peak 820 vs the
  // Pro plan's 500, grace period ends 06 Dec): the old reconnect path called
  // startRealtime() again, which made a NEW supabase client (= a new
  // WebSocket) every time without closing the old one. Worse, its own
  // ch.unsubscribe() fired CLOSED on the old channel, which scheduled yet
  // another reconnect, so one open tab kept stacking sockets all day.
  // Now: ONE client per page, created once and reused; every (re)subscribe
  // first tears down the previous channel; callbacks from a superseded
  // channel are ignored via a generation counter; and the socket is fully
  // disconnected while the tab is hidden (the safety poll + focus catch-up
  // cover that gap), so background tabs on outlet PCs hold no connection.
  var rtClient = null;
  var rtChannel = null;
  var rtGen = 0;
  var rtCfg = null;
  var reconnectAttempt = 0;
  var reconnectTimer = null;
  var HIDDEN_DISCONNECT_MS = 2 * 60 * 1000;
  var hiddenTimer = null;

  async function getClient() {
    if (rtClient) return rtClient;
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      console.warn('[OpsSync] supabase-js not loaded — Realtime disabled, safety poll will handle changes.');
      realtimeStatus = 'no-sdk';
      return null;
    }
    if (!rtCfg) {
      try {
        var r = await fetch('/api/sync-config', { cache: 'no-store' });
        rtCfg = await r.json();
      } catch (e) {
        console.warn('[OpsSync] /api/sync-config failed — Realtime disabled.', e);
        realtimeStatus = 'no-config';
        return null;
      }
    }
    if (!rtCfg || !rtCfg.url || !rtCfg.anonKey) {
      console.warn('[OpsSync] /api/sync-config returned no credentials — Realtime disabled.');
      realtimeStatus = 'no-config';
      rtCfg = null;
      return null;
    }
    if (rtClient) return rtClient;            // another call won the race while we awaited
    try {
      rtClient = window.supabase.createClient(rtCfg.url, rtCfg.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        realtime: { params: { eventsPerSecond: 2 } },
      });
    } catch (e) {
      console.warn('[OpsSync] createClient failed:', e);
      realtimeStatus = 'client-err';
      return null;
    }
    window.OpsSync._client = rtClient;
    return rtClient;
  }

  function teardownChannel() {
    rtGen++;                                   // any callback from the old channel is now stale
    var old = rtChannel;
    rtChannel = null;
    window.OpsSync._channel = null;
    if (old && rtClient) { try { rtClient.removeChannel(old); } catch (e) { /* ignore */ } }
  }

  function stopRealtime(reason) {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    teardownChannel();
    if (rtClient) {
      try { rtClient.removeAllChannels(); } catch (e) { /* ignore */ }
      try { rtClient.realtime.disconnect(); } catch (e) { /* ignore */ }
    }
    realtimeStatus = 'paused';
    if (reason) console.log('[OpsSync] Realtime paused (' + reason + ').');
  }

  function scheduleReconnect(reason) {
    if (reconnectTimer || document.visibilityState === 'hidden') return;
    reconnectAttempt++;
    var delay = Math.min(60000, 1000 * Math.pow(2, reconnectAttempt - 1));
    console.warn('[OpsSync] Reconnecting Realtime in ' + delay + 'ms (' + reason + ', attempt ' + reconnectAttempt + ')');
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      startRealtime();
    }, delay);
  }

  async function startRealtime() {
    var client = await getClient();
    if (!client) return;
    teardownChannel();
    var gen = rtGen;

    // One channel, both tables — one subscription event covers both pipelines
    var ch = client.channel('ops_sync_all');

    // Costing snapshots: pm, bom, pf, si
    ch.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'costing_snapshots' },
      function (payload) {
        if (gen !== rtGen) return;
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
        if (gen !== rtGen) return;
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

    rtChannel = ch;
    window.OpsSync._channel = ch;
    ch.subscribe(function (status) {
      if (gen !== rtGen) return;               // a channel we already replaced or closed ourselves
      realtimeStatus = status;
      if (status === 'SUBSCRIBED') {
        reconnectAttempt = 0;
        console.log('[OpsSync] Realtime subscribed — listening for costing_snapshots + inventory_snapshots INSERTs.');
      }
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        console.warn('[OpsSync] Realtime ' + status + ' — reconnecting.');
        scheduleReconnect(status);
      }
    });
  }

  // Tab regained focus / became visible: a laptop that was asleep almost
  // certainly dropped its WebSocket. Resubscribe (on the SAME client) and
  // run a safety-poll pass so the UI catches up without waiting on the timer.
  //
  // 2026-10-30 (traffic-flood guard): earlier revision called safetyPoll on
  // EVERY focus / visibilitychange, which chattered under rapid alt-tab
  // and Chrome's power-saver visibility ticks — contributing to the 1.5M-
  // requests-per-day spike Satvik saw at Vercel's firewall. We cap the
  // extra safety-poll to one per 30 s, and reboot the subscription only
  // when it's been >15 s since we last tried.
  var lastWakeSafetyMs    = 0;
  var lastSubscribeRebootMs = 0;
  function onWakeOrFocus() {
    if (hiddenTimer) { clearTimeout(hiddenTimer); hiddenTimer = null; }
    var now = Date.now();
    if (realtimeStatus !== 'SUBSCRIBED' && !reconnectTimer && (now - lastSubscribeRebootMs) > 15000) {
      lastSubscribeRebootMs = now;
      console.log('[OpsSync] Tab active, Realtime not healthy (' + realtimeStatus + ') — resubscribing.');
      reconnectAttempt = 0;
      startRealtime();
    }
    if ((now - lastWakeSafetyMs) > 30000) {
      lastWakeSafetyMs = now;
      safetyPoll();
    }
  }
  window.addEventListener('focus', onWakeOrFocus);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') { onWakeOrFocus(); return; }
    if (hiddenTimer) clearTimeout(hiddenTimer);
    hiddenTimer = setTimeout(function () {
      hiddenTimer = null;
      if (document.visibilityState === 'hidden') stopRealtime('tab hidden');
    }, HIDDEN_DISCONNECT_MS);
  });
  window.addEventListener('pagehide', function () { stopRealtime(); });

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
