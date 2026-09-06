'use strict';
/* ─── OMG Shooter — the sound ─────────────────────────────────────────────────
   Every sound in this game is synthesised in the browser. There are no audio
   files, nothing is downloaded, and nothing was taken from anywhere.

   WHY SYNTHESIS AND NOT SAMPLES. Game sound effects are one of the few places
   where making the waveform beats finding a recording: a gunshot is a noise
   burst under a fast decay, an engine is a couple of detuned saws through a
   low-pass, a servo is a filtered triangle with a pitch ramp. All of that is a
   dozen lines each, weighs nothing, loads instantly, and can be varied per shot
   so a minigun does not machine-gun the identical click sixty times a second.

   TWO KINDS OF SOUND HERE. One-shots (a gun, a break, an explosion) are built,
   played and thrown away. Beds (the engine, the turret servo) are built once at
   start and left running for the life of the page with their gain ridden up and
   down, because starting and stopping an oscillator per frame is both expensive
   and audibly clicky.

   BROWSERS WILL NOT LET YOU MAKE NOISE until the user has interacted with the
   page. The context therefore starts suspended and is resumed on the first
   click or key, which in this game is the Play button. */

(function (root) {

  var ctx = null;
  var master = null;
  var beds = null;
  var muted = false;
  var ready = false;

  /* One shared noise buffer. Generating white noise is cheap but not free, and
     every gun in the game wants some, so it is made once and re-read. */
  var noiseBuf = null;

  function init() {
    if (ctx) return ctx;
    var AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();

    master = ctx.createGain();
    master.gain.value = 0.55;
    master.connect(ctx.destination);

    var n = ctx.sampleRate * 2;
    noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
    var d = noiseBuf.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;

    buildBeds();
    ready = true;
    return ctx;
  }

  /* Resumed on a real gesture. Called from the Play button and from the first
     key or click, because a context created before a gesture starts suspended
     and silently plays nothing. */
  function unlock() {
    if (!ctx) init();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  function now() { return ctx.currentTime; }

  function noise(dur, gain, filterType, freq, q) {
    var src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    var f = ctx.createBiquadFilter();
    f.type = filterType || 'lowpass';
    f.frequency.value = freq || 1200;
    if (q) f.Q.value = q;
    var g = ctx.createGain();
    g.gain.setValueAtTime(gain, now());
    g.gain.exponentialRampToValueAtTime(0.0001, now() + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start();
    src.stop(now() + dur + 0.02);
    return { filter: f, gain: g };
  }

  function tone(type, f0, f1, dur, gain, delay) {
    var t = now() + (delay || 0);
    var o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master);
    o.start(t);
    o.stop(t + dur + 0.02);
    return o;
  }

  /* ── the beds ───────────────────────────────────────────────────────────
     Two continuous voices that never stop, whose volume is ridden by the game.
     Owen asked for these to sit in the background, so they are quiet, and the
     engine is deliberately duller than the guns so it never competes with a
     shot for attention. */
  function buildBeds() {
    // Engine: two detuned saws through a low-pass, plus a little rumble.
    var engGain = ctx.createGain();
    engGain.gain.value = 0;
    var engFilter = ctx.createBiquadFilter();
    engFilter.type = 'lowpass';
    engFilter.frequency.value = 320;
    engFilter.Q.value = 3;
    engFilter.connect(engGain);
    engGain.connect(master);

    var a = ctx.createOscillator(); a.type = 'sawtooth'; a.frequency.value = 46;
    var b = ctx.createOscillator(); b.type = 'sawtooth'; b.frequency.value = 69;
    var rumble = ctx.createBufferSource();
    rumble.buffer = noiseBuf; rumble.loop = true;
    var rf = ctx.createBiquadFilter(); rf.type = 'lowpass'; rf.frequency.value = 140;
    var rg = ctx.createGain(); rg.gain.value = 0.5;
    rumble.connect(rf); rf.connect(rg); rg.connect(engFilter);
    a.connect(engFilter); b.connect(engFilter);
    a.start(); b.start(); rumble.start();

    // Turret servo: a filtered triangle that only exists while the gun turns.
    var srvGain = ctx.createGain();
    srvGain.gain.value = 0;
    var srvFilter = ctx.createBiquadFilter();
    srvFilter.type = 'bandpass';
    srvFilter.frequency.value = 900;
    srvFilter.Q.value = 6;
    srvFilter.connect(srvGain);
    srvGain.connect(master);
    var s = ctx.createOscillator(); s.type = 'triangle'; s.frequency.value = 320;
    s.connect(srvFilter); s.start();

    beds = { engGain: engGain, engA: a, engB: b, engFilter: engFilter,
             srvGain: srvGain, srvOsc: s };
  }

  /* Called every frame with how hard the tank is working. `drive` is 0..1 of
     top speed, `turn` is 0..1 of how fast the turret is swinging. Ramps rather
     than jumps, because a gain that steps produces a click. */
  function rig(drive, turn) {
    if (!ready || muted) return;
    var t = now();
    var d = Math.max(0, Math.min(1, drive || 0));
    var r = Math.max(0, Math.min(1, turn || 0));

    /* Quiet. This is a bed, not an instrument: you should notice it stop,
       not notice it playing. Roughly a third of where it started, and the
       filter stays low so it never gets bright enough to pull focus off a gun. */
    beds.engGain.gain.setTargetAtTime(0.009 + d * 0.030, t, 0.08);
    beds.engFilter.frequency.setTargetAtTime(190 + d * 240, t, 0.08);
    beds.engA.frequency.setTargetAtTime(44 + d * 26, t, 0.10);
    beds.engB.frequency.setTargetAtTime(66 + d * 40, t, 0.10);

    beds.srvGain.gain.setTargetAtTime(r * 0.013, t, 0.05);
    beds.srvOsc.frequency.setTargetAtTime(280 + r * 260, t, 0.05);
  }

  /* ── the guns ───────────────────────────────────────────────────────────
     Ten weapons, ten voices. The rule each one follows is that you should be
     able to name the gun with your eyes shut: the minigun is a dry tick, the
     cannon is a body blow, the railgun is a long charged crack, the
     flamethrower is breath rather than a bang. */
  var GUNS = {
    minigun: function () {
      noise(0.06, 0.16, 'highpass', 1400);
      tone('square', 220 + Math.random() * 60, 90, 0.05, 0.05);
    },
    shotgun: function () {
      noise(0.28, 0.42, 'lowpass', 2200);
      tone('sawtooth', 160, 45, 0.22, 0.16);
    },
    ricochet: function () {
      tone('square', 900, 300, 0.09, 0.10);
      noise(0.10, 0.14, 'bandpass', 2400, 4);
    },
    flamethrower: function () {
      noise(0.22, 0.10, 'bandpass', 900, 1.2);
    },
    cannon: function () {
      noise(0.34, 0.50, 'lowpass', 1400);
      tone('sine', 120, 38, 0.34, 0.34);
      tone('sawtooth', 240, 70, 0.16, 0.12);
    },
    shock: function () {
      for (var i = 0; i < 5; i++) {
        tone('square', 1800 + Math.random() * 2200, 600, 0.05, 0.05, i * 0.035);
      }
      noise(0.22, 0.10, 'highpass', 3000);
    },
    rockets: function () {
      noise(0.55, 0.26, 'lowpass', 1000);
      tone('sawtooth', 420, 120, 0.5, 0.10);
    },
    laser: function () {
      tone('sine', 1900, 420, 0.16, 0.16);
      tone('square', 950, 210, 0.12, 0.05);
    },
    railgun: function () {
      // A charge that rises, then the crack.
      tone('sine', 260, 1500, 0.20, 0.09);
      noise(0.40, 0.52, 'highpass', 700);
      tone('sawtooth', 90, 30, 0.42, 0.26, 0.16);
    },
    mines: function () {
      tone('square', 620, 620, 0.05, 0.07);
      tone('square', 880, 880, 0.05, 0.06, 0.07);
    },
  };

  function gun(key) {
    if (!ready || muted) return;
    (GUNS[key] || GUNS.cannon)();
  }

  /* ── everything else ────────────────────────────────────────────────────── */

  var FX = {
    // A shot landing on a wall that did not break.
    hit: function () {
      noise(0.07, 0.10, 'bandpass', 1800, 2);
    },
    // A crate, brick or wood panel coming apart.
    breakBlock: function () {
      noise(0.26, 0.30, 'lowpass', 1600);
      tone('square', 150, 60, 0.14, 0.07);
    },
    // A barrel, a rocket, a mine.
    boom: function () {
      noise(0.75, 0.60, 'lowpass', 800);
      tone('sine', 90, 28, 0.7, 0.36);
      tone('sawtooth', 180, 45, 0.3, 0.12);
    },
    coin: function () {
      tone('sine', 1050, 1050, 0.07, 0.13);
      tone('sine', 1560, 1560, 0.11, 0.11, 0.06);
    },
    medkit: function () {
      tone('sine', 620, 930, 0.16, 0.13);
    },
    // You took damage.
    hurt: function () {
      noise(0.14, 0.22, 'lowpass', 700);
      tone('sawtooth', 190, 70, 0.16, 0.10);
    },
    death: function () {
      noise(0.9, 0.45, 'lowpass', 600);
      tone('sawtooth', 220, 34, 0.85, 0.22);
    },
    // The five seconds in the middle paying off.
    banked: function () {
      [660, 880, 1320].forEach(function (f, i) {
        tone('sine', f, f, 0.22, 0.15, i * 0.09);
      });
    },
    // Ticking up while you stand in the square.
    bankTick: function () {
      tone('sine', 880, 880, 0.05, 0.05);
    },
  };

  function fx(name) {
    if (!ready || muted) return;
    if (FX[name]) FX[name]();
  }

  function setMuted(v) {
    muted = !!v;
    if (master) master.gain.setTargetAtTime(muted ? 0 : 0.55, now(), 0.05);
    return muted;
  }

  root.ShooterSound = {
    init: init, unlock: unlock, gun: gun, fx: fx, rig: rig,
    setMuted: setMuted,
    get muted() { return muted; },
    get ready() { return ready; },
  };

})(typeof window !== 'undefined' ? window : globalThis);
