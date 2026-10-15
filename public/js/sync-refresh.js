/*  Ops Dashboard — cross-tool, cross-tab, cross-device sync notifier (REAL-TIME).
 *
 *  Every tool that displays PACT-backed data (Outlet Consumption, Outlet
 *  Dispatch, Costing Dashboard, Main Dashboard) includes TWO scripts:
 *
 *    <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *    <script src="/js/sync-refresh.js"></script>
 *
 *  …defines a page-level handler for refreshes:
 *
 *    window.onDataChanged = function(changedReports) {
 *      // changedReports is a subset of ['pm','bom','pf','si']
 *      // Re-fetch and re-render whichever your tool shows.
 *    };
 *
 *  …and OPTIONALLY calls, right after its own ⚡ Sync button completes:
 *
 *    window.OpsSync.broadcast('pm', newSyncedAt);
 *
 *  Behaviour (three layers, defence in depth):
 *   1. SUPABASE REALTIME (primary) — opens a WebSocket to Supabase and
 *      subscribes to INSERT events on public.costing_snapshots. The moment the
 *      PACT worker writes a new row, every open tool receives a push in
 *      roughly 200–500 ms, regardless of browser or device.
 *   2. BROADCASTCHANNEL (same-browser latency) — when any tool in this browser
 *      profile fires its own ⚡ Sync button or receives a Realtime push, it
 *      posts to a BroadcastChannel so sibling tabs refresh instantly (<50 ms)
 *      without each one having to react to Realtime independently.
 *   3. SAFETY POLL (last resort) — every 5 minutes the module checks
 *      /api/product-master and /api/costing/bom for a synced_at advance it
 *      somehow missed. Catches cases where the WebSocket silently dropped.
 *
 *  All three layers converge on the same window.onDataChanged() hook, so the
 *  tool code doesn't care which path a change arrived on.
 *
 *  Fail-silent: if supabase-js didn't load, Realtime is skipped and the safety
 *  poll + BroadcastChannel still work. If the browser is ancient (no
 *  BroadcastChannel), it's skipped too. If /api/sync-config returns an error,
 *  Realtime is skipped. The tool never breaks because of this module.
 */
(function () {
  'use strict';

  var CHANNEL        = 'ops-dashboard-sync-v1';
  var SAFETY_POLL_MS = 5 * 60 * 1000;   // 5 min safety net (down from the old 60 s)
  var FIRST_POLL_MS  = 15 * 1000;        // first safety check 15 s after load

  // ─── 1. BroadcastChannel (same-browser instant) ──────────────────────────
  var bc = null;
  try { bc = new BroadcastChannel(CHANNEL); } catch (e) { /* older browsers */ }

  // Last-known synced_at per report. First observation sets the baseline so
  // we don't fire onDataChanged() for the page's own initial load.
  var last = { pm: null, bom: null, pf: null, si: null };
  var realtimeStatus = 'init';   // for debugging

  function fireChange(changed) {
    if (!changed || !changed.length) return;
    if (typeof window.onDataChanged === 'function') {
      try { window.onDataChanged(changed); }
      catch (e) { console.warn('[OpsSync] onDataChanged threw:', e); }
    }
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
      // Trust the sender's timestamps so we don't re-fire for our own broadcast
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

    var ch = client
      .channel('ops_sync_costing_snapshots')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'costing_snapshots' },
        function (payload) {
          var row = payload && payload.new;
          if (!row || !row.report || !row.synced_at) return;
          var report = String(row.report).toLowerCase();
          if (!(report in last)) return;
          // Ignore stale rows (older than what we already know, which can
          // happen if the publication replays on reconnect).
          if (last[report] && row.synced_at <= last[report]) return;
          last[report] = row.synced_at;
          console.log('[OpsSync] Realtime INSERT received:', report, row.synced_at);
          fireChange([report]);
          broadcast(report, row.synced_at, 'realtime');
        }
      )
      .subscribe(function (status) {
        realtimeStatus = status;
        if (status === 'SUBSCRIBED') console.log('[OpsSync] Realtime subscribed — listening for costing_snapshots INSERTs.');
        else if (status === 'CHANNEL_ERROR') console.warn('[OpsSync] Realtime channel error — safety poll will cover.');
        else if (status === 'TIMED_OUT')     console.warn('[OpsSync] Realtime timed out — reconnecting…');
        else if (status === 'CLOSED')         console.warn('[OpsSync] Realtime channel closed.');
      });

    // Expose for debug
    window.OpsSync._client  = client;
    window.OpsSync._channel = ch;
  }

  // ─── 3. Safety poll (every 5 min — catches missed Realtime drops) ────────
  async function safetyPoll() {
    try {
      var urls = { pm: '/api/product-master', bom: '/api/costing/bom' };
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
        if (last[k] === null) { last[k] = at; continue; }   // first known — baseline only
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

  // ─── Public API (unchanged from v1 so no tool needs to update) ───────────
  window.OpsSync = {
    broadcast: function (reportKey, newSyncedAt) {
      broadcast(reportKey, newSyncedAt, 'self');
    },
    _state: function () {
      return { last: Object.assign({}, last), realtime: realtimeStatus };
    },
    _client:  null,  // populated after Realtime connects
    _channel: null,
  };

  // Kick off — Realtime first, then safety poll on a long interval.
  startRealtime();
  setTimeout(safetyPoll, FIRST_POLL_MS);
  setInterval(safetyPoll, SAFETY_POLL_MS);
})();
