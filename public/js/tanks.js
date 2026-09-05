'use strict';
/* ─── Tanks, the client ───────────────────────────────────────────────────────
   Draws the battlefield and plays back what the server decided.

   IT DECIDES NOTHING. The angle and the power are the only two numbers this file
   originates; everything else — where the shell went, what it hit, what that
   cost, whose turn it is now — arrives from the server as a finished result and
   is animated. That is not caution for its own sake: a client that computes its
   own trajectory can be edited to compute a better one, and this product pays
   out real money.

   So the shell you watch has already landed. The animation is a replay of a
   trajectory the server flew, drawn one point at a time, which is exactly what
   it looks like anyway. */

(function () {
  const $ = (id) => document.getElementById(id);
  const cv = $('field');
  const ctx = cv.getContext('2d');
  const socket = io();

  const name = (() => {
    try { return sessionStorage.getItem('playerName') || 'Player'; } catch (_) { return 'Player'; }
  })();
  const wallet = (() => {
    try { return localStorage.getItem('duelseries_wallet') || null; } catch (_) { return null; }
  })();

  /* Everything known about the match. Replaced wholesale by the server. */
  let S = null;
  let myId = null;
  let shell = null;          // { path, i } while a shot is being replayed
  let blast = null;          // { x, y, t } a fading flash where it landed
  let dpr = 1, view = { x: 0, y: 0, k: 1 };

  /* ── fitting the battlefield to the screen ─────────────────────────────────
     The world is a fixed 1400x700. The screen is anything. Fit it by width, sit
     it above the controls, and never scale so far that the tanks become dots. */
  function layout() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = window.innerWidth, h = window.innerHeight;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
    if (!S) return;
    const bottomUi = Math.min(210, h * 0.32);      // the dials
    const topUi = 70;
    const usableH = Math.max(160, h - bottomUi - topUi);
    view.k = Math.min(w / S.w, usableH / S.h);
    view.x = (w - S.w * view.k) / 2;
    view.y = topUi + (usableH - S.h * view.k) / 2;
  }
  window.addEventListener('resize', layout);

  // World point -> canvas pixel. The world's y is UP; the screen's is down.
  const px = (x) => (view.x + x * view.k) * dpr;
  const py = (y) => (view.y + (S.h - y) * view.k) * dpr;

  /* ── drawing ──────────────────────────────────────────────────────────────── */

  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!S) { requestAnimationFrame(draw); return; }

    drawSky();
    drawGround();
    for (const p of S.players) drawTank(p);
    drawAimHint();                 // over the tanks, under the shell
    if (shell) drawShell();
    if (blast) drawBlast();

    requestAnimationFrame(draw);
  }

  function drawSky() {
    /* Dusk. The haze sits at the horizon rather than filling the frame, so the
       hill has something to be a silhouette against. */
    const top = py(S.h), bottom = py(0);
    const g = ctx.createLinearGradient(0, top, 0, bottom);
    g.addColorStop(0, '#14110d');
    g.addColorStop(0.62, '#241a12');
    g.addColorStop(1, '#3a2a18');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cv.width, cv.height);
  }

  function drawGround() {
    const n = S.ground.length;
    ctx.beginPath();
    ctx.moveTo(px(0), py(S.ground[0]));
    for (let i = 1; i < n; i++) ctx.lineTo(px(i / (n - 1) * S.w), py(S.ground[i]));
    ctx.lineTo(px(S.w), cv.height);
    ctx.lineTo(px(0), cv.height);
    ctx.closePath();
    /* Nearly black, and darker than the sky is anywhere. The fill was #241d14
       against a horizon of #3a2a18 — a shade apart, so the hill only existed
       because of the line on top of it, and a crater in it was invisible until
       the line moved. Ground should be the solid thing on the screen. */
    const gg = ctx.createLinearGradient(0, py(S.h * 0.6), 0, cv.height);
    gg.addColorStop(0, '#191309');
    gg.addColorStop(1, '#0c0906');
    ctx.fillStyle = gg;
    ctx.fill();

    /* The lit crust. One bright line along the top of the hill is what makes a
       flat silhouette read as ground with a sun on it, and it is the same amber
       the power dial uses — the light and the number are the same idea. */
    ctx.beginPath();
    ctx.moveTo(px(0), py(S.ground[0]));
    for (let i = 1; i < n; i++) ctx.lineTo(px(i / (n - 1) * S.w), py(S.ground[i]));
    ctx.strokeStyle = 'rgba(240,168,48,0.85)';
    ctx.lineWidth = 2 * dpr;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  function drawTank(p) {
    const mine = p.id === myId;
    const gx = px(p.x);
    const gy = py(groundAt(p.x));
    /* Floored at a size you can actually see. The whole battlefield has to fit
       on screen — that is the genre — so on a phone the scale gets small enough
       that a true-to-world tank is six pixels of nothing. It is drawn slightly
       larger than life instead, which is a lie about scale and the truth about
       what you need to see. */
    const k = Math.max(view.k, 0.62);
    const w = 34 * k * dpr, h = 16 * k * dpr;
    const body = mine ? '#f4f1ea' : '#e0705f';

    ctx.save();
    ctx.globalAlpha = p.health > 0 ? 1 : 0.35;

    // The barrel, at the angle currently dialled. It IS the aim readout.
    const rad = (mine ? angleOf() : p.angle) * Math.PI / 180;
    ctx.strokeStyle = body;
    ctx.lineWidth = Math.max(2.4, 3.5 * k) * dpr;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(gx, gy - h * 0.55);
    ctx.lineTo(gx + Math.cos(rad) * w * 0.85, gy - h * 0.55 - Math.sin(rad) * w * 0.85);
    ctx.stroke();

    // Hull: a squat trapezium, which reads as a tank at any size.
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(gx - w / 2, gy);
    ctx.lineTo(gx + w / 2, gy);
    ctx.lineTo(gx + w * 0.34, gy - h);
    ctx.lineTo(gx - w * 0.34, gy - h);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /* Only the first stretch of the arc, and only on your turn. Enough to see
     where you are pointing; nowhere near enough to be told the answer. */
  function drawAimHint() {
    const me = myTank();
    if (!me || !isMyTurn() || shell) return;
    const rad = angleOf() * Math.PI / 180;
    const gx = px(me.x), gy = py(groundAt(me.x)) - 16 * view.k * dpr * 0.55;
    ctx.save();
    ctx.setLineDash([3 * dpr, 5 * dpr]);
    ctx.strokeStyle = 'rgba(245,241,232,0.35)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(gx, gy);
    const reach = (40 + powerOf() * 0.9) * view.k * dpr;
    ctx.lineTo(gx + Math.cos(rad) * reach, gy - Math.sin(rad) * reach);
    ctx.stroke();
    ctx.restore();
  }

  function drawShell() {
    const path = shell.path;
    const upto = Math.min(shell.i, path.length - 1);
    /* The trail behind it, fading. A shell is a dot; the arc is the information,
       and you need to see the arc to correct the next one. */
    ctx.save();
    ctx.lineCap = 'round';
    for (let i = Math.max(1, upto - 46); i <= upto; i++) {
      const a = (i - (upto - 46)) / 46;
      ctx.strokeStyle = 'rgba(240,168,48,' + (0.10 + a * 0.55).toFixed(3) + ')';
      ctx.lineWidth = (0.8 + a * 2) * dpr;
      ctx.beginPath();
      ctx.moveTo(px(path[i - 1][0]), py(path[i - 1][1]));
      ctx.lineTo(px(path[i][0]), py(path[i][1]));
      ctx.stroke();
    }
    const p = path[upto];
    ctx.fillStyle = '#fff3d8';
    ctx.beginPath();
    ctx.arc(px(p[0]), py(p[1]), 3.2 * dpr, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawBlast() {
    const age = (Date.now() - blast.t) / 420;
    if (age >= 1) { blast = null; return; }
    const r = (10 + age * 62) * view.k * dpr;
    ctx.save();
    ctx.globalAlpha = 1 - age;
    ctx.strokeStyle = '#ffd9a0';
    ctx.lineWidth = (3 - age * 2) * dpr;
    ctx.beginPath();
    ctx.arc(px(blast.x), py(blast.y), r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function groundAt(x) {
    const n = S.ground.length;
    const i = Math.max(0, Math.min(n - 1, Math.round(x / S.w * (n - 1))));
    return S.ground[i];
  }

  /* ── state and controls ───────────────────────────────────────────────────── */

  const myTank = () => S && S.players.find(p => p.id === myId);
  const isMyTurn = () => S && S.state === 'playing' && S.turn === myId;
  const angleOf = () => Number($('angle').value);
  const powerOf = () => Number($('power').value);

  function paintDials() {
    $('angleVal').textContent = angleOf() + '°';
    $('powerVal').textContent = powerOf();
  }
  $('angle').addEventListener('input', paintDials);
  $('power').addEventListener('input', paintDials);

  function applyState(next) {
    S = next;
    layout();
    if (!S) return;

    $('top').hidden = false;
    $('controls').hidden = false;
    $('turn').hidden = false;
    $('wait').hidden = true;

    const me = myTank();
    const foe = S.players.find(p => p.id !== myId);
    if (me) {
      $('youName').textContent = me.name;
      $('youHp').textContent = me.health;
      $('youBar').style.width = me.health + '%';
    }
    if (foe) {
      $('themName').textContent = foe.name;
      $('themHp').textContent = foe.health;
      $('themBar').style.width = foe.health + '%';
    }

    /* The wind as an arrow you can read at a glance, with its strength in the
       number of chevrons rather than a figure to interpret mid-aim. */
    const w = S.wind || 0;
    const strength = Math.min(3, Math.ceil(Math.abs(w) / 20));
    $('windArrow').textContent = w === 0 ? '—'
      : (w < 0 ? '◀'.repeat(strength) : '▶'.repeat(strength));

    const mine = isMyTurn();
    $('turnText').textContent = S.state !== 'playing' ? '' : mine ? 'Your shot' : 'Their shot';
    $('turn').classList.toggle('mine', mine);
    $('controls').classList.toggle('waiting', !mine || !!shell);
    $('fire').disabled = !mine || !!shell;
  }

  $('fire').addEventListener('click', () => {
    if (!isMyTurn() || shell) return;
    $('fire').disabled = true;
    socket.emit('tanks:fire', { angle: angleOf(), power: powerOf() });
  });

  /* Replay a shot the server has already flown. */
  function playShot(result) {
    shell = { path: result.path, i: 0 };
    $('controls').classList.add('waiting');
    const step = () => {
      if (!shell) return;
      shell.i += 3;
      if (shell.i < shell.path.length - 1) { setTimeout(step, 16); return; }
      const end = result.hit;
      shell = null;
      if (end && end.type !== 'out') blast = { x: end.x, y: end.y, t: Date.now() };
      if (result.state) applyState(result.state);
    };
    step();
  }

  /* ── the wire ─────────────────────────────────────────────────────────────── */

  socket.on('connect', () => {
    myId = socket.id;
    socket.emit('tanks:queue', { name, wallet });
  });

  socket.on('tanks:queued', () => {
    $('wait').hidden = false;
    $('waitMain').textContent = 'Looking for an opponent';
    $('waitSub').textContent = 'Free table. Nothing staked.';
  });

  socket.on('tanks:start', (state) => {
    myId = socket.id;
    applyState(state);
    /* Point the barrel at the other tank to begin with, so the first shot is a
       correction rather than a shot in the dark. */
    const me = myTank();
    if (me) { $('angle').value = me.side === 'left' ? 45 : 135; paintDials(); }
  });

  socket.on('tanks:shot', (result) => playShot(result));

  socket.on('tanks:timeout', (m) => { if (m.state) applyState(m.state); });

  socket.on('tanks:over', (m) => {
    if (m.state) applyState(m.state);
    const me = myTank();
    const won = m.winner && me && m.winner.name === me.name;
    $('over').hidden = false;
    $('overEyebrow').textContent = 'Match over';
    $('overWho').textContent = !m.winner ? 'Both destroyed' : won ? 'You won' : m.winner.name + ' won';
    $('overWho').className = 'overWho' + (!m.winner ? '' : won ? ' won' : ' lost');
    $('overWhy').textContent = m.why === 'opponent left' ? 'They left the match.'
      : !m.winner ? 'Nobody was left standing.' : '';
    $('controls').classList.add('waiting');
  });

  socket.on('maintenance', (m) => {
    $('wait').hidden = false;
    $('waitMain').textContent = 'The game is closed right now';
    $('waitSub').textContent = (m && m.message) || 'Back shortly.';
  });

  socket.on('disconnect', () => {
    $('wait').hidden = false;
    $('waitMain').textContent = 'Lost connection';
    $('waitSub').textContent = 'Trying to get back in.';
  });

  /* ── leaving ──────────────────────────────────────────────────────────────── */

  function toLobby() {
    socket.emit('tanks:leave');
    if (window.parent && window.parent !== window) window.parent.postMessage('game:done', '*');
    else window.location.href = '/';
  }
  $('waitCancel').addEventListener('click', toLobby);
  $('lobbyBtn').addEventListener('click', toLobby);
  $('againBtn').addEventListener('click', () => {
    $('over').hidden = true;
    socket.emit('tanks:leave');
    socket.emit('tanks:queue', { name, wallet });
    $('wait').hidden = false;
    $('waitMain').textContent = 'Looking for an opponent';
    $('waitSub').textContent = 'Free table. Nothing staked.';
  });

  /* ONE render loop. There were briefly two — the second drew the aim hint on a
     frame the first had already cleared, so it flickered at whatever rate the
     two happened to interleave. The hint is part of the frame, so it is drawn
     in the frame. */
  layout();
  paintDials();
  draw();
})();
