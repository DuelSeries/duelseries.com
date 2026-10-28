'use strict';
/* ─── 8 Ball Pool: the sound ─────────────────────────────────────────────────
   The house engine (dsSfx.js) with a few sounds only a pool table has, defined
   the same way: a few lines of numbers, synthesised once at load, no files.
     the cue on the cue ball   p8.cue      a short wooden tock, louder with power
     ball on ball              p8.ball     a hard high click, its volume the speed of the hit
     a cushion                 p8.rail     a soft low thump
     a pocket                  p8.pocket   a dull drop and a short roll in the return rail
     your turn / a foul        g.join, g.err (the Glass game pack)
   pool8.js calls play(kind, strength 0..1) as the server's tape reaches each moment. */

(function (root) {
  const S = root.DSSfx;
  if (!S) return;
  S.define({
    'p8.cue':    [{ o: 's', f: [900, 520], d: 0.05, v: 0.22, e: 0.014 }, { o: 'n', d: 0.03, v: 0.1, bp: [2400, 1.4], e: 0.008 }],
    'p8.ball':   [{ o: 's', f: [2600, 2100], d: 0.035, v: 0.24, e: 0.008 }, { o: 't', f: 3900, d: 0.02, v: 0.08, e: 0.005 },
                  { o: 'n', d: 0.018, v: 0.12, hp: 2500, e: 0.004 }],
    'p8.rail':   [{ o: 's', f: [190, 120], d: 0.09, v: 0.2, e: 0.03 }, { o: 'n', d: 0.04, v: 0.05, lp: 800, e: 0.012 }],
    'p8.pocket': [{ o: 's', f: [240, 90], d: 0.16, v: 0.24, e: 0.05 }, { o: 'n', d: 0.12, v: 0.06, lp: [1200, 300], e: 0.04 },
                  { o: 's', f: [420, 380], at: 0.16, d: 0.35, v: 0.05, e: 0.15, vib: [22, 0.05] }],
  });
  const map = { cue: 'p8.cue', ball: 'p8.ball', rail: 'p8.rail', pocket: 'p8.pocket', turn: 'g.join', foul: 'g.err', tick: 'g.tick' };
  function play(kind, strength) {
    const name = map[kind];
    if (!name) return;
    const v = Math.max(0.08, Math.min(1, Number(strength) || 0));
    S.play(name, { vol: kind === 'ball' || kind === 'rail' ? v : Math.max(0.5, v), rate: 0.96 + Math.random() * 0.08, gap: kind === 'ball' ? 25 : 40 });
  }
  function unlock() { try { if (S.wake) S.wake(); } catch (_) {} }
  root.Pool8Sound = { play, unlock };
})(typeof window !== 'undefined' ? window : globalThis);
