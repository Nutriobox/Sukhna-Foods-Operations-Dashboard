/*  Sukhna Ops — access gate for the dashboard tools.
 *
 *  Flag-aware (audit S1/S4, 2026-11-03):
 *   - Reads /api/sync-config. If authEnforced is FALSE, behaves exactly as
 *     before: a client-side 1122 overlay (no change until you flip the flag).
 *   - If authEnforced is TRUE, requires a real Supabase Auth login (email +
 *     password). The access token is stored and attached to every /api call
 *     (Authorization: Bearer + sb-access-token cookie), and the server verifies
 *     it on each protected route.
 *
 *  Enable server auth by setting DASHBOARD_AUTH_ENFORCED=true (and creating the
 *  admin login in Supabase Auth). Until then this file is a no-op change.
 */
(function () {
  'use strict';
  var LEGACY_PW = '1122';
  var TOKEN_KEY = 'sb-access-token';
  var REFRESH_KEY = 'sb-refresh-token';
  var cfg = { url: '', anonKey: '', authEnforced: false };

  try { document.documentElement.style.visibility = 'hidden'; } catch (e) {}
  function reveal() { try { document.documentElement.style.visibility = ''; } catch (e) {} }

  // ---- token helpers ----
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setSession(access, refresh) {
    try {
      localStorage.setItem(TOKEN_KEY, access || '');
      if (refresh) localStorage.setItem(REFRESH_KEY, refresh);
    } catch (e) {}
    try { document.cookie = TOKEN_KEY + '=' + encodeURIComponent(access || '') + '; path=/; SameSite=Lax; max-age=43200'; } catch (e) {}
  }
  function clearSession() {
    try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(REFRESH_KEY); } catch (e) {}
    try { document.cookie = TOKEN_KEY + '=; path=/; max-age=0'; } catch (e) {}
  }

  // ---- patch fetch so every same-origin /api call carries the token ----
  var _fetch = window.fetch.bind(window);
  var _refreshing = null;
  function sameOriginApi(input) {
    try {
      var u = new URL((typeof input === 'string') ? input : input.url, location.href);
      return u.origin === location.origin && u.pathname.indexOf('/api/') === 0;
    } catch (e) { return false; }
  }
  async function refreshToken() {
    var rt; try { rt = localStorage.getItem(REFRESH_KEY); } catch (e) { rt = null; }
    if (!rt || !cfg.url || !cfg.anonKey) return false;
    try {
      var r = await _fetch(cfg.url.replace(/\/$/, '') + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: { 'apikey': cfg.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: rt }),
      });
      if (!r.ok) return false;
      var j = await r.json();
      if (j && j.access_token) { setSession(j.access_token, j.refresh_token || rt); return true; }
    } catch (e) {}
    return false;
  }
  window.fetch = async function (input, init) {
    if (!sameOriginApi(input)) return _fetch(input, init);
    init = init || {};
    var tok = getToken();
    if (tok) {
      var h = new Headers((init && init.headers) || (typeof input !== 'string' && input.headers) || {});
      if (!h.has('Authorization')) h.set('Authorization', 'Bearer ' + tok);
      init = Object.assign({}, init, { headers: h });
    }
    var res = await _fetch(input, init);
    // One transparent refresh-and-retry on 401 when auth is enforced.
    if (res.status === 401 && cfg.authEnforced && getToken()) {
      if (!_refreshing) _refreshing = refreshToken().finally(function () { _refreshing = null; });
      var ok = await _refreshing;
      if (ok) {
        var h2 = new Headers((init && init.headers) || {});
        h2.set('Authorization', 'Bearer ' + getToken());
        return _fetch(input, Object.assign({}, init, { headers: h2 }));
      }
      clearSession();
      showLogin('Your session expired. Please sign in again.');
    }
    return res;
  };

  // ---- overlays ----
  function overlayShell(innerHtml) {
    var ov = document.createElement('div');
    ov.id = '__ops_pw_gate__';
    ov.style.cssText = ['position:fixed', 'inset:0', 'z-index:2147483647',
      'background:linear-gradient(135deg,#1e293b 0%,#0f172a 100%)', 'display:flex',
      'align-items:center', 'justify-content:center',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif'].join(';');
    ov.innerHTML = '<div style="background:#fff;border-radius:14px;padding:34px 36px;'
      + 'box-shadow:0 20px 60px rgba(0,0,0,.4);width:360px;max-width:92vw">' + innerHtml + '</div>';
    return ov;
  }

  function showLegacyGate() {
    function build() {
      var ov = overlayShell(''
        + '<div style="font-size:22px;font-weight:700;color:#0f172a;margin-bottom:4px">🔒 Sukhna Ops Dashboard</div>'
        + '<div style="font-size:13px;color:#64748b;margin-bottom:20px">Enter password to continue</div>'
        + '<form id="__ops_pw_form__" autocomplete="off" spellcheck="false">'
        + '<input type="text" name="username" autocomplete="username" style="display:none"/>'
        + '<input id="__ops_pw_input__" type="password" placeholder="Password" autofocus '
        + 'autocomplete="new-password" data-lpignore="true" data-form-type="other" '
        + 'name="sukhna_ops_pw_' + Math.random().toString(36).slice(2) + '" '
        + 'style="width:100%;padding:11px 14px;font-size:15px;border:1px solid #cbd5e1;'
        + 'border-radius:8px;outline:none;box-sizing:border-box;letter-spacing:2px"/>'
        + '<div id="__ops_pw_err__" style="color:#dc2626;font-size:12.5px;margin-top:8px;min-height:16px;display:none">Wrong password — try again.</div>'
        + '<button type="submit" style="margin-top:14px;width:100%;padding:11px;background:#4f46e5;color:#fff;border:0;border-radius:8px;font-weight:600;font-size:15px;cursor:pointer">Unlock</button>'
        + '</form>'
        + '<div style="margin-top:16px;font-size:11.5px;color:#94a3b8;text-align:center">Access limited to Sukhna Foods / Allsure Services team.</div>');
      document.body.appendChild(ov); reveal();
      var inp = document.getElementById('__ops_pw_input__');
      var err = document.getElementById('__ops_pw_err__');
      var frm = document.getElementById('__ops_pw_form__');
      setTimeout(function () { inp.value = ''; inp.focus(); }, 50);
      setTimeout(function () { inp.value = ''; inp.focus(); }, 300);
      frm.addEventListener('submit', function (e) {
        e.preventDefault();
        if (inp.value === LEGACY_PW) { ov.remove(); }
        else { err.style.display = 'block'; inp.value = ''; inp.focus(); }
      });
    }
    if (document.body) build(); else document.addEventListener('DOMContentLoaded', build);
  }

  function showLogin(msg) {
    function build() {
      var existing = document.getElementById('__ops_pw_gate__'); if (existing) existing.remove();
      var ov = overlayShell(''
        + '<div style="font-size:22px;font-weight:700;color:#0f172a;margin-bottom:4px">🔒 Sukhna Ops Dashboard</div>'
        + '<div style="font-size:13px;color:#64748b;margin-bottom:18px">Sign in to continue</div>'
        + '<form id="__ops_login_form__" autocomplete="on" spellcheck="false">'
        + '<input id="__ops_email__" type="email" placeholder="Email" autocomplete="username" '
        + 'style="width:100%;padding:11px 14px;font-size:15px;border:1px solid #cbd5e1;border-radius:8px;outline:none;box-sizing:border-box;margin-bottom:10px"/>'
        + '<input id="__ops_pass__" type="password" placeholder="Password" autocomplete="current-password" '
        + 'style="width:100%;padding:11px 14px;font-size:15px;border:1px solid #cbd5e1;border-radius:8px;outline:none;box-sizing:border-box"/>'
        + '<div id="__ops_login_err__" style="color:#dc2626;font-size:12.5px;margin-top:8px;min-height:16px;display:none"></div>'
        + '<button type="submit" id="__ops_login_btn__" style="margin-top:14px;width:100%;padding:11px;background:#4f46e5;color:#fff;border:0;border-radius:8px;font-weight:600;font-size:15px;cursor:pointer">Sign in</button>'
        + '</form>'
        + '<div style="margin-top:16px;font-size:11.5px;color:#94a3b8;text-align:center">Access limited to Sukhna Foods / Allsure Services team.</div>');
      document.body.appendChild(ov); reveal();
      var email = document.getElementById('__ops_email__');
      var pass = document.getElementById('__ops_pass__');
      var err = document.getElementById('__ops_login_err__');
      var btn = document.getElementById('__ops_login_btn__');
      var frm = document.getElementById('__ops_login_form__');
      if (msg) { err.textContent = msg; err.style.display = 'block'; }
      setTimeout(function () { email.focus(); }, 50);
      frm.addEventListener('submit', async function (e) {
        e.preventDefault();
        err.style.display = 'none'; btn.disabled = true; btn.textContent = 'Signing in…';
        try {
          var r = await _fetch(cfg.url.replace(/\/$/, '') + '/auth/v1/token?grant_type=password', {
            method: 'POST',
            headers: { 'apikey': cfg.anonKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email.value.trim(), password: pass.value }),
          });
          var j = await r.json();
          if (!r.ok || !j.access_token) throw new Error((j && (j.error_description || j.msg || j.error)) || 'Sign-in failed');
          setSession(j.access_token, j.refresh_token);
          location.reload();
        } catch (ex) {
          err.textContent = (ex && ex.message) || 'Sign-in failed'; err.style.display = 'block';
          btn.disabled = false; btn.textContent = 'Sign in';
        }
      });
    }
    if (document.body) build(); else document.addEventListener('DOMContentLoaded', build);
  }

  // ---- boot: learn the flag, then choose the gate ----
  _fetch('/api/sync-config', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      cfg.url = j.url || ''; cfg.anonKey = j.anonKey || ''; cfg.authEnforced = j.authEnforced === true;
      if (!cfg.authEnforced) { showLegacyGate(); return; }
      if (getToken()) { setSession(getToken(), null); reveal(); }   // trust token; server 401 triggers refresh/login
      else { showLogin(''); }
    })
    .catch(function () { showLegacyGate(); });   // config unreachable → fail safe to legacy gate
})();
