// The one product-tracking helper (Owen 2026-10-29: "track absolutely everything", and stay organized). Every page
// that sends an event goes through here, and every event name and property is checked against the one plan in
// shared/trackPlan.js (load it first: <script src="/shared/trackPlan.js">). An event not in the plan is dropped
// with a console warning, so a game cannot invent its own spelling.
//
// One PostHog per visit: the lobby loads PostHog (public/js/posthog-init.js); a game page in the lobby's frame sends
// through the lobby's (same origin), so a visit is one person, one session and one replay, never one per frame. A
// game page opened on its own loads PostHog itself.
//
// DSTrack.event(name, props)            any planned event
// DSTrack.game(game, base) -> session   one game page's player: base { paid, stake, mode, room, region, guest,
//                                       vs_bot, engine }. Sends game_opened now, then:
//   .set(partial)                       update the base (a paid seat found out late, a room id)
//   .queue() / .unqueue(reason)         queue_joined / queue_left (duels)
//   .start(partial)                     game_started (free only: a PAID start and end come from the server)
//   .end({ result, score, amount, place, players, reason })
//                                       game_ended (free only, as above) and the FPS and ping summary (game_perf)
//   .spectate()                         spectate_started
//   .stage                              'loading' | 'queue' | 'playing' | 'end_card' | 'spectating' (read only)
//   Leaving the page while loading, queued or playing sends game_quit (and, free, game_ended 'left').
// DSTrack.watchSocket(socket)           game_disconnected / game_reconnected (dsPerfHud.js calls it for every game)
// DSTrack.sample({ fps, ping })         one FPS or ping reading (dsPerfHud.js, twice a second at most)
// DSTrack.identify(wallet)              the lobby does this by itself when the wallet signs in (duelwallet:change)
// Also, in the lobby only: first-touch source (UTMs, ad click ids, referrer, /play/<game> invites) kept on this
// device and on the person; the owner marked (is_owner) from his wallet or a device signed into Control; money that
// arrives in the wallet soon after Add funds opened sent as funded; JS errors from game frames sent as exceptions.
//
// Never throws, never blocks a frame, never sends a key, a signature, a token or a balance.
(function (root) {
  'use strict';
  if (!root || !root.document || root.DSTrack) return;
  var doc = root.document;
  var PLAN = root.DSTrackPlan || null;
  var LS = null;
  try { LS = root.localStorage; } catch (_) { LS = null; }
  function lsGet(k) { try { return LS ? LS.getItem(k) : null; } catch (_) { return null; } }
  function lsSet(k, v) { try { if (LS) LS.setItem(k, v); } catch (_) { /* private mode */ } }
  function now() { return Date.now(); }
  function warn(m) { try { if (root.console && root.console.warn) root.console.warn('[DSTrack] ' + m); } catch (_) { /* none */ } }

  /* The lobby's DSTrack when this page is in its frame (same origin), else null: this page is the host. */
  function hostOf() {
    try {
      var t = root.top;
      if (!t || t === root) return null;
      if (t.location.origin !== root.location.origin) return null;
      return t.DSTrack && t.DSTrack._host ? t.DSTrack : null;
    } catch (_) { return null; }
  }
  var host = hostOf();
  var IS_HOST = !host;

  function guessGame() {
    var p = String(root.location.pathname || '').replace(/\.html$/, '').replace(/^\//, '').split('/')[0];
    if (p === 'game') return 'slither';
    return PLAN ? PLAN.game(p) : null;
  }
  function device() {
    try { return root.matchMedia && root.matchMedia('(pointer: coarse)').matches ? 'phone' : 'pc'; } catch (_) { return 'pc'; }
  }

  // ── sending ──────────────────────────────────────────────────────────────────────────────────────────────────
  function ph() { return root.posthog && typeof root.posthog.capture === 'function' ? root.posthog : null; }
  /* Host only: hands one checked event to PostHog. A game page opened on its own loads PostHog after this file
     (below), so what it sends before then waits here (50 at most) and goes once PostHog is there. */
  var waiting = [];
  function send(name, props) {
    var p = ph();
    if (!p) { if (waiting.length < 50) waiting.push([name, props || {}]); return; }
    try { p.capture(name, props || {}); } catch (_) { /* analytics never breaks the page */ }
  }
  function flushWaiting() {
    var p = ph();
    if (!p) return;
    var w = waiting; waiting = [];
    for (var i = 0; i < w.length; i++) { try { p.capture(w[i][0], w[i][1]); } catch (_) { /* none */ } }
  }
  function event(name, props) {
    var c = PLAN ? PLAN.clean(name, props) : { ok: true, props: props || {}, dropped: [] };
    if (!c.ok) { warn('not in the tracking plan, not sent: ' + name); return false; }
    if (c.dropped.length) warn(name + ': dropped ' + c.dropped.join(', ') + ' (not in the plan for this event)');
    if (!IS_HOST) { c.props.page = 'game'; try { host._send(name, c.props); } catch (_) { /* lobby gone */ } return true; }
    var g = PLAN ? PLAN.EVENTS[name] : null;
    if (g && g.who === 'server') { warn(name + ' is sent by the server only'); return false; }
    if (hooks[name]) { try { hooks[name](c.props); } catch (_) { /* none */ } }
    send(name, c.props);
    return true;
  }

  // ── a game page's player ─────────────────────────────────────────────────────────────────────────────────────
  var current = null;          // this page's game session (one at a time)
  var perf = null;             // readings since the last summary
  function freshPerf() { return { fps: [], ping: [], disc: 0, reco: 0, hiddenMs: 0, hiddenAt: doc.hidden ? now() : 0 }; }
  perf = freshPerf();
  var MAX_SAMPLES = 1800;      // 15 minutes at two a second; past that the summary is of the first 15

  function pct(a, q) {
    if (!a.length) return undefined;
    var s = a.slice().sort(function (x, y) { return x - y; });
    return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
  }
  function avg(a) { if (!a.length) return undefined; var t = 0; for (var i = 0; i < a.length; i++) t += a[i]; return Math.round(t / a.length * 10) / 10; }
  function base(s) {
    var b = {};
    for (var k in s.base) if (Object.prototype.hasOwnProperty.call(s.base, k)) b[k] = s.base[k];
    b.game = s.game;
    return b;
  }
  function secs(ms) { return Math.round(ms / 100) / 10; }

  /* The FPS and ping summary since the last one, for the session's game (or this page's), then a fresh count. */
  function flushPerf(s, durMs) {
    var p = perf;
    perf = freshPerf();
    if (p.hiddenAt) p.hiddenMs += now() - p.hiddenAt;
    if (!p.fps.length && !p.ping.length && !p.disc) return;
    var props = s ? base(s) : { game: guessGame() };
    props.duration_s = durMs != null ? secs(durMs) : undefined;
    props.fps_avg = avg(p.fps); props.fps_p10 = pct(p.fps, 0.1); props.fps_min = p.fps.length ? Math.min.apply(null, p.fps) : undefined;
    props.ping_avg = avg(p.ping); props.ping_p50 = pct(p.ping, 0.5); props.ping_p90 = pct(p.ping, 0.9);
    props.ping_max = p.ping.length ? Math.max.apply(null, p.ping) : undefined;
    props.samples = p.fps.length + p.ping.length; props.disconnects = p.disc; props.reconnects = p.reco;
    props.hidden_s = secs(p.hiddenMs);
    event('game_perf', props);
  }

  function Session(game, b) {
    this.game = (PLAN && PLAN.game(game)) || guessGame() || String(game || '');
    this.base = {};
    this.stage = 'loading';
    this.t0 = 0; this.q0 = 0; this.page0 = now();
    this.set(b);
  }
  /* A paid seat moved money on its own (its buy-in, a refund, a payout): the lobby's funding watch must not take
     the next balance change for money the player added (watchFunds). */
  function paidMoney() {
    if (IS_HOST) markPaid(); else { try { host._paidEnded(); } catch (_) { /* none */ } }
  }
  Session.prototype.set = function (b) {
    if (b && typeof b === 'object') for (var k in b) if (Object.prototype.hasOwnProperty.call(b, k)) this.base[k] = b[k];
    if (this.base.stake != null && this.base.paid == null) this.base.paid = Number(this.base.stake) > 0;
    return this;
  };
  Session.prototype.paid = function () { return this.base.paid === true; };
  Session.prototype.queue = function () {
    this.stage = 'queue'; this.q0 = now();
    if (this.paid()) paidMoney();
    event('queue_joined', base(this));
    return this;
  };
  Session.prototype.unqueue = function (reason) {
    if (this.stage !== 'queue') return this;
    var p = base(this);
    p.wait_s = secs(now() - this.q0); p.reason = reason || undefined;
    this.stage = 'loading';
    if (this.paid()) paidMoney();   // a paid queue left is a refund on its way
    event('queue_left', p);
    return this;
  };
  Session.prototype.start = function (b) {
    this.set(b);
    if (this.stage === 'playing') return this;   // a second start for the same game is the same game
    if (this.paid()) paidMoney();
    this.stage = 'playing'; this.t0 = now();
    perf.fps.length = 0; perf.ping.length = 0;   // readings from loading, a queue or an end card are not the game's
    if (!this.paid()) event('game_started', base(this));
    return this;
  };
  Session.prototype.end = function (r) {
    if (this.stage !== 'playing') return this;
    var dur = now() - this.t0;
    this.stage = 'end_card';
    if (!this.paid()) {
      var p = base(this);
      r = r || {};
      p.result = r.result; p.duration_s = secs(dur); p.score = r.score; p.amount = r.amount; p.net = r.net;
      p.place = r.place; p.players = r.players; p.reason = r.reason;
      if (p.vs_bot == null && r.vs_bot != null) p.vs_bot = r.vs_bot;
      event('game_ended', p);
    } else { paidMoney(); }
    flushPerf(this, dur);
    return this;
  };
  Session.prototype.spectate = function () {
    this.stage = 'spectating';
    event('spectate_started', base(this));
    return this;
  };
  /* The page is going away (a frame swapped out, the tab closed). Sent once. */
  Session.prototype._leave = function () {
    if (this._left) return;
    this._left = true;
    var st = this.stage;
    if (this.paid()) paidMoney();   // a paid seat closed early is refunded or paid out by the server
    if (st === 'loading' || st === 'queue' || st === 'playing') {
      var p = base(this);
      p.stage = st;
      p.duration_s = secs(now() - (st === 'playing' ? this.t0 : st === 'queue' ? this.q0 : this.page0));
      event('game_quit', p);
      if (st === 'queue') this.unqueue('left');
      if (st === 'playing') this.end({ result: 'left', reason: 'page_left' });
    }
    if (st === 'spectating') flushPerf(this, null);
  };

  function game(g, b) {
    if (current && !current._left) current._leave();
    current = new Session(g, b);
    event('game_opened', base(current));
    return current;
  }

  function leaving() {
    if (current) current._leave();
    else flushPerf(null, null);
  }
  /* A frame tells the lobby how to say goodbye: when the whole tab closes, the lobby's pagehide comes first and
     PostHog sends its last batch then, so a frame's own pagehide would be too late. */
  var leavers = [];
  root.addEventListener('pagehide', function () {
    leaving();
    if (IS_HOST) for (var i = 0; i < leavers.length; i++) { try { leavers[i](); } catch (_) { /* a frame already gone */ } }
    else { try { host._offLeave(leaving); } catch (_) { /* none */ } }
  });
  if (!IS_HOST) { try { host._onLeave(leaving); } catch (_) { /* none */ } }
  doc.addEventListener('visibilitychange', function () {
    if (doc.hidden) perf.hiddenAt = now();
    else if (perf.hiddenAt) { perf.hiddenMs += now() - perf.hiddenAt; perf.hiddenAt = 0; }
  });

  function sample(o) {
    if (!o || doc.hidden) return;
    if (typeof o.fps === 'number' && isFinite(o.fps) && perf.fps.length < MAX_SAMPLES) perf.fps.push(Math.round(o.fps));
    if (typeof o.ping === 'number' && isFinite(o.ping) && o.ping >= 0 && perf.ping.length < MAX_SAMPLES) perf.ping.push(Math.round(o.ping));
  }

  /* Dropped and restored game connections. A disconnect this page asked for ('io client disconnect') is not one. */
  var MAX_DROPS = 20, drops = 0;
  function watchSocket(sock) {
    if (!sock || typeof sock.on !== 'function' || sock.__dsTrack) return;
    try { sock.__dsTrack = true; } catch (_) { return; }
    var downAt = 0;
    sock.on('disconnect', function (reason) {
      if (reason === 'io client disconnect') return;
      downAt = now(); perf.disc++;
      if (++drops > MAX_DROPS) return;
      var p = current ? base(current) : { game: guessGame() };
      p.reason = String(reason || ''); p.stage = current ? current.stage : undefined;
      event('game_disconnected', p);
    });
    sock.on('connect', function () {
      if (!downAt) return;
      var p = current ? base(current) : { game: guessGame() };
      p.down_s = secs(now() - downAt);
      downAt = 0; perf.reco++;
      if (drops > MAX_DROPS) return;
      event('game_reconnected', p);
    });
  }

  /* JS errors in a game frame: the lobby's PostHog captures its own page's errors, not a frame's. 20 a page, each
     message once. */
  var errs = 0, errSeen = {};
  function frameError(err, msg) {
    if (errs >= 20) return;
    var key = String(msg || (err && err.message) || '').slice(0, 200);
    if (!key || key === 'Script error.' || errSeen[key]) return;
    errSeen[key] = 1; errs++;
    try { host._exception(err instanceof Error ? err : new Error(key), { game: guessGame(), page: 'game', url: root.location.pathname }); } catch (_) { /* none */ }
  }
  if (!IS_HOST) {
    root.addEventListener('error', function (e) { if (e && (e.error || e.message)) frameError(e.error, e.message); });
    root.addEventListener('unhandledrejection', function (e) { var r = e && e.reason; frameError(r instanceof Error ? r : null, r && r.message ? r.message : String(r)); });
  }

  // ── the host (the lobby, or a game page opened on its own) ───────────────────────────────────────────────────
  var hooks = {};
  /* The last paid money move this browser saw, in any tab (localStorage), so a payout or refund is never a funding. */
  function markPaid() { lsSet('ds_paid_at', String(now())); }
  function paidAt() { var n = Number(lsGet('ds_paid_at')); return isFinite(n) ? n : 0; }
  var identifyWallet = function () { /* a frame: the lobby identifies */ };
  var fundMethod = function () { /* a frame: the lobby watches fundings */ };
  if (IS_HOST) {
    // PostHog itself: the lobby's <head> loads it; a game page on its own loads it here (no visit ping, as before).
    if (!root.posthog) {
      try {
        var sc = doc.createElement('script');
        sc.src = '/js/posthog-init.js';
        sc.setAttribute('data-no-visit-ping', '');
        sc.onload = function () { registerSupers(); flushWaiting(); };
        (doc.head || doc.documentElement).appendChild(sc);
      } catch (_) { /* none */ }
    }

    /* First touch: where this device first came from, kept for good (an ad, a referral, an invite link, direct).
       Read before invite.js turns /play/<game> back into /. */
    var CLICK_IDS = { gclid: 'google', gbraid: 'google', wbraid: 'google', fbclid: 'facebook', ttclid: 'tiktok',
      twclid: 'x', li_fat_id: 'linkedin', rdt_cid: 'reddit', msclkid: 'bing', sccid: 'snapchat', epik: 'pinterest' };
    var ft = null;
    try { ft = JSON.parse(lsGet('ds_ft') || 'null'); } catch (_) { ft = null; }
    if (!ft || typeof ft !== 'object') {
      ft = {};
      try {
        var q = new URLSearchParams(root.location.search || '');
        var refHost = '';
        try { refHost = doc.referrer ? new URL(doc.referrer).hostname.replace(/^www\./, '') : ''; } catch (_) { refHost = ''; }
        if (refHost && refHost.replace(/^eu\./, '') === String(root.location.hostname).replace(/^www\./, '').replace(/^eu\./, '')) refHost = '';
        var inv = /^\/play\/([a-z0-9-]+)\/?$/i.exec(root.location.pathname || '');
        var click = '';
        for (var cid in CLICK_IDS) if (q.get(cid)) { click = cid; break; }
        var invite = inv ? ((PLAN && PLAN.game(inv[1])) || inv[1].toLowerCase()) : '';
        ft.ft_source = (q.get('utm_source') || q.get('ref') || (click ? CLICK_IDS[click] : '') || (invite ? 'invite' : '') || refHost || 'direct').slice(0, 80);
        ft.ft_medium = (q.get('utm_medium') || (click ? 'paid' : invite ? 'invite' : refHost ? 'referral' : 'none')).slice(0, 80);
        if (q.get('utm_campaign')) ft.ft_campaign = q.get('utm_campaign').slice(0, 120);
        if (q.get('utm_content')) ft.ft_content = q.get('utm_content').slice(0, 120);
        if (q.get('utm_term')) ft.ft_term = q.get('utm_term').slice(0, 120);
        if (click) ft.ft_click = click;
        if (refHost) ft.ft_referrer = refHost.slice(0, 120);
        ft.ft_landing = String(root.location.pathname || '/').slice(0, 120);
        if (invite) ft.ft_invite = invite;
        ft.ft_at = new Date().toISOString();
      } catch (_) { /* none */ }
      lsSet('ds_ft', JSON.stringify(ft));
    }

    var owner = lsGet('ds_owner') === '1';
    function supers() {
      var s = { is_owner: owner, page: guessGame() ? 'game' : 'lobby', device: device() };
      for (var k in ft) if (Object.prototype.hasOwnProperty.call(ft, k)) s[k] = ft[k];
      return s;
    }
    function registerSupers() { var p = ph(); if (p && p.register) { try { p.register(supers()); } catch (_) { /* none */ } } }
    registerSupers();

    function markOwner() {
      if (owner) return;
      owner = true;
      lsSet('ds_owner', '1');
      registerSupers();
      var p = ph();
      // $internal_or_test_user puts him in PostHog's own "Internal / Test users" cohort, which every dashboard leaves out
      try { if (p && p.setPersonProperties && identified) p.setPersonProperties({ is_owner: true, $internal_or_test_user: true }); } catch (_) { /* none */ }
    }
    // A device signed into Control (its HttpOnly cookie) is the owner's, signed in to a game or not.
    if (!owner && root.fetch) {
      try {
        root.fetch('/api/owner/session', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) { if (j && j.signedIn === true) markOwner(); }).catch(function () { /* none */ });
      } catch (_) { /* none */ }
    }

    var identified = '';
    identifyWallet = function (wallet) {
      wallet = String(wallet || '');
      if (!wallet || wallet === identified) return;
      identified = wallet;
      var p = ph();
      try {
        var set = { is_owner: owner, last_device: device() };
        if (owner) set.$internal_or_test_user = true;
        if (p && p.identify) p.identify(wallet, set, ft);
      } catch (_) { /* none */ }
      registerSupers();
      if (!owner && root.fetch) {
        try {
          root.fetch('/api/br/owner', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: wallet }) })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) { if (j && j.isOwner === true && identified === wallet) markOwner(); }).catch(function () { /* none */ });
        } catch (_) { /* none */ }
      }
    };
    function reset() {
      if (!identified) return;
      identified = '';
      event('signed_out', {});
      var p = ph();
      try { if (p && p.reset) p.reset(); } catch (_) { /* none */ }
      registerSupers();
    }

    /* Money that lands within 30 minutes of Add funds opening, on this device, and not within 3 minutes of a paid
       game ending (a payout), is a funding: card or crypto, from the method the player picked. Linked-wallet adds
       go through the server, which sends its own (verified) one. */
    var FUND_MS = 30 * 60 * 1000, PAYOUT_MS = 3 * 60 * 1000;
    var lastSol = null, lastAddr = '';
    hooks.add_funds_opened = function (p) {
      lsSet('ds_fund', JSON.stringify({ at: now(), method: p.method || 'any' }));
    };
    /* The widget says which way the player paid in Privy's sheet (card, or crypto for Receive funds). */
    fundMethod = function (m) {
      var f = null;
      try { f = JSON.parse(lsGet('ds_fund') || 'null'); } catch (_) { f = null; }
      if (!f || f.used || (m !== 'card' && m !== 'crypto')) return;
      f.method = m;
      lsSet('ds_fund', JSON.stringify(f));
    };
    function watchFunds(w) {
      if (!w.address || w.stale || typeof w.sol !== 'number' || !isFinite(w.sol)) return;
      if (w.address !== lastAddr) { lastAddr = w.address; lastSol = w.sol; return; }
      var rise = w.sol - lastSol;
      lastSol = w.sol;
      if (!(rise > 0.0005)) return;
      var f = null;
      try { f = JSON.parse(lsGet('ds_fund') || 'null'); } catch (_) { f = null; }
      if (!f || f.used || !(now() - f.at < FUND_MS) || now() - paidAt() < PAYOUT_MS) return;
      if (current && current.paid() && (current.stage === 'queue' || current.stage === 'playing')) return;   // a paid seat open here
      if (f.method === 'linked') return;   // the server sends that one
      // one funding per Add funds opening, whichever tab sees it first
      f.used = true;
      lsSet('ds_fund', JSON.stringify(f));
      var usd = typeof w.solUsd === 'number' && w.solUsd > 0 ? Math.round(rise * w.solUsd * 100) / 100 : undefined;
      event('funded', { amount: usd, amount_sol: Math.round(rise * 1e6) / 1e6, method: f.method, verified: false });
    }

    var wasAuthed = false, checkedStale = false;
    /* Loaded signed out while PostHog still holds the last wallet (a Privy session that ran out, a sign-out on
       another page): start a new anonymous visitor, so the next person to sign in here is not counted as them.
       PostHog's saved state is readable once its library has loaded: asked again each second, ten times at most. */
    function staleCheck(tries) {
      var p = ph();
      if (!p || !p.__loaded) { if (tries < 10) setTimeout(function () { staleCheck(tries + 1); }, 1000); return; }
      if (checkedStale) return;
      checkedStale = true;
      var w = root.duelWallet || {};
      if (w.authenticated) return;
      try {
        if (p.get_property && p.get_property('$user_state') === 'identified') { p.reset(); registerSupers(); }
      } catch (_) { /* none */ }
    }
    function onWallet() {
      var w = root.duelWallet || {};
      if (!w.ready) return;
      if (w.authenticated && w.address) { wasAuthed = true; identifyWallet(w.address); watchFunds(w); }
      else if (wasAuthed && !w.authenticated) { wasAuthed = false; lastAddr = ''; reset(); }
      else if (!w.authenticated && !checkedStale) staleCheck(0);
    }
    root.addEventListener('duelwallet:change', onWallet);
    onWallet();
  }

  var api = {
    version: 1,
    event: event,
    game: game,
    current: function () { return current; },
    sample: sample,
    watchSocket: watchSocket,
    identify: function (w) { identifyWallet(w); },
    fundMethod: function (m) { fundMethod(m); }   // the widget: 'card' or 'crypto', as picked in Privy's sheet
  };
  if (IS_HOST) {
    api._host = true;
    api._send = function (name, props) {
      var g = PLAN ? PLAN.EVENTS[name] : null;
      if (g && g.who === 'server') return;
      if (hooks[name]) { try { hooks[name](props); } catch (_) { /* none */ } }
      send(name, props);
    };
    api._paidEnded = function () { markPaid(); };
    api._onLeave = function (fn) { if (typeof fn === 'function' && leavers.indexOf(fn) < 0) leavers.push(fn); };
    api._offLeave = function (fn) { var i = leavers.indexOf(fn); if (i >= 0) leavers.splice(i, 1); };
    api._exception = function (err, props) {
      var p = ph();
      try { if (p && typeof p.captureException === 'function') p.captureException(err, props); } catch (_) { /* none */ }
    };
  }
  root.DSTrack = api;
  /* The older call sites (window.phEvent / phIdentify) go through the plan too. */
  root.phEvent = function (name, props) { event(name, props); };
  root.phIdentify = function (id) { identifyWallet(id); };
})(typeof window !== 'undefined' ? window : null);
