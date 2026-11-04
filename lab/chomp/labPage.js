// Pac-Man lab page helpers: canvas fit, keyboard and thumb-stick input, the fixed 60 Hz loop, scene pieces for the real
// game's renderer (ChompPixel), sleeping ghosts, score pops and sounds. Shared by royale.html, duel.html and arena.html.
(function (root) {
  'use strict';
  var TK = { chew: 2, deathFreeze: 20, deathFrame: 6 };
  var CHEW = [0, 1, 2, 1];

  // Fit a ChompPixel so cols x rows arcade tiles (score rows included) show whole, at a whole-number scale.
  function fit(px, cssW, cssH, cols, rows) {
    var dpr = Math.min(root.devicePixelRatio || 1, 3);
    px.canvas.style.width = cssW + 'px'; px.canvas.style.height = cssH + 'px';
    px.resize(cssW, cssH, dpr);
    if (cols && rows) {
      var k = Math.max(1, Math.floor(Math.min(px.canvas.width / (cols * 8), px.canvas.height / (rows * 8))));
      px.k = k; px.S = k * 8;
      px.buf.width = Math.ceil(px.canvas.width / k); px.buf.height = Math.ceil(px.canvas.height / k);
    }
    return px.k;
  }

  // Keyboard (arrows, WASD) and a thumb stick that follows the thumb (the live game's phone control): drag anywhere,
  // the way you drag is the way you go. onDir(d) with d 0 up, 1 left, 2 down, 3 right. hold(on) for a held key (Q).
  function input(o) {
    var KEYS = { ArrowUp: 0, KeyW: 0, ArrowLeft: 1, KeyA: 1, ArrowDown: 2, KeyS: 2, ArrowRight: 3, KeyD: 3 };
    root.addEventListener('keydown', function (e) {
      if (e.code in KEYS) { o.onDir(KEYS[e.code]); e.preventDefault(); }
      else if (e.code === 'KeyQ' && o.hold) { o.hold(true); }
      else if ((e.code === 'Space' || e.code === 'Enter') && o.onAction) { o.onAction(); e.preventDefault(); }
    });
    root.addEventListener('keyup', function (e) { if (e.code === 'KeyQ' && o.hold) o.hold(false); });
    var el = o.el || document.body, ax = 0, ay = 0, id = null, moved = false;
    el.addEventListener('touchstart', function (e) {
      if (e.target.closest && e.target.closest('button, a, .lab-ui')) return;
      var t = e.changedTouches[0]; id = t.identifier; ax = t.clientX; ay = t.clientY; moved = false;
      e.preventDefault();
    }, { passive: false });
    el.addEventListener('touchmove', function (e) {
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i];
        if (t.identifier !== id) continue;
        var dx = t.clientX - ax, dy = t.clientY - ay, m = Math.max(Math.abs(dx), Math.abs(dy));
        if (m < 14) continue;
        var d = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 3 : 1) : (dy > 0 ? 2 : 0);
        o.onDir(d); moved = true;
        // the anchor follows the thumb, so a new drag the other way turns at once
        ax = t.clientX - Math.sign(dx) * Math.min(Math.abs(dx), 14) * (Math.abs(dx) > Math.abs(dy) ? 1 : 0);
        ay = t.clientY - Math.sign(dy) * Math.min(Math.abs(dy), 14) * (Math.abs(dy) >= Math.abs(dx) ? 1 : 0);
      }
      e.preventDefault();
    }, { passive: false });
    el.addEventListener('touchend', function (e) {
      for (var i = 0; i < e.changedTouches.length; i++) if (e.changedTouches[i].identifier === id) {
        id = null;
        if (!moved && o.onAction) o.onAction();
      }
    });
  }

  // Fixed 60 Hz steps from requestAnimationFrame; draw once a frame.
  function loop(step, draw) {
    var last = performance.now(), acc = 0, STEP = 1000 / 60;
    function frame(now) {
      acc += Math.min(250, now - last); last = now;
      var n = 0;
      while (acc >= STEP && n < 6) { step(); acc -= STEP; n++; }
      if (n === 6) acc = 0;
      draw();
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // Chewing: a mouth that opens and shuts while moving, never stopping shut.
  var chew = new Map();
  function chewFrame(id, moving) {
    var c = chew.get(id);
    if (!c) { c = { t: 0, f: 2 }; chew.set(id, c); }
    if (moving) { c.t++; c.f = CHEW[Math.floor(c.t / TK.chew) % 4]; } else if (c.f === 0) c.f = 2;
    return c.f;
  }
  function deathFrame(t) { return t < TK.deathFreeze ? -1 : Math.min(13, Math.floor((t - TK.deathFreeze) / TK.deathFrame)); }

  // A ghost as ChompPixel draws it. look: 'eyes' | 'blue' | 'flash' | 'normal'
  function ghostSprite(g, look, tick) {
    return { x: g.x, y: g.y, dir: g.dir, look: g.dir, ki: g.ki, frame: Math.floor(tick / 8) % 2,
      mode: look === 'eyes' ? 3 : look === 'blue' ? 1 : look === 'flash' ? 2 : 0 };
  }
  function blueLook(powerTicks, tick) {
    if (powerTicks <= 0) return 'normal';
    if (powerTicks < 120 && Math.floor(tick / 14) % 2 === 1) return 'flash';
    return 'blue';
  }

  // Sleeping ghosts (the Train modes): a dim ghost with shut eyes, drawn over the frame on the screen canvas.
  var sleepCache = {};
  function sleepSprite(ki) {
    if (sleepCache[ki]) return sleepCache[ki];
    var BODY = ['#7a2a2a', '#7a4a7a', '#2a6a7a', '#7a5a2a'][ki] || '#555', LID = '#c8c8ff';
    var c = document.createElement('canvas'); c.width = c.height = 16;
    var g = c.getContext('2d');
    for (var j = 0; j < 16; j++) for (var i = 0; i < 16; i++) {
      var x = i - 1, y = j - 1;
      if (x < 0 || y < 0 || x > 13 || y > 13) continue;
      var fx = x + 0.5 - 7, fy = y + 0.5 - 7, body;
      if (fy < 0) body = fx * fx + fy * fy <= 49; else if (y < 12) body = true; else { var u = x % 5; body = y === 12 ? u !== 4 : (u === 1 || u === 2); }
      if (!body) continue;
      var lid = y === 6 && ((x >= 2 && x <= 5) || (x >= 8 && x <= 11));
      g.fillStyle = lid ? LID : BODY;
      g.fillRect(i, j, 1, 1);
    }
    sleepCache[ki] = c;
    return c;
  }
  function drawSleepers(px, sleepers, tick) {
    var v = px.view;
    if (!v) return;
    var m = px.ctx, k = v.k;
    m.imageSmoothingEnabled = false;
    sleepers.forEach(function (s) {
      var bob = Math.floor((tick + s.x * 7) / 30) % 2;
      var sx = (v.ox + Math.floor(s.x * v.T) - 8) * k, sy = (v.oy + Math.floor(s.y * v.T) - 8 + bob) * k;
      if (sy < v.top * k || sy > v.bottom * k) return;
      m.drawImage(sleepSprite(s.ki), sx, sy, 16 * k, 16 * k);
      if (Math.floor((tick + s.x * 13) / 45) % 3 === 0) {
        m.fillStyle = '#c8c8ff'; m.font = (4 * k) + 'px "Press Start 2P", monospace'; m.textAlign = 'left'; m.textBaseline = 'bottom';
        m.fillText('z', sx + 13 * k, sy + 2 * k);
      }
    });
  }

  // Score pops: { x, y, text, color, born, word }; ChompPixel draws them, we age them out.
  function Pops() { this.list = []; }
  Pops.prototype.add = function (x, y, text, color, tick, word) { this.list.push({ x: x, y: y, text: String(text), color: color || '#00ffff', born: tick, word: !!word }); };
  Pops.prototype.scene = function (tick) {
    this.list = this.list.filter(function (q) { return tick - q.born < (q.word ? 70 : 60); });
    return this.list.map(function (q) { return { x: q.x, y: q.y, text: q.text, color: q.color, word: q.word, age: (tick - q.born) / 70 }; });
  };

  function sound(name) { if (root.ChompSound) root.ChompSound.play(name); }
  function chewSound() { if (root.ChompSound) root.ChompSound.eat(); }
  // Browsers start audio only after a key or a touch.
  function unlockAudio() {
    function go() { try { if (root.DSSfx && root.DSSfx.wake) root.DSSfx.wake(); } catch (e) { /* no sound */ } }
    root.addEventListener('keydown', go, { once: true });
    root.addEventListener('touchstart', go, { once: true });
    root.addEventListener('mousedown', go, { once: true });
  }

  // Query string helpers
  function q(name, def) { var v = new URLSearchParams(location.search).get(name); return v == null ? def : v; }
  function qn(name, def) { var v = parseFloat(q(name, '')); return isFinite(v) ? v : def; }
  function setQ(obj) {
    var u = new URL(location.href);
    Object.keys(obj).forEach(function (k) { u.searchParams.set(k, obj[k]); });
    location.href = u.toString();
  }

  // A row of choice chips (speed, players...): [{ label, value }], current value, onPick(value).
  function chips(el, title, list, cur, onPick) {
    var wrap = document.createElement('div'); wrap.className = 'lab-chips';
    var t = document.createElement('span'); t.textContent = title; wrap.appendChild(t);
    list.forEach(function (it) {
      var b = document.createElement('button');
      b.textContent = it.label; b.title = it.title || '';
      if (String(it.value) === String(cur)) b.className = 'on';
      b.addEventListener('click', function (e) { e.stopPropagation(); onPick(it.value); b.blur(); });
      wrap.appendChild(b);
    });
    el.appendChild(wrap);
  }

  root.LabPage = { fit: fit, input: input, loop: loop, chewFrame: chewFrame, deathFrame: deathFrame, ghostSprite: ghostSprite,
    blueLook: blueLook, drawSleepers: drawSleepers, Pops: Pops, sound: sound, chewSound: chewSound, unlockAudio: unlockAudio,
    q: q, qn: qn, setQ: setQ, chips: chips };
})(typeof self !== 'undefined' ? self : this);
