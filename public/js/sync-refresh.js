/*  Ops Dashboard — cross-tool, cross-tab sync notifier.
 *
 *  Every tool that displays PACT-backed data (Outlet Consumption, Outlet
 *  Dispatch, Costing Dashboard, Main Dashboard) includes this file once:
 *
 *    <script src="/js/sync-refresh.js"></script>
 *
 *  …and defines a page-level handler for refreshes:
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
 *  Behaviour:
 *   1.  Polls /api/product-master and /api/costing/bom every POLL_MS to see if
 *       their synced_at advanced. If yes, calls window.onDataChanged([...])
 *       so the tool refreshes AND broadcasts to other tabs.
 *   2.  Listens on a BroadcastChannel for near-instant cross-tab reloads —
 *       so when any tool in the same browser profile finishes a sync, every
 *       other open tool catches it without waiting for the next poll.
 *   3.  Fails silent on older browsers (no BroadcastChannel) — polling still
 *       works. Fails silent on fetch errors (keeps retrying next tick).
 */
(function () {
  'use strict';

  var CHANNEL  = 'ops-dashboard-sync-v1';
  var POLL_MS  = 60 * 1000;      // every 60 s
  var FIRST_MS = 10 * 1000;      // first check 10 s after load (let page settle)

  var bc = null;
  try { bc = new BroadcastChannel(CHANNEL); } catch (e) { /* older browsers */ }

  // Last-known synced_at per report. Initialized on first successful poll
  // so we don't call onDataChanged() when the page itself just loaded fresh
  // data — only on genuine subsequent advances.
  var last = { pm: null, bom: null, pf: null, si: null };

  function fireChange(changed) {
    if (!changed.length) return;
    if (typeof window.onDataChanged === 'function') {
      try { window.onDataChanged(changed); }
      catch (e) { console.warn('[OpsSync] onDataChanged threw:', e); }
    }
  }

  async function pollOnce() {
    try {
      var urls = {
        pm:  '/api/product-master',
        bom: '/api/costing/bom',
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
        if (last[k] === null) { last[k] = at; continue; }   // first known — baseline only
        if (at !== last[k]) {
          last[k] = at;
          changed.push(k);
        }
      }
      if (changed.length) {
        if (bc) bc.postMessage({ type: 'data-updated', changed: changed, by: 'poll', at: last });
        fireChange(changed);
      }
    } catch (e) { /* fail silent */ }
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

  // Exposed for tools to call right after their own Sync button succeeds, so
  // other open tabs refresh immediately instead of waiting up to POLL_MS.
  window.OpsSync = {
    broadcast: function (reportKey, newSyncedAt) {
      if (reportKey in last && newSyncedAt) last[reportKey] = newSyncedAt;
      if (bc) {
        var payload = { type: 'data-updated', changed: [reportKey], by: 'self', at: {} };
        payload.at[reportKey] = newSyncedAt || last[reportKey];
        bc.postMessage(payload);
      }
    },
    // Debug helper: current known timestamps
    _state: function () { return Object.assign({}, last); },
  };

  // Kick off polling after a short delay so the page's own data load wins.
  setTimeout(pollOnce, FIRST_MS);
  setInterval(pollOnce, POLL_MS);
})();
