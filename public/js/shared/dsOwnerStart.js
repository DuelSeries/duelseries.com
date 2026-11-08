// The owner's Start now inside an event's waiting screen (Owen 2026-11-08: "a little Start now button" while he is in
// the event, just for him, so he does not have to go to Control). Used by the battle royale on /sl
// (public/js/slx/slxBr.js), its old engine (public/js/game.js) and the Swim Race (public/js/swim/swimEventMain.js).
// It sends the same action as Control's Start now to the same route (/api/owner/do), and the server checks who is
// asking on every press (server/index.js ownerAuthOf: the owner session cookie, then a signature from an owner wallet,
// then a Privy token, against the owner list each time). Nothing here decides anything: a forged answer below draws a
// button whose press the server refuses.
//
// Who sees the button: a device signed into Control (its session cookie, asked at /api/owner/session), or a lobby
// wallet the server says is the owner's (/api/br/owner). Anyone else: no button, and nothing on the page changes.
// The lobby's wallet can sign in after the game loads (Privy is slower on a phone), so its duelwallet:change asks again.
//
// DSOwnerStart.watch(onChange)   onChange(true|false) each time the answer changes (starts false, nothing called)
//                                -> { stop(), owner() }
// DSOwnerStart.start(action, args) -> Promise<{ ok, status, text }>: the cookie first (no prompt), then the lobby's
//                                wallet signs it over the duel:signaction bridge (public/js/v2/play.js) with the
//                                Privy token alongside; text is the server's note, or why it was refused.
(function (root) {
  'use strict';
  if (!root || root.DSOwnerStart) return;

  var SIGN_MS = 15000;
  var lastSession = false; // the last session check said this device is signed into Control

  function lobby() {
    try {
      var p = root.parent;
      return p && p !== root ? p : null;
    } catch (_) {
      return null;
    }
  }
  // The lobby's signed-in wallet (window.duelWallet, same origin), never localStorage: the wallet widget writes a
  // token there for every signed-in player.
  function lobbyWallet() {
    try {
      var p = lobby();
      var w = p && p.duelWallet;
      return w && w.authenticated === true && typeof w.address === 'string' ? w.address : '';
    } catch (_) {
      return '';
    }
  }

  function sessionSignedIn() {
    if (typeof root.fetch !== 'function') return Promise.resolve(false);
    return root.fetch('/api/owner/session', { credentials: 'same-origin', cache: 'no-store', headers: { 'X-DS-Owner': '1' } })
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .then(function (j) { lastSession = !!(j && j.signedIn === true); return lastSession; })
      .catch(function () { return false; });
  }
  // Only a real answer counts: a refusal (the limiter's 429) or no answer throws, so the wallet is asked again later.
  function walletIsOwner(w) {
    return root.fetch('/api/br/owner', { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wallet: w }) })
      .then(function (r) {
        if (!r || !r.ok) throw new Error('owner check ' + (r && r.status));
        return r.json();
      })
      .then(function (j) { return !!(j && j.isOwner === true); });
  }

  function watch(onChange) {
    var via = null; // 'session' | 'wallet' | null
    var asked = '';
    var stopped = false;
    function set(v) {
      if (stopped || v === via) return;
      via = v;
      try { onChange(!!via); } catch (_) { /* the page's own trouble */ }
    }
    function checkWallet() {
      if (stopped || via === 'session') return;
      var w = lobbyWallet();
      // signed out, or another wallet signed in: the wallet's answer goes (a session's stays, it is the device's)
      if (via === 'wallet' && w !== asked) set(null);
      if (w !== asked) asked = '';
      if (!w || w === asked || typeof root.fetch !== 'function') return;
      asked = w;
      walletIsOwner(w).then(function (ok) {
        if (asked === w && lobbyWallet() === w) set(ok ? 'wallet' : null);
      }).catch(function () {
        if (asked === w) asked = '';
      });
    }
    sessionSignedIn().then(function (ok) {
      if (ok) set('session');
      else checkWallet();
    });
    var p = lobby();
    try {
      if (p && typeof p.addEventListener === 'function') p.addEventListener('duelwallet:change', checkWallet);
    } catch (_) { /* a parent on another origin */ }
    return {
      owner: function () { return !!via; },
      stop: function () {
        stopped = true;
        try { if (p) p.removeEventListener('duelwallet:change', checkWallet); } catch (_) { /* gone */ }
      },
    };
  }

  // The lobby's wallet signs (the frame cannot: the widget lives out there). null when it cannot or will not.
  var signSeq = 0;
  function sign(action, args) {
    return new Promise(function (resolve) {
      var p = lobby();
      var origin = root.location && root.location.origin;
      if (!p || !origin || origin === 'null' || typeof root.addEventListener !== 'function') {
        resolve(null);
        return;
      }
      var id = 'own' + (++signSeq);
      var done = false;
      function finish(v) {
        if (done) return;
        done = true;
        root.removeEventListener('message', onMsg);
        resolve(v);
      }
      function onMsg(e) {
        if (!e || e.source !== p || e.origin !== origin) return;
        var d = e.data;
        if (!d || d.id !== id) return;
        if (d.type === 'duel:signaction:done') finish(d.proof && typeof d.proof === 'object' ? d.proof : null);
        else if (d.type === 'duel:signaction:error') finish(null);
      }
      root.addEventListener('message', onMsg);
      try {
        p.postMessage({ type: 'duel:signaction', id: id, action: action, args: args || {} }, origin);
      } catch (_) {
        finish(null);
        return;
      }
      root.setTimeout(function () { finish(null); }, SIGN_MS);
    });
  }
  // The lobby's Privy tokens (wallet-widget duelWalletToken), or none.
  function tokens() {
    return new Promise(function (resolve) {
      var p = lobby();
      var get = null;
      try { get = p && typeof p.duelWalletToken === 'function' ? p.duelWalletToken : null; } catch (_) { get = null; }
      if (!get) { resolve({}); return; }
      var t = root.setTimeout(function () { resolve({}); }, 5000);
      Promise.resolve().then(function () { return get(); }).then(function (v) {
        root.clearTimeout(t);
        resolve(v && typeof v === 'object' ? v : {});
      }, function () {
        root.clearTimeout(t);
        resolve({});
      });
    });
  }

  function post(body, extra) {
    var headers = { 'content-type': 'application/json', 'X-DS-Owner': '1' };
    for (var k in extra || {}) headers[k] = extra[k];
    return root.fetch('/api/owner/do', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: headers,
      body: JSON.stringify(body) });
  }
  function answer(r) {
    return r.json().catch(function () { return {}; }).then(function (j) {
      j = j || {};
      return { ok: !!r.ok, status: r.status, text: r.ok ? (j.note || 'Started') : (j.error || 'Refused') };
    });
  }

  function start(action, args) {
    args = args || {};
    if (typeof root.fetch !== 'function') return Promise.resolve({ ok: false, status: 0, text: 'Could not reach the server.' });
    function signed() {
      return Promise.all([sign(action, args), tokens()]).then(function (got) {
        var proof = got[0];
        var t = got[1] || {};
        var h = {};
        if (typeof t.access === 'string' && t.access) h.Authorization = 'Bearer ' + t.access;
        if (typeof t.identity === 'string' && t.identity) h['privy-id-token'] = t.identity;
        if (!proof && !h.Authorization && !h['privy-id-token']) return { ok: false, status: 0, text: 'The wallet did not sign.' };
        return post(proof || { action: action, args: args }, h).then(answer);
      });
    }
    // 1. the session cookie, when this device has one: nothing to sign, no prompt
    var first = lastSession
      ? post({ action: action, args: args }).then(function (r) {
        if (r.status === 401 || r.status === 403) { lastSession = false; return signed(); } // it lapsed: sign instead
        return answer(r);
      })
      : signed();
    return first.catch(function () { return { ok: false, status: 0, text: 'Could not reach the server.' }; });
  }

  root.DSOwnerStart = { watch: watch, start: start };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.DSOwnerStart;
})(typeof window !== 'undefined' ? window : this);
