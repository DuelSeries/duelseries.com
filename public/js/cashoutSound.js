'use strict';
/* ─── The cash-out fanfare ────────────────────────────────────────────────────
   Getting paid should sound the same everywhere. The snake game, the agar.io
   game and the tank arena are three different renderers with three different
   audio graphs, and the only way three copies of a sound stay identical is for
   there to be one copy. So this is it: the snake game's cash-out flourish,
   lifted out whole, taking the caller's context and output node so each game
   can still route it through its own mixer and its own mute.

   Three parts, in order:
     1. a quick rising flourish, G4-C5-E5, that says something is coming
     2. a held C major chord across two octaves, which is the payoff itself
     3. a sparkle gliding up over the top of the chord

   The numbers are the snake game's numbers. Do not "improve" them in one game;
   change them here and all three move together, which is the whole point. */

(function (root) {

  function play(ctx, dest, vol) {
    if (!ctx || !dest) return false;
    var v = vol === undefined ? 1 : vol;
    try {
      var t0 = ctx.currentTime;

      // 1) the rising flourish
      [[392, 0], [523, 0.07], [659, 0.14]].forEach(function (p) {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'triangle'; o.frequency.value = p[0];
        o.connect(g); g.connect(dest);
        var t = t0 + p[1];
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.2 * v, t + 0.015);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
        o.start(t); o.stop(t + 0.2);
      });

      // 2) the held chord: C5 E5 G5 C6, the top one a triangle so it carries
      var ct = t0 + 0.22;
      [523.25, 659.25, 783.99, 1046.5].forEach(function (f, i) {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.type = (i === 3) ? 'triangle' : 'sine'; o.frequency.value = f;
        o.connect(g); g.connect(dest);
        g.gain.setValueAtTime(0, ct);
        g.gain.linearRampToValueAtTime(0.16 * v, ct + 0.03);
        g.gain.setValueAtTime(0.16 * v, ct + 0.35);
        g.gain.exponentialRampToValueAtTime(0.001, ct + 0.85);
        o.start(ct); o.stop(ct + 0.88);
      });

      // 3) the sparkle
      var s = ctx.createOscillator(), sg = ctx.createGain();
      s.type = 'sine';
      s.frequency.setValueAtTime(1568, ct + 0.05);
      s.frequency.exponentialRampToValueAtTime(2093, ct + 0.3);
      s.connect(sg); sg.connect(dest);
      sg.gain.setValueAtTime(0.0001, ct);
      sg.gain.linearRampToValueAtTime(0.1 * v, ct + 0.09);
      sg.gain.exponentialRampToValueAtTime(0.0001, ct + 0.5);
      s.start(ct); s.stop(ct + 0.52);

      return true;
    } catch (e) { return false; }
  }

  /* How long the whole thing runs, in seconds. Useful if a caller wants to
     hold a screen open until the sound has finished. */
  play.DURATION = 1.1;

  root.CashoutSound = { play: play };

})(typeof window !== 'undefined' ? window : globalThis);
