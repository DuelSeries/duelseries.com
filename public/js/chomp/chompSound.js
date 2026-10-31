// Chomp's sounds: our own, synthesized by the shared engine (DSSfx, /js/dsSfx.js) in the spirit of an early arcade
// sound chip: square and triangle tones, quick glides. No recordings and no melodies from any other game.
//   ch.waka1 / ch.waka2  a dot, alternating down and up glides, so a run of dots makes the chewing sound
//   ch.power   an energizer          ch.scared  the short warble repeated while you are powered
//   ch.ghost   a ghost eaten         ch.player  a player eaten       ch.fruit   fruit
//   ch.death   your chomper caught   ch.life    a bonus life        ch.ready   coming in / back
//   ch.whoosh  a cherry's speed boost (Owen 2026-10-30): a rising band of noise with a quick square glide on top
(function (root) {
  'use strict';
  var S = root.DSSfx;
  if (!S) { root.ChompSound = { play: function () {}, eat: function () {} }; return; }
  var mf = S.mf, arp = S.arp;
  var sq = function (f, d, v, x) { var o = { o: 'q', du: 0.5, f: f, d: d, v: v, e: d * 0.9 }; for (var k in x) o[k] = x[k]; return o; };
  S.define({
    'ch.waka1': [sq([560, 260], 0.075, 0.07, { g: 0.07 })],
    'ch.waka2': [sq([260, 560], 0.075, 0.07, { g: 0.07 })],
    'ch.power': [sq([180, 720], 0.18, 0.08, { g: 0.18, du: 0.25 }), sq([360, 1440], 0.18, 0.03, { g: 0.18, at: 0.02 })],
    'ch.scared': [{ o: 't', f: [300, 520], g: 0.12, d: 0.24, v: 0.06, e: 0.2, vib: [14, 0.08] }],
    'ch.ghost': [sq([220, 1700], 0.3, 0.07, { g: 0.3, du: 0.3 }), { o: 't', f: [440, 2200], g: 0.3, d: 0.32, v: 0.05, e: 0.3 }],
    'ch.player': [sq([160, 1100], 0.32, 0.08, { g: 0.3, du: 0.3 })].concat(arp([84, 91], 0.08, { o: 't', at: 0.28, d: 0.2, v: 0.08, e: 0.1 })),
    'ch.fruit': arp([79, 86, 91], 0.05, { o: 'q', du: 0.25, d: 0.12, v: 0.06, e: 0.08 }),
    'ch.death': [sq([780, 120], 1.1, 0.08, { g: 1.0, vib: [11, 0.12], du: 0.4 }), sq([90, 60], 0.18, 0.07, { at: 1.1 }), sq([90, 60], 0.18, 0.07, { at: 1.3 })],
    'ch.life': arp([84, 88, 91, 96, 91, 96], 0.07, { o: 'q', du: 0.25, d: 0.1, v: 0.06, e: 0.06 }),
    'ch.ready': arp([72, 79, 76, 84, 79, 88], 0.09, { o: 'q', du: 0.25, d: 0.14, v: 0.06, e: 0.1 }),
    'ch.whoosh': [{ o: 'n', bp: [[500, 3200], 1.4], g: 0.32, d: 0.4, v: 0.16, a: 0.03, e: 0.2 },
      sq([260, 1040], 0.22, 0.035, { g: 0.22, du: 0.25 })]
  });
  var flip = false;
  root.ChompSound = {
    play: function (name, o) { try { S.play(name, o); } catch (e) { /* sound never breaks the game */ } },
    eat: function () { flip = !flip; this.play(flip ? 'ch.waka1' : 'ch.waka2', { max: 2 }); }
  };
})(typeof self !== 'undefined' ? self : this);
