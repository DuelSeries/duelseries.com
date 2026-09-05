'use strict';
/* ─── Tank Assault, the client ────────────────────────────────────────────────
   Sends which keys are down and where the mouse is. Draws what comes back.

   It runs no simulation of its own. At 30 snapshots a second a top-down tank is
   already smooth enough with plain interpolation between the last two frames,
   and prediction here would buy a few milliseconds in exchange for the client
   holding an opinion about where things are — which is the thing this product
   cannot afford it to have.

   The camera follows you and the arena is bigger than the screen, which is what
   makes breaking a crate to see round a corner worth doing. */

(function () {
  const $ = (id) => document.getElementById(id);
  const cv = $('arena');
  const ctx = cv.getContext('2d');
  const socket = io();

  const NAME = (() => {
    try { return sessionStorage.getItem('playerName') || 'Player'; } catch (_) { return 'Player'; }
  })();

  let map = null;                 // { cols, rows, tile, cells: [][] }
  let prev = null, next = null;   // the two most recent snapshots
  let prevAt = 0, nextAt = 0;
  let dpr = 1;
  let started = false;
  const cam = { x: 0, y: 0 };
  /* World units per screen pixel for the frame being drawn. Every radius and
     line width below is in world units and multiplied by this, so zooming does
     not leave the tanks the size they were. */
  let S = 1;

  /* About twenty-six tiles across and sixteen down, whatever the screen. Any
     less and a phone shows a corridor; any more and the tanks are specks. */
  function zoom() {
    const fit = Math.min(cv.width / (26 * 40), cv.height / (16 * 40));
    return Math.max(0.5 * dpr, Math.min(1.2 * dpr, fit));
  }
  /* A world smaller than the screen is centred; otherwise the camera stops
     half a screen from each wall. */
  function clampCam(v, half, extent) {
    if (extent <= half * 2) return extent / 2;
    return Math.max(half, Math.min(extent - half, v));
  }

  const keys = Object.create(null);
  const input = { up: 0, down: 0, left: 0, right: 0, fire: 0, aim: 0 };
  let mouse = { x: 0, y: 0 };
  const touch = { active: false, dx: 0, dy: 0, id: null };

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

  /* ── input ────────────────────────────────────────────────────────────────── */
  const KEYMAP = {
    KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down',
    KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
  };
  window.addEventListener('keydown', (e) => {
    if (KEYMAP[e.code]) { keys[KEYMAP[e.code]] = 1; e.preventDefault(); }
    if (e.code === 'Digit1') pickGun('cannon');
    if (e.code === 'Digit2') pickGun('rapid');
    if (e.code === 'Digit3') pickGun('scatter');
  });
  window.addEventListener('keyup', (e) => { if (KEYMAP[e.code]) keys[KEYMAP[e.code]] = 0; });
  /* Keys held when the window loses focus stay held forever otherwise, and you
     come back to a tank driving into a wall on its own. */
  window.addEventListener('blur', () => { for (const k in keys) keys[k] = 0; input.fire = 0; });

  cv.addEventListener('mousemove', (e) => { mouse = { x: e.clientX, y: e.clientY }; });
  cv.addEventListener('mousedown', (e) => { if (e.button === 0) input.fire = 1; });
  window.addEventListener('mouseup', () => { input.fire = 0; });
  cv.addEventListener('contextmenu', (e) => e.preventDefault());

  // Touch: a stick on the left, a fire button on the right.
  const stick = $('stick'), nub = $('stickNub');
  function stickAt(t) {
    const r = stick.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let dx = t.clientX - cx, dy = t.clientY - cy;
    const d = Math.hypot(dx, dy), max = r.width / 2 - 12;
    if (d > max) { dx = dx / d * max; dy = dy / d * max; }
    nub.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    touch.dx = dx / max; touch.dy = dy / max;
  }
  stick.addEventListener('touchstart', (e) => {
    e.preventDefault(); touch.active = true; touch.id = e.changedTouches[0].identifier;
    stickAt(e.changedTouches[0]);
  }, { passive: false });
  stick.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) if (t.identifier === touch.id) stickAt(t);
  }, { passive: false });
  const stickEnd = (e) => {
    e.preventDefault(); touch.active = false; touch.dx = touch.dy = 0;
    nub.style.transform = 'translate(0,0)';
  };
  stick.addEventListener('touchend', stickEnd, { passive: false });
  stick.addEventListener('touchcancel', stickEnd, { passive: false });

  $('tfire').addEventListener('touchstart', (e) => { e.preventDefault(); input.fire = 1; }, { passive: false });
  $('tfire').addEventListener('touchend', (e) => { e.preventDefault(); input.fire = 0; }, { passive: false });

  /* On a phone there is no mouse, so the barrel points where you are driving.
     Aiming and driving separately needs two thumbs and a second stick, and one
     stick that does both is the honest version of this game on a phone. */
  const isTouch = matchMedia('(pointer: coarse)').matches;
  if (isTouch) $('touch').hidden = false;

  function sendInput() {
    if (!started) return;
    if (isTouch && touch.active) {
      input.left = touch.dx < -0.2 ? 1 : 0; input.right = touch.dx > 0.2 ? 1 : 0;
      input.up = touch.dy < -0.2 ? 1 : 0;   input.down = touch.dy > 0.2 ? 1 : 0;
      if (Math.hypot(touch.dx, touch.dy) > 0.2) input.aim = Math.atan2(touch.dy, touch.dx);
    } else if (isTouch) {
      input.left = input.right = input.up = input.down = 0;
    } else {
      input.up = keys.up || 0; input.down = keys.down || 0;
      input.left = keys.left || 0; input.right = keys.right || 0;
      /* The camera is locked to your tank, so the centre of the screen IS the
         tank and the barrel points from there to the cursor. No need to know
         where the tank is in the world to work that out. */
      input.aim = Math.atan2(mouse.y - window.innerHeight / 2,
                             mouse.x - window.innerWidth / 2);
    }
    socket.emit('sh:input', input);
  }
  setInterval(sendInput, 1000 / 30);

  /* ── the wire ─────────────────────────────────────────────────────────────── */

  socket.on('sh:map', (m) => {
    map = { cols: m.cols, rows: m.rows, tile: m.tile,
            cells: m.cells.split('|').map(row => row.split('').map(Number)) };
  });
  socket.on('sh:state', (s) => {
    prev = next; prevAt = nextAt;
    next = s; nextAt = performance.now();
    if (!prev) prev = s, prevAt = nextAt;
    paintHud(s);
  });
  socket.on('sh:cleared', () => {
    $('between').hidden = false;
    $('clearedCoins').textContent = next ? next.coins : 0;
  });

  /* ── the HUD ──────────────────────────────────────────────────────────────── */
  function paintHud(s) {
    if (!started) return;
    $('hud').hidden = false;
    $('guns').hidden = false;
    if (s.you) {
      const pct = Math.max(0, s.you.health / s.you.max * 100);
      $('hpBar').style.width = pct + '%';
      $('hpNum').textContent = s.you.health;
    }
    $('lvlNum').textContent = s.level;
    $('coinNum').textContent = s.coins;
    if (s.base) $('baseBar').style.width = (s.base.health / s.base.max * 100) + '%';

    const COST = { cannon: 0, rapid: 120, scatter: 220 };
    for (const btn of document.querySelectorAll('.gun')) {
      const w = btn.dataset.w;
      const owned = s.owned.indexOf(w) !== -1;
      btn.classList.toggle('owned', owned);
      btn.classList.toggle('on', s.weapon === w);
      btn.classList.toggle('afford', !owned && s.coins >= COST[w]);
      btn.querySelector('em').textContent = owned ? '' : COST[w];
    }

    $('msg').hidden = !(s.you && s.you.dead);
    if (s.you && s.you.dead) $('msg').textContent = 'Rebuilding…';
  }

  function pickGun(w) { socket.emit('sh:buy', { weapon: w }); }
  for (const btn of document.querySelectorAll('.gun')) {
    btn.addEventListener('click', () => pickGun(btn.dataset.w));
  }

  /* ── drawing ──────────────────────────────────────────────────────────────── */

  function lerp(a, b, t) { return a + (b - a) * t; }

  function draw() {
    requestAnimationFrame(draw);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#100e0b';
    ctx.fillRect(0, 0, cv.width, cv.height);
    if (!map || !next || !started) return;

    /* Between the last two snapshots. At 30Hz that is a 33ms lag and perfectly
       smooth; running ahead of the server instead would mean guessing, and this
       client is deliberately not in the guessing business. */
    const span = Math.max(1, nextAt - prevAt);
    const t = Math.min(1, (performance.now() - nextAt) / span);

    const you = next.you || { x: 0, y: 0 };
    const pyou = (prev && prev.you) || you;

    /* Zoom, then clamp. Drawing the world at one screen pixel per world unit
       showed nine tiles across a phone and left a quarter of a desktop screen
       as black void off the edge of the arena, because the tank spawns in a
       corner. A fixed amount of world on screen fixes the first; a camera that
       stops at the wall fixes the second. */
    const z = zoom();
    const halfW = cv.width / 2 / z, halfH = cv.height / 2 / z;
    const worldW = map.cols * map.tile, worldH = map.rows * map.tile;
    cam.x = clampCam(lerp(pyou.x, you.x, t), halfW, worldW);
    cam.y = clampCam(lerp(pyou.y, you.y, t), halfH, worldH);

    const ox = cv.width / 2 - cam.x * z;
    const oy = cv.height / 2 - cam.y * z;
    const X = (x) => x * z + ox;
    const Y = (y) => y * z + oy;
    S = z;                       // what every radius and line width is drawn at

    drawFloor(X, Y);
    drawBase(X, Y);
    drawPickups(X, Y);
    drawTanks(X, Y, t, you, pyou);
    drawBullets(X, Y);
    drawBaseArrow(X, Y);
  }

  function drawFloor(X, Y) {
    const T = map.tile;
    /* Only the cells on screen. The arena is 34x22 so drawing all of it would
       be fine, but the loop is written to survive a much bigger one. */
    const c0 = Math.max(0, Math.floor((cam.x - cv.width / 2 / S) / T) - 1);
    const c1 = Math.min(map.cols - 1, Math.ceil((cam.x + cv.width / 2 / S) / T) + 1);
    const r0 = Math.max(0, Math.floor((cam.y - cv.height / 2 / S) / T) - 1);
    const r1 = Math.min(map.rows - 1, Math.ceil((cam.y + cv.height / 2 / S) / T) + 1);

    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const v = map.cells[r][c];
        const x = X(c * T), y = Y(r * T), s = T * S;
        if (v === 0) {
          // A faint grid on the floor, so movement reads as movement.
          ctx.fillStyle = ((r + c) & 1) ? '#15120d' : '#171310';
          ctx.fillRect(x, y, s, s);
        } else if (v === 1) {
          ctx.fillStyle = '#7a5a2e';
          ctx.fillRect(x + 2 * S, y + 2 * S, s - 4 * S, s - 4 * S);
          ctx.strokeStyle = 'rgba(240,168,48,0.45)';
          ctx.lineWidth = Math.max(1, S);
          ctx.strokeRect(x + 2 * S, y + 2 * S, s - 4 * S, s - 4 * S);
        } else {
          ctx.fillStyle = '#584a35';
          ctx.fillRect(x, y, s, s);
          // A lit top edge and a shadowed bottom: the cell reads as standing up.
          ctx.fillStyle = 'rgba(255,235,190,0.10)';
          ctx.fillRect(x, y, s, Math.max(1, 3 * S));
          ctx.fillStyle = 'rgba(0,0,0,0.45)';
          ctx.fillRect(x, y + s - 5 * S, s, 5 * S);
        }
      }
    }
  }

  function drawBase(X, Y) {
    const b = next.base;
    if (!b || b.health <= 0) return;
    const x = X(b.x), y = Y(b.y), r = b.r * S;
    ctx.save();
    // A pulse, so the thing you are here to destroy is never lost in the scenery.
    const pulse = 0.6 + 0.4 * Math.sin(Date.now() / 260);
    ctx.strokeStyle = 'rgba(224,112,95,' + pulse.toFixed(2) + ')';
    ctx.lineWidth = 3 * S;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(224,112,95,0.18)';
    ctx.fill();
    ctx.fillStyle = '#e0705f';
    ctx.beginPath(); ctx.arc(x, y, r * 0.42, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  /* Coins and repairs, neither of which moves, so there is nothing here to
     interpolate. A repair is a cross rather than a differently coloured circle:
     at this size colour alone is not a difference you can act on at speed. */
  function drawPickups(X, Y) {
    for (const c of next.coinsOnFloor) {
      const x = X(c[0]), y = Y(c[1]);
      if (c[2]) {
        const a = 7 * S, b = 2.4 * S;
        ctx.fillStyle = '#8ed081';
        ctx.fillRect(x - a, y - b, a * 2, b * 2);
        ctx.fillRect(x - b, y - a, b * 2, a * 2);
      } else {
        ctx.fillStyle = '#f0a830';
        ctx.beginPath();
        ctx.arc(x, y, 5 * S, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /* The base sits in the far corner of an arena wider than the screen, so for
     most of a level the thing you are here to destroy is not on it. A marker
     pinned to the edge of the screen says which way to drive; it disappears the
     moment the base itself is visible, because two of them would be one too
     many. */
  function drawBaseArrow(X, Y) {
    const b = next.base;
    if (!b || b.health <= 0) return;
    const bx = X(b.x), by = Y(b.y);
    const pad = 26 * dpr;
    if (bx > pad && bx < cv.width - pad && by > pad && by < cv.height - pad) return;
    const cx = cv.width / 2, cy = cv.height / 2;
    const a = Math.atan2(by - cy, bx - cx);
    /* Where the line out to the base leaves the screen. Scaling by whichever
       axis runs out first is what keeps the marker in the corner rather than
       sliding off it. */
    const k = Math.min((cx - pad) / Math.max(1e-6, Math.abs(Math.cos(a))),
                       (cy - pad) / Math.max(1e-6, Math.abs(Math.sin(a))));
    const x = cx + Math.cos(a) * k, y = cy + Math.sin(a) * k;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    ctx.fillStyle = '#e0705f';
    ctx.beginPath();
    ctx.moveTo(11 * dpr, 0);
    ctx.lineTo(-8 * dpr, -8 * dpr);
    ctx.lineTo(-8 * dpr, 8 * dpr);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function tankShape(X, Y, x, y, angle, aim, colour, hp, max) {
    const s = 15 * S;
    ctx.save();
    ctx.translate(X(x), Y(y));

    // Hull, pointing where it is driving.
    ctx.save();
    ctx.rotate(angle);
    ctx.fillStyle = colour;
    ctx.fillRect(-s, -s * 0.78, s * 2, s * 1.56);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(-s, -s * 0.78, s * 2, s * 0.3);
    ctx.fillRect(-s, s * 0.48, s * 2, s * 0.3);
    ctx.restore();

    // Turret, pointing where it is aiming. Two directions at once is the whole
    // feel of the genre: you drive one way and shoot another.
    ctx.save();
    ctx.rotate(aim);
    ctx.fillStyle = colour;
    ctx.beginPath(); ctx.arc(0, 0, s * 0.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = colour;
    ctx.fillRect(0, -s * 0.16, s * 1.6, s * 0.32);
    ctx.restore();

    // A health pip above anything that is hurt.
    if (hp < max) {
      const w = s * 2;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(-w / 2, -s * 1.7, w, 3 * S);
      ctx.fillStyle = colour;
      ctx.fillRect(-w / 2, -s * 1.7, w * (hp / max), 3 * S);
    }
    ctx.restore();
  }

  function drawTanks(X, Y, t, you, pyou) {
    for (let i = 0; i < next.tanks.length; i++) {
      const n = next.tanks[i];
      const p = (prev && prev.tanks[i]) || n;
      tankShape(X, Y, lerp(p.x, n.x, t), lerp(p.y, n.y, t),
                n.angle, n.aim, '#e0705f', n.health, n.max);
    }
    if (next.you && !next.you.dead) {
      const x = lerp(pyou.x, you.x, t), y = lerp(pyou.y, you.y, t);
      if (you.safe) {
        // Shells bounce off for a moment after you respawn. Say so.
        ctx.strokeStyle = 'rgba(142,208,129,' + (0.35 + 0.35 * Math.sin(Date.now() / 90)).toFixed(2) + ')';
        ctx.lineWidth = 2 * S;
        ctx.beginPath(); ctx.arc(X(x), Y(y), 24 * S, 0, Math.PI * 2); ctx.stroke();
      }
      tankShape(X, Y, x, y, you.angle, you.aim, '#8ed081', you.health, you.max);
    }
  }

  function drawBullets(X, Y) {
    for (const b of next.bullets) {
      ctx.fillStyle = b[3] ? '#e0705f' : '#ffe9b8';
      ctx.beginPath();
      ctx.arc(X(b[0]), Y(b[1]), Math.max(2, b[2] * S), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* ── starting, and leaving ────────────────────────────────────────────────── */

  $('startBtn').addEventListener('click', () => {
    $('boot').hidden = true;
    started = true;
    socket.emit('sh:join', { name: NAME });
  });
  $('nextBtn').addEventListener('click', () => {
    $('between').hidden = true;
    socket.emit('sh:next');
  });
  const leave = () => {
    socket.emit('sh:leave');
    if (window.parent && window.parent !== window) window.parent.postMessage('game:done', '*');
    else window.location.href = '/';
  };
  $('quitBtn').addEventListener('click', leave);
  $('exitBtn').addEventListener('click', leave);
  window.addEventListener('keydown', (e) => { if (e.code === 'Escape') leave(); });

  draw();
})();
