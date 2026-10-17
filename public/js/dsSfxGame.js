/* ─── Game sounds, Glass pack ─────────────────────────────────────────────────
   Every in-game sound, in the house style Owen picked for the lobby (Glass,
   2026-10-16): sines, triangles, soft bells, filtered noise. Load after
   /js/dsSfx.js; each game's sound module plays these by name with DSSfx.play.

   Each sound keeps its job readable with your eyes elsewhere: good news rises
   and rings (bells, major), bad news falls (triangles, minor), danger beats
   against itself (two notes a semitone apart), impacts are a low sine thump
   plus a puff of noise. Pass {rate} to vary a sound that repeats (an eat, a
   shot) so the hundredth one is not the same click.

   Names (g. = game):
     moments  g.join g.go g.tick g.win g.lose g.death g.kill g.cashout g.money
     money    g.pickup (gold eaten) g.ringStart g.ringTick g.ringCancel
     moving   g.eat g.boostOn g.boostOff g.split g.eject g.merge g.capture g.bounce g.fall
     combat   g.shoot g.shootHeavy g.hit g.hurt g.explode g.splash g.sunk g.heal g.empty g.reload
     alerts   g.warn g.danger g.turn g.chat g.err g.click */
(function (root) {
  'use strict';
  const S = root.DSSfx;
  if (!S) return;
  const { mf, arp } = S;
  const thump = (f0, f1, d, v, at) => ({ o: 's', f: [f0, f1], d: d, v: v, e: d / 3.5, at: at || 0 });
  const bell = (n, at, d, v, x) => Object.assign({ o: 'fm', f: mf(n), m: 3.5, i: 1.3, at: at, d: d, v: v, e: d / 3 }, x);
  const r = S.rng(31);
  const sparkle = Array.from({ length: 9 }, (_, k) => bell(96 + [0, 4, 7, 12, 16, 19][Math.floor(r() * 6)], 0.32 + k * 0.06 + r() * 0.03, 0.35, 0.03 + r() * 0.015, { i: 1.6 }));

  S.define({
    /* moments */
    'g.join':     arp([79, 86], 0.07, { o: 's', d: 0.26, v: 0.14, e: 0.09 }).concat([bell(98, 0.12, 0.4, 0.04, { i: 1 })]),
    'g.tick':     [{ o: 's', f: mf(84), d: 0.09, v: 0.15, e: 0.03 }, { o: 'n', d: 0.01, v: 0.03, hp: 4000, e: 0.003 }],
    'g.go':       [{ o: 's', f: mf(91), d: 0.4, v: 0.16, e: 0.13 }, { o: 's', f: mf(96), d: 0.4, v: 0.08, e: 0.13 }, thump(190, 85, 0.14, 0.24)],
    'g.kill':     [thump(190, 90, 0.12, 0.24)].concat(arp([84, 91, 96], 0.05, { o: 't', d: 0.24, v: 0.13, e: 0.08 }), [bell(103, 0.1, 0.42, 0.05, { i: 1.5 })]),
    /* A signature: a breath drawn in, a low boom, then falling minor bells. */
    'g.death':    [{ o: 'n', d: 0.3, v: 0.07, a: 0.27, e: 0.05, bp: [[700, 3500], 1] }, thump(130, 32, 0.75, 0.38, 0.28),
                   { o: 'n', at: 0.28, d: 0.5, v: 0.12, a: 0.003, e: 0.12, lp: [1800, 120] }]
                    .concat([88, 84, 81, 76].map((n, k) => bell(n, 0.32 + k * 0.11, 0.7, 0.06, { m: 2, i: 1 }))),
    'g.win':      arp([72, 76, 79, 84, 88, 91], 0.06, { o: 't', d: 0.45, v: 0.12, e: 0.15 })
                    .concat([84, 88, 91, 96].map((n, k) => bell(n, 0.38 + k * 0.012, 1.1, 0.065, { i: 1.2 })), [thump(170, 70, 0.3, 0.3, 0.36)], sparkle),
    'g.lose':     arp([72, 67, 63], 0.13, { o: 't', d: 0.42, v: 0.12, e: 0.15 }).concat([{ o: 's', f: [150, 70], d: 0.5, v: 0.16, e: 0.18, at: 0.26 }]),
    /* money */
    'g.cashout':  arp([67, 72, 76, 79, 84], 0.055, { o: 't', d: 0.5, v: 0.12, e: 0.15 })
                    .concat([84, 88, 91, 96].map((n, k) => bell(n, 0.3 + k * 0.015, 1.15, 0.07, { i: 1.5 })),
                            [thump(180, 75, 0.3, 0.3, 0.29), { o: 'n', at: 0.3, d: 0.6, v: 0.025, hp: 6000, a: 0.05, e: 0.18 }], sparkle),
    'g.money':    arp([84, 88, 91, 96, 100], 0.05, { o: 'fm', m: 3.5, i: 1.6, d: 0.55, v: 0.1, e: 0.16 })
                    .concat([{ o: 's', f: mf(60), d: 0.3, v: 0.12, e: 0.1 }]),
    'g.pickup':   [bell(100, 0, 0.24, 0.07, { i: 1.4 }), { o: 's', f: mf(88), d: 0.08, v: 0.05, e: 0.03 }],
    'g.ringStart': [{ o: 's', f: [mf(72), mf(84)], d: 0.5, v: 0.1, a: 0.02, e: 0.3, g: 0.5 }, bell(91, 0, 0.3, 0.04, { i: 0.8 })],
    'g.ringTick': [bell(96, 0, 0.12, 0.05, { i: 1 })],
    'g.ringCancel': [{ o: 's', f: [mf(79), mf(67)], d: 0.2, v: 0.11, e: 0.07 }],
    /* moving */
    'g.eat':      [{ o: 's', f: [700, 1300], d: 0.05, v: 0.09, e: 0.015, g: 0.03 }],
    'g.boostOn':  [{ o: 'n', d: 0.22, v: 0.12, a: 0.03, e: 0.08, bp: [[500, 2200], 1.1] }, { o: 's', f: [220, 330], d: 0.18, v: 0.06, a: 0.02, e: 0.07 }],
    'g.boostOff': [{ o: 'n', d: 0.14, v: 0.07, a: 0.01, e: 0.05, bp: [[1600, 500], 1.1] }],
    'g.split':    [{ o: 's', f: [400, 900], d: 0.1, v: 0.14, e: 0.035, g: 0.06 }, { o: 'n', d: 0.08, v: 0.06, bp: [[1500, 4000], 1], e: 0.025 }],
    'g.eject':    [{ o: 'n', d: 0.05, v: 0.08, bp: [2500, 1.2], e: 0.015 }, { o: 's', f: [900, 600], d: 0.04, v: 0.06, e: 0.012 }],
    'g.merge':    [{ o: 's', f: [500, 350], d: 0.16, v: 0.12, e: 0.05 }, { o: 's', f: [750, 525], d: 0.16, v: 0.06, e: 0.05 }],
    'g.capture':  [{ o: 's', f: [400, 800], d: 0.22, v: 0.12, e: 0.08, g: 0.15 }].concat(arp([79, 84, 88], 0.04, { o: 's', at: 0.08, d: 0.26, v: 0.08, e: 0.09 })),
    'g.bounce':   [thump(260, 170, 0.08, 0.24), { o: 'n', d: 0.03, v: 0.06, lp: 1500, e: 0.008 }],
    'g.fall':     [{ o: 's', f: [700, 110], d: 0.65, v: 0.13, e: 0.28, g: 0.65 }, { o: 'n', at: 0.5, d: 0.3, v: 0.08, lp: [900, 120], e: 0.08 }],
    /* combat */
    'g.shoot':    [{ o: 'n', d: 0.08, v: 0.18, e: 0.018, bp: [[2400, 700], 0.8] }, thump(230, 90, 0.07, 0.2)],
    'g.shootHeavy': [{ o: 'n', d: 0.2, v: 0.22, e: 0.045, lp: [3000, 400] }, thump(140, 50, 0.22, 0.32)],
    'g.hit':      [thump(300, 120, 0.09, 0.28), { o: 'n', d: 0.04, v: 0.09, lp: 2500, e: 0.01 }],
    'g.hurt':     [thump(160, 80, 0.16, 0.3), { o: 't', f: mf(57), d: 0.2, v: 0.08, e: 0.07 }, { o: 't', f: mf(58), d: 0.2, v: 0.08, e: 0.07 }],
    'g.explode':  [{ o: 'n', d: 0.6, v: 0.3, a: 0.003, e: 0.15, lp: [2500, 150] }, thump(110, 35, 0.5, 0.35)],
    'g.splash':   [{ o: 'n', d: 0.36, v: 0.22, a: 0.005, e: 0.09, bp: [[1800, 300], 1] }, { o: 's', f: [500, 180], d: 0.12, v: 0.1, e: 0.04 }],
    'g.sunk':     [{ o: 'n', d: 0.8, v: 0.3, a: 0.003, e: 0.2, lp: [2200, 120] }, thump(100, 32, 0.7, 0.36)]
                    .concat(arp([67, 62, 55], 0.13, { o: 't', at: 0.15, d: 0.45, v: 0.12, e: 0.15 })),
    'g.heal':     arp([84, 88, 91], 0.05, { o: 's', d: 0.22, v: 0.1, e: 0.07 }).concat([{ o: 'n', at: 0.05, d: 0.3, v: 0.02, hp: 6000, a: 0.04, e: 0.1 }]),
    'g.empty':    [{ o: 's', f: 1200, d: 0.025, v: 0.07, e: 0.006 }, { o: 's', f: 900, at: 0.05, d: 0.025, v: 0.05, e: 0.006 }],
    'g.reload':   [{ o: 'n', d: 0.02, v: 0.1, bp: [3500, 2], e: 0.005 }, { o: 's', f: [600, 900], at: 0.07, d: 0.06, v: 0.08, e: 0.02 }],
    /* alerts */
    'g.warn':     arp([81, 76, 81, 76], 0.14, { o: 't', d: 0.13, v: 0.14, e: 0.06 }),
    'g.danger':   [{ o: 't', f: mf(64), d: 0.26, v: 0.15, e: 0.09 }, { o: 't', f: mf(65), d: 0.26, v: 0.12, e: 0.09 }, thump(110, 90, 0.26, 0.2)],
    'g.turn':     [bell(84, 0, 0.4, 0.1, { m: 2, i: 0.8 }), bell(91, 0.1, 0.45, 0.08, { m: 2, i: 0.8 })],
    'g.chat':     [{ o: 's', f: mf(88), d: 0.07, v: 0.08, e: 0.025 }, { o: 's', f: mf(93), at: 0.06, d: 0.13, v: 0.08, e: 0.04 }],
    'g.err':      [{ o: 't', f: mf(69), d: 0.14, v: 0.16, e: 0.05 }, { o: 't', f: mf(65), at: 0.12, d: 0.26, v: 0.16, e: 0.09 }],
    'g.click':    [{ o: 's', f: [2100, 1700], d: 0.03, v: 0.16, e: 0.008 }, { o: 'n', d: 0.012, v: 0.04, bp: [4200, 1.2], e: 0.003 }],
  });
})(typeof window !== 'undefined' ? window : globalThis);
