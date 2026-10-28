'use strict';
/* ─── Air Hockey: the sound ──────────────────────────────────────────────────
   The house engine (dsSfx.js) and its Glass game pack (dsSfxGame.js), plus the
   sounds only an air hockey table makes, defined the same way: a few lines of
   numbers, synthesised once at load, no files.
     a mallet on the puck  ah.hit     a hard plastic clack, deeper and louder the harder the hit
     the rail              ah.rail    a short knock
     a post                ah.post    a ring off the metal edge of the mouth
     a goal                ah.goal    the puck dropping into the slot, then the buzzer
     the serve             ah.serve   a soft puff of air under the puck
     the end               ah.end     the long buzzer
     3, 2, 1 and go        g.tick / g.go
     match found / won / lost / refused   g.join, g.win, g.lose, g.err

   airhockey.js feeds it: attach() once with the socket, local() for every
   hit, rail and post the moment the screen predicts it (so a hit is heard on
   the frame it is seen). The server's copies of those are skipped for a
   player, except the other player's hits, which this screen can only guess.
   Watching a match: every sound comes from the server, and no win or loss. */

(function (root) {
  const S = root.DSSfx;
  if (!S) return;
  const mf = S.mf;
  let muted = false;
  S.setLevel(function () { return muted ? 0 : 1; });

  const thump = (f0, f1, d, v, at) => ({ o: 's', f: [f0, f1], d: d, v: v, e: d / 3.5, at: at || 0 });
  S.define({
    'ah.hit':   [{ o: 'n', d: 0.035, v: 0.3, bp: [3200, 1.4], e: 0.008 }, thump(520, 190, 0.07, 0.3),
                 { o: 't', f: [900, 420], d: 0.04, v: 0.08, e: 0.012 }],
    'ah.rail':  [{ o: 'n', d: 0.03, v: 0.16, bp: [1800, 1.1], e: 0.008 }, thump(300, 150, 0.06, 0.2)],
    'ah.post':  [{ o: 'fm', f: 1480, m: 1.41, i: 2.2, d: 0.4, v: 0.08, e: 0.12, ie: 0.05 }, thump(340, 180, 0.05, 0.14)],
    'ah.goal':  [thump(160, 60, 0.18, 0.4), { o: 'n', d: 0.22, v: 0.12, lp: [2400, 300], e: 0.07 },
                 { o: 'q', f: mf(57), du: 0.35, d: 0.62, v: 0.06, a: 0.01, e: 0.5, at: 0.12 },
                 { o: 'q', f: mf(64), du: 0.35, d: 0.62, v: 0.045, a: 0.01, e: 0.5, at: 0.12 }],
    'ah.serve': [{ o: 'n', d: 0.25, v: 0.07, a: 0.04, e: 0.1, bp: [[600, 2400], 0.7] }, thump(240, 160, 0.05, 0.08)],
    'ah.end':   [{ o: 'q', f: mf(52), du: 0.4, d: 1.1, v: 0.08, a: 0.01, e: 0.9 },
                 { o: 'q', f: mf(59), du: 0.4, d: 1.1, v: 0.06, a: 0.01, e: 0.9 }],
  });

  const now = () => (root.performance ? root.performance.now() : Date.now());
  const play = (name, opt) => S.play(name, opt);
  let get = () => ({});
  const view = () => { try { return get() || {}; } catch (_) { return {}; } };
  const W = (root.AHSim && root.AHSim.AH.W) || 600;
  const panAt = (x) => (typeof x === 'number' ? Math.max(-1, Math.min(1, x / W * 2 - 1)) * 0.4 : 0);
  let theirHitAt = -1e9;

  /* kind 'hit' | 'rail' | 'post'; v the strength (the impulse the sim reports); x for the pan (screen side). */
  function sound(kind, v, x) {
    const s = Math.max(0, Math.min(1, (v | 0) / 3000));
    if (kind === 'hit') play('ah.hit', { vol: 0.35 + 0.65 * s, rate: 1.15 - 0.3 * s, pan: panAt(x), gap: 40 });
    else if (kind === 'rail') { if (v > 80) play('ah.rail', { vol: 0.25 + 0.6 * s, rate: 0.95 + Math.random() * 0.1, pan: panAt(x), gap: 45 }); }
    else if (kind === 'post') play('ah.post', { vol: 0.5 + 0.5 * s, pan: panAt(x), gap: 90 });
  }

  function attach(socket, getter) {
    if (typeof getter === 'function') get = getter;
    socket.on('ah:start', () => { if (!view().watch) play('g.join'); });
    socket.on('ah:play', () => play('g.go', { vol: 0.8, gap: 400 }));
    socket.on('ah:serve', () => play('ah.serve', { gap: 300 }));
    socket.on('ah:ev', (list) => {
      if (!Array.isArray(list)) return;
      const v = view();
      for (let i = 0; i < list.length && i < 6; i++) {
        const e = list[i];
        if (!Array.isArray(e) || typeof e[0] !== 'string') continue;
        const kind = e[0] === 'h' ? 'hit' : e[0] === 'p' ? 'post' : 'rail';
        if (!v.watch) {
          // A player already heard everything the screen predicted: only the other player's hits come from here,
          // and only when the screen did not already guess that one.
          if (kind !== 'hit' || e[1] === v.mySide || now() - theirHitAt < 160) continue;
        }
        sound(kind, e[2], v.puckX);
      }
    });
    socket.on('ah:goal', () => play('ah.goal', { gap: 600 }));
    socket.on('ah:whistle', () => play('ah.end', { gap: 800 }));
    socket.on('ah:sudden', () => play('ah.end', { vol: 0.7, gap: 800 }));
    socket.on('ah:refused', () => play('g.err', { vol: 0.7 }));
    socket.on('ah:over', (m) => {
      const v = view();
      if (v.watch || !m) return;
      play(m.winnerId && m.winnerId === v.me ? 'g.win' : m.winnerId ? 'g.lose' : 'g.turn');
    });
  }

  /* The page's own predicted event. */
  function local(kind, side, v, x) {
    if (kind === 'hit' && side !== view().mySide) theirHitAt = now();
    sound(kind, v, x);
  }
  function count() { play('g.tick', { vol: 0.6, rate: 1.1, gap: 300 }); }

  root.AirHockeySound = { attach, local, count, setMuted: (v) => { muted = !!v; } };
})(window);
