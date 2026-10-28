/* ─── Crossy Road: the sound ──────────────────────────────────────────────────
   Our own sounds, synthesized by the house engine (dsSfx.js: a few lines of
   numbers each, no files), for the moments the reference has a sound for: the
   hop, a coin, a car's horn, the splash, the squash, the crossing bell and the
   train going by, the eagle. Match found, the countdown and the result use the
   house set every game shares (dsSfxGame.js).

   crossyMain.js calls CrossySound.play(name, opts). */
(function (root) {
  'use strict';
  const S = root.DSSfx;
  if (!S) { root.CrossySound = { play() {} }; return; }
  const { mf } = S;
  S.define({
    // Our cluck for every hop: a quick dropping square, a squeak on top, a breath of noise (crossyMain alternates rate).
    'cr.hop': [{ o: 'q', du: 0.25, f: [820, 560], d: 0.045, v: 0.045, a: 0.003, e: 0.02 },
               { o: 't', f: [1250, 700], at: 0.035, d: 0.05, v: 0.05, e: 0.03 },
               { o: 'n', d: 0.03, v: 0.025, bp: [[1800, 1200], 1.2], e: 0.02 }],
    'cr.coin': [{ o: 'q', du: 0.5, f: mf(93), d: 0.06, v: 0.05, e: 0.03 },
                { o: 'q', du: 0.5, f: mf(100), at: 0.06, d: 0.16, v: 0.05, e: 0.06 }],
    'cr.horn': [{ o: 'q', du: 0.45, f: 330, d: 0.22, v: 0.035, a: 0.01, e: 0.12 },
                { o: 'q', du: 0.45, f: 415, d: 0.22, v: 0.03, a: 0.01, e: 0.12 }],
    'cr.squash': [{ o: 'n', d: 0.18, v: 0.16, lp: [2600, 300], e: 0.06 }, { o: 's', f: [190, 60], d: 0.22, v: 0.2, e: 0.08 }],
    'cr.splash': [{ o: 'n', d: 0.5, v: 0.14, bp: [[2400, 500], 0.9], a: 0.01, e: 0.16 },
                  { o: 's', f: [520, 140], d: 0.3, v: 0.06, e: 0.1 }],
    'cr.bell': [{ o: 'fm', f: mf(88), m: 2.76, i: 1.4, d: 0.22, v: 0.05, e: 0.08 },
                { o: 'fm', f: mf(88), m: 2.76, i: 1.4, at: 0.25, d: 0.22, v: 0.05, e: 0.08 },
                { o: 'fm', f: mf(88), m: 2.76, i: 1.4, at: 0.5, d: 0.22, v: 0.05, e: 0.08 }],
    'cr.train': [{ o: 'n', d: 0.9, v: 0.13, lp: [400, 1800], a: 0.12, e: 0.4 }, { o: 't', f: [110, 82], d: 0.8, v: 0.06, e: 0.3 }],
    'cr.eagle': [{ o: 's', f: [mf(96), mf(84)], d: 0.5, v: 0.08, a: 0.03, e: 0.2, vib: [22, 0.03] },
                 { o: 'n', d: 0.4, v: 0.05, hp: 3000, e: 0.15 }],
  });
  root.CrossySound = { play(name, o) { try { S.play(name, o); } catch (_) {} } };
})(typeof window !== 'undefined' ? window : this);
