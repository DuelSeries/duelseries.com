'use strict';
/* ─── OMG Shooter, the client ─────────────────────────────────────────────────
   Sends which keys are down and where the mouse is. Draws what comes back.

   It runs no simulation of its own. At 30 snapshots a second a top-down tank is
   smooth enough with plain interpolation between the last two frames, and
   prediction here would buy a few milliseconds in exchange for the client
   holding an opinion about where things are — which is the thing this product
   cannot afford it to have.

   THE FOG IS DRAWN HERE, and it is the one place the client decides what you
   see. Everything past a wall is black. It is recomputed from the player's own
   position by walking the same grid the server walks, and it is deliberately
   NOT a secret: the minimap shows every tank on the map, because a big arena
   with no minimap is twenty minutes of driving. The fog is about sight lines —
   you know roughly where people are and still cannot shoot round a corner. */

(function () {
  var $ = function (id) { return document.getElementById(id); };
  var A = window.ShooterArt;
  var cv = $('arena'), ctx = cv.getContext('2d');
  var socket = io();

  var NAME = (function () {
    try { return sessionStorage.getItem('playerName') || localStorage.getItem('duel:name') || 'Player'; }
    catch (_) { return 'Player'; }
  })();
  var WEAPON = (function () {
    try { return localStorage.getItem('shooter:weapon') || 'minigun'; } catch (_) { return 'minigun'; }
  })();

  var map = null;                 // { cols, rows, tile, cells: Uint8Array, bank, sight }
  var prev = null, next = null, prevAt = 0, nextAt = 0;
  var dpr = 1, started = false, S = 1;
  var cam = { x: 0, y: 0 };
  var feed = [];                  // recent kills and cash-outs
  var mini = null, miniDirty = true;

  /* Fog: what is visible right now, and what has ever been visible. Two arrays
     rather than one, because a room you have already been in should stay drawn
     and dimmed — going back to pure black would mean re-learning the map every
     time you turn round. */
  var vis = null, seen = null, fogAt = 0, fogX = -1e9, fogY = -1e9;

  var keys = Object.create(null);
  var input = { up: 0, down: 0, left: 0, right: 0, fire: 0, aim: 0 };
  var mouse = { x: 0, y: 0 };
  var touch = { active: false, dx: 0, dy: 0, id: null };
  var isTouch = matchMedia('(pointer: coarse)').matches;

  /* ── sizing ───────────────────────────────────────────────────────────────── */
  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(window.innerWidth * dpr);
    cv.height = Math.round(window.innerHeight * dpr);
    cv.style.width = window.innerWidth + 'px';
    cv.style.height = window.innerHeight + 'px';
  }
  window.addEventListener('resize', resize);
  resize();

  /* About twenty-two tiles across a desktop screen and fewer on a phone, which
     is the range where a tank is big enough to aim and the room is big enough
     to see. */
  function zoom() {
    var want = window.innerWidth < 620 ? 11 : 22;
    return cv.width / (want * (map ? map.tile : 54));
  }

  /* ── input ────────────────────────────────────────────────────────────────── */
  var KEYMAP = {
    KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down',
    KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
  };
  window.addEventListener('keydown', function (e) {
    if (KEYMAP[e.code]) { keys[KEYMAP[e.code]] = 1; e.preventDefault(); }
    if (e.code === 'Escape') leave();
    var n = e.code.indexOf('Digit') === 0 ? Number(e.code.slice(5)) : -1;
    if (n >= 0) {
      var idx = n === 0 ? 9 : n - 1;          // 1..9 then 0 for the tenth
      if (A.WEAPONS[idx]) pickWeapon(A.WEAPONS[idx].key);
    }
  });
  window.addEventListener('keyup', function (e) { if (KEYMAP[e.code]) keys[KEYMAP[e.code]] = 0; });
  /* Keys held when the window loses focus stay held forever otherwise, and you
     come back to a tank driving into a wall on its own. */
  window.addEventListener('blur', function () {
    for (var k in keys) keys[k] = 0;
    input.fire = 0;
  });

  cv.addEventListener('mousemove', function (e) { mouse = { x: e.clientX, y: e.clientY }; });
  cv.addEventListener('mousedown', function (e) { if (e.button === 0) input.fire = 1; });
  window.addEventListener('mouseup', function () { input.fire = 0; });
  cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  var stick = $('stick'), nub = $('stickNub');
  function stickAt(t) {
    var r = stick.getBoundingClientRect();
    var dx = t.clientX - (r.left + r.width / 2), dy = t.clientY - (r.top + r.height / 2);
    var d = Math.hypot(dx, dy), max = r.width / 2 - 12;
    if (d > max) { dx = dx / d * max; dy = dy / d * max; }
    nub.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    touch.dx = dx / max; touch.dy = dy / max;
  }
  stick.addEventListener('touchstart', function (e) {
    e.preventDefault(); touch.active = true; touch.id = e.changedTouches[0].identifier;
    stickAt(e.changedTouches[0]);
  }, { passive: false });
  stick.addEventListener('touchmove', function (e) {
    e.preventDefault();
    for (var i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === touch.id) stickAt(e.changedTouches[i]);
    }
  }, { passive: false });
  function stickEnd(e) {
    e.preventDefault(); touch.active = false; touch.dx = touch.dy = 0;
    nub.style.transform = 'translate(0,0)';
  }
  stick.addEventListener('touchend', stickEnd, { passive: false });
  stick.addEventListener('touchcancel', stickEnd, { passive: false });
  $('tfire').addEventListener('touchstart', function (e) { e.preventDefault(); input.fire = 1; }, { passive: false });
  $('tfire').addEventListener('touchend', function (e) { e.preventDefault(); input.fire = 0; }, { passive: false });
  if (isTouch) {
    $('touch').hidden = false;
    /* The card explains a mouse and a keyboard to somebody holding neither.
       One line, swapped, rather than a second card to keep in step. */
    var how = $('howto');
    if (how) {
      how.innerHTML = 'Drive and aim with the stick, tap <b>Fire</b> to shoot. ' +
        'Break crates for coins and med kits. Kill someone and they drop ' +
        'everything they were carrying.';
    }
  }

  function sendInput() {
    if (!started) return;
    if (isTouch) {
      /* One stick that drives and aims. Two thumbs and a second stick is the
         other answer and it is worse on a phone this size: aiming where you are
         driving is at least always true. */
      input.left = touch.dx < -0.2 ? 1 : 0; input.right = touch.dx > 0.2 ? 1 : 0;
      input.up = touch.dy < -0.2 ? 1 : 0; input.down = touch.dy > 0.2 ? 1 : 0;
      if (Math.hypot(touch.dx, touch.dy) > 0.2) input.aim = Math.atan2(touch.dy, touch.dx);
    } else {
      input.up = keys.up || 0; input.down = keys.down || 0;
      input.left = keys.left || 0; input.right = keys.right || 0;
      /* The camera is locked to your tank, so the centre of the screen IS the
         tank and the barrel points from there to the cursor. */
      input.aim = Math.atan2(mouse.y - window.innerHeight / 2, mouse.x - window.innerWidth / 2);
    }
    socket.volatile.emit('sh:input', input);
  }
  setInterval(sendInput, 1000 / 30);

  /* ── the wire ─────────────────────────────────────────────────────────────── */

  socket.on('sh:map', function (m) {
    var rows = m.cells.split('|');
    var cells = new Uint8Array(m.cols * m.rows);
    for (var r = 0; r < m.rows; r++) {
      for (var c = 0; c < m.cols; c++) cells[r * m.cols + c] = rows[r].charCodeAt(c) - 48;
    }
    map = { cols: m.cols, rows: m.rows, tile: m.tile, cells: cells,
            bank: m.bank, cashoutMs: m.cashoutMs, sight: m.sight };
    vis = new Uint8Array(m.cols * m.rows);
    seen = new Uint8Array(m.cols * m.rows);
    fogX = -1e9;
    miniDirty = true;
  });

  socket.on('sh:state', function (s) {
    if (map && s.cells) {
      for (var i = 0; i < s.cells.length; i += 2) map.cells[s.cells[i]] = s.cells[i + 1];
      miniDirty = true;
      fogX = -1e9;                       // a wall came down: the sight lines changed
    }
    prev = next; prevAt = nextAt;
    next = s; nextAt = performance.now();
    if (!prev) { prev = s; prevAt = nextAt; }
    paintHud(s);
  });

  socket.on('sh:killed', function (e) {
    say(e.by ? e.by + ' killed ' + e.name : e.name + ' was destroyed');
  });
  socket.on('sh:banked', function (e) {
    say(e.name + ' banked ' + e.amount, true);
  });

  function say(text, good) {
    feed.unshift({ text: text, good: !!good, at: Date.now() });
    feed.length = Math.min(feed.length, 5);
    $('feed').innerHTML = feed.map(function (f) {
      return '<li' + (f.good ? ' class="good"' : '') + '>' + esc(f.text) + '</li>';
    }).join('');
  }
  function esc(t) {
    return String(t).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* ── the HUD ──────────────────────────────────────────────────────────────── */
  function paintHud(s) {
    if (!started || !s.you) return;
    $('hud').hidden = false;
    $('guns').hidden = false;
    $('hpBar').style.width = Math.max(0, s.you.hp / s.you.max * 100) + '%';
    $('hpNum').textContent = s.you.hp;
    $('carry').textContent = s.you.coins;
    $('banked').textContent = s.you.banked;

    /* The cash-out bar only exists while you are actually banking. A permanent
       empty bar is a control that is broken 99% of the time. */
    var cw = $('cashwrap');
    cw.hidden = !(s.you.cash > 0);
    if (s.you.cash > 0) {
      $('cashBar').style.width = (s.you.cash * 100) + '%';
      $('cashNum').textContent = (map ? (map.cashoutMs / 1000 * (1 - s.you.cash)).toFixed(1) : '');
    }

    $('dead').hidden = !s.you.dead;
    if (s.you.dead) $('deadIn').textContent = (s.you.respawn / 1000).toFixed(1);

    for (var i = 0; i < gunBtns.length; i++) {
      gunBtns[i].classList.toggle('on', gunBtns[i].dataset.w === s.you.weapon);
    }

    $('board').innerHTML = (s.board || []).map(function (b) {
      return '<li' + (b.me ? ' class="me"' : '') + '><b>' + esc(b.n) + '</b>' +
             '<span class="num">' + b.b + '</span></li>';
    }).join('');
  }

  /* The same ten buttons twice: a grid on the way in, and a row along the
     bottom in game. One builder, so the picker can never offer a gun the game
     does not draw. */
  var gunBtns = [];
  function buildGuns(wrap, withNames) {
    if (!wrap) return;
    A.WEAPONS.forEach(function (w, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'gun';
      b.dataset.w = w.key;
      b.title = w.name + ' \u2014 ' + w.blurb;
      b.innerHTML = '<canvas width="120" height="78"></canvas>' +
                    (withNames ? '<b>' + w.name + '</b>' : '') +
                    '<i>' + ((i + 1) % 10) + '</i>';
      b.addEventListener('click', function () { pickWeapon(w.key); });
      wrap.appendChild(b);
      gunBtns.push(b);
      // A picture of the gun, not its name: you are choosing a silhouette.
      var g = b.querySelector('canvas').getContext('2d');
      g.translate(60, 44);
      g.rotate(-Math.PI / 2);
      A.gun(g, w.key, A.TEAMS.you);
    });
  }
  buildGuns($('bootguns'), true);
  buildGuns($('guns'), false);
  function pickWeapon(key) {
    try { localStorage.setItem('shooter:weapon', key); } catch (_) {}
    WEAPON = key;
    if (started) socket.emit('sh:weapon', { weapon: key });
    else for (var i = 0; i < gunBtns.length; i++) {
      gunBtns[i].classList.toggle('on', gunBtns[i].dataset.w === key);
    }
  }

  /* ── the fog ──────────────────────────────────────────────────────────────
     A cell is visible if any of its centre or corners can be reached from the
     tank without crossing a wall. Corners matter: without them the far face of
     every wall is black, so walls look like holes and the map reads as a cave
     of pits rather than a field with things on it.

     Only cells on screen are tested, which keeps this at a few thousand cheap
     steps however big the arena gets. */
  function computeFog(px, py) {
    var T = map.tile, C = map.cols, R = map.rows;
    var reach = Math.min(map.sight, cv.width / S / 2 + T * 2);
    var c0 = Math.max(0, Math.floor((px - reach) / T)), c1 = Math.min(C - 1, Math.ceil((px + reach) / T));
    var r0 = Math.max(0, Math.floor((py - reach) / T)), r1 = Math.min(R - 1, Math.ceil((py + reach) / T));
    vis.fill(0);
    for (var r = r0; r <= r1; r++) {
      for (var c = c0; c <= c1; c++) {
        var cx = (c + 0.5) * T, cy = (r + 0.5) * T;
        if (Math.hypot(cx - px, cy - py) > map.sight) continue;
        if (open(px, py, cx, cy) ||
            open(px, py, c * T + 2, r * T + 2) ||
            open(px, py, (c + 1) * T - 2, r * T + 2) ||
            open(px, py, c * T + 2, (r + 1) * T - 2) ||
            open(px, py, (c + 1) * T - 2, (r + 1) * T - 2)) {
          vis[r * C + c] = 1;
          seen[r * C + c] = 1;
        }
      }
    }
  }
  /* The walk stops one step short of the destination, so a wall cell is visible
     from its own near side rather than invisible because it is solid. */
  function open(x0, y0, x1, y1) {
    var T = map.tile;
    var steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (T * 0.5));
    for (var i = 1; i < steps; i++) {
      var t = i / steps;
      var x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
      var c = Math.floor(x / T), r = Math.floor(y / T);
      if (c < 0 || r < 0 || c >= map.cols || r >= map.rows) return false;
      if (map.cells[r * map.cols + c] !== 0) return false;
    }
    return true;
  }
  function visibleAt(x, y) {
    var c = Math.floor(x / map.tile), r = Math.floor(y / map.tile);
    if (c < 0 || r < 0 || c >= map.cols || r >= map.rows) return false;
    return vis[r * map.cols + c] === 1;
  }

  /* ── drawing ──────────────────────────────────────────────────────────────── */

  function lerp(a, b, t) { return a + (b - a) * t; }
  function clampCam(v, half, extent) {
    if (extent <= half * 2) return extent / 2;
    return Math.max(half, Math.min(extent - half, v));
  }

  function draw() {
    requestAnimationFrame(draw);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0f09';
    ctx.fillRect(0, 0, cv.width, cv.height);
    if (!map || !next || !next.you || !started) return;

    var span = Math.max(1, nextAt - prevAt);
    var t = Math.min(1, (performance.now() - nextAt) / span);
    var you = next.you, pyou = (prev && prev.you) || you;

    S = zoom();
    var halfW = cv.width / 2 / S, halfH = cv.height / 2 / S;
    var worldW = map.cols * map.tile, worldH = map.rows * map.tile;
    var px = lerp(pyou.x, you.x, t), py = lerp(pyou.y, you.y, t);
    cam.x = clampCam(px, halfW, worldW);
    cam.y = clampCam(py, halfH, worldH);

    var ox = cv.width / 2 - cam.x * S, oy = cv.height / 2 - cam.y * S;
    var X = function (x) { return x * S + ox; };
    var Y = function (y) { return y * S + oy; };

    /* Recomputed on movement rather than every frame: the fog only changes when
       the tank does, and at 60fps that is half the work thrown away. */
    var nowMs = performance.now();
    if (Math.hypot(px - fogX, py - fogY) > 10 || nowMs - fogAt > 150) {
      computeFog(px, py); fogX = px; fogY = py; fogAt = nowMs;
    }

    drawGround(X, Y);
    drawBank(X, Y);
    drawPickups(X, Y);
    drawMines(X, Y);
    drawTanks(X, Y, t, you, pyou, px, py);
    drawBullets(X, Y);
    drawFx(X, Y);
    drawFog(X, Y);
    drawMinimap(px, py);
  }

  function drawGround(X, Y) {
    var T = map.tile;
    var c0 = Math.max(0, Math.floor(cam.x / T - cv.width / 2 / S / T) - 1);
    var c1 = Math.min(map.cols - 1, Math.ceil(cam.x / T + cv.width / 2 / S / T) + 1);
    var r0 = Math.max(0, Math.floor(cam.y / T - cv.height / 2 / S / T) - 1);
    var r1 = Math.min(map.rows - 1, Math.ceil(cam.y / T + cv.height / 2 / S / T) + 1);
    var s = T * S;
    for (var r = r0; r <= r1; r++) {
      for (var c = c0; c <= c1; c++) {
        if (!seen[r * map.cols + c]) continue;      // never been here: leave it black
        var x = X(c * T), y = Y(r * T), v = map.cells[r * map.cols + c];
        A.drawGrass(ctx, x, y, s + 1, c, r);
        if (v === 1) A.drawCrate(ctx, x, y, s);
        else if (v === 2) A.drawStone(ctx, x, y, s, c, r);
        else if (v === 3) A.drawBrick(ctx, x, y, s, c, r);
        else if (v === 4) A.drawWood(ctx, x, y, s, c, r);
        else if (v === 5) A.drawBarrel(ctx, x, y, s);
      }
    }
  }

  /* The bank. A gold square you can see from outside it, because the whole
     tension of the game is knowing who is standing in it. */
  function drawBank(X, Y) {
    var b = map.bank, h = b.half;
    var x = X(b.x - h), y = Y(b.y - h), w = h * 2 * S;
    ctx.save();
    ctx.fillStyle = 'rgba(240,181,0,0.10)';
    ctx.fillRect(x, y, w, w);
    ctx.setLineDash([12 * S, 8 * S]);
    ctx.lineWidth = Math.max(2, 3 * S);
    ctx.strokeStyle = 'rgba(255,181,0,0.85)';
    ctx.strokeRect(x, y, w, w);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,228,159,0.75)';
    ctx.font = '600 ' + Math.round(22 * S) + 'px Archivo, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('CASH OUT', X(b.x), Y(b.y - h) - 10 * S);
    ctx.restore();
  }

  function drawPickups(X, Y) {
    var T = map.tile;
    for (var i = 0; i < next.pickups.length; i++) {
      var p = next.pickups[i];
      if (!visibleAt(p[0], p[1])) continue;
      if (p[2]) A.drawMedkit(ctx, X(p[0]), Y(p[1]), T * S);
      else A.drawCoin(ctx, X(p[0]), Y(p[1]), T * S, p[3] >= 40);
    }
  }

  function drawMines(X, Y) {
    for (var i = 0; i < next.mines.length; i++) {
      var m = next.mines[i];
      if (!visibleAt(m[0], m[1])) continue;
      ctx.beginPath();
      ctx.arc(X(m[0]), Y(m[1]), 9 * S, 0, Math.PI * 2);
      ctx.fillStyle = m[2] ? '#c0392b' : '#6b4a1a';
      ctx.fill();
      ctx.strokeStyle = '#000'; ctx.lineWidth = Math.max(1, 2 * S); ctx.stroke();
      if (m[2]) {
        ctx.beginPath();
        ctx.arc(X(m[0]), Y(m[1]), (11 + Math.sin(Date.now() / 140) * 3) * S, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,90,60,0.7)'; ctx.stroke();
      }
    }
  }

  /* Other tanks are matched between frames by id, not by position in the array.
     The set changes as people die and spawn, so an index-matched interpolation
     makes every tank jump to another tank whenever one leaves. */
  function byId(list) {
    var m = Object.create(null);
    if (!list) return m;
    for (var i = 0; i < list.length; i++) m[list[i].id] = list[i];
    return m;
  }

  function drawTanks(X, Y, t, you, pyou, px, py) {
    var T = map.tile, size = A.BODY_W * S;
    var was = byId(prev && prev.tanks);
    for (var i = 0; i < next.tanks.length; i++) {
      var n = next.tanks[i];
      if (!visibleAt(n.x, n.y)) continue;
      var p = was[n.id] || n;
      A.drawTank(ctx, {
        x: X(lerp(p.x, n.x, t)), y: Y(lerp(p.y, n.y, t)), size: size,
        hull: n.h, turret: n.a, roll: n.r, team: 'them', weapon: n.w,
        hp: n.hp, max: n.max, label: n.n,
      });
      if (n.c) ring(X(n.x), Y(n.y), size * 0.9, '#ffb500');
    }
    if (!you.dead) {
      if (you.safe) ring(X(px), Y(py), size * 0.78, 'rgba(158,222,74,' +
        (0.4 + 0.35 * Math.sin(Date.now() / 90)).toFixed(2) + ')');
      A.drawTank(ctx, {
        x: X(px), y: Y(py), size: size,
        hull: you.hull, turret: you.aim, roll: you.roll, team: 'you',
        weapon: you.weapon, hp: you.hp, max: you.max,
      });
    }
  }

  function ring(x, y, r, colour) {
    ctx.save();
    ctx.strokeStyle = colour;
    ctx.lineWidth = Math.max(2, 2.5 * S);
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  function drawBullets(X, Y) {
    for (var i = 0; i < next.bullets.length; i++) {
      var b = next.bullets[i];
      if (!visibleAt(b[0], b[1])) continue;
      ctx.beginPath();
      ctx.arc(X(b[0]), Y(b[1]), Math.max(1.5, b[2] * S), 0, Math.PI * 2);
      ctx.fillStyle = '#ffe9b8'; ctx.fill();
      ctx.strokeStyle = '#000'; ctx.lineWidth = Math.max(1, 1.4 * S); ctx.stroke();
    }
  }

  /* Beams, chains and blasts. All three land instantly, so this is the only
     thing that says they happened at all. */
  function drawFx(X, Y) {
    for (var i = 0; i < next.fx.length; i++) {
      var f = next.fx[i];
      ctx.save();
      if (f[0] === 0) {
        ctx.strokeStyle = f[5] ? '#8fd6ff' : '#ff6b6b';
        ctx.lineWidth = (f[5] ? 6 : 4) * S;
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(X(f[1]), Y(f[2])); ctx.lineTo(X(f[3]), Y(f[4])); ctx.stroke();
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.6 * S;
        ctx.beginPath(); ctx.moveTo(X(f[1]), Y(f[2])); ctx.lineTo(X(f[3]), Y(f[4])); ctx.stroke();
      } else if (f[0] === 1) {
        ctx.strokeStyle = '#8fd6ff';
        ctx.lineWidth = 3 * S; ctx.lineJoin = 'round';
        ctx.beginPath();
        for (var k = 1; k < f.length; k += 2) {
          if (k === 1) ctx.moveTo(X(f[k]), Y(f[k + 1])); else ctx.lineTo(X(f[k]), Y(f[k + 1]));
        }
        ctx.stroke();
      } else {
        var g = ctx.createRadialGradient(X(f[1]), Y(f[2]), 0, X(f[1]), Y(f[2]), f[3] * S);
        g.addColorStop(0, 'rgba(255,224,160,0.95)');
        g.addColorStop(0.45, 'rgba(255,120,30,0.7)');
        g.addColorStop(1, 'rgba(180,40,10,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(X(f[1]), Y(f[2]), f[3] * S, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
  }

  /* Black where you have never been, dimmed where you have been but cannot see
     now. Drawn last, over everything, so a tank standing in the dark is in the
     dark rather than half-lit. */
  function drawFog(X, Y) {
    var T = map.tile, s = T * S + 1;
    var c0 = Math.max(0, Math.floor(cam.x / T - cv.width / 2 / S / T) - 1);
    var c1 = Math.min(map.cols - 1, Math.ceil(cam.x / T + cv.width / 2 / S / T) + 1);
    var r0 = Math.max(0, Math.floor(cam.y / T - cv.height / 2 / S / T) - 1);
    var r1 = Math.min(map.rows - 1, Math.ceil(cam.y / T + cv.height / 2 / S / T) + 1);
    for (var r = r0; r <= r1; r++) {
      for (var c = c0; c <= c1; c++) {
        var i = r * map.cols + c;
        if (vis[i]) continue;
        ctx.fillStyle = seen[i] ? 'rgba(6,10,6,0.66)' : '#0b0f09';
        ctx.fillRect(X(c * T), Y(r * T), s, s);
      }
    }
  }

  /* ── the minimap ──────────────────────────────────────────────────────────
     Bottom left, the whole arena, white for you and red for everybody else.
     The walls are painted once into an offscreen canvas and only repainted when
     one of them comes down, so the per-frame cost is a handful of dots. */
  function drawMinimap(px, py) {
    /* A third of a phone screen is not a minimap, it is a map with a game in
       the corner. It is sized off the screen rather than fixed, and it sits
       above the stick rather than under it. */
    var pad = 14 * dpr;
    var box = Math.min(172, cv.width / dpr * 0.30) * dpr;
    var x0 = pad, y0 = cv.height - box - pad - (isTouch ? 216 * dpr : 0);
    var k = box / (map.cols * map.tile);

    if (!mini || miniDirty) {
      mini = mini || document.createElement('canvas');
      mini.width = map.cols; mini.height = map.rows;
      var g = mini.getContext('2d');
      g.clearRect(0, 0, map.cols, map.rows);
      for (var r = 0; r < map.rows; r++) {
        for (var c = 0; c < map.cols; c++) {
          var v = map.cells[r * map.cols + c];
          g.fillStyle = v === 0 ? '#2e6636'
                      : v === 2 ? '#6c6055'
                      : v === 3 ? '#8e4433'
                      : v === 5 ? '#a3300f'
                      : '#a2661f';
          g.fillRect(c, r, 1, 1);
        }
      }
      miniDirty = false;
    }

    ctx.save();
    ctx.fillStyle = 'rgba(8,10,7,0.82)';
    A.roundRect(ctx, x0 - 4, y0 - 4, box + 8, box + 8, 10 * dpr);
    ctx.fill();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(mini, x0, y0, box, box);
    ctx.imageSmoothingEnabled = true;

    // The bank, so the thing everybody is driving toward is on the map.
    var b = map.bank;
    ctx.strokeStyle = '#ffb500'; ctx.lineWidth = 2 * dpr;
    ctx.strokeRect(x0 + (b.x - b.half) * k, y0 + (b.y - b.half) * k, b.half * 2 * k, b.half * 2 * k);

    for (var i = 0; i < next.tanks.length; i++) {
      var t = next.tanks[i];
      dot(x0 + t.x * k, y0 + t.y * k, 3 * dpr, '#ef3f35');
    }
    dot(x0 + px * k, y0 + py * k, 3.6 * dpr, '#ffffff');

    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = dpr;
    A.roundRect(ctx, x0 - 4, y0 - 4, box + 8, box + 8, 10 * dpr);
    ctx.stroke();
    ctx.restore();
  }
  function dot(x, y, r, colour) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = colour; ctx.fill();
    ctx.lineWidth = Math.max(1, dpr); ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.stroke();
  }

  /* ── starting, and leaving ────────────────────────────────────────────────── */

  $('startBtn').addEventListener('click', function () {
    $('boot').hidden = true;
    started = true;
    socket.emit('sh:join', { name: NAME, weapon: WEAPON });
  });

  function leave() {
    socket.emit('sh:leave');
    if (window.parent && window.parent !== window) window.parent.postMessage('game:done', '*');
    else window.location.href = '/';
  }
  $('exitBtn').addEventListener('click', leave);

  /* The last snapshot, for the console. It is the same data the page has
     already been sent and can already read off the wire, so this gives nothing
     away; what it gives is a way to check where a tank actually is when the
     screen says something odd, without adding a HUD nobody wants. */
  window.SHOOTER_STATE = function () { return next; };

  pickWeapon(WEAPON);
  draw();
})();
