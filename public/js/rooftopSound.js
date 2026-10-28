'use strict';
/* ─── Rooftop Snipers: the sound ──────────────────────────────────────────────
   The house engine (dsSfx.js) and its Glass game pack (dsSfxGame.js), plus the
   few sounds a rooftop shoot-out has, defined here the same way: a few lines of
   numbers, synthesised once at load, no files (the reference's own recordings
   are never used).

   The moments are the reference's (its AudioStreamPlayer nodes):
     a shot                rt.shot    a sharp crack with a low boom under it
     a hit                 rt.hurt    a dull punch (the reference's HurtSound, 10 dB up)
     a jump                rt.jump    a short springy hop
     the first round       rt.bell    a boxing-ring bell (StartBell)
     a point               rt.point   two rising ticks (Checkmark Sound)
     a match point round   rt.match   a three-note sting (matchPointSound)
     the round's label     rt.swoosh  a quick air swish (Swoosh)
   rooftop.js feeds it: attach() once with the socket, local() for your own shot
   and jump the moment your screen predicts them; the server's copy of those is
   then skipped. Watching a match: the roof's sounds only, no win or loss. */

(function (root) {
  const S = root.DSSfx;
  if (!S) return;
  let muted = false;
  S.setLevel(function () { return muted ? 0 : 1; });

  S.define({
    'rt.shot':  [{ o: 'n', d: 0.16, v: 0.34, a: 0.001, e: 0.05, lp: [7000, 1200] },
                 { o: 's', f: [150, 45], d: 0.22, v: 0.3, e: 0.07 },
                 { o: 'n', d: 0.45, v: 0.06, a: 0.01, e: 0.2, lp: 900 }],
    'rt.hurt':  [{ o: 's', f: [220, 70], d: 0.16, v: 0.34, e: 0.05 },
                 { o: 'n', d: 0.07, v: 0.14, lp: [1800, 400], e: 0.02 }],
    'rt.jump':  [{ o: 's', f: [260, 620], d: 0.12, v: 0.13, e: 0.05, g: 0.04 },
                 { o: 't', f: [130, 310], d: 0.1, v: 0.05, e: 0.04 }],
    'rt.bell':  [0, 0.16, 0.32].map((at) => ({ o: 'fm', f: 1320, m: 1.41, i: 2.2, at: at, d: 0.9, v: 0.1, e: 0.35, ie: 0.15 })),
    'rt.point': [{ o: 't', f: 880, d: 0.09, v: 0.14, e: 0.05 }, { o: 't', f: 1320, at: 0.09, d: 0.2, v: 0.14, e: 0.12 }],
    'rt.match': [{ o: 'q', f: 392, du: 0.5, d: 0.16, v: 0.07, e: 0.08 }, { o: 'q', f: 523, du: 0.5, at: 0.15, d: 0.16, v: 0.07, e: 0.08 },
                 { o: 'q', f: 784, du: 0.5, at: 0.3, d: 0.42, v: 0.08, e: 0.3 }],
    'rt.boom':  [{ o: 'n', d: 0.6, v: 0.36, a: 0.002, e: 0.25, lp: [2400, 300] }, { o: 's', f: [90, 32], d: 0.5, v: 0.34, e: 0.2 }],
    'rt.launch': [{ o: 'n', d: 0.35, v: 0.16, a: 0.01, e: 0.15, bp: [[900, 2400], 0.8] }, { o: 's', f: [180, 90], d: 0.18, v: 0.16, e: 0.06 }],
    'rt.swoosh': [{ o: 'n', d: 0.22, v: 0.08, a: 0.06, e: 0.1, bp: [[600, 3200], 1.4] }],
  });

  const now = () => (root.performance ? root.performance.now() : Date.now());
  const play = (name, opt) => S.play(name, opt);
  let get = () => ({});
  const view = () => { try { return get() || {}; } catch (_) { return {}; } };
  const panAt = (x) => (typeof x === 'number' ? Math.max(-1, Math.min(1, x / 640)) * 0.4 : 0);

  // Your own shot and jump, already heard from your own screen: the server's copy is skipped.
  const heard = { shot: -1e9, jump: -1e9 };

  function shot(side, x, hit, local) {
    const v = view(), mine = !v.watch && side === v.mySide;
    if (mine && !local && now() - heard.shot < 500) { if (hit) play('rt.hurt', { vol: 0.9, gap: 80 }); return; }
    if (local) heard.shot = now();
    play('rt.shot', { vol: mine ? 1 : 0.85, rate: 0.95 + Math.random() * 0.1, pan: panAt(x), gap: 60 });
    if (hit && !local) play('rt.hurt', { vol: 0.9, pan: panAt(x), gap: 80 });
  }
  function jump(side, x, local) {
    const v = view(), mine = !v.watch && side === v.mySide;
    if (mine && !local && now() - heard.jump < 450) return;
    if (local) heard.jump = now();
    play('rt.jump', { vol: mine ? 1 : 0.7, pan: panAt(x), gap: 80 });
  }

  function attach(socket, getter) {
    if (typeof getter === 'function') get = getter;
    socket.on('rt:start', () => { if (!view().watch) play('g.join'); });
    socket.on('rt:go', () => play('rt.bell', { vol: 0.8, gap: 500 }));
    socket.on('rt:ev', (list) => {
      if (!Array.isArray(list)) return;
      for (let i = 0; i < list.length && i < 6; i++) {
        const e = list[i];
        if (!Array.isArray(e) || typeof e[0] !== 'string') continue;
        if (e[0] === 'shot') shot(e[1], e[2], !!e[6], false);
        else if (e[0] === 'jump') jump(e[1], view().xOf ? view().xOf(e[1]) : 0, false);
        else if (e[0] === 'rocket') { const v = view(); if (v.watch || e[1] !== v.mySide || now() - heard.shot > 500) play('rt.launch', { gap: 60 }); }
        else if (e[0] === 'boom') { play('rt.boom', { pan: panAt(e[2]), gap: 80 }); if (e[4]) play('rt.hurt', { vol: 0.9, gap: 80 }); }
        else if (e[0] === 'ready') play('g.tick', { vol: 0.6, gap: 120 });
      }
    });
    socket.on('rt:point', () => play('rt.point', { gap: 400 }));
    socket.on('rt:round', (m) => {
      play('rt.swoosh', { vol: 0.8, gap: 300 });
      const v = view();
      if (m && v.matchPoint && v.matchPoint()) root.setTimeout(() => play('rt.match', { gap: 600 }), 120);
    });
    socket.on('rt:refused', () => play('g.err', { vol: 0.7 }));
    socket.on('rt:over', (m) => {
      const v = view();
      if (v.watch || !m) return;
      play(m.winnerId && m.winnerId === v.me ? 'g.win' : m.winnerId ? 'g.lose' : 'g.turn');
    });
  }

  // The page's own predicted shot or jump for your seat.
  function local(name, side, x, hit) {
    if (name === 'shot') shot(side, x, hit, true);
    else if (name === 'jump') jump(side, x, true);
    else if (name === 'rocket') { heard.shot = now(); play('rt.launch', { gap: 60 }); }
  }

  root.RooftopSound = { attach, local, setMuted: (v) => { muted = !!v; } };
})(window);
