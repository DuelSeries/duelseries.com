// Chomp's page: the socket, the title card, input (arrows/WASD, swipes), your own chomper predicted with the
// server's movement code, everyone else drawn a little in the past between snapshots, the HUD and the sounds.
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
  var lookName = params.get('look') || store('chomp.look') || 'arcade';

  var canvas = document.getElementById('cv');
  var ctx = canvas.getContext('2d');
  var titleEl = document.getElementById('title');
  var nameEl = document.getElementById('name');
  var playEl = document.getElementById('play');

  var A = null, draw = null, socket = null;
  var myId = 0, metas = new Map();
  var dotsServer = null, dotsView = null, pending = new Map();
  var fruitOn = new Set();
  var snaps = [], offset = null;
  var me = null, L = 0, hist = new Map(), inputs = [], seq = 0, predicting = false;
  var smooth = { x: 0, y: 0 }, cam = { x: 0, y: 0 }, camSet = false;
  var myPower = 0, mySafe = 0, myScore = 0, myLives = R.LIVES, myRank = 0, roomN = 0;
  var phase = attract ? 'watch' : 'title';
  var pops = [], dying = new Map(), mouthPhase = new Map(), lastPos = new Map();
  var lbRows = [], board = null, scaredUntil = 0, readyUntil = 0;
  var stats = { checks: 0, fixes: 0, fixDist: 0 };       // prediction health, read by the test harness

  // ---- sizing
  function resize() {
    if (!draw) return;
    var w = window.innerWidth, h = window.innerHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    // CHOSEN: a computer shows 33 rows top to bottom (the arcade screen's 36 less its score lines); a phone held
    // upright shows 28.5 columns across, the arcade's own width, as the arcade cabinet's screen stands.
    var portrait = h > w;
    draw.resize(w, h, dpr, portrait ? (w * dpr / 28.5) : (h * dpr / 33));
  }
  window.addEventListener('resize', resize);

  // ---- net
  function connect() {
    socket = window.io('/chomp');
    socket.on('c:init', onInit);
    socket.on('c:you', function (m) { myId = m.id; (m.metas || []).forEach(setMeta); predicting = false; phase = 'play'; titleEl.hidden = true; readyUntil = performance.now() + 1500; Snd.play('ch.ready'); });
    socket.on('c:s', onSnap);
    socket.on('c:dots', onDots);
    socket.on('c:ev', onEvents);
    socket.on('c:lb', function (rows) { lbRows = rows || []; showBoard(); });
    socket.on('c:me', function (m) { myScore = m.s; myLives = m.l; myRank = m.rk; roomN = m.n; showBoard(); });
    socket.on('c:over', onOver);
    socket.on('c:refused', function (m) { toast(m && m.why === 'full' ? 'The arena is full. Try again in a moment.' : 'Too many tabs open here.'); });
    socket.on('disconnect', function () { predicting = false; if (phase === 'play') { phase = 'title'; titleEl.hidden = false; } });
  }

  function setMeta(m) { metas.set(m.id, { n: m.n, c: m.c }); }

  function onInit(m) {
    var fresh = !A || A.mx !== m.mx || A.my !== m.my;
    if (fresh) {
      A = Maze.build(m.mx, m.my);
      draw = new Draw(canvas, A, lookName);
      resize();
    }
    dotsServer = new Uint8Array(m.dots);
    dotsView = new Uint8Array(dotsServer);
    pending.clear();
    metas.clear();
    (m.metas || []).forEach(setMeta);
    fruitOn = new Set(m.fruit || []);
    snaps = []; offset = null; myId = 0; predicting = false;
    if (phase === 'play') { phase = 'title'; titleEl.hidden = false; }
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
        pop(e.x, e.y, String(e.pts), '#00ffff');
        if (e.id === myId) Snd.play('ch.ghost');
      } else if (e.k === 'eatp') {
        pop(e.x, e.y, String(e.pts), '#00ffff');
        if (e.id === myId) Snd.play('ch.player');
      } else if (e.k === 'die') {
        dying.set(e.id, now);
        if (e.id === myId) { Snd.play('ch.death'); predicting = false; myPower = 0; }
      } else if (e.k === 'spawn') {
        dying.delete(e.id);
        if (e.id === myId) { readyUntil = now + 1500; Snd.play('ch.ready'); }
      } else if (e.k === 'power') {
        if (e.id === myId) scaredUntil = now + R.FRIGHT_S * 1000;
      } else if (e.k === 'fruit') {
        if (e.on) fruitOn.add(e.m); else fruitOn.delete(e.m);
        if (!e.on && e.pts) {
          var m = A.modules[e.m];
          pop(m.ox + Maze.FRUIT.x, m.oy + Maze.FRUIT.y, String(e.pts), '#ffb8ff');
          if (e.id === myId) Snd.play('ch.fruit');
        }
      } else if (e.k === 'life') {
        if (e.id === myId) Snd.play('ch.life');
      }
    });
  }

  function pop(x, y, text, color) { pops.push({ x: x, y: y, text: text, color: color, at: performance.now() }); }

  function onOver(m) {
    phase = 'over'; predicting = false; myId = 0;
    if (!window.DSEnd) { titleEl.hidden = false; phase = 'title'; return; }
    var secs = m.secs || 0;
    window.DSEnd.show({
      tone: 'plain', verdict: 'Game over', hero: fmt(m.score), unit: 'points',
      facts: [['Rank', '#' + m.rank + ' of ' + m.of], ['Time', Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0')]],
      buttons: [
        { id: 'again', text: 'Play again', primary: true, onClick: function () { window.DSEnd.hide(); join(); } },
        { id: 'menu', text: 'Menu', onClick: function () { window.DSEnd.hide(); phase = 'title'; titleEl.hidden = false; } }
      ]
    });
  }

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
    if (phase === 'title' && e.key === 'Enter') { join(); return; }
    var d = KEYS[e.code];
    if (d == null) return;
    e.preventDefault();
    if (!e.repeat) want(d);
  });
  var touch = null;
  canvas.addEventListener('touchstart', function (e) { var t = e.changedTouches[0]; touch = { x: t.clientX, y: t.clientY }; }, { passive: true });
  canvas.addEventListener('touchmove', function (e) {
    if (!touch) return;
    var t = e.changedTouches[0], dx = t.clientX - touch.x, dy = t.clientY - touch.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 18) return;
    want(Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 1 : 3) : (dy < 0 ? 0 : 2));
    touch = { x: t.clientX, y: t.clientY };
    e.preventDefault();
  }, { passive: false });
  canvas.addEventListener('touchend', function () { touch = null; });
  playEl.addEventListener('click', join);

  // ---- prediction
  function mySpeed() { return R.speed(myPower > 0 ? R.PAC_FRIGHT_SPEED : R.PAC_SPEED); }

  function stepLocal() {
    if (myPower > 0) myPower--;
    L++;                                  // counts even while not predicting: it is the clock the server's echo maps onto
    if (!predicting || !me) return;
    var paused = me.pause > 0;
    Move.tick(me, A, mySpeed(), DT, dotsView, function (k, kind) {
      dotsView[k] = 0;
      pending.set(k, performance.now() + 1500);
      if (kind === Maze.ENERGIZER) { myPower = R.FRIGHT_S * R.TICK_HZ; Snd.play('ch.power'); } else Snd.eat();
    });
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
      return;
    }
    // the server's power count wins when they disagree by more than a snapshot's worth (it ate the energizer, or did not)
    if (Math.abs(rec.power - myPower) > 12) myPower = rec.power;
    var inp = null;
    for (var i = inputs.length - 1; i >= 0; i--) if (inputs[i].seq === rec.seq) { inp = inputs[i]; break; }
    if (!inp) {
      // nothing of ours applied yet this life: just follow the server
      if (Math.abs(me.x - rec.x) > 0.001 || Math.abs(me.y - rec.y) > 0.001 || me.dir !== rec.dir) {
        smooth.x += me.x - rec.x; smooth.y += me.y - rec.y;
        me.x = rec.x; me.y = rec.y; me.dir = rec.dir;
      }
      return;
    }
    var Lk = Math.min(L, inp.L + rec.since);
    var h = hist.get(Lk);
    stats.checks++;
    // CHOSEN: within a sixth of a tile on the same heading is jitter (we run a tick or two off the server), not an error
    if (h && Math.abs(h.x - rec.x) < 0.17 && Math.abs(h.y - rec.y) < 0.17 && h.dir === rec.dir) return;
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
    smooth.x += ox - me.x; smooth.y += oy - me.y;
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
    if (Math.abs(p.x - q.x) + Math.abs(p.y - q.y) > 2) return { x: q.x, y: q.y };
    return { x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k };
  }

  function mouthFor(id, x, y, moving) {
    var lp = lastPos.get(id), ph = mouthPhase.get(id) || 0;
    if (lp) ph += Math.abs(x - lp.x) + Math.abs(y - lp.y);
    lastPos.set(id, { x: x, y: y });
    mouthPhase.set(id, ph);
    if (!moving) return 0.25;
    var u = (ph / 0.75) % 1;                         // CHOSEN: one chew per 0.75 tile
    return 0.5 * (u < 0.5 ? u * 2 : 2 - u * 2);
  }

  // ---- drawing
  var FLASH_TICKS = R.FRIGHT_FLASHES * R.FLASH_PERIOD_S * R.TICK_HZ;
  function render(now) {
    if (!draw || !A) return;
    var w = sampleWorld(now);
    var players = [], ghosts = [], fruit = [];
    var flashOn = Math.floor(now / (R.FLASH_PERIOD_S * 500)) % 2 === 1;
    if (w) {
      w.b.ghosts.forEach(function (gb, i) {
        var ga = w.a.ghosts[i];
        var pos = lerp(ga, gb, w.k);
        var mode = 0;
        if (gb.state === 3 || gb.state === 4) mode = 3;
        else if (gb.fright > 0) mode = gb.fright < FLASH_TICKS && flashOn ? 2 : 1;
        ghosts.push({ x: pos.x, y: pos.y, dir: gb.dir, ki: gb.kind, mode: mode, frame: Math.floor(now / 133) % 2 });
      });
      w.b.players.forEach(function (pb) {
        if (pb.id === myId && (predicting || !(pb.flags & Wire.F.DYING))) return;
        var pa = w.a.pmap.get(pb.id), pos = lerp(pa, pb, w.k);
        var meta = metas.get(pb.id) || { n: '', c: 0 };
        var o = {
          x: pos.x, y: pos.y, dir: pb.dir >= 0 ? pb.dir : 1, name: meta.n, me: pb.id === myId,
          color: pb.id === myId ? draw.L.me : draw.L.players[(meta.c % 7) + 1],
          mouth: mouthFor(pb.id, pos.x, pos.y, pb.flags & Wire.F.MOVING)
        };
        if (pb.flags & Wire.F.DYING) {
          var t0 = dying.get(pb.id);
          if (t0 == null) { t0 = now; dying.set(pb.id, now); }
          o.dying = Math.min(1, (now - t0) / (R.DEATH_S * 1000 * 0.85));
          if (pb.id === myId && me) { o.x = me.x; o.y = me.y; }
        } else {
          if (pb.flags & Wire.F.SAFE) o.alpha = Math.floor(now / 120) % 2 ? 0.35 : 1;
          if (pb.flags & Wire.F.POWER) o.halo = true;
          if (myPower > 0 && !(pb.flags & (Wire.F.POWER | Wire.F.SAFE))) {
            o.scared = true;
            o.scaredFlash = myPower < FLASH_TICKS && flashOn;
          }
        }
        players.push(o);
      });
    }
    if (predicting && me) {
      smooth.x *= 0.82; smooth.y *= 0.82;
      var mx = me.x + smooth.x, my = me.y + smooth.y;
      players.push({
        x: mx, y: my, dir: me.face, me: true, color: draw.L.me, mouth: mouthFor(myId, mx, my, me.moving),
        alpha: mySafe ? (Math.floor(now / 120) % 2 ? 0.35 : 1) : 1, halo: myPower > 0
      });
    }
    fruitOn.forEach(function (mi) { var m = A.modules[mi]; if (m) fruit.push({ x: m.ox + Maze.FRUIT.x, y: m.oy + Maze.FRUIT.y }); });
    // camera
    var target = null;
    if (predicting && me) target = { x: me.x + smooth.x, y: me.y + smooth.y };
    else if (w) {
      var follow = lbRows.length ? w.b.pmap.get(lbRows[0][0]) : w.b.players[0];
      if (follow) target = { x: follow.x, y: follow.y };
    }
    if (!target) target = { x: A.W / 2, y: A.H / 2 };
    if (!camSet) { cam.x = target.x; cam.y = target.y; camSet = true; }
    var kf = predicting ? 1 : 0.04;
    cam.x += (target.x - cam.x) * kf; cam.y += (target.y - cam.y) * kf;
    var vw = canvas.width / draw.S, vh = canvas.height / draw.S;
    var cx = vw >= A.W + 2 ? A.W / 2 : Math.max(vw / 2 - 1, Math.min(A.W - vw / 2 + 1, cam.x));
    var cy = vh >= A.H + 2 ? A.H / 2 : Math.max(vh / 2 - 1, Math.min(A.H - vh / 2 + 1, cam.y));
    // points that pop
    var ps = [];
    pops = pops.filter(function (q) { return now - q.at < 1000; });
    pops.forEach(function (q) { ps.push({ x: q.x, y: q.y, text: q.text, color: q.color, a: 1 - Math.max(0, (now - q.at - 700) / 300) }); });
    pending.forEach(function (exp, k) { if (now > exp) { pending.delete(k); dotsView[k] = dotsServer[k]; } });
    draw.frame({ cam: { x: cx, y: cy }, t: now, dots: dotsView, players: players, ghosts: ghosts, fruit: fruit, pops: ps });
    hud(now);
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
    if (myPower > 0 && Math.floor(now / 400) !== hud.lastBeat) { hud.lastBeat = Math.floor(now / 400); Snd.play('ch.scared'); }
  }

  function showBoard() {
    if (!window.DSEnd || attract) return;
    if (!board) board = window.DSEnd.board({ title: 'Leaderboard' });
    var rows = lbRows.map(function (r) {
      var m = metas.get(r[0]);
      return { name: m ? m.n : '', value: fmt(r[1]), me: r[0] === myId };
    });
    board.set(rows, myId && myRank ? { rank: myRank, name: (metas.get(myId) || {}).n || 'You', value: fmt(myScore) } : null);
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
    render(now);
    requestAnimationFrame(loop);
  }

  nameEl.value = store('chomp.name') || '';
  if (attract) titleEl.hidden = true;
  window.ChompPage = {
    state: function () { return { phase: phase, myId: myId, predicting: predicting, me: me, score: myScore, lives: myLives, stats: stats, snaps: snaps.length, look: draw && draw.L.id }; },
    setLook: function (n) { lookName = n; store('chomp.look', n); if (draw) { draw.setLook(n); resize(); } } };
  connect();
  requestAnimationFrame(loop);
})();
