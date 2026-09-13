'use strict';
/* ─── Battleship — the sound ──────────────────────────────────────────────────
   Synthesised in the browser, like the shooter's. No files, nothing downloaded,
   nothing taken from anywhere — see shooterSound.js for the reasoning, which is
   the same here and matters more: this game has exactly four noises and every
   one of them is a shape a few oscillators make better than a recording would.

   FOUR SOUNDS, AND THEY HAVE TO BE TOLD APART WITH YOUR EYES ELSEWHERE.

     miss    a shell into water: noise through a falling filter, a hollow plop.
             The SAME sound whoever fired it, because a miss is a miss and
             giving the two sides different splashes would only be noise.
     hit     yours landing: a hard metallic crack with a bright confirm over it,
             rising. The only sound on this screen that goes UP.
     taken   theirs landing on you: the same crack, but low, detuned and
             falling. Deliberately the inverse of the good one, so the two are
             distinguishable in a fraction of a second and without looking.
     sunk    a whole ship gone: a long groan under a low boom, which is the one
             event in a match worth stopping for.

   Direction carries the meaning: up is good, down is bad, flat is nothing. That
   holds with the sound turned down low, through a phone speaker, and for
   somebody who cannot hear the difference between two timbres. */

(function (root) {

  var ctx = null, master = null, ready = false, muted = false;

  function boot() {
    if (ctx) return ctx;
    var AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch (_) { return null; }
    master = ctx.createGain();
    master.gain.value = 0.55;
    master.connect(ctx.destination);
    ready = true;
    return ctx;
  }

  /* Browsers will not make a sound until the page has been interacted with, so
     the context is created suspended and woken on the first input. */
  function wake() {
    if (!boot()) return;
    if (ctx.state === 'suspended') ctx.resume().catch(function () {});
  }
  ['pointerdown', 'keydown'].forEach(function (e) {
    root.addEventListener(e, wake, { passive: true });
  });

  /* A burst of noise, which is the basis of every impact and every splash. */
  function noise(dur) {
    var n = Math.max(1, Math.floor(ctx.sampleRate * dur));
    var buf = ctx.createBuffer(1, n, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    var src = ctx.createBufferSource();
    src.buffer = buf;
    return src;
  }

  function env(node, at, peak, attack, decay) {
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    node.connect(g);
    return g;
  }

  function tone(type, f0, f1, at, dur, peak) {
    var o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, at);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), at + dur);
    var g = env(o, at, peak, 0.006, dur);
    g.connect(master);
    o.start(at); o.stop(at + dur + 0.05);
  }

  /* ── the four ───────────────────────────────────────────────────────────── */

  /* Into the water. Noise pushed through a low-pass that closes as it falls,
     which is what makes it read as a plop rather than a hiss. */
  function miss() {
    if (!ready || muted || !ctx) return;
    var t = ctx.currentTime;
    var src = noise(0.30);
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1600, t);
    lp.frequency.exponentialRampToValueAtTime(180, t + 0.28);
    src.connect(lp);
    var g = env(lp, t, 0.34, 0.004, 0.28);
    g.connect(master);
    src.start(t); src.stop(t + 0.32);
    /* The hollow note underneath: what makes it water and not gravel. */
    tone('sine', 420, 120, t + 0.01, 0.22, 0.16);
  }

  /* Steel. Short, hard, and the only thing here that rises. */
  function hit() {
    if (!ready || muted || !ctx) return;
    var t = ctx.currentTime;
    var src = noise(0.16);
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(2400, t);
    bp.Q.value = 1.1;
    src.connect(bp);
    var g = env(bp, t, 0.42, 0.003, 0.14);
    g.connect(master);
    src.start(t); src.stop(t + 0.18);
    /* The confirm over the top, going UP: the whole point of this sound. */
    tone('square', 560, 980, t + 0.02, 0.13, 0.12);
    tone('sine', 880, 1320, t + 0.05, 0.16, 0.10);
  }

  /* Theirs, on you. The same crack pitched down and falling — the inverse of
     the good one, so the two never need a second's thought to tell apart. */
  function taken() {
    if (!ready || muted || !ctx) return;
    var t = ctx.currentTime;
    var src = noise(0.26);
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(140, t + 0.24);
    src.connect(lp);
    var g = env(lp, t, 0.40, 0.003, 0.24);
    g.connect(master);
    src.start(t); src.stop(t + 0.28);
    tone('sawtooth', 240, 90, t + 0.01, 0.26, 0.16);
  }

  /* A ship gone. Longer, lower, and the one thing in a match worth a pause. */
  function sunk() {
    if (!ready || muted || !ctx) return;
    var t = ctx.currentTime;
    var src = noise(0.9);
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(600, t);
    lp.frequency.exponentialRampToValueAtTime(90, t + 0.85);
    src.connect(lp);
    var g = env(lp, t, 0.34, 0.02, 0.85);
    g.connect(master);
    src.start(t); src.stop(t + 0.95);
    /* The groan: two detuned saws a long way down, which is metal giving way. */
    tone('sawtooth', 150, 46, t, 0.85, 0.18);
    tone('sawtooth', 146, 44, t + 0.02, 0.85, 0.14);
    tone('sine', 80, 38, t, 0.7, 0.20);
  }

  function setMuted(v) { muted = !!v; }

  root.BattleshipSound = { miss: miss, hit: hit, taken: taken, sunk: sunk, setMuted: setMuted, wake: wake };
})(window);
