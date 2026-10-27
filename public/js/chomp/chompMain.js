// Chomp's page: the socket, the title card, input (arrows/WASD, the phone's thumb stick), your own chomper predicted
// with the server's movement code, everyone else drawn a little in the past between snapshots, the HUD and the sounds.
//
// Paid (only when the lobby's wallet left a paid hand-off: chompPaid.js, on agar.io's client flow public/js/ag/
// agPaid.js): the socket connects with auth { paid: 1 } and joins through the paid door with the entry token (or a
// resume key after a reload); no title card; c:ready once its own chomper is drawn; the coins on the maze, money in
// the HUD and the board, hold Q (a held Cash out button on a phone) with the gold ring while it moves on; the paid end
// cards; and no way back to the lobby while money is in the room (it leaves only by cash-out).
//
// Prediction: every key press is numbered and logged with the local tick it happened on. The server echoes the last
// number it applied and how many ticks ago, which says which of our own past ticks its position belongs to; if ours
// differed there, we take its position and replay our ticks since (with the same dot pauses), and ease the
// difference out on screen.
(function () {
  'use strict';
  var R = window.ChompRules, Maze = window.ChompMaze, Move = window.ChompMove, Wire = window.ChompWire;
  var Draw = window.ChompDraw, Snd = window.ChompSound;
  var DT = 1 / R.TICK_HZ, STEP_MS = 1000 / R.TICK_HZ;
  var params = new URLSearchParams(location.search);
  var attract = params.get('attract') === '1';
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  // Owen's pick 2026-10-25: the pixel look ('arcade' and 'neon' stay reachable with ?look= for comparisons)
  var lookName = params.get('look') || 'pixel';

  var canvas = document.getElementById('cv');
  var ctx = canvas.getContext('2d');
  var titleEl = document.getElementById('title');
  // the shown name (shared/chompName.js, Pac-Man for now): the tab and the title card's mark
  var NAME = window.DS_CHOMP_NAME || 'Chomp';
  document.title = NAME + ' - DuelSeries';
  if (NAME !== 'Chomp') {
    var markEl = titleEl.querySelector('.mark');
    if (markEl) { markEl.textContent = NAME.toUpperCase(); markEl.setAttribute('aria-label', NAME); }
  }
  // chomp.html's veil keeps the title card off screen in the lobby's frame until the game is up (no flash on Play)
  function unveil() { document.documentElement.classList.remove('veil'); }
  setTimeout(unveil, 5000);
  var nameEl = document.getElementById('name');
  var playEl = document.getElementById('play');

  // ---- paid hand-off (chompPaid.js); null pieces on the free page
  var PAID = window.ChompPaid && window.ChompPaid.available ? window.ChompPaid : null;
  var hand = PAID ? PAID.handoff() : { paid: false };
  var paidMode = !!hand.paid;
  var isTouch = false;
  try { isTouch = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch (e) { isTouch = false; }
  var flow = null, pcard = null, lock = null, hold = null, paidChip = null;
  // a hold pressed while the spawn blink still protects you counts only once it ends (the server's rule): say so
  function holdPressed() {
    if (!hold) return;
    hold.press();
    if (mySafe && paidChip && phase === 'play') paidChip.show('Cash out starts when you stop blinking', 2500, window);
  }
  var stakeNow = 0, myMoney = 0, coins = new Map(), coinList = [], deadTimer = null;

  var A = null, draw = null, socket = null;
  var myId = 0, metas = new Map();
  var dotsServer = null, dotsView = null, pending = new Map();
  var fruitOn = new Set();
  var snaps = [], offset = null;
  var me = null, L = 0, hist = new Map(), inputs = [], seq = 0, predicting = false;
  var smooth = { x: 0, y: 0 }, cam = { x: 0, y: 0 }, camSet = false;
  var myPower = 0, myBoost = 0, fruitTaken = -1, mySafe = 0, myScore = 0, myLives = R.LIVES, myRank = 0, roomN = 0;
  var phase = attract ? 'watch' : 'title';
  var pops = [], dying = new Map(), mouthPhase = new Map(), lastPos = new Map();
  var lbRows = [], board = null, scaredUntil = 0, readyUntil = 0;
  // Owen 2026-10-26: every ghost is blue for YOU while your own energizer lasts, for nobody else (server/chomp/
  // chompRoom.js blueFor, the same rule): except one that went home as eyes since your energizer (it comes back out
  // normal). ghostHome lists those by index: the ones in eyes when your energizer landed (the server's power event
  // lists them; freshPower guesses from the newest snapshot until it lands), and every one eaten since.
  var ghostHome = new Set();
  function freshPower() {
    ghostHome = new Set();
    var s = snaps[snaps.length - 1];
    if (s) s.ghosts.forEach(function (g, i) { if (g.state === 3 || g.state === 4) ghostHome.add(i); });
  }
  function blueForMe(i, g) { return myPower > 0 && predicting && g.state !== 3 && g.state !== 4 && !ghostHome.has(i); }
  var stats = { checks: 0, fixes: 0, fixDist: 0 };       // prediction health, read by the test harness

  // ---- sizing
  function resize() {
    if (!draw) return;
    var w = window.innerWidth, h = window.innerHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    // CHOSEN: a computer shows 33 rows top to bottom (the arcade screen's 36 less its score lines); a phone held
    // upright shows 28.5 columns across, the arcade's own width, as the arcade cabinet's screen stands.
    var portrait = h > w;
    if (draw.L.id === 'pixel') draw.resize(w, h, dpr);
    else draw.resize(w, h, dpr, portrait ? (w * dpr / 28.5) : (h * dpr / 33));
  }
  window.addEventListener('resize', resize);

  // ---- net
  function connect() {
    var opts = undefined;
    if (paidMode) opts = { auth: { paid: 1 } };
    else if (watchStake > 0) opts = { auth: { watchStake: watchStake } };
    // the look picked in the lobby's Customize: a free colour (duel.chomp.skin) and a bought skin with the lobby's
    // skin pass (duel.shop.chomp, duel.skinpass); the server wears only what it checks (chompBoot skinOf)
    if (watchStake <= 0) {
      try {
        var ls = window.localStorage, look = {};
        var free = ls && ls.getItem('duel.chomp.skin'), shopId = ls && ls.getItem('duel.shop.chomp'), pass = ls && ls.getItem('duel.skinpass');
        if (typeof free === 'string' && free && free.length <= 32) look.skin = free;
        if (shopId && pass && /^[a-z][a-z0-9]{0,23}$/.test(shopId) && pass.length <= 4096) { look.shop = shopId; look.skinPass = pass; }
        if (look.skin || look.shop) { opts = opts || { auth: {} }; Object.assign(opts.auth, look); }
      } catch (e) { /* storage blocked: the game's own look */ }
    }
    socket = opts ? window.io('/chomp', opts) : window.io('/chomp');
    socket.on('c:init', onInit);
    socket.on('c:chat', function (m) {
      if (!chat) return;
      var others = draw ? draw.L.players.length - 1 : 5;
      chat.add({ name: m.name, text: m.text, me: !!m.me, color: m.me ? '#ffff00' : (draw ? draw.L.players[(m.c % others) + 1] : '#dedeff') });
    });
    socket.on('c:chatnote', function (m) { if (chat && m && m.text) chat.add({ kind: 'sys', text: m.text }); });
    socket.on('c:you', function (m) { unveil(); closeWatch(); myId = m.id; (m.metas || []).forEach(setMeta); predicting = false; phase = 'play'; titleEl.hidden = true; readyUntil = performance.now() + 1500; cueSpawn(); Snd.play('ch.ready'); });
    socket.on('c:s', onSnap);
    socket.on('c:dots', onDots);
    socket.on('c:ev', onEvents);
    socket.on('c:lb', function (rows) { lbRows = rows || []; showBoard(); });
    socket.on('c:me', function (m) { myScore = m.s; myLives = m.l; myRank = m.rk; roomN = m.n; if (m.m != null) myMoney = m.m; showBoard(); });
    socket.on('c:over', onOver);
    socket.on('c:refused', function (m) {
      if (flow) { if (m && m.closed === true) seatEnded(); flow.onEvent('ag:refused', m); return; }
      if (m && m.why === 'nobody') { toast('Nobody is playing at that stake right now.'); return; }
      toast(m && m.why === 'full' ? 'The arena is full. Try again in a moment.' : m && m.why === 'maintenance'
        ? 'DuelSeries is updating. Try again in a few minutes.' : 'Too many tabs open here.');
    });
    socket.on('c:coins', onCoins);
    socket.on('c:arena', onArena);
    socket.on('c:holding', function (p) { if (hold) hold.server(p); });
    socket.on('c:joined', function (p) { if (flow) flow.onEvent('ag:joined', p); });
    socket.on('c:dead', onPaidDead);
    socket.on('c:cashedout', function (p) {
      var life = { secs: Math.round((performance.now() - (lifeT0 || performance.now())) / 1000), score: myScore };
      seatEnded();
      if (pcard) pcard.showCashed(p, p && p.resumed ? null : life);
      if (flow) flow.onEvent('ag:cashedout', p);
      Snd.play('ch.life');
    });
    socket.on('c:paid', function (p) { if (pcard && p) pcard.paid(p.sig, null); });
    socket.on('c:payerror', function (p) { if (pcard) pcard.payError(p && p.message); });
    socket.on('c:closed', function (p) { seatEnded(); if (pcard) pcard.showClosed(p); if (flow) flow.onEvent('ag:closed', p); });
    socket.on('c:refunded', function (p) { if (flow) flow.onEvent('ag:refunded', p); });
    socket.on('c:replaced', function (p) { seatEnded(); if (flow) flow.onEvent('ag:replaced', p); });
    socket.on('connect', function () { if (flow) flow.onConnect(); });
    socket.on('disconnect', function () {
      predicting = false;
      if (hold) hold.reset();
      if (flow) { if (lock) lock.drop(); flow.onDisconnect(); return; }
      if (phase === 'play') { phase = 'title'; titleEl.hidden = false; }
    });
  }

  // ---- paid
  var lifeT0 = 0;
  // The seat ended (cashed out, caught, closed, released, replaced): money is out of the room.
  var lastMyId = 0;
  function seatEnded() {
    if (myId) lastMyId = myId;
    if (lock) lock.setMoney(false);
    if (hold) hold.reset();
    syncCashBtn();
    phase = 'over'; predicting = false; myId = 0; myMoney = 0;
  }
  function onPaidDead(p) {
    var mine = myId, wait = p && p.resumed ? 0 : Math.round(R.DEATH_S * 1000) + 200;
    if (mine && !(p && p.resumed)) Snd.play('ch.death');
    seatEnded();
    if (mine) dying.set(mine, performance.now());
    clearTimeout(deadTimer);
    // the card after the death animation, then the flow (its Play again goes on the card just shown)
    deadTimer = setTimeout(function () {
      if (pcard) pcard.showDead(p);
      if (flow) flow.onEvent('ag:dead', p);
    }, wait);
  }
  function onCoins(d) {
    var me = myId;
    (d.a || []).forEach(function (c) { coins.set(c[0], { k: c[1], c: c[1] % A.W, r: Math.floor(c[1] / A.W), micro: c[2] }); });
    (d.r || []).forEach(function (c) {
      coins.delete(c[0]);
      if (me && c[1] === me) Snd.play('ch.fruit');
    });
    coinList = Array.from(coins.values());
  }
  // A paid seat opened (agPaid on c:joined): the play state the free Play button gives, without the title card.
  function enterPaidPlay(p) {
    closeWatch();
    if (pcard) pcard.hide();
    clearTimeout(deadTimer);
    myId = p.id; (p.metas || []).forEach(setMeta);
    predicting = false; phase = 'play'; titleEl.hidden = true;
    myMoney = Number(p.micro) || 0;
    lifeT0 = performance.now();
    if (lock) lock.setMoney(true);
    readyUntil = performance.now() + 1500; cueSpawn(); Snd.play('ch.ready');
    syncCashBtn();
  }
  function usd(micro) { return window.DSEnd ? window.DSEnd.usd(micro) : '$' + (micro / 1e6).toFixed(2); }

  // The phone's Cash out button (held), shown only while a paid seat plays on a touch screen.
  var cashBtn = null;
  function syncCashBtn() {
    if (!paidMode || !isTouch) return;
    if (!cashBtn) {
      cashBtn = document.createElement('button');
      cashBtn.id = 'cashout';
      cashBtn.type = 'button';
      cashBtn.textContent = 'Hold to cash out';
      var down = function (e) { e.preventDefault(); holdPressed(); cashBtn.classList.add('held'); };
      var up = function (e) { if (e) e.preventDefault(); if (hold) hold.release(); cashBtn.classList.remove('held'); };
      cashBtn.addEventListener('pointerdown', down);
      cashBtn.addEventListener('pointerup', up);
      cashBtn.addEventListener('pointercancel', up);
      cashBtn.addEventListener('pointerleave', up);
      cashBtn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      document.body.appendChild(cashBtn);
    }
    cashBtn.hidden = !(phase === 'play' && myId && flow && flow.canSteer());
  }

  function setMeta(m) { metas.set(m.id, { n: m.n, c: m.c, look: lookOf(m.s) }); }
  // A chomper's Customize look from its meta's s ('f:<id>' a free colour, shared/chompSkins.js; 'p:<id>' a bought
  // skin, shared/shopSkins.js SKINS.chomp, drawn pixel by pixel by chompPixel): { col, k }, or null for the game's own.
  function lookOf(s) {
    if (typeof s !== 'string' || s.length < 3) return null;
    var id = s.slice(2), k = null;
    if (s[0] === 'f' && window.DS_CHOMP_SKINS) k = window.DS_CHOMP_SKINS.byId(id);
    else if (s[0] === 'p' && window.DS_SHOP_SKINS) k = window.DS_SHOP_SKINS.byId('chomp', id);
    return k ? { col: k.col, k: k } : null;
  }

  function onInit(m) {
    stakeNow = Number(m.stake) > 0 ? Number(m.stake) : 0;
    var fresh = !A || A.mx !== m.mx || A.my !== m.my || A.wrap !== !!m.wrap;
    if (fresh) {
      A = Maze.build(m.mx, m.my, { wrap: !!m.wrap });
      draw = lookName === 'pixel' && window.ChompPixel ? new window.ChompPixel(canvas, A) : new Draw(canvas, A, lookName);
      resize();
    }
    dotsServer = new Uint8Array(m.dots);
    dotsView = new Uint8Array(dotsServer);
    pending.clear();
    metas.clear();
    (m.metas || []).forEach(setMeta);
    fruitOn = new Set(m.fruit || []);
    snaps = []; offset = null; myId = 0; predicting = false;
    coins.clear();
    (m.coins || []).forEach(function (c) { coins.set(c[0], { k: c[1], c: c[1] % A.W, r: Math.floor(c[1] / A.W), micro: c[2] }); });
    coinList = Array.from(coins.values());
    if (phase === 'play' && !paidMode) { phase = 'title'; titleEl.hidden = false; }
    // In the lobby's frame the free room starts at once under the lobby name, the way agar.io's and Paper's do (the
    // lobby already asked for the name); a Spectate opens watching instead, and the title card stays the way back.
    if (inLobby && !paidMode && !autoJoined && phase === 'title' && !watchStake && !watchAsked) {
      autoJoined = true;
      join();
    }
  }
  var autoJoined = false, watchAsked = false;

  // The arena grew or shrank by a module column or row (server/chomp/chompResize.js), away from you: the server turned
  // the torus by `shift` tiles on one axis first, so every position we hold turns the same way (nothing moves on
  // screen), then the map, its dots, coins and fruit come new; gmap says where each ghost now sits in the list.
  function onArena(m) {
    if (!A || !m || !A.wrap) return;
    var isX = m.axis === 'x', S = Number(m.shift) || 0, Wo = A.W, Ho = A.H;
    function fx(x) { return isX ? ((x - S) % Wo + Wo) % Wo : x; }
    function fy(y) { return isX ? y : ((y - S) % Ho + Ho) % Ho; }
    var gmap = m.gmap || [];
    snaps.forEach(function (sn) {
      sn.players.forEach(function (p) { p.x = fx(p.x); p.y = fy(p.y); });
      var g2 = [];
      sn.ghosts.forEach(function (g, i) { var j = gmap[i]; if (j >= 0) { g.x = fx(g.x); g.y = fy(g.y); g2[j] = g; } });
      var home = new Set();
      ghostHome.forEach(function (i) { if (gmap[i] >= 0) home.add(gmap[i]); });
      ghostHome = home;
      sn.ghosts = g2;
    });
    if (me) { me.x = fx(me.x); me.y = fy(me.y); }
    hist.forEach(function (h) { h.x = fx(h.x); h.y = fy(h.y); });
    cam.x = fx(cam.x); cam.y = fy(cam.y);
    pops.forEach(function (q) { q.x = fx(q.x); q.y = fy(q.y); });
    lastPos.clear();
    A = Maze.build(m.mx, m.my, { wrap: true });
    draw = lookName === 'pixel' && window.ChompPixel ? new window.ChompPixel(canvas, A) : new Draw(canvas, A, lookName);
    resize();
    dotsServer = new Uint8Array(m.dots);
    dotsView = new Uint8Array(dotsServer);
    pending.clear();
    coins.clear();
    (m.coins || []).forEach(function (c) { coins.set(c[0], { k: c[1], c: c[1] % A.W, r: Math.floor(c[1] / A.W), micro: c[2] }); });
    coinList = Array.from(coins.values());
    fruitOn = new Set(m.fruit || []);
  }

  function onSnap(buf) {
    var s = Wire.decode(buf);
    if (!s || !A) return;
    var now = performance.now();
    s.t = s.tick * 1000 / R.TICK_HZ;
    var sample = now - s.t;
    if (offset == null || sample < offset) offset = sample; else offset += (sample - offset) * 0.02;
    s.pmap = new Map();
    s.players.forEach(function (p) { s.pmap.set(p.id, p); });
    snaps.push(s);
    while (snaps.length > 40) snaps.shift();
    var mine = myId ? s.pmap.get(myId) : null;
    if (mine) reconcile(mine);
  }

  function onDots(d) {
    if (!dotsServer) return;
    (d.e || []).forEach(function (k) { dotsServer[k] = 0; dotsView[k] = 0; pending.delete(k); });
    (d.b || []).forEach(function (k) { dotsServer[k] = A.dot0[k]; if (!pending.has(k)) dotsView[k] = A.dot0[k]; });
  }

  function onEvents(list) {
    var now = performance.now();
    list.forEach(function (e) {
      if (e.k === 'meta') setMeta(e);
      else if (e.k === 'gone') { metas.delete(e.id); dying.delete(e.id); }
      else if (e.k === 'eatg') {
        ghostHome.add(e.g);
        pop(e.x, e.y, String(e.pts), '#00ffff');
        if (e.id === myId) Snd.play('ch.ghost');
      } else if (e.k === 'eatp') {
        pop(e.x, e.y, String(e.pts), '#00ffff');
        if (e.id === myId) Snd.play('ch.player');
      } else if (e.k === 'die') {
        dying.set(e.id, now);
        if (e.id === myId) { Snd.play('ch.death'); predicting = false; myPower = 0; myBoost = 0; }
      } else if (e.k === 'spawn') {
        dying.delete(e.id);
        if (e.id === myId) { readyUntil = now + 1500; cueSpawn(); Snd.play('ch.ready'); }
      } else if (e.k === 'power') {
        if (e.id === myId) { scaredUntil = now + R.FRIGHT_S * 1000; ghostHome = new Set(e.home || []); }
      } else if (e.k === 'fruit') {
        if (e.on) fruitOn.add(e.m); else fruitOn.delete(e.m);
        // a fruit's speed burst: ours if the server says we took it (we may have seen it first, stepLocal); one
        // somebody else beat us to is not
        if (!e.on && e.pts) {
          if (e.id === myId && fruitTaken !== e.m) myBoost = R.FRUIT_BOOST_S * R.TICK_HZ;
          else if (e.id !== myId && fruitTaken === e.m) myBoost = 0;
        } else if (!e.on && fruitTaken === e.m) myBoost = 0;
        if (fruitTaken === e.m) fruitTaken = -1;
        if (!e.on && e.pts) {
          var m = A.modules[e.m];
          pop(m.ox + Maze.FRUIT.x, m.oy + Maze.FRUIT.y, String(e.pts), '#ffb8ff', 80 * STEP_MS);
          if (e.id === myId) Snd.play('ch.fruit');
        }
      } else if (e.k === 'life') {
        if (e.id === myId) Snd.play('ch.life');
      }
    });
  }

  function pop(x, y, text, color, ms) { pops.push({ x: x, y: y, text: text, color: color, at: performance.now(), ms: ms || 1000 }); }

  // The shared end card (dsEnd.js), the buttons in the other games' order: Lobby (Menu on a direct visit), Spectate,
  // Play again.
  function onOver(m) {
    phase = 'over'; predicting = false; myId = 0;
    if (!window.DSEnd) { titleEl.hidden = false; phase = 'title'; return; }
    var secs = m.secs || 0;
    window.DSEnd.show({
      tone: 'plain', verdict: m.ghost ? 'Caught by a ghost' : m.by ? 'Eaten by ' + m.by : 'Game over',
      hero: fmt(m.score), unit: 'points',
      facts: [['Rank', '#' + m.rank + ' of ' + m.of], ['Time', Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0')]],
      // Share your score (2026-10-26): the free page only, never a paid one
      share: paidMode || typeof window.DSEnd.share !== 'function' ? null : { onClick: function () {
        window.DSEnd.share({ game: 'chomp', hero: fmt(m.score), unit: 'points',
          facts: [['Rank', '#' + m.rank + ' of ' + m.of], ['Time', Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0')]] });
      } },
      buttons: [
        { id: 'lobby', text: inLobby ? 'Lobby' : 'Menu', onClick: function () { window.DSEnd.hide(); backToLobby(); } },
        { id: 'watch', text: 'Spectate', onClick: function () { window.DSEnd.hide(); startWatch(); } },
        { id: 'again', text: 'Play again', primary: true, onClick: function () { window.DSEnd.hide(); join(); } }
      ]
    });
  }

  // ---- the lobby around the page (its free games open in the lobby's #game-frame) and Spectate
  var inLobby = false;
  try { inLobby = !!window.frameElement && window.frameElement.id === 'game-frame'; } catch (e) { inLobby = false; }
  var framed = false;
  try { framed = window.parent && window.parent !== window; } catch (e) { framed = true; }
  function backToLobby() {
    if (lock && lock.locked()) { if (flow) flow.escape(); return; }
    closeWatch();
    if ((inLobby || (paidMode && framed)) && window.parent) { window.parent.postMessage('game:done', '*'); return; }
    if (paidMode) { location.href = '/'; return; }
    phase = 'title'; titleEl.hidden = false;
  }
  var watchId = 0, watchName = null;
  function watchList() {
    var s = snaps[snaps.length - 1];
    if (!s) return [];
    var score = new Map(lbRows.map(function (r) { return [r[0], r[1]]; }));
    return s.players.filter(function (p) { return !(p.flags & Wire.F.DYING); })
      .map(function (p) { return p.id; })
      .sort(function (a, b) { return (score.get(b) || 0) - (score.get(a) || 0) || a - b; });
  }
  function stepWatch(d) {
    var list = watchList(), bar = window.DSWatchBar;
    if (!list.length) { watchId = 0; watchName = null; if (bar) bar.empty(); return; }
    var i = list.indexOf(watchId);
    watchId = list[i < 0 ? 0 : (i + d + list.length) % list.length];
    var meta = metas.get(watchId);
    watchName = meta ? meta.n : '';
    if (bar) bar.watching(watchName || 'Player');
  }
  function startWatch() {
    unveil();
    phase = 'watch'; titleEl.hidden = true; predicting = false;
    if (window.DSWatchBar) window.DSWatchBar.open({
      game: 'chomp', stake: 0,
      onPrev: function () { stepWatch(-1); },
      onNext: function () { stepWatch(1); },
      onLobby: function () { backToLobby(); }
    });
    watchId = 0;
    stepWatch(0);
  }
  function closeWatch() { if (window.DSWatchBar && window.DSWatchBar.shown()) window.DSWatchBar.close(); }

  function join() {
    if (!socket) return;
    var n = (nameEl.value || '').trim().slice(0, 15);
    store('chomp.name', n);
    socket.emit('c:join', { name: n || 'Player' });
  }

  // ---- input
  function want(d) {
    // nothing while caught or before we are placed: the server would drop it, and replaying it later would not match
    if (phase !== 'play' || !myId || !socket || !predicting || !me) return;
    if (flow && !flow.canSteer()) return;
    if (me.want === d && me.dir === d) return;
    seq = seq >= 65535 ? 1 : seq + 1;
    me.want = d;
    inputs.push({ seq: seq, d: d, L: L });
    if (inputs.length > 300) inputs.splice(0, inputs.length - 300);
    var c = Math.floor(me.x), r = Math.floor(me.y);
    socket.emit('c:dir', { d: d, s: seq, c: c, r: r });
  }
  var KEYS = { ArrowUp: 0, KeyW: 0, ArrowLeft: 1, KeyA: 1, ArrowDown: 2, KeyS: 2, ArrowRight: 3, KeyD: 3 };
  window.addEventListener('keydown', function (e) {
    if (e.target === nameEl) { if (e.key === 'Enter') { e.preventDefault(); join(); } return; }
    if (phase === 'title' && e.key === 'Enter' && !paidMode) { join(); return; }
    if (e.code === 'KeyQ' && hold) { if (!e.repeat) holdPressed(); return; }
    if (e.code === 'Escape' && flow) { flow.escape(); return; }
    var d = KEYS[e.code];
    if (d == null) return;
    e.preventDefault();
    if (!e.repeat) want(d);
  });
  window.addEventListener('keyup', function (e) { if (e.code === 'KeyQ' && hold) hold.release(); });
  window.addEventListener('blur', function () { if (hold) hold.release(); });
  // The phone's thumb stick: the other games' anchor-and-follow stick (agar.io's agInput, slither's numbers: a 10 px
  // dead zone, the anchor dragged along 60 px behind the thumb), turned into the four directions a chomper has. The
  // dominant axis wins, and a switch to the other axis needs it STICK_SWITCH times as far, so a thumb held near a
  // diagonal does not flicker. Lifting the thumb keeps the last direction (a chomper always runs on).
  var STICK_DEADZONE = 10, STICK_FOLLOW = 60, STICK_SWITCH = 1.25;
  var stick = null;
  function stickDir(dx, dy, last) {
    var ax = Math.abs(dx), ay = Math.abs(dy);
    var horiz = last === 1 || last === 3 ? ax * STICK_SWITCH >= ay : ax > ay * STICK_SWITCH;
    if (last < 0) horiz = ax >= ay;
    return horiz ? (dx < 0 ? 1 : 3) : (dy < 0 ? 0 : 2);
  }
  function findTouch(list, id) { for (var i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i]; return null; }
  canvas.addEventListener('touchstart', function (e) {
    if (stick) return;
    var t = e.changedTouches[0];
    stick = { id: t.identifier, ax: t.clientX, ay: t.clientY, d: -1 };
  }, { passive: true });
  canvas.addEventListener('touchmove', function (e) {
    if (!stick) return;
    var t = findTouch(e.changedTouches, stick.id);
    if (!t) return;
    var dx = t.clientX - stick.ax, dy = t.clientY - stick.ay, dist = Math.hypot(dx, dy);
    if (dist > STICK_FOLLOW) {
      stick.ax = t.clientX - dx / dist * STICK_FOLLOW; stick.ay = t.clientY - dy / dist * STICK_FOLLOW;
      dx = t.clientX - stick.ax; dy = t.clientY - stick.ay; dist = STICK_FOLLOW;
    }
    e.preventDefault();
    if (dist <= STICK_DEADZONE) return;
    var d = stickDir(dx, dy, stick.d);
    if (d !== stick.d) { stick.d = d; want(d); }
  }, { passive: false });
  function stickEnd(e) { if (stick && findTouch(e.changedTouches, stick.id)) stick = null; }
  canvas.addEventListener('touchend', stickEnd);
  canvas.addEventListener('touchcancel', stickEnd);
  playEl.addEventListener('click', join);

  // ---- prediction
  function mySpeed() { return R.speed((myPower > 0 ? R.PAC_FRIGHT_SPEED : R.PAC_SPEED) * (myBoost > 0 ? R.FRUIT_BOOST : 1)); }

  function stepLocal() {
    if (myPower > 0) myPower--;
    if (myBoost > 0) myBoost--;
    L++;                                  // counts even while not predicting: it is the clock the server's echo maps onto
    if (!predicting || !me) return;
    var paused = me.pause > 0;
    Move.tick(me, A, mySpeed(), DT, dotsView, function (k, kind) {
      dotsView[k] = 0;
      pending.set(k, performance.now() + 1500);
      if (kind === Maze.ENERGIZER) { myPower = R.FRIGHT_S * R.TICK_HZ; freshPower(); Snd.play('ch.power'); } else Snd.eat();
    });
    // the fruit, as the server takes it (chompRoom checkFruit): its speed burst starts now, not a round trip later
    var fm = fruitOn.size ? A.moduleAt(me.x, me.y) : null;
    if (fm && fruitOn.has(fm.index) && fruitTaken !== fm.index && Math.floor(me.y) === fm.oy + Math.floor(Maze.FRUIT.y) &&
        (Math.floor(me.x) === fm.ox + Maze.FRUIT.x - 1 || Math.floor(me.x) === fm.ox + Maze.FRUIT.x)) {
      fruitTaken = fm.index;
      myBoost = R.FRUIT_BOOST_S * R.TICK_HZ;
    }
    if (me.dir >= 0) me.face = me.dir;
    hist.set(L, { x: me.x, y: me.y, dir: me.dir, paused: paused });
    hist.delete(L - 300);
  }

  function wantAt(tick) {
    var w = -1;
    for (var i = 0; i < inputs.length; i++) if (inputs[i].L < tick) w = inputs[i].d;
    return w;
  }

  function reconcile(rec) {
    mySafe = rec.flags & Wire.F.SAFE;
    if (rec.flags & Wire.F.DYING) { predicting = false; return; }
    if (!predicting || !me) {
      me = { x: rec.x, y: rec.y, dir: rec.dir, want: rec.dir, pause: 0, moving: false, face: rec.dir >= 0 ? rec.dir : 1 };
      myPower = rec.power;
      predicting = true; hist.clear(); smooth.x = smooth.y = 0;
      if (!camSet) { cam.x = me.x; cam.y = me.y; camSet = true; }
      if (flow) flow.onSpawn();
      return;
    }
    // the server's power count wins when they disagree by more than a snapshot's worth (it ate the energizer, or did not)
    if (Math.abs(rec.power - myPower) > 12) myPower = rec.power;
    var inp = null;
    for (var i = inputs.length - 1; i >= 0; i--) if (inputs[i].seq === rec.seq) { inp = inputs[i]; break; }
    if (!inp) {
      // nothing of ours applied yet this life: just follow the server
      if (Math.abs(me.x - rec.x) > 0.001 || Math.abs(me.y - rec.y) > 0.001 || me.dir !== rec.dir) {
        smooth.x += A.dx(rec.x, me.x); smooth.y += A.dy(rec.y, me.y);
        me.x = rec.x; me.y = rec.y; me.dir = rec.dir;
      }
      return;
    }
    var Lk = Math.min(L, inp.L + rec.since);
    var h = hist.get(Lk);
    stats.checks++;
    // CHOSEN: within a sixth of a tile on the same heading is jitter (we run a tick or two off the server), not an error
    if (h && Math.abs(A.dx(rec.x, h.x)) < 0.17 && Math.abs(A.dy(rec.y, h.y)) < 0.17 && h.dir === rec.dir) return;
    var ox = me.x, oy = me.y;
    stats.fixes++;
    stats.fixDist += Math.abs(h ? h.x - rec.x : 0) + Math.abs(h ? h.y - rec.y : 0);
    stats.last = (stats.last || []).slice(-7).concat([h ? [+(h.x - rec.x).toFixed(2), +(h.y - rec.y).toFixed(2), h.dir, rec.dir, rec.since] : 'nohist']);
    var st = { x: rec.x, y: rec.y, dir: rec.dir, want: wantAt(Lk + 1), pause: 0, moving: false };
    var speed = mySpeed();
    for (var j = Lk + 1; j <= L; j++) {
      for (var q = 0; q < inputs.length; q++) if (inputs[q].L === j - 1) st.want = inputs[q].d;
      var hj = hist.get(j);
      if (!(hj && hj.paused)) { Move.tryTurn(st, A); Move.advance(st, A, speed * DT); }
      hist.set(j, { x: st.x, y: st.y, dir: st.dir, paused: !!(hj && hj.paused) });
    }
    me.x = st.x; me.y = st.y; me.dir = st.dir; me.want = st.want;
    if (me.dir >= 0) me.face = me.dir;
    smooth.x += A.dx(me.x, ox); smooth.y += A.dy(me.y, oy);
    if (Math.abs(smooth.x) + Math.abs(smooth.y) > 3) smooth.x = smooth.y = 0;
  }

  // ---- interpolation
  function sampleWorld(now) {
    if (!snaps.length) return null;
    var rt = now - offset - R.INTERP_MS;
    var a = snaps[0], b = snaps[0];
    for (var i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i].t <= rt) { a = snaps[i]; b = snaps[i + 1] || snaps[i]; break; }
    }
    if (rt < snaps[0].t) { a = b = snaps[0]; }
    var k = b.t > a.t ? Math.max(0, Math.min(1, (rt - a.t) / (b.t - a.t))) : 0;
    return { a: a, b: b, k: k };
  }
  function lerp(p, q, k) {
    if (!p) return { x: q.x, y: q.y };
    var dx = A.dx(p.x, q.x), dy = A.dy(p.y, q.y);    // the short way: across a torus seam it is a small step
    if (Math.abs(dx) + Math.abs(dy) > 2) return { x: q.x, y: q.y };
    return { x: p.x + dx * k, y: p.y + dy * k };
  }

  function mouthFor(id, x, y, moving) {
    var lp = lastPos.get(id), ph = mouthPhase.get(id) || 0;
    if (lp) ph += Math.abs(A.dx(lp.x, x)) + Math.abs(A.dy(lp.y, y));
    lastPos.set(id, { x: x, y: y });
    mouthPhase.set(id, ph);
    if (!moving) return 0.25;
    var u = (ph / 0.75) % 1;                         // CHOSEN: one chew per 0.75 tile
    return 0.5 * (u < 0.5 ? u * 2 : 2 - u * 2);
  }

  // ---- drawing
  // Animation timings in 60 Hz ticks (sources in chompPixel.js TK and docs/chomp-look.md).
  var TK = window.ChompPixel ? window.ChompPixel.TK : { chew: 2, skirt: 8, flash: 14, flashes: 5, blink: 10, deathFreeze: 30, deathFrames: 14, deathFrame: 8 };
  var FLASH_WINDOW = TK.flashes * TK.flash * 2;          // the last 5 blue-white flashes of a fright
  var CHEW = [0, 1, 2, 1];                               // shut, half, wide, half
  var chew = new Map();                                  // id -> { t: ticks spent moving, f: frame shown }
  function flashing(left) {
    if (left <= 0 || left >= FLASH_WINDOW) return false;
    return Math.floor((FLASH_WINDOW - left) / TK.flash) % 2 === 1;
  }
  function chewFrame(id, moving, dt) {
    var c = chew.get(id);
    if (!c) { c = { t: 0, f: 2 }; chew.set(id, c); }
    if (moving) { c.t += dt; c.f = CHEW[Math.floor(c.t / TK.chew) % 4]; }
    else if (c.f === 0) c.f = 2;                         // jspacman: Pac-Man never stops with his mouth shut
    return c.f;
  }
  function deathFrame(t0, now) {
    var e = (now - t0) / STEP_MS;
    if (e < TK.deathFreeze) return -1;
    return Math.min(TK.deathFrames, Math.floor((e - TK.deathFreeze) / TK.deathFrame));
  }
  var lastRender = 0, renderErr = false;
  function render(now) {
    if (!draw || !A) return;
    var dtTicks = lastRender ? Math.min(10, (now - lastRender) / STEP_MS) : 0;
    lastRender = now;
    var tick = Math.floor(now / STEP_MS);
    var pixel = draw.L.id === 'pixel';
    var w = sampleWorld(now);
    var players = [], ghosts = [], fruit = [];
    var flashOn = Math.floor(now / (TK.flash * STEP_MS)) % 2 === 1;
    if (w) {
      w.b.ghosts.forEach(function (gb, i) {
        var ga = w.a.ghosts[i];
        var pos = lerp(ga, gb, w.k);
        var mode = 0;
        if (gb.state === 3 || gb.state === 4) mode = 3;
        var blue = blueForMe(i, gb);
        if (blue) mode = (pixel ? flashing(myPower) : myPower < FLASH_WINDOW && flashOn) ? 2 : 1;
        // while it flashes the skirt keeps step with the flash: 4 frames of 7 ticks (jspacman Ghost.js animations[2])
        var frame = blue && myPower < FLASH_WINDOW ? Math.floor((FLASH_WINDOW - myPower) / (TK.flash / 2)) % 2 : Math.floor(tick / TK.skirt) % 2;
        ghosts.push({ x: pos.x, y: pos.y, dir: gb.dir, look: gb.look, ki: gb.kind, mode: mode, frame: frame });
      });
      w.b.players.forEach(function (pb) {
        if (pb.id === myId && (predicting || !(pb.flags & Wire.F.DYING))) return;
        var pa = w.a.pmap.get(pb.id), pos = lerp(pa, pb, w.k);
        var meta = metas.get(pb.id) || { n: '', c: 0 };
        var others = draw.L.players.length - 1;
        var o = {
          x: pos.x, y: pos.y, dir: pb.dir >= 0 ? pb.dir : 1, name: meta.n, me: pb.id === myId,
          color: meta.look ? meta.look.col : pb.id === myId || (paidMode && pb.id === lastMyId) ? draw.L.me : draw.L.players[(meta.c % others) + 1],
          skin: meta.look && meta.look.k.art ? meta.look.k : null,
          mouth: mouthFor(pb.id, pos.x, pos.y, pb.flags & Wire.F.MOVING),
          frame: chewFrame(pb.id, pb.flags & Wire.F.MOVING, dtTicks)
        };
        if (pb.flags & Wire.F.DYING) {
          var t0 = dying.get(pb.id);
          if (t0 == null) { t0 = now; dying.set(pb.id, now); }
          o.dying = pixel ? deathFrame(t0, now) : Math.min(1, (now - t0) / (R.DEATH_S * 1000 * 0.85));
          if (pb.id === myId && me) { o.x = me.x; o.y = me.y; }
        } else {
          if (pb.flags & Wire.F.SAFE) { if (pixel) o.hidden = Math.floor(tick / 8) % 2 === 1; else o.alpha = Math.floor(now / 120) % 2 ? 0.35 : 1; }
          if (pb.flags & Wire.F.POWER) o.halo = true;
          if (myPower > 0 && !(pb.flags & (Wire.F.POWER | Wire.F.SAFE))) {
            o.scared = true;
            o.scaredFlash = pixel ? flashing(myPower) : myPower < FLASH_WINDOW && flashOn;
          }
        }
        players.push(o);
      });
    }
    if (predicting && me) {
      smooth.x *= 0.82; smooth.y *= 0.82;
      var mx = me.x + smooth.x, my = me.y + smooth.y, myMeta = metas.get(myId), myLook = myMeta && myMeta.look;
      players.push({
        x: mx, y: my, dir: me.face, me: true, color: myLook ? myLook.col : draw.L.me, skin: myLook && myLook.k.art ? myLook.k : null,
        mouth: mouthFor(myId, mx, my, me.moving),
        frame: chewFrame(myId, me.moving, dtTicks),
        alpha: !pixel && mySafe ? (Math.floor(now / 120) % 2 ? 0.35 : 1) : 1, hidden: pixel && mySafe && Math.floor(tick / 8) % 2 === 1, halo: myPower > 0
      });
    }
    fruitOn.forEach(function (mi) { var m = A.modules[mi]; if (m) fruit.push({ x: m.ox + Maze.FRUIT.x, y: m.oy + Maze.FRUIT.y }); });
    // camera
    var target = null;
    if (predicting && me) target = { x: me.x + smooth.x, y: me.y + smooth.y };
    else if (w && phase === 'watch') {
      var wb = w.b.pmap.get(watchId);
      if (!wb || (wb.flags & Wire.F.DYING)) { if (tick % 30 === 0) stepWatch(1); }
      else { var wp = lerp(w.a.pmap.get(watchId), wb, w.k); target = { x: wp.x, y: wp.y }; }
    } else if (w) {
      var follow = lbRows.length ? w.b.pmap.get(lbRows[0][0]) : w.b.players[0];
      if (follow) target = { x: follow.x, y: follow.y };
    }
    if (!target) target = { x: A.W / 2, y: A.H / 2 };
    if (!camSet) { cam.x = target.x; cam.y = target.y; camSet = true; }
    // a paid seat that just ended keeps its spot on screen (the coins it dropped are there)
    var kf = predicting ? 1 : phase === 'watch' ? 0.2 : paidMode && phase === 'over' ? 0 : 0.04;
    cam.x += A.dx(cam.x, target.x) * kf; cam.y += A.dy(cam.y, target.y) * kf;
    var cx, cy;
    if (A.wrap) {
      // Owen 2026-10-26: the camera stays on you (a torus has no edge for it to stop at), from the first frame
      cam.x = A.wx(cam.x); cam.y = A.wy(cam.y);
      cx = cam.x; cy = cam.y;
      var ux = function (o) { o.x = cx + A.dx(cx, o.x); o.y = cy + A.dy(cy, o.y); };
      players.forEach(ux); ghosts.forEach(ux); fruit.forEach(ux);
    } else {
      var vw = canvas.width / draw.S, vh = canvas.height / draw.S - (pixel ? 5 : 0);
      cx = vw >= A.W + 2 ? A.W / 2 : Math.max(vw / 2 - 1, Math.min(A.W - vw / 2 + 1, cam.x));
      cy = vh >= A.H + 2 ? A.H / 2 : Math.max(vh / 2 - 1, Math.min(A.H - vh / 2 + 1, cam.y));
    }
    // where your chomper is on screen (the short way from the camera): the hold ring and the spawn cue go there
    var meX = predicting && me ? cx + A.dx(cx, me.x + smooth.x) : 0, meY = predicting && me ? cy + A.dy(cy, me.y + smooth.y) : 0;
    // points that pop: a ghost's for 60 ticks (the arcade's freeze while it shows), fruit's for 80 (jspacman)
    var ps = [];
    pops = pops.filter(function (q) { return now - q.at < q.ms; });
    pops.forEach(function (q) { ps.push({ x: cx + A.dx(cx, q.x), y: cy + A.dy(cy, q.y), text: q.text, color: q.color, a: 1 }); });
    pending.forEach(function (exp, k) { if (now > exp) { pending.delete(k); dotsView[k] = dotsServer[k]; } });
    var coinsNear = A.wrap ? coinList.map(function (co) {
      return { c: Math.floor(cx + A.dx(cx, co.c + 0.5)), r: Math.floor(cy + A.dy(cy, co.r + 0.5)) };
    }) : coinList;
    var scene = { cam: { x: cx, y: cy }, t: now, tick: tick, dots: dotsView, players: players, ghosts: ghosts, fruit: fruit, pops: ps,
      coins: coinsNear };
    if (pixel && !attract) {
      var high = lbRows.length ? lbRows[0][1] : 0;
      scene.hud = phase === 'play' || phase === 'over'
        ? { score: myScore, high: Math.max(high, myScore), lives: Math.max(0, myLives - 1), fruit: true, blink: phase === 'play' }
        : { score: 0, high: high, lives: 0, fruit: true, watch: phase === 'watch' };
      if (stakeNow > 0) {
        // a paid room: money in place of the scores (yours while you play, the richest chomper's beside it)
        var mine = phase === 'play' ? myMoney : 0;
        scene.hud.money = usd(mine);
        scene.hud.highMoney = usd(Math.max(high, mine));
        scene.hud.fruit = false;
      }
      if (predicting && me && me.dir < 0 && phase === 'play') scene.banner = { text: 'READY!', color: draw.C.yellow, x: meX, y: meY - 6 };
    }
    draw.frame(scene);
    if (!pixel) hud(now);
    if (predicting && me && phase === 'play') {
      if (flow) flow.onFrame(1);
      var hp = hold ? hold.progress() : 0;
      if (hp > 0 && window.DSEnd && draw.view) {
        var v = draw.view;
        var rx = (v.ox + meX * v.T) * v.k, ry = (v.oy + meY * v.T) * v.k;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        window.DSEnd.ring(ctx, rx, ry, 12 * v.k, hp, now, { lw: 2.2 * v.k, mobile: isTouch });
      }
      spawnCue(now, meX, meY);
    }
    syncCashBtn();
    if (myPower > 0 && Math.floor(now / 400) !== hud.lastBeat) { hud.lastBeat = Math.floor(now / 400); Snd.play('ch.scared'); }
  }

  // Owen 2026-10-26: "if I die before I even find my character": for SPAWN_CUE_MS after you come on the maze, two
  // rings in your colour close in on your chomper (drawn over the scene, at screen sharpness), while the spawn blink
  // keeps every ghost off you.
  var SPAWN_CUE_MS = 2000, spawnAt = 0;
  function cueSpawn() { spawnAt = performance.now(); }
  function spawnCue(now, x, y) {
    var t = now - spawnAt;
    if (!spawnAt || t < 0 || t > SPAWN_CUE_MS || !draw || !draw.view) return;
    var v = draw.view, sx = (v.ox + x * v.T) * v.k, sy = (v.oy + y * v.T) * v.k;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineWidth = Math.max(2, v.k * 1.5);
    for (var i = 0; i < 2; i++) {
      var u = ((t / 700) + i * 0.5) % 1;                 // each ring closes from 40 px to 12 px (arcade px) in 0.7 s
      ctx.globalAlpha = (1 - u) * (1 - t / SPAWN_CUE_MS * 0.5);
      ctx.strokeStyle = draw.L.me;
      ctx.beginPath();
      ctx.arc(sx, sy, (12 + 28 * (1 - u)) * v.k, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  function hud(now) {
    if (attract) return;
    var dpr = draw.dpr, W = canvas.width, H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    var u = Math.max(9, Math.round(Math.min(W, H) / 52));
    ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    ctx.font = u + 'px "Press Start 2P", monospace';
    if (phase === 'play') {
      ctx.fillStyle = '#ffffff';
      ctx.fillText('SCORE', u * 1.5, u * 1.5);
      ctx.font = Math.round(u * 1.6) + 'px "Press Start 2P", monospace';
      ctx.fillText(fmt(myScore), u * 1.5, u * 3.1);
      // lives: small chompers bottom left (the one in play not counted, as in the arcade)
      var lr = u * 0.75;
      for (var i = 0; i < Math.min(6, myLives - 1); i++) {
        Draw.drawChomper(ctx, u * 2 + i * lr * 2.8, H - u * 2, lr, 1, 0.33, draw.L.me);
      }
      if (predicting && me && me.dir < 0 && now < readyUntil + 4000) {
        ctx.font = Math.round(u * 1.1) + 'px "Press Start 2P", monospace';
        ctx.textAlign = 'center'; ctx.fillStyle = '#ffff00';
        ctx.fillText('READY!', W / 2, H / 2 + draw.S * 1.4);
      }
    }
  }

  function showBoard() {
    if (!window.DSEnd || attract) return;
    // a phone held sideways is wider than dsEnd's phone cut but short: it gets the phone's 5 rows, not 10
    if (!board) board = window.DSEnd.board({ title: 'Leaderboard', money: stakeNow > 0, rowsPC: isTouch || window.innerHeight < 520 ? 5 : 10 });
    var val = stakeNow > 0 ? usd : fmt;
    var rows = lbRows.map(function (r) {
      var m = metas.get(r[0]);
      return { name: m ? m.n : '', value: val(r[1]), me: r[0] === myId };
    });
    board.set(rows, myId && myRank ? { rank: myRank, name: (metas.get(myId) || {}).n || 'You', value: val(stakeNow > 0 ? myMoney : myScore) } : null);
  }

  function toast(text) {
    var t = document.getElementById('toast');
    t.textContent = text; t.hidden = false;
    clearTimeout(toast.h); toast.h = setTimeout(function () { t.hidden = true; }, 3000);
  }

  // ---- the loop: fixed 60 Hz steps for the prediction, one draw per screen frame
  var last = performance.now(), acc = 0;
  function loop(now) {
    acc += now - last; last = now;
    if (acc > 250) acc = 250;
    while (acc >= STEP_MS) { stepLocal(); acc -= STEP_MS; }
    // a drawing error must never stop the loop (the game and its steering go on); it is reported once
    try { render(now); } catch (e) { if (!renderErr) { renderErr = true; console.error('[chomp] render', e); } }
    requestAnimationFrame(loop);
  }

  nameEl.value = store('chomp.name') || '';
  if (inLobby) {
    var lobbyName = '';
    try { lobbyName = String(sessionStorage.getItem('playerName') || '').trim().slice(0, 15); } catch (e) { lobbyName = ''; }
    if (lobbyName) nameEl.value = lobbyName;
  }
  if (attract) titleEl.hidden = true;
  // the shared chat (dsChat.js): T to type, a button on phones; only a seated chomper sends
  var chat = window.DSChat ? window.DSChat.mount({
    send: function (t) { if (!socket || !socket.connected) return false; socket.emit('c:chat', { text: t }); return true; },
    canSend: function () { return phase === 'play' && predicting && (!flow || flow.canSteer()); },
    pc: { left: 16, bottom: 56 },
    phoneAt: { left: 10, top: 64 }
  }) : null;
  function syncChat() { if (chat) chat.visible(phase === 'play' || phase === 'watch'); }
  setInterval(syncChat, 250);
  // the lobby's Spectate (play.js WATCH_PAGE) leaves dsWatch=chomp for the page it opens (dsWatchStake: a paid rung,
  // watched read only in that rung's busiest room)
  var watchStake = 0;
  try {
    if (!paidMode && sessionStorage.getItem('dsWatch') === 'chomp') {
      sessionStorage.removeItem('dsWatch');
      watchStake = Number(sessionStorage.getItem('dsWatchStake')) || 0;
      sessionStorage.removeItem('dsWatchStake');
      watchAsked = true;
      setTimeout(startWatch, 600);
    }
  } catch (e) { /* storage blocked: the title card shows */ }
  if (paidMode) {
    titleEl.hidden = true;
    unveil();
    phase = 'joining';
    var AP = window.DuelAgarLib.agPaid;
    pcard = PAID.createCard({ onLobby: function () { backToLobby(); }, onSpectate: function () { pcard.hide(); startWatch(); } });
    lock = PAID.createLock(window);
    hold = PAID.createHold({
      win: window, tickMs: STEP_MS,
      can: function () { return !!(socket && socket.connected && flow && flow.canSteer() && phase === 'play'); },
      send: function (on) { if (!socket || !socket.connected) return false; socket.emit('c:hold', { on: on ? 1 : 0 }); return true; }
    });
    var ss = null;
    try { ss = window.sessionStorage; } catch (e) { ss = null; }
    flow = AP.createFlow({
      handoff: hand, store: ss, win: window, game: 'chomp', text: PAID.WORDS, refused: PAID.REFUSED, resumeKey: PAID.RESUME_KEY,
      send: function (kind, payload) {
        if (!socket || !socket.connected) return false;
        if (kind === 'paidJoin') socket.emit('c:join', payload);
        else if (kind === 'ready') socket.emit('c:ready');
        return true;
      },
      reconnect: function () { if (socket && !socket.connected) socket.connect(); },
      card: function () { return pcard; },
      enterPlay: enterPaidPlay,
      freshTarget: function () {},
      lock: function (on) { lock.setPage(on); },
      touch: function () { return isTouch; },
      chip: (paidChip = AP.createChip(document, document.body)),
      framed: framed, parent: window.parent, origin: location.origin
    });
    pcard.onAgain = function () { flow.restake(); };
    // only the lobby around this page, on this origin (agPaid onMessage checks the request's nonce too)
    window.addEventListener('message', function (e) {
      if (e.origin !== location.origin || e.source !== window.parent) return;
      flow.onMessage(e);
    });
    window.addEventListener('pagehide', function () {
      flow.onPageHide();
      // a token that never went out goes back with its launch mark, so the reloaded page is still the paid one
      try { if (flow.state().unspent && ss) ss.setItem(PAID.LAUNCH_KEY, '1'); } catch (e) { /* storage gone */ }
    });
    window.addEventListener('pageshow', function (e) { flow.onPageShow(e); });
    flow.start();
  }
  window.ChompPage = {
    state: function () { return { phase: phase, myId: myId, predicting: predicting, me: me, score: myScore, lives: myLives, stats: stats, snaps: snaps.length, look: draw && draw.L.id,
      paid: paidMode, stake: stakeNow, money: myMoney, coins: coins.size, locked: !!(lock && lock.locked()), hold: hold ? hold.progress() : 0,
      flow: flow ? flow.state() : null, card: pcard ? pcard.kind : '' }; },
    dims: function () { return A ? A.mx + 'x' + A.my : null; },
    // read only, for the headless checks: the maze, the dots as drawn, your own fright and boost, how many ghosts are
    // blue for you in the newest snapshot, and your Customize look
    view: function () {
      var s = snaps[snaps.length - 1], mm = metas.get(myId);
      return { A: A, dots: dotsView, power: myPower, boost: myBoost,
        blue: s ? s.ghosts.filter(function (g, i) { return blueForMe(i, g); }).length : 0,
        ghosts: s ? s.ghosts.length : 0, gt: s ? s.ghosts.map(function (g) { return [Math.floor(g.x), Math.floor(g.y), g.state]; }) : [],
        eyes: s ? s.ghosts.filter(function (g) { return g.state === 3 || g.state === 4; }).length : 0,
        skin: mm && mm.look ? (mm.look.k.id || mm.look.col) : '' };
    },
    setLook: function (n) { lookName = n; if (A) { draw = n === 'pixel' && window.ChompPixel ? new window.ChompPixel(canvas, A) : new Draw(canvas, A, n); resize(); } } };
  if (!(flow && flow.offline())) connect();
  requestAnimationFrame(loop);
})();
