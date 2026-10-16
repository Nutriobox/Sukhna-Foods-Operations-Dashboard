/*  Sukhna Ops — simple password gate for the Factory Costing Dashboard
 *  and Outlet Consumption tools. Include this script FIRST in <head>:
 *
 *     <script src="/js/password-gate.js"></script>
 *
 *  Behaviour:
 *   - Hides the page immediately on load (document.documentElement
 *     visibility:hidden) so content doesn't flash before unlock.
 *   - Checks localStorage['sukhna-ops-unlocked'] — if truthy, reveals
 *     the page and does nothing else.
 *   - Otherwise injects a full-screen password overlay. On submit of
 *     the correct password it sets the flag and reveals the page.
 *   - Password is intentionally client-side (team dashboard, not a
 *     public-facing app). Not meant to be fort-knox — just to keep
 *     casual eyes out. If you need stronger auth later, move to a
 *     Next.js middleware with a server-set cookie.
 */
(function () {
  'use strict';
  var UNLOCK_KEY = 'sukhna-ops-unlocked';
  var PASSWORD   = '1122';   // if changed, every user re-enters

  // Hide the page before anything else paints
  try { document.documentElement.style.visibility = 'hidden'; } catch (e) {}

  function reveal() {
    try { document.documentElement.style.visibility = ''; } catch (e) {}
  }

  function alreadyUnlocked() {
    try { return localStorage.getItem(UNLOCK_KEY) === '1'; } catch (e) { return false; }
  }

  function setUnlocked() {
    try { localStorage.setItem(UNLOCK_KEY, '1'); } catch (e) {}
  }

  function showGate() {
    // Build overlay once body exists
    function build() {
      var ov = document.createElement('div');
      ov.id = '__ops_pw_gate__';
      ov.style.cssText = [
        'position:fixed','inset:0','z-index:2147483647',
        'background:linear-gradient(135deg,#1e293b 0%,#0f172a 100%)',
        'display:flex','align-items:center','justify-content:center',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',
      ].join(';');
      ov.innerHTML = ''
        + '<div style="background:#fff;border-radius:14px;padding:34px 36px;'
        +            'box-shadow:0 20px 60px rgba(0,0,0,.4);width:360px;max-width:92vw">'
        +   '<div style="font-size:22px;font-weight:700;color:#0f172a;margin-bottom:4px">🔒 Sukhna Ops Dashboard</div>'
        +   '<div style="font-size:13px;color:#64748b;margin-bottom:20px">Enter password to continue</div>'
        +   '<form id="__ops_pw_form__" autocomplete="off">'
        +     '<input id="__ops_pw_input__" type="password" placeholder="Password" autofocus '
        +       'style="width:100%;padding:11px 14px;font-size:15px;border:1px solid #cbd5e1;'
        +              'border-radius:8px;outline:none;box-sizing:border-box;letter-spacing:2px"/>'
        +     '<div id="__ops_pw_err__" style="color:#dc2626;font-size:12.5px;margin-top:8px;'
        +           'min-height:16px;display:none">Wrong password — try again.</div>'
        +     '<button type="submit" style="margin-top:14px;width:100%;padding:11px;background:#4f46e5;'
        +             'color:#fff;border:0;border-radius:8px;font-weight:600;font-size:15px;cursor:pointer">'
        +       'Unlock</button>'
        +   '</form>'
        +   '<div style="margin-top:16px;font-size:11.5px;color:#94a3b8;text-align:center">'
        +     'Access limited to Sukhna Foods / Allsure Services team.</div>'
        + '</div>';
      document.body.appendChild(ov);
      reveal();   // show the overlay (body was hidden)
      var inp = document.getElementById('__ops_pw_input__');
      var err = document.getElementById('__ops_pw_err__');
      var frm = document.getElementById('__ops_pw_form__');
      frm.addEventListener('submit', function (e) {
        e.preventDefault();
        if (inp.value === PASSWORD) {
          setUnlocked();
          ov.remove();
        } else {
          err.style.display = 'block';
          inp.value = '';
          inp.focus();
        }
      });
    }
    if (document.body) build();
    else document.addEventListener('DOMContentLoaded', build);
  }

  if (alreadyUnlocked()) {
    reveal();
  } else {
    showGate();
  }
})();
