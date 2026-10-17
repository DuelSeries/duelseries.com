// DuelSeries layer on the frozen slither.io client: the nightly battle royale on the /sl page (server/slBr; Owen
// 2026-10-15: the event plays exactly like the free room, with the wandering circle and spectate kept). Ours, not a
// parity area. Loaded by the /sl page after slxPaid.js and before slxMain.js (server/sl/slBoot.js SLX_FILES).
//
// Inert unless slxNet installed the production transport, and a plain free page unless the lobby launched the event:
// public/js/v2/play.js writes sessionStorage 'slBr' = 'play' (Join) or 'watch' (Watch) before it opens /sl in the
// game frame. The mark is taken out at boot (a later free launch is never the event) and kept in this closure.
//
// 1. The handshake (slxMain merges slx.brAuth into slx.auth): { br: 1 } always; a player adds idProof, a one-time
//    signature by their own wallet over 'play:identify' asked of the lobby through the duel:signaction bridge
//    (public/js/v2/play.js, answered only for #game-frame on this origin), so the server knows where the prize goes;
//    a watcher adds watch: 1 (and follow, a snake id). The proof is spent by the socket that opens with it, so every
//    Play asks for a fresh one first (slx.brLaunch for the lobby's first Play, beforeAgain for the card's).
// 2. The circle (sl:x {t: 'br', z}): one .slx-br canvas between their game canvas and their HUD (slxPaid's camera
//    math): the outside tinted red, the wall as a red line, the announced circle as a white dashed ring. z is a whole
//    ring { f, t, w, m } and the lerp runs on this page's clock, so the wall moves smoothly between messages.
// 3. The HUD, one block at the top centre: the 10 s count and GO, the winner's moment or the phase, how many are
//    left of how many started, the next move of the wall; the owner's Start match (shown only when the server said owner for this seat; the action is still signed by the
//    owner wallet and checked at /api/owner/do).
// 4. The card (slxCard hooks): out of a running match, Play again is Watch; the podium and the prize line when one
//    is decided; between matches, when the next one starts.
// 5. Watching: their client follows the watched snake as its own; mouse, touch and the boost keys on the game are
//    swallowed here so nothing on screen pretends to steer it. When it ends the next survivor is watched at once.
(function (root) {
  'use strict';
  var D = root.DuelSlither;
  if (!D || !D.slx || !D.slx.active) return;
  var slx = D.slx;
  var S = D.S;
  var doc = root.document;
  if (!S || !doc) return;

  var KEY = 'slBr';
  var mode = '';
  try {
    var ss = root.sessionStorage;
    mode = String((ss && ss.getItem(KEY)) || '');
    if (ss) ss.removeItem(KEY);
  } catch (e) {
    mode = '';
  }
  if (mode !== 'play' && mode !== 'watch') return;
  // A mark left behind by a launch whose page never booted must not make a later PAID page the event's: slxPaid
  // (loaded before this file) owns that page.
  if (slx.paid && slx.paid.on === true) return;
  if (typeof slx.paidHold === 'function' && slx.paidHold() === true) return;

  var BR_Z = '6'; // between their game canvas (5) and their HUD (7), as slxPaid's cash canvas
  var PRIZE_WORDS = '$20';
  var PHASE = {
    waiting: 'Battle Royale', countdown: 'Starting', warning: 'Next circle', closing: 'Circle closing',
    holding: 'The circle is set', over: 'Match over', reopening: 'Match over'
  };

  var proof = null; // the one-time identity proof for the next socket (spent on open)
  var proven = false; // this life's wallet signed (the prize can go to it)
  var st = null; // the last sl:x {t: 'br'}
  var stAt = 0; // this page's clock when it came
  var owner = false; // the server said this seat is the owner's
  var myId = 0; // the own snake's id this life (the winner check)
  var lastMyId = 0;
  var watching = null; // { id, name } while watching
  var errors = 0;

  function now() {
    return typeof slx.now === 'function' ? slx.now() : Date.now();
  }

  // ---- 1. the handshake and the proof

  var signSeq = 0;
  // Asks the lobby's wallet to sign action; resolves the proof, or null (no lobby, refused, 10 s with no answer).
  function sign(action, args) {
    return new Promise(function (resolve) {
      var parent = root.parent;
      var origin = root.location && root.location.origin;
      if (!parent || parent === root || !origin || origin === 'null') {
        resolve(null);
        return;
      }
      var id = 'br' + (++signSeq);
      var done = false;
      function finish(v) {
        if (done) return;
        done = true;
        root.removeEventListener('message', onMsg);
        resolve(v);
      }
      function onMsg(e) {
        if (e.source !== parent || e.origin !== origin) return;
        var d = e.data;
        if (!d || d.id !== id) return;
        if (d.type === 'duel:signaction:done') finish(d.proof && typeof d.proof === 'object' ? d.proof : null);
        else if (d.type === 'duel:signaction:error') finish(null);
      }
      root.addEventListener('message', onMsg);
      try {
        parent.postMessage({ type: 'duel:signaction', id: id, action: action, args: args || {} }, origin);
      } catch (e) {
        finish(null);
        return;
      }
      root.setTimeout(function () { finish(null); }, 10000);
    });
  }

  function withProof(go) {
    if (mode === 'watch') {
      go();
      return;
    }
    sign('play:identify', {}).then(function (p) {
      proof = p;
      proven = !!p;
      go();
    });
  }

  slx.brAuth = function () {
    var a = { br: 1 };
    if (mode === 'watch') {
      a.watch = 1;
      if (watching && watching.next) a.follow = watching.next;
    } else if (proof) {
      a.idProof = proof;
    }
    return a;
  };
  // the lobby's first Play (slxMain): the proof first, then their Play under the lobby name
  slx.brLaunch = function (name) {
    withProof(function () { D.play(name); });
    return true;
  };

  slx.on('open', function () {
    proof = null; // spent: the server checked it with this socket's sl:join
    myId = 0;
    if (mode !== 'watch') watching = null;
  });
  slx.on('ownAdd', function (ev) {
    if (ev && typeof ev.id === 'number') {
      myId = ev.id;
      if (mode !== 'watch') {
        lastMyId = ev.id;
        seenResult = false; // a new life of their own: the last match's result is not this life's card
      }
    }
  });
  slx.on('x:watch', function (m) {
    watching = { id: m.id, name: typeof m.name === 'string' ? m.name : '' };
  });
  slx.on('x:br', function (m) {
    var was = st ? st.state : '';
    st = m;
    stAt = now();
    noteResult();
    // A watcher following a bot that won: the bot stays in the arena (no cash-out for a bot), so their life would
    // never end and the result card never come. The match closing ends it from here, as Next does.
    if (mode === 'watch' && was === 'over' && m.state === 'reopening' && m.winner && m.winner.bot &&
      typeof slx.endLife === 'function') {
      root.setTimeout(function () { if (mode === 'watch') slx.endLife(); }, 600);
    }
    if (m.owner === true) owner = true;
    hudPaint();
    if (slx.card && typeof slx.card.refresh === 'function') slx.card.refresh();
  });

  // ---- 2. the circle

  var canvas = null;
  var ctx = null;
  var cw = -1;
  var ch = -1;
  var cdpr = -1;
  var body = doc.body;

  if (body) {
    canvas = doc.createElement('canvas');
    canvas.className = 'slx-br';
    var cs = canvas.style;
    cs.position = 'fixed';
    cs.left = '0px';
    cs.top = '0px';
    cs.pointerEvents = 'none';
    cs.zIndex = BR_Z;
    body.appendChild(canvas);
    ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  }

  function fit() {
    var w = root.innerWidth;
    var hh = root.innerHeight;
    var dpr = root.devicePixelRatio > 0 ? root.devicePixelRatio : 1;
    if (w === cw && hh === ch && dpr === cdpr) return;
    cw = w;
    ch = hh;
    cdpr = dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = hh + 'px';
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(hh * dpr));
  }

  // their camera (slxPaid screenX, screenY)
  function screenX(wx) {
    return Math.floor(S.ww / 2 - S.mww / 2) + S.mww / 2 + (wx - S.view_xx) * S.gsc * S.csc;
  }
  function screenY(wy) {
    return Math.floor(S.hh / 2 - S.mhh / 2) + S.mhh / 2 + (wy - S.view_yy) * S.gsc * S.csc;
  }

  // The circle now, from the last message's ring and this page's clock: { x, y, r, tgt } or null.
  function zoneNow(t) {
    var z = st && st.z;
    if (!z || !z.f) return null;
    var f = z.f;
    if (!z.t || !(z.m > 0)) return { x: f[0], y: f[1], r: f[2], tgt: null };
    var el = t - stAt - (z.w || 0);
    var k = el <= 0 ? 0 : Math.min(1, el / z.m);
    if (z.ease) k = 1 - (1 - k) * (1 - k);
    return {
      x: f[0] + (z.t[0] - f[0]) * k,
      y: f[1] + (z.t[1] - f[1]) * k,
      r: f[2] + (z.t[2] - f[2]) * k,
      tgt: z.ease ? null : { x: z.t[0], y: z.t[1], r: z.t[2] }
    };
  }

  // The circle on their minimap too: a small canvas over their minimap holder (above their HUD), mapped as their
  // own dot is (slHud.js oefDot: mmrad + 12 + mmrad x (x - grd) / flux_grd inside the holder).
  var mm = null;
  var mctx = null;
  var mmShown = false;
  if (body) {
    mm = doc.createElement('canvas');
    mm.className = 'slx-br-mm';
    var ms = mm.style;
    ms.position = 'fixed';
    ms.pointerEvents = 'none';
    ms.zIndex = '8';
    ms.display = 'none';
    body.appendChild(mm);
    mctx = typeof mm.getContext === 'function' ? mm.getContext('2d') : null;
  }
  function drawMini(c) {
    var dot = S.myloc;
    var holder = dot && dot.parentNode;
    if (!c || !mctx || !holder || typeof holder.getBoundingClientRect !== 'function' || !(S.mmrad > 0) ||
      !(S.flux_grd > 0)) {
      if (mmShown) mm.style.display = 'none';
      mmShown = false;
      return;
    }
    var r = holder.getBoundingClientRect();
    if (!(r.width > 0)) return;
    var ow = holder.offsetWidth || r.width;
    var s = r.width / ow;
    var dpr = cdpr > 0 ? cdpr : 1;
    var w = Math.max(1, Math.round(r.width * dpr));
    var h = Math.max(1, Math.round(r.height * dpr));
    if (mm.width !== w || mm.height !== h) {
      mm.width = w;
      mm.height = h;
    }
    mm.style.left = r.left + 'px';
    mm.style.top = r.top + 'px';
    mm.style.width = r.width + 'px';
    mm.style.height = r.height + 'px';
    if (!mmShown) mm.style.display = 'block';
    mmShown = true;
    mctx.setTransform(dpr * s, 0, 0, dpr * s, 0, 0);
    mctx.clearRect(0, 0, ow, r.height / s);
    var R = S.mmrad;
    var k = R / S.flux_grd;
    mctx.beginPath();
    mctx.arc(R + 12 + (c.x - S.grd) * k, R + 12 + (c.y - S.grd) * k, Math.max(0.5, c.r * k), 0, Math.PI * 2);
    mctx.lineWidth = 1.5;
    mctx.strokeStyle = 'rgba(255, 80, 80, 0.95)';
    mctx.stroke();
    if (c.tgt && st && (st.phase === 'warning' || st.phase === 'closing')) {
      mctx.beginPath();
      mctx.arc(R + 12 + (c.tgt.x - S.grd) * k, R + 12 + (c.tgt.y - S.grd) * k, Math.max(0.5, c.tgt.r * k), 0, Math.PI * 2);
      mctx.setLineDash([3, 3]);
      mctx.lineWidth = 1;
      mctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      mctx.stroke();
      mctx.setLineDash([]);
    }
  }

  var drawnZone = false;
  function draw() {
    fit();
    var c = S.connected && S.view_xx !== undefined ? zoneNow(now()) : null;
    drawMini(c);
    if (!c) {
      if (drawnZone) ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawnZone = false;
      return;
    }
    drawnZone = true;
    var dpr = cdpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    var k = S.gsc * S.csc;
    var sx = screenX(c.x);
    var sy = screenY(c.y);
    var sr = Math.max(0, c.r * k);
    // the outside, tinted: everything but the disc
    ctx.beginPath();
    ctx.rect(0, 0, cw, ch);
    ctx.arc(sx, sy, sr, 0, Math.PI * 2, true);
    ctx.fillStyle = 'rgba(150, 10, 20, 0.30)';
    ctx.fill();
    // the wall
    ctx.beginPath();
    ctx.arc(sx, sy, sr, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(2, 5 * k);
    ctx.strokeStyle = 'rgba(255, 70, 70, 0.95)';
    ctx.stroke();
    // where it is going
    if (c.tgt && st && (st.phase === 'warning' || st.phase === 'closing')) {
      var pulse = 0.65 + 0.35 * Math.sin(now() / 180);
      ctx.beginPath();
      ctx.arc(screenX(c.tgt.x), screenY(c.tgt.y), Math.max(0, c.tgt.r * k), 0, Math.PI * 2);
      ctx.setLineDash([14, 11]);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = 'rgba(255, 255, 255, ' + pulse.toFixed(3) + ')';
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // ---- 3. the HUD
  // One block at the top centre (Owen 2026-10-16: nothing in the middle of the screen). Its head line is the moment
  // (the countdown, GO, the winner), bigger, or else the phase; the line under it says how many are in the match and
  // what comes next; the owner's Start match sits under that. The block takes the slot slxHud keeps clear of their
  // leaderboard and top left box (slx.hud.topSlot: beside them on a computer and on a phone held sideways, just under
  // the smaller board on a phone held upright), so it never covers the snake in the middle or their minimap.

  var hud = null;
  var hudHead = null;
  var hudSub = null;
  var startBtn = null;
  var lobbyBtn = null;
  var hudKey = '';
  var hudW = 0; // the block's width, read when what it says changes
  var hudTop = -1;
  var TOP_PX = 8; // without slxHud
  var FONT = 'Arial,"Helvetica Neue",Helvetica,sans-serif';
  var style = doc.createElement('style');
  style.textContent = [
    '.slx-br-hud{position:fixed;top:' + TOP_PX + 'px;left:50%;transform:translateX(-50%);z-index:8;' +
      'box-sizing:border-box;width:max-content;max-width:calc(100vw - 24px);padding:5px 14px 6px;border-radius:12px;' +
      'background:rgba(0,0,0,.42);text-align:center;color:#fff;font:13px ' + FONT + ';' +
      'text-shadow:0 1px 3px rgba(0,0,0,.9);pointer-events:none;-webkit-user-select:none;user-select:none;' +
      'opacity:0;transition:opacity .5s ease-out;}',
    '.slx-br-hud.slx-br-in{opacity:1;}',
    '@media (prefers-reduced-motion:reduce){.slx-br-hud{transition:none;}}',
    '.slx-br-head{font-weight:bold;font-size:16px;line-height:20px;white-space:nowrap;}',
    '.slx-br-now .slx-br-head{font-size:24px;line-height:29px;}',
    '.slx-br-sub{margin-top:1px;line-height:17px;opacity:.92;}',
    '.slx-br-start{display:none;margin:6px auto 0;padding:6px 16px;border:0;border-radius:6px;background:#14F195;' +
      'color:#06231a;font:bold 14px ' + FONT + ';text-shadow:none;cursor:pointer;pointer-events:auto;}',
    '.slx-br-lobby{position:fixed;top:10px;left:10px;z-index:9;display:none;padding:6px 14px;border:1px solid #ccc;' +
      'border-radius:4px;background:#fff;color:#333;font:bold 13px ' + FONT + ';cursor:pointer;}',
    // a phone page laid out at 0.7, either way up (slx.hud.phone() and zoom() > 1; no media query can tell). In the
    // lobby's game frame the page is at 1 (a frame ignores the viewport line), so the plain sizes are a phone's there.
    '.slx-br-phone.slx-br-hud{max-width:calc(100vw - 16px);padding:4px 12px 5px;font-size:15px;}',
    '.slx-br-phone .slx-br-head{font-size:18px;line-height:22px;}',
    '.slx-br-phone.slx-br-now .slx-br-head{font-size:26px;line-height:31px;}',
    '.slx-br-phone .slx-br-sub{line-height:19px;}'
  ].join('\n');
  (doc.head || body).appendChild(style);
  if (body) {
    hud = doc.createElement('div');
    hud.className = 'slx-br-hud slx-br-ui';
    hudHead = doc.createElement('div');
    hudHead.className = 'slx-br-head';
    hudSub = doc.createElement('div');
    hudSub.className = 'slx-br-sub';
    hud.appendChild(hudHead);
    hud.appendChild(hudSub);
    startBtn = doc.createElement('button');
    startBtn.className = 'slx-br-start slx-br-ui';
    startBtn.type = 'button';
    startBtn.textContent = 'Start match';
    hud.appendChild(startBtn);
    body.appendChild(hud);
    // While watching there is no card (the watched snake is alive), so this is the way out
    lobbyBtn = doc.createElement('button');
    lobbyBtn.className = 'slx-br-lobby slx-br-ui';
    lobbyBtn.type = 'button';
    lobbyBtn.textContent = 'Lobby';
    body.appendChild(lobbyBtn);
  }

  var say = '';
  var sayUntil = 0;
  function hudSay(text) {
    say = text;
    sayUntil = now() + 4000;
    hudPaint();
  }

  function secsLeft(ms) {
    return Math.max(0, Math.ceil((ms - (now() - stAt)) / 1000));
  }

  function clock(ms) {
    var left = Math.max(0, ms - (now() - stAt));
    var h = Math.floor(left / 3600000);
    var m = Math.floor((left % 3600000) / 60000);
    var s = Math.floor((left % 60000) / 1000);
    return (h ? h + 'h ' : '') + m + 'm ' + s + 's';
  }

  function players(n) {
    return n + (n === 1 ? ' player' : ' players');
  }

  // How many are left, out of how many started when the server says (startedCount, server/slBr/brMatch.js).
  function leftLine() {
    var alive = st.alive || 0;
    var from = st.startedCount || 0;
    return (from >= alive && from > 0 ? alive + ' of ' + from : alive) + ' left';
  }

  // -> { head, sub, now }: now is a moment (the countdown, GO, the winner), drawn bigger while this page is live
  function hudText() {
    var phase = st.phase || st.state;
    var head = PHASE[phase] || 'Battle Royale';
    var sub = '';
    var moment = false;
    var w = st.winner;
    if (st.state === 'countdown') {
      var n = secsLeft(st.countdownMs || 0);
      head = n > 0 ? 'Starting in ' + n : 'GO';
      moment = true;
      sub = players(st.alive || 0) + ' · last snake alive wins' + (st.prize > 0 ? ' ' + PRIZE_WORDS : '');
    } else if (st.state === 'running') {
      if (now() - stAt < 1200 && st.elapsedMs < 1500) {
        head = 'GO';
        moment = true;
      }
      sub = leftLine() + ' · ' + (phase === 'warning' ? 'circle closes in ' + secsLeft(st.zoneMs || 0) + 's'
        : phase === 'closing' ? 'get inside the circle' : 'last snake alive wins') + (st.soloRun ? ' · solo run' : '');
    } else if (st.state === 'over' || st.state === 'reopening') {
      if (st.state === 'over' && w) {
        head = myId && w.id === myId && mode === 'play' ? 'You won!' : w.name + ' wins';
        moment = true;
      }
      sub = st.soloRun ? (w ? w.name + ' lasted the whole match' : 'The circle won')
        : !w ? 'Nobody survived'
          : moment ? 'Last snake alive' + (st.startedCount > 1 ? ' of ' + st.startedCount : '') : w.name + ' won';
    } else {
      sub = players(st.alive || 0) + ' · next match in ' + clock(st.nextStartMs || 0);
    }
    if (mode === 'watch' && watching && watching.name) sub = 'Watching ' + watching.name + ' · ' + sub;
    if (say && now() < sayUntil) sub = say;
    return { head: head, sub: sub, now: moment && (typeof slx.connected !== 'function' || slx.connected()) };
  }

  // The block comes in with the game, as the board does (their menu fades out, the game in), never on top of their
  // menu while the lobby's wallet signs: from the first life, or once the sign wait (10 s) is over whatever happened.
  var bootAt = now();
  var LATE_MS = 10500;
  var cameIn = false;

  function hudPaint() {
    if (!hud || !st) return;
    if (!cameIn && (S.playing || now() - bootAt > LATE_MS)) cameIn = true;
    var t = hudText();
    if (hudHead.textContent !== t.head) hudHead.textContent = t.head;
    if (hudSub.textContent !== t.sub) hudSub.textContent = t.sub;
    var hs = slx.hud;
    var big = hs && typeof hs.phone === 'function' && hs.phone() && !(typeof hs.zoom === 'function' && hs.zoom() === 1);
    var cls = 'slx-br-hud slx-br-ui' + (t.now ? ' slx-br-now' : '') + (big ? ' slx-br-phone' : '') +
      (cameIn ? ' slx-br-in' : '');
    if (hud.className !== cls) hud.className = cls;
    // the owner's Start while the arena waits, playing or watching (a dead owner watching the end starts the next)
    var sd = owner && st.state === 'waiting' ? 'block' : 'none';
    if (startBtn && startBtn.style.display !== sd) startBtn.style.display = sd;
    if (lobbyBtn) lobbyBtn.style.display = mode === 'watch' && S.connected ? 'block' : 'none';
    var key = cls + '|' + t.head + '|' + t.sub + '|' + sd;
    if (key !== hudKey) {
      hudKey = key;
      hudW = hud.offsetWidth || 0;
    }
    var top = hs && typeof hs.topSlot === 'function' ? hs.topSlot(hudW) : TOP_PX;
    if (top !== hudTop) {
      hudTop = top;
      hud.style.top = top + 'px';
    }
  }

  if (startBtn && typeof slx.guard === 'function') bindStart();
  function bindStart() {
    if (lobbyBtn) {
      slx.guard(lobbyBtn, { activate: function () {
        if (typeof slx.toLobby === 'function' && slx.toLobby()) return;
        try {
          root.location.assign('/');
        } catch (e) { /* nothing to do */ }
      } });
    }
    var busy = false;
    var act = function () {
      if (busy) return;
      busy = true;
      startBtn.textContent = 'Check your wallet…';
      sign('br:start', {}).then(function (p) {
        if (!p) {
          hudSay('The wallet did not sign.');
          return null;
        }
        return root.fetch('/api/owner/do', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(p) }).then(function (r) {
          return r.json().then(function (j) {
            hudSay(r.ok ? (j.note || 'Started') : (j.error || 'Refused'));
          });
        });
      }).catch(function () {
        hudSay('Could not reach the server.');
      }).then(function () {
        busy = false;
        startBtn.textContent = 'Start match';
      });
    };
    slx.guard(startBtn, { activate: act });
  }
  // slxMain (which defines guard) loads after this file: bind the button once it exists
  if (startBtn && typeof slx.guard !== 'function') {
    var bindLater = function () {
      if (typeof slx.guard === 'function') bindStart();
      else root.setTimeout(bindLater, 50);
    };
    root.setTimeout(bindLater, 0);
  }

  // ---- 4. the card

  function running() {
    return !!st && (st.state === 'countdown' || st.state === 'running');
  }
  // The result stays up after the arena reopens, until the next match counts down (Owen 2026-10-16: the winner and
  // everyone else see the result; it used to vanish 7.5 s after the decision). Set by a decided state this page saw,
  // so a page that arrives later is never shown an old match's result as if it were its own.
  var seenResult = false;
  function noteResult() {
    if (!st) return;
    if (st.state === 'over' || st.state === 'reopening') seenResult = true;
    else if (st.state === 'countdown' || st.state === 'running') seenResult = false;
  }
  function decided() {
    return !!st && (st.state === 'over' || st.state === 'reopening' || (st.state === 'waiting' && seenResult));
  }
  // The top 3 for the card: { rank, name, me } (the podium has names only: a win is place 1, else the own name).
  function podiumRows(won) {
    var out = [];
    var mine = D.slMain && typeof D.slMain.nick === 'string' ? D.slMain.nick : '';
    var p = st && Array.isArray(st.podium) ? st.podium : [];
    for (var i = 0; i < p.length && i < 3; i++) {
      var name = String(p[i].name || '');
      out.push({ rank: i + 1, name: name, me: won ? i === 0 : !!mine && name === mine && mode === 'play' });
    }
    return out;
  }
  function nextLine() {
    return 'Next battle royale starts in ' + clock((st && st.nextStartMs) || 0);
  }

  var lastKind = '';
  // A watcher's card is about the match, not a life of theirs: no length and no stats of the snake they watched.
  slx.cardLines = function (kind) {
    var v = cardView(kind);
    if (v && mode === 'watch') {
      v.length = false;
      v.facts = [];
      if (v.title === undefined) v.title = 'Battle Royale';
    }
    return v;
  };
  // Owen 2026-10-16: a death is out for the rest of the match, the owner's too. While it runs the card is Spectate and
  // Lobby only (slxCard draws Lobby; again is Spectate). Once it is decided the result stays up, and when the arena
  // has reopened the button is Join next.
  function cardView(kind) {
    lastKind = String(kind || '');
    if (!st && kind !== 'match' && kind !== 'nobody') return null;
    if (kind === 'match' && (!st || running() || decided())) {
      return { title: 'Match under way', lines: [st ? st.alive + ' still alive. Spectate it, or wait for the next.'
        : 'Spectate it, or wait for the next.'], again: 'Spectate' };
    }
    if (kind === 'twice') {
      return { title: 'Already in this match', lines: ['Your wallet already has a snake in this arena (another tab?).'],
        again: 'Try again' };
    }
    if (kind === 'nobody') return { title: 'Nothing to watch', lines: ['The match is over.'], again: 'Play' };
    if (decided()) {
      var won = st.winner && lastMyId && st.winner.id === lastMyId && mode === 'play';
      var lines = [];
      // The shared card (slxCard, dsEnd): the podium as its rows, a win's place as the big figure, the prize as money.
      var view = { title: won ? 'You won!' : 'Match over', podium: podiumRows(won), lines: lines,
        again: st.state === 'reopening' || st.state === 'over' ? { text: 'Next match opening', disabled: true }
          : 'Join next' };
      if (won) {
        view.tone = 'win';
        view.hero = '1st';
        view.unit = st.startedCount > 1 ? 'of ' + st.startedCount : '';
        if (st.soloRun) lines.push('Solo test run: no prize.');
        else if (st.prize > 0 && proven) {
          view.ledger = [['Prize', PRIZE_WORDS]];
          view.status = { text: 'Sending to your wallet', state: 'pending' };
        } else lines.push('The prize is settled by hand.');
      }
      else if (st.winner && st.winner.bot) lines.push(st.winner.name + ' was the last snake alive.');
      else if (st.prize > 0) lines.push('First place took ' + PRIZE_WORDS + '.');
      return view;
    }
    if (running()) {
      if (mode === 'watch') {
        return { title: 'Watching', lines: [(watching && watching.name ? watching.name + ' is out. ' : '') +
          st.alive + ' still alive.'], again: 'Spectate next' };
      }
      return { title: 'You are out', lines: [st.alive + ' still alive. Spectate to the end, or wait for the next match.'],
        again: 'Spectate' };
    }
    // between matches (a winner's 'cashed' card would otherwise say Cashed Out)
    return { title: kind === 'cashed' ? 'Battle Royale' : undefined, lines: [nextLine()], again: 'Play again' };
  }

  // Play again: into a running match it is Watch; between matches it is Play with a fresh proof.
  slx.beforeAgain = function (go) {
    // nothing to watch, another tab's snake (refused only while waiting), or the decided match's arena has reopened
    // (Join next): play
    var reopened = !!st && st.state === 'waiting' && decided();
    // a 'match' or 'twice' refusal, a running or finishing match, a watcher with nothing known: watch
    if (lastKind !== 'nobody' && lastKind !== 'twice' && !reopened && ((lastKind === 'match' && !st) || running() ||
      (st && (st.state === 'over' || st.state === 'reopening')) || (!st && mode === 'watch'))) {
      mode = 'watch';
      if (watching) watching.next = 0;
      go();
      return true;
    }
    mode = 'play';
    watching = null;
    withProof(go);
    return true;
  };

  // A watcher whose snake ended watches the next survivor at once (their death fade runs, then the card's Play again).
  slx.on('menuShow', function () {
    if (mode !== 'watch' || !running()) return;
    root.setTimeout(function () {
      if (mode === 'watch' && running() && slx.card && typeof slx.card.playAgain === 'function') slx.card.playAgain();
    }, 900);
  });

  // ---- 5. watching: nothing on the game steers the watched snake

  function onGame(e) {
    for (var el = e.target; el && el !== doc; el = el.parentNode) {
      if (typeof el.className === 'string' && /(^|\s)slx-/.test(el.className)) return false; // a layer control
    }
    return true;
  }
  function swallow(e) {
    if (mode !== 'watch' || !S.connected || !onGame(e)) return;
    e.stopImmediatePropagation();
    if (e.type === 'touchstart' || e.type === 'touchmove') e.preventDefault();
  }
  var types = ['mousemove', 'mousedown', 'touchstart', 'touchmove', 'wheel'];
  for (var i = 0; i < types.length; i++) root.addEventListener(types[i], swallow, { capture: true, passive: false });
  root.addEventListener('keydown', function (e) {
    if (mode !== 'watch' || !S.connected) return;
    var k = e.keyCode;
    if (k === 32 || (k >= 37 && k <= 40) || k === 81) e.stopImmediatePropagation();
  }, true);

  // ---- between lives: the card keeps up with the match
  // After a death their client closes its socket (one socket per life), so no sl:x reaches this page while the card is
  // up. The lobby's own poll (/api/live br, the Events tab's) fills the gap every POLL_MS while no /sl socket is open
  // and the page is visible: the count, the phase, the winner and the podium, and when the next one starts.
  var POLL_MS = 2500;
  var polling = false;
  function pollLive() {
    if (polling || (typeof slx.connected === 'function' && slx.connected()) || doc.hidden) return;
    if (typeof root.fetch !== 'function') return;
    polling = true;
    root.fetch('/api/live', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      var b = j && j.br;
      if (!b || b.engine !== 'sl' || (typeof slx.connected === 'function' && slx.connected())) return;
      // to the second (the server's Eastern clock), or the HUD's 'next match in' snapped back to :00 at every poll
      var secs = (b.startHour * 3600 + b.startMin * 60) - (b.etHour * 3600 + b.etMin * 60 + (b.etSec || 0));
      if (secs < 0) secs += 24 * 3600;
      var next = {};
      if (st) for (var k in st) if (Object.prototype.hasOwnProperty.call(st, k)) next[k] = st[k];
      next.state = b.state;
      next.phase = b.phase;
      next.alive = b.alive;
      next.humans = b.humans;
      next.ring = b.ring;
      next.startedCount = b.startedCount;
      next.countdownMs = b.countdownMs;
      next.winner = b.winner;
      next.podium = b.podium;
      next.nextStartMs = isFinite(secs) ? secs * 1000 : (st && st.nextStartMs) || 0;
      next.prize = typeof b.prize === 'number' ? b.prize : 0;
      next.soloRun = b.soloRun === true;
      next.zoneMs = 0; // the wall's countdown comes with the socket's messages only
      next.z = null;
      st = next;
      stAt = now();
      noteResult();
      hudPaint();
      if (slx.card && typeof slx.card.refresh === 'function') slx.card.refresh();
    }).catch(function () { /* the next poll tries again */ }).then(function () { polling = false; });
  }
  root.setInterval(pollLive, POLL_MS);

  // ---- the frame

  // The phone's CASH OUT button (slxHold) goes while the match is fought: the server refuses Q then (allowsHold), and
  // a control that does nothing is worse than none (the old event hid it the same way).
  var holdBtn = null;
  function holdButton() {
    if (!holdBtn) holdBtn = doc.querySelector('.slx-hold');
    if (!holdBtn) return;
    var v = mode === 'watch' || running() ? 'hidden' : '';
    if (holdBtn.style.visibility !== v) holdBtn.style.visibility = v;
  }

  function frame() {
    root.requestAnimationFrame(frame);
    try {
      if (ctx) draw();
      holdButton();
      hudPaint();
    } catch (e) {
      errors++;
      slx.errors = (slx.errors || 0) + 1;
    }
  }
  if (typeof root.requestAnimationFrame === 'function') root.requestAnimationFrame(frame);

  slx.br = {
    mode: function () { return mode; },
    state: function () { return st; },
    zone: function () { return zoneNow(now()); },
    watching: function () { return watching; },
    errors: function () { return errors; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
