'use strict';
/* ─── Knockout: the sound ────────────────────────────────────────────────────
   The house Glass sounds (dsSfx.js engine, dsSfxGame.js library), picked by
   name. No files. Two one-line calls in knockout.js feed it: attach() once,
   right after the socket exists, and frame() every animation frame. The
   countdown and the Lock in button are picked up from the page itself.

     match found      g.join                 countdown   g.tick, g.tick, g.go
     your next turn   g.turn                 clock low   g.tick (last 3 s)
     Lock in          g.click                arrows go   g.shoot per arrow, heavier for a long pull
     two pieces meet  g.bounce / g.hit (a hard one), pitched by speed
     piece goes off   g.fall; yours also g.hurt, theirs (knocked off) also g.kill
     match over       g.win / g.lose

   Watching a match: no turn, hurt, kill or result sounds, only the board's. */

(function (root) {
  const S = root.DSSfx;
  if (!S) return;
  const doc = root.document;
  const play = (name, opt) => S.play(name, opt);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  let get = () => ({});
  let cur = null, idx = 0;               // the tape being played and the frame heard up to
  let launched = false, lastReveal = null;
  let fell = new Set(), ringSeen = new Set(), pairAt = new Map();
  let tickLeft = -1;

  const view = () => { try { return get() || {}; } catch (_) { return {}; } };
  const watching = () => !!view().watch;

  function reset() {
    cur = null; idx = 0; launched = false; lastReveal = null;
    fell = new Set(); ringSeen = new Set(); pairAt = new Map(); tickLeft = -1;
  }

  /* ── what the server says ───────────────────────────────────────────────── */
  function attach(socket, getter) {
    if (typeof getter === 'function') get = getter;
    socket.on('ko:start', () => { reset(); if (!watching()) play('g.join'); });
    socket.on('ko:watching', reset);
    socket.on('ko:turn', (m) => {
      tickLeft = -1;
      if (!watching() && m && m.turn > 1) play('g.turn');     // turn 1 opens on the countdown's Go
    });
    socket.on('ko:refused', () => play('g.err', { vol: 0.7 }));
    socket.on('ko:over', (m) => {
      if (watching() || !m) return;
      play(m.winnerId && m.winnerId === view().me ? 'g.win' : 'g.lose');
    });
  }

  /* ── the countdown: the page's own number and box ───────────────────────── */
  if (doc && root.MutationObserver) {
    const box = doc.getElementById('count'), num = doc.getElementById('countNum');
    let shown = false, lastNum = '';
    const sync = () => {
      if (!box.hidden) {
        const n = num.textContent;
        if (shown && n !== lastNum) play('g.tick', { gap: 200 });     // the first number rides on g.join
        shown = true; lastNum = n;
      } else if (shown) {
        shown = false;
        if (lastNum === '1') play('g.go', { gap: 200 });              // only when it ran all the way down
      }
    };
    if (box && num) {
      const ob = new root.MutationObserver(sync);
      ob.observe(box, { attributes: true, attributeFilter: ['hidden'] });
      ob.observe(num, { childList: true, characterData: true, subtree: true });
    }
    const lock = doc.getElementById('lock');
    if (lock) lock.addEventListener('click', () => { if (!lock.disabled) play('g.click', { vol: 0.8 }); });
  }

  /* ── the board, every frame ─────────────────────────────────────────────── */
  const SLACK = 2.5;                      // positions are whole units, so contact gets a little give
  const at = (f, i) => [f[i * 2], f[i * 2 + 1]];

  function frame(tape, tapeAt, reveal, ringFall) {
    const v = view(), st = v.st;
    /* The ring closing past a piece: it drops as the ring reaches it. */
    if (ringFall && ringFall.size) {
      ringFall.forEach((_, id) => {
        if (ringSeen.has(id)) return;
        ringSeen.add(id);
        pieceOut(id, v, true);
      });
    }
    /* The clock's last three seconds, while it is red and you have not locked in. */
    if (!tape && !reveal && !v.watch && doc) {
      const num = doc.getElementById('clockNum'), box = num && num.parentElement;
      if (box && box.classList.contains('urgent')) {
        const left = parseInt(num.textContent, 10);
        if (left >= 1 && left <= 3 && left !== tickLeft) { tickLeft = left; play('g.tick', { vol: 0.8, rate: 0.85, gap: 300 }); }
      }
    }
    if (reveal) lastReveal = reveal;
    if (!tape || reveal || !st) return;

    if (tape !== cur) {
      cur = tape; idx = Math.min(tapeAt, tape.frames.length - 1); launched = false;
      fell = new Set(); pairAt = new Map();
    }
    if (!launched) { launched = true; if (idx === 0) launch(v); lastReveal = null; }

    const last = Math.min(tapeAt, tape.frames.length - 1);
    const reach = (st.pieceR || 26) * 2 + SLACK;
    const n = tape.order.length;
    const outAt = new Map((tape.out || []).map(o => [o.id, o.frame]));
    const live = (i, f) => { const o = outAt.get(tape.order[i]); return o === undefined || f < o; };
    for (let f = idx + 1; f <= last; f++) {
      const A = tape.frames[f], P = tape.frames[f - 1];
      if (!A || !P) continue;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          if (!live(i, f) || !live(j, f) || !live(i, f - 1) || !live(j, f - 1)) continue;
          const a = at(A, i), b = at(A, j), pa = at(P, i), pb = at(P, j);
          if (Math.hypot(b[0] - a[0], b[1] - a[1]) > reach || Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) <= reach) continue;
          const key = i * 8 + j;
          if (f - (pairAt.get(key) || -99) < 10) continue;       // a pair pushing on each other is one bump
          pairAt.set(key, f);
          bump(tape, f, i, j, a, b, v);
        }
      }
      (tape.out || []).forEach(o => {
        if (o.frame !== f || fell.has(o.id)) return;
        fell.add(o.id);
        pieceOut(o.id, v, false);
      });
    }
    idx = Math.max(idx, last);
  }

  /* All the arrows let go at once: a short, staggered burst, a longer pull louder. */
  function launch(v) {
    const maxPull = (v.st && v.st.maxPull) || 260;
    (lastReveal || []).slice(0, 4).forEach((a, k) => {
      const pull = clamp(Math.hypot(a.ax || 0, a.ay || 0) / maxPull, 0, 1);
      const name = pull > 0.8 ? 'g.shootHeavy' : 'g.shoot';
      const o = { vol: 0.45 + 0.55 * pull, rate: 1.1 - 0.25 * pull + k * 0.03, gap: 0 };
      if (k === 0) play(name, o); else root.setTimeout(() => play(name, o), k * 40);
    });
  }

  /* Two pieces touched. Harder and lower the faster they were going. */
  function bump(tape, f, i, j, a, b, v) {
    const P = tape.frames[Math.max(0, f - 2)], Q = tape.frames[f - 1];
    const sp = (k) => { const p = at(P, k), q = at(Q, k); return Math.hypot(q[0] - p[0], q[1] - p[1]); };
    const fast = Math.max(sp(i), sp(j));
    if (fast < 2) return;                                          // a nudge too light to hear
    const u = clamp(fast / 18, 0, 1);
    const arenaR = (v.st && v.st.arenaR) || 420;
    const mx = (a[0] + b[0]) / 2 * (v.flip ? -1 : 1);
    play(u > 0.55 ? 'g.hit' : 'g.bounce', { vol: 0.35 + 0.65 * u, rate: 1.15 - 0.3 * u, pan: clamp(mx / arenaR, -1, 1) * 0.5, gap: 40 });
  }

  /* A piece left the disc: knocked off, or caught by the closing ring. */
  function pieceOut(id, v, ring) {
    const p = v.st && (v.st.pieces || []).find(q => q.id === id);
    const mine = !!p && p.owner === v.me;
    play('g.fall', { vol: mine || v.watch ? 1 : 0.7, rate: p && !mine ? 1.2 : 1, gap: 150 });
    if (v.watch || !p) return;
    if (mine) root.setTimeout(() => play('g.hurt', { vol: 0.8, gap: 200 }), 280);
    else if (!ring) root.setTimeout(() => play('g.kill', { vol: 0.8, gap: 200 }), 380);
  }

  root.KnockoutSound = { attach: attach, frame: frame };
})(window);
