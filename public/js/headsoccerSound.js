'use strict';
/* ─── Head Soccer: the sound ─────────────────────────────────────────────────
   The house engine (dsSfx.js) and its Glass game pack (dsSfxGame.js), plus a few
   sounds only a football match has, defined here the same way: a few lines of
   numbers, synthesised once at load, no files.

     a boot on the ball  hs.kick       a low thump with a slap of noise
     a header            hs.head       a short cartoon bonk
     the woodwork        hs.post       a metal clang that rings off
     a bounce            hs.bounce     quiet, so a bouncing ball is not a drum solo
     kick-off            hs.whistle    one short blast
     full time           hs.whistleEnd short, short, long
     a goal              hs.roar + hs.horn   the crowd, then the stadium horn
     the power shot      hs.zap        an electric crackle under the lightning
     the last 5 seconds  g.tick        soft, once a second
     match found / won / lost / refused   g.join, g.win, g.lose, g.err

   headsoccer.js feeds it: attach() once with the socket, local() for your own
   kicks and headers the moment your screen predicts them (so they are not a
   round trip late), power() when a cutscene starts, clock() every frame. The
   server's copy of a touch you already heard is skipped. Watching a match: the
   pitch's sounds only, no win or loss. */

(function (root) {
  const S = root.DSSfx;
  if (!S) return;
  const mf = S.mf;
  let muted = false;
  /* Mute is the engine's page volume, read on every play (battleshipSound.js does the same). */
  S.setLevel(function () { return muted ? 0 : 1; });

  const thump = (f0, f1, d, v, at) => ({ o: 's', f: [f0, f1], d: d, v: v, e: d / 3.5, at: at || 0 });
  S.define({
    'hs.kick':   [thump(170, 58, 0.13, 0.34), { o: 'n', d: 0.05, v: 0.16, lp: [2600, 600], e: 0.012 },
                  { o: 't', f: [320, 140], d: 0.05, v: 0.06, e: 0.015 }],
    'hs.head':   [{ o: 's', f: [620, 300], d: 0.11, v: 0.2, e: 0.04, g: 0.08 }, { o: 't', f: [330, 220], d: 0.09, v: 0.09, e: 0.03 },
                  { o: 'n', d: 0.02, v: 0.05, bp: [1800, 1.2], e: 0.006 }],
    'hs.post':   [{ o: 'fm', f: 1180, m: 1.41, i: 2.6, d: 0.7, v: 0.11, e: 0.2, ie: 0.08 },
                  { o: 'fm', f: 1765, m: 2.03, i: 1.8, d: 0.5, v: 0.06, e: 0.14, ie: 0.06 }, thump(260, 150, 0.06, 0.16)],
    'hs.bounce': [thump(210, 130, 0.07, 0.13), { o: 'n', d: 0.02, v: 0.03, lp: 900, e: 0.006 }],
    'hs.whistle': [{ o: 's', f: 2900, d: 0.34, v: 0.1, a: 0.012, e: 0.3, vib: [32, 0.03] },
                   { o: 't', f: 2930, d: 0.34, v: 0.04, a: 0.012, e: 0.3, vib: [32, 0.03] },
                   { o: 'n', d: 0.3, v: 0.025, hp: 3500, a: 0.01, e: 0.2 }],
    'hs.whistleEnd': [0, 0.26, 0.52].map((at, k) => ({ o: 's', f: 2900, at: at, d: k === 2 ? 0.62 : 0.18, v: 0.1, a: 0.01,
                      e: k === 2 ? 0.5 : 0.16, vib: [32, 0.03] }))
                      .concat([{ o: 'n', at: 0.52, d: 0.6, v: 0.02, hp: 3500, a: 0.01, e: 0.4 }]),
    'hs.roar':   [{ o: 'n', d: 2.1, v: 0.2, a: 0.28, e: 0.75, bp: [[520, 1300], 0.55] },
                  { o: 'n', d: 1.8, v: 0.07, a: 0.2, e: 0.6, lp: 3200 }],
    'hs.horn':   [{ o: 't', f: mf(58), d: 0.75, v: 0.1, a: 0.03, e: 0.6, vib: [5, 0.004] },
                  { o: 'q', f: mf(58), du: 0.4, d: 0.75, v: 0.025, a: 0.03, e: 0.6 },
                  { o: 't', f: mf(65), d: 0.75, v: 0.06, a: 0.03, e: 0.6 }],
    'hs.zap':    [{ o: 'n', d: 0.55, v: 0.15, a: 0.004, e: 0.2, sh: [5200, 700], lp: [6000, 900] },
                  { o: 's', f: [1900, 160], d: 0.32, v: 0.08, e: 0.1, g: 0.3 },
                  { o: 'q', f: 110, du: 0.5, d: 0.6, v: 0.03, a: 0.01, e: 0.3, vib: [18, 0.08] }],
  });

  const W = (root.HSSim && root.HSSim.HS.W) || 1196;
  const now = () => (root.performance ? root.performance.now() : Date.now());
  const play = (name, opt) => S.play(name, opt);
  let get = () => ({});
  const view = () => { try { return get() || {}; } catch (_) { return {}; } };
  const panAt = (x) => (typeof x === 'number' ? Math.max(-1, Math.min(1, x / W * 2 - 1)) * 0.45 : 0);

  /* Your own touches, already heard from your own screen: the server's copy of the same one is skipped. */
  const heard = { kick: -1e9, head: -1e9 };
  let powerAt = -1e9, lastTick = -1;

  function touch(name, side, x, local) {
    const v = view(), mine = !v.watch && side === v.mySide;
    if (name === 'kick' || name === 'head') {
      if (mine && !local && now() - heard[name] < 450) return;
      if (local) heard[name] = now();
      play(name === 'kick' ? 'hs.kick' : 'hs.head', { vol: mine ? 1 : 0.8, rate: 0.95 + Math.random() * 0.1, pan: panAt(x), gap: 60 });
    } else if (name === 'post') play('hs.post', { pan: panAt(x), gap: 120 });
    else if (name === 'bounce') play('hs.bounce', { vol: 0.7, pan: panAt(x), gap: 90 });
  }

  function attach(socket, getter) {
    if (typeof getter === 'function') get = getter;
    socket.on('hs:start', () => { lastTick = -1; if (!view().watch) play('g.join'); });
    socket.on('hs:watching', () => { lastTick = -1; });
    socket.on('hs:kickoff', () => play('hs.whistle', { gap: 400 }));
    socket.on('hs:ev', (list) => {
      if (!Array.isArray(list)) return;
      const x = view().ballX;
      for (let i = 0; i < list.length && i < 6; i++) {
        const e = list[i];
        if (Array.isArray(e) && typeof e[0] === 'string') touch(e[0], e[1], x, false);
      }
    });
    socket.on('hs:goal', () => {
      play('hs.roar', { gap: 800 });
      root.setTimeout(() => play('hs.horn', { vol: 0.9, gap: 800 }), 140);
    });
    socket.on('hs:whistle', () => play('hs.whistleEnd', { gap: 800 }));
    socket.on('hs:refused', () => play('g.err', { vol: 0.7 }));
    socket.on('hs:over', (m) => {
      const v = view();
      if (v.watch || !m) return;
      play(m.winnerId && m.winnerId === v.me ? 'g.win' : m.winnerId ? 'g.lose' : 'g.turn');
    });
  }

  /* The page's own predicted touch (kick or head) for your seat. */
  function local(name, side, x) { touch(name, side, x, true); }

  /* A power cutscene started (the page calls this once per cutscene, from whichever told it first). */
  function power() {
    if (now() - powerAt < 1200) return;
    powerAt = now();
    play('hs.zap');
  }

  /* The last five seconds of the clock, once a second, while it runs. */
  function clock(secLeft, running) {
    if (!running) { lastTick = -1; return; }
    if (secLeft >= 1 && secLeft <= 5 && secLeft !== lastTick) {
      lastTick = secLeft;
      play('g.tick', { vol: 0.55, rate: 0.9, gap: 300 });
    }
  }

  root.HeadSoccerSound = { attach, local, power, clock, setMuted: (v) => { muted = !!v; } };
})(window);
