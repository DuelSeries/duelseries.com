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

  /* `existing` lets a caller hand in its own context. The game never does,
     but it means the whole graph can be rendered into an OfflineAudioContext
     and measured, which is the only way to check a mix without ears. */
  function init(existing) {
    if (ctx) return ctx;
    if (existing) { ctx = existing; }
    else {
      var AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }

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
     Continuous voices that never stop, whose levels are ridden by the game.
     Owen asked for these to sit behind everything, so they are tiny. */
  function buildBeds() {
    /* THE ENGINE. A tank does not drone, it chugs. The first version was two
       detuned sawtooths through a resonant low-pass, which is a generator, or
       a fridge, and Owen was right that it did not sound like a tank at all.

       What makes a diesel read as a diesel is that you can hear the separate
       cylinders firing, so this is built as a pulse train. An inverted
       sawtooth LFO gates a band of low noise and a low saw; inverted, because
       a rising ramp is a wobble and a falling one is a bang, and a combustion
       stroke is a bang. The rate of that LFO IS the engine speed, so driving
       revs the engine rather than merely turning it up. Under it sits a
       steady sub and some rumble, which is the mass of the thing.

       Then the tracks, on their own faster pulse train of bright filtered
       noise: link plates slapping the road wheels. They only exist while the
       tank is actually rolling, which is the other half of why the old bed
       read as a machine sitting still. */
    var engGain = ctx.createGain();
    engGain.gain.value = 0;
    engGain.connect(master);

    // the mass: always there while the engine is running
    var body = ctx.createGain(); body.gain.value = 0.30;
    body.connect(engGain);
    var sub = ctx.createOscillator(); sub.type = 'sine'; sub.frequency.value = 33;
    sub.connect(body);
    var rum = ctx.createBufferSource(); rum.buffer = noiseBuf; rum.loop = true;
    var rumF = ctx.createBiquadFilter(); rumF.type = 'lowpass'; rumF.frequency.value = 110;
    var rumG = ctx.createGain(); rumG.gain.value = 0.45;
    rum.connect(rumF); rumF.connect(rumG); rumG.connect(body);

    // the chug: one pulse per firing stroke
    var chug = ctx.createGain(); chug.gain.value = 0.5;  // offset; the LFO swings it 0..1
    chug.connect(engGain);
    var chugN = ctx.createBufferSource(); chugN.buffer = noiseBuf; chugN.loop = true;
    var chugF = ctx.createBiquadFilter();
    chugF.type = 'lowpass'; chugF.frequency.value = 250; chugF.Q.value = 1.1;
    chugN.connect(chugF); chugF.connect(chug);
    /* Exactly TWO octaves-worth of the sub, not a free-running pitch. Two low
       oscillators at an unrelated interval beat at their difference, and that
       slow throb is what made the first bed sound like a generator: its 46Hz
       and 69Hz saws beat at 23Hz, which measured as a stronger rhythm than
       anything intentional in it. Locked to a harmonic, the two reinforce
       into one tone and the only rhythm left is the chug. */
    var chugT = ctx.createOscillator(); chugT.type = 'sawtooth'; chugT.frequency.value = 66;
    var chugTG = ctx.createGain(); chugTG.gain.value = 0.22;
    chugT.connect(chugTG); chugTG.connect(chug);

    var lfo = ctx.createOscillator(); lfo.type = 'sawtooth'; lfo.frequency.value = 7;
    var lfoD = ctx.createGain(); lfoD.gain.value = -0.5;   // negative depth = inverted saw
    lfo.connect(lfoD); lfoD.connect(chug.gain);

    // the tracks
    var clat = ctx.createGain(); clat.gain.value = 0;
    clat.connect(master);
    var clatN = ctx.createBufferSource(); clatN.buffer = noiseBuf; clatN.loop = true;
    var clatF = ctx.createBiquadFilter();
    clatF.type = 'bandpass'; clatF.frequency.value = 2400; clatF.Q.value = 2.5;
    var clatGate = ctx.createGain(); clatGate.gain.value = 0.5;
    clatN.connect(clatF); clatF.connect(clatGate); clatGate.connect(clat);
    var clatLfo = ctx.createOscillator(); clatLfo.type = 'sawtooth'; clatLfo.frequency.value = 10;
    var clatD = ctx.createGain(); clatD.gain.value = -0.5;
    clatLfo.connect(clatD); clatD.connect(clatGate.gain);

    sub.start(); rum.start(); chugN.start(); chugT.start(); lfo.start();
    clatN.start(); clatLfo.start();

    // TURRET SERVO: a filtered triangle that only exists while the gun turns.
    var srvGain = ctx.createGain();
    srvGain.gain.value = 0;
    var srvFilter = ctx.createBiquadFilter();
    srvFilter.type = 'bandpass';
    srvFilter.frequency.value = 900;
    srvFilter.Q.value = 6;
    srvFilter.connect(srvGain);
    srvGain.connect(master);
    var srv = ctx.createOscillator(); srv.type = 'triangle'; srv.frequency.value = 320;
    srv.connect(srvFilter); srv.start();

    /* THE CASH-OUT SQUARE. Sitting in the box is worth its own sound, and Owen
       asked for a very quiet one. It is the first two notes of the fanfare you
       get when the five seconds are up, C5 and the G above it, held under a
       slow tremolo so it breathes rather than sitting there like a test tone.
       You should barely notice it start and definitely notice it stop. */
    var bankGain = ctx.createGain(); bankGain.gain.value = 0;
    bankGain.connect(master);
    var trem = ctx.createGain(); trem.gain.value = 0.62;
    trem.connect(bankGain);
    var tremLfo = ctx.createOscillator(); tremLfo.type = 'sine'; tremLfo.frequency.value = 2.6;
    var tremD = ctx.createGain(); tremD.gain.value = 0.38;   // swings the tremolo 0.24..1
    tremLfo.connect(tremD); tremD.connect(trem.gain);
    var bA = ctx.createOscillator(); bA.type = 'sine'; bA.frequency.value = 523.25;
    var bAg = ctx.createGain(); bAg.gain.value = 0.55;
    bA.connect(bAg); bAg.connect(trem);
    var bB = ctx.createOscillator(); bB.type = 'sine'; bB.frequency.value = 783.99;
    var bBg = ctx.createGain(); bBg.gain.value = 0.32;
    bB.connect(bBg); bBg.connect(trem);
    bA.start(); bB.start(); tremLfo.start();

    beds = { engGain: engGain, sub: sub, chugT: chugT, chugF: chugF, lfo: lfo,
             clat: clat, clatLfo: clatLfo,
             srvGain: srvGain, srvOsc: srv,
             bankGain: bankGain, tremLfo: tremLfo };
  }

  /* Called every frame with how hard the tank is working. `drive` is 0..1 of
     top speed, `turn` is 0..1 of how fast the turret is swinging. Ramps rather
     than jumps, because a gain that steps produces a click. */
  function rig(drive, turn) {
    if (!ready || muted) return;
    var t = now();
    var d = Math.max(0, Math.min(1, drive || 0));
    var r = Math.max(0, Math.min(1, turn || 0));

    /* Very quiet, and pulsed rather than droning, which lowers what you
       actually hear again at the same peak. The rate climbing with speed is
       what carries the effort, so this does not need volume to read as work. */
    beds.engGain.gain.setTargetAtTime(0.006 + d * 0.017, t, 0.12);
    beds.lfo.frequency.setTargetAtTime(7 + d * 13, t, 0.18);
    var f0 = 33 + d * 15;                       // the engine's own low tone
    beds.sub.frequency.setTargetAtTime(f0, t, 0.18);
    beds.chugT.frequency.setTargetAtTime(f0 * 2, t, 0.18);   // locked, never beating
    beds.chugF.frequency.setTargetAtTime(250 + d * 240, t, 0.15);

    beds.clat.gain.setTargetAtTime(d * 0.0075, t, 0.14);
    beds.clatLfo.frequency.setTargetAtTime(9 + d * 13, t, 0.18);

    beds.srvGain.gain.setTargetAtTime(r * 0.010, t, 0.05);
    beds.srvOsc.frequency.setTargetAtTime(280 + r * 260, t, 0.05);
  }

  /* The cash-out square, every frame. `inBox` is whether the tank is inside it
     at all, which is what starts the sound, and `progress` is 0..1 of the five
     seconds, which leans it up and speeds the tremolo so the sound itself
     tells you how close you are. Two arguments rather than one because a bare
     progress value is 0 at the moment you drive in, and that moment is exactly
     what Owen asked to be able to hear. */
  function bank(inBox, progress) {
    if (!ready || !beds) return;
    var t = now();
    if (!inBox || muted) { beds.bankGain.gain.setTargetAtTime(0, t, 0.12); return; }
    var p = Math.max(0, Math.min(1, progress || 0));
    beds.bankGain.gain.setTargetAtTime(0.0045 + p * 0.0075, t, 0.10);
    beds.tremLfo.frequency.setTargetAtTime(2.6 + p * 2.6, t, 0.15);
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
    /* The five seconds in the middle paying off. This is the SAME sound the
       snake game plays when you cash out, because every game should pay out
       the same way and three copies of a sound do not stay identical. It
       lives in js/cashoutSound.js. Routed through master so mute still works,
       and at 0.9 because master already sits at 0.55 while the snake game
       plays the same thing at 0.5 straight to the destination.

       There used to be a bankTick one-shot here for the seconds counting up.
       Nothing ever called it, and the quiet held bed in buildBeds is what
       actually covers standing in the square now. */
    banked: function () {
      if (root.CashoutSound) root.CashoutSound.play(ctx, master, 0.9);
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
    init: init, unlock: unlock, gun: gun, fx: fx, rig: rig, bank: bank,
    setMuted: setMuted,
    get muted() { return muted; },
    get ready() { return ready; },
  };

})(typeof window !== 'undefined' ? window : globalThis);
