'use strict';
/* ─── OMG Shooter, the sound ──────────────────────────────────────────────────
   Every sound in this game is synthesised in the browser. There are no audio
   files, nothing is downloaded, and nothing was taken from anywhere.

   TWO KINDS OF SOUND HERE.

   One-shots (a gun, a break, an explosion, a pickup) are Glass sounds from the
   shared engine, public/js/dsSfx.js. They are rendered once into buffers while
   the page loads, so a trigger only starts one: zero delay, nothing built per
   shot. The weapon voices are defined at the bottom of this file ('sh.<gun>')
   in the same layer format and the same house style as dsSfxGame.js: a low sine
   thump plus a puff of filtered noise, heavier guns lower and longer. Every
   shot gets a small random {rate} so a minigun is not the same click ten times
   a second.

   Beds (the engine, the turret servo, the flame, the cash-out square hum) are
   built once and left running for the life of the page with their gain ridden
   up and down, because starting and stopping an oscillator per frame is both
   expensive and audibly clicky. They are live graphs on the SAME AudioContext
   as the one-shots (DSSfx.context()) and feed DSSfx.output() through one gain,
   so there is one context per page and one place to mute them.

   BROWSERS WILL NOT LET YOU MAKE NOISE until the user has interacted with the
   page. The shared context is resumed on the first click or key. */

(function (root) {

  var ctx = null;
  var bedOut = null;      // every live bed runs through this one gain
  var beds = null;
  var muted = false;
  var ready = false;

  var BED_LEVEL = 0.45;   // the beds' share of the page mix (the old master was 0.55)

  /* The noise the beds are made of, made once and re-read. */
  var noiseBuf = null;

  function sfx() { return root.DSSfx || null; }

  /* `existing` lets a caller hand in its own context. The game never does, but
     it means the beds can be rendered into an OfflineAudioContext and measured
     (public/dev-soundcheck.html), which is the only way to check a mix without
     ears. Without one, the beds join the shared Glass context. */
  function init(existing) {
    if (ctx) return ctx;
    var S = sfx(), dest = null;
    if (existing) { ctx = existing; dest = ctx.destination; }
    else if (S && S.context()) { ctx = S.context(); dest = S.output(); }
    else {
      var AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      dest = ctx.destination;
    }

    bedOut = ctx.createGain();
    bedOut.gain.value = muted ? 0 : BED_LEVEL;
    bedOut.connect(dest);
    if (S) S.setLevel(function () { return muted ? 0 : 1; });   // the one-shots' volume

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
    if (ctx && ctx.state === 'suspended') {
      var p = ctx.resume();
      if (p && p.catch) p.catch(function () {});
    }
  }

  function now() { return ctx.currentTime; }

  /* One Glass one-shot. False when the engine is missing or held the sound back. */
  function cue(name, o) {
    var S = sfx();
    return S ? S.play(name, o) : false;
  }
  /* A random playback rate within +-spread/2 of 1, so repeats are never identical. */
  function vary(spread) { return 1 - spread / 2 + Math.random() * spread; }

  /* ── the beds ───────────────────────────────────────────────────────────
     Continuous voices that never stop, whose levels are ridden by the game.
     Owen asked for these to sit behind everything, so they are tiny. They are
     soft on purpose: sines and triangles, low-passed noise, nothing bright. */
  function buildBeds() {
    /* THE ENGINE. A tank does not drone, it chugs. The first version was two
       detuned sawtooths through a resonant low-pass, which is a generator, or
       a fridge, and Owen was right that it did not sound like a tank at all.

       What makes a diesel read as a diesel is that you can hear the separate
       cylinders firing, so this is built as a pulse train. An inverted
       sawtooth LFO gates a band of low noise and a low tone; inverted, because
       a rising ramp is a wobble and a falling one is a bang, and a combustion
       stroke is a bang. The rate of that LFO IS the engine speed, so driving
       revs the engine rather than merely turning it up. Under it sits a
       steady sub and some rumble, which is the mass of the thing.

       Then the tracks, on their own faster pulse train of filtered noise: link
       plates slapping the road wheels. They only exist while the tank is
       actually rolling, which is the other half of why the old bed read as a
       machine sitting still.

       The Glass pass: the chug tone is a triangle rather than a saw, the noise
       filter is no longer resonant, and the whole engine goes through a gentle
       low-pass, so the pulses thud instead of bark. */
    var engGain = ctx.createGain();
    engGain.gain.value = 0;
    var engLP = ctx.createBiquadFilter();
    engLP.type = 'lowpass'; engLP.frequency.value = 700; engLP.Q.value = 0.5;
    engGain.connect(engLP); engLP.connect(bedOut);

    // the mass: always there while the engine is running
    var body = ctx.createGain(); body.gain.value = 0.30;
    body.connect(engGain);
    var sub = ctx.createOscillator(); sub.type = 'sine'; sub.frequency.value = 33;
    sub.connect(body);
    var rum = ctx.createBufferSource(); rum.buffer = noiseBuf; rum.loop = true;
    var rumF = ctx.createBiquadFilter(); rumF.type = 'lowpass'; rumF.frequency.value = 110;
    var rumG = ctx.createGain(); rumG.gain.value = 0.4;
    rum.connect(rumF); rumF.connect(rumG); rumG.connect(body);

    // the chug: one pulse per firing stroke
    var chug = ctx.createGain(); chug.gain.value = 0.5;  // offset; the LFO swings it 0..1
    chug.connect(engGain);
    var chugN = ctx.createBufferSource(); chugN.buffer = noiseBuf; chugN.loop = true;
    var chugF = ctx.createBiquadFilter();
    chugF.type = 'lowpass'; chugF.frequency.value = 250; chugF.Q.value = 0.7;
    chugN.connect(chugF); chugF.connect(chug);
    /* Exactly TWO octaves-worth of the sub, not a free-running pitch. Two low
       oscillators at an unrelated interval beat at their difference, and that
       slow throb is what made the first bed sound like a generator: its 46Hz
       and 69Hz saws beat at 23Hz, which measured as a stronger rhythm than
       anything intentional in it. Locked to a harmonic, the two reinforce
       into one tone and the only rhythm left is the chug. */
    var chugT = ctx.createOscillator(); chugT.type = 'triangle'; chugT.frequency.value = 66;
    var chugTG = ctx.createGain(); chugTG.gain.value = 0.22;
    chugT.connect(chugTG); chugTG.connect(chug);

    var lfo = ctx.createOscillator(); lfo.type = 'sawtooth'; lfo.frequency.value = 7;
    var lfoD = ctx.createGain(); lfoD.gain.value = -0.5;   // negative depth = inverted saw
    lfo.connect(lfoD); lfoD.connect(chug.gain);

    // the tracks
    var clat = ctx.createGain(); clat.gain.value = 0;
    clat.connect(bedOut);
    var clatN = ctx.createBufferSource(); clatN.buffer = noiseBuf; clatN.loop = true;
    var clatF = ctx.createBiquadFilter();
    clatF.type = 'bandpass'; clatF.frequency.value = 1700; clatF.Q.value = 1.1;
    var clatLP = ctx.createBiquadFilter();
    clatLP.type = 'lowpass'; clatLP.frequency.value = 2400; clatLP.Q.value = 0.5;
    var clatGate = ctx.createGain(); clatGate.gain.value = 0.5;
    clatN.connect(clatF); clatF.connect(clatLP); clatLP.connect(clatGate); clatGate.connect(clat);
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
    srvFilter.Q.value = 3.5;
    srvFilter.connect(srvGain);
    srvGain.connect(bedOut);
    var srv = ctx.createOscillator(); srv.type = 'triangle'; srv.frequency.value = 320;
    srv.connect(srvFilter); srv.start();

    /* THE CASH-OUT SQUARE HUM. Sitting in the box is worth its own sound, and
       Owen asked for a very quiet one. It is C5 and the G above it, the notes the
       cash-out chime resolves into, held under a slow tremolo so it breathes rather than sitting there like a test tone.
       The Glass cues (ring start, a tick each second, ring cancel) ride on top
       of it from bank() below. */
    var bankGain = ctx.createGain(); bankGain.gain.value = 0;
    bankGain.connect(bedOut);
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

    /* THE FLAMETHROWER. Every other gun here is an event, so every other gun
       is a one-shot. Fire is not an event, it is a thing that is happening,
       and firing a one-shot every 50ms produced a stuttering rattle that
       sounded like a gun because it WAS shaped like a gun, twenty times a
       second. So the flamethrower is a bed like the engine: held open for
       exactly as long as the trigger is.

       Two layers. The roar is broad low noise with its cutoff pushed around
       by two LFOs at rates that do not divide into each other, so it billows
       and never settles into a loop you can hear repeating. Over it, a thin
       hiss, which is the gas leaving the nozzle. Softened for Glass: a lower,
       calmer roar and a band-passed hiss instead of a bright high-pass. */
    var flmGain = ctx.createGain(); flmGain.gain.value = 0;
    flmGain.connect(bedOut);

    var roar = ctx.createBufferSource(); roar.buffer = noiseBuf; roar.loop = true;
    var roarF = ctx.createBiquadFilter();
    roarF.type = 'lowpass'; roarF.frequency.value = 560; roarF.Q.value = 0.6;
    var roarG = ctx.createGain(); roarG.gain.value = 0.9;
    roar.connect(roarF); roarF.connect(roarG); roarG.connect(flmGain);

    var wob = ctx.createOscillator(); wob.type = 'sine'; wob.frequency.value = 5.5;
    var wobD = ctx.createGain(); wobD.gain.value = 200;
    wob.connect(wobD); wobD.connect(roarF.frequency);
    var wob2 = ctx.createOscillator(); wob2.type = 'sine'; wob2.frequency.value = 1.7;
    var wob2D = ctx.createGain(); wob2D.gain.value = 130;
    wob2.connect(wob2D); wob2D.connect(roarF.frequency);

    var hiss = ctx.createBufferSource(); hiss.buffer = noiseBuf; hiss.loop = true;
    var hissF = ctx.createBiquadFilter();
    hissF.type = 'bandpass'; hissF.frequency.value = 2400; hissF.Q.value = 0.7;
    var hissG = ctx.createGain(); hissG.gain.value = 0.16;
    hiss.connect(hissF); hissF.connect(hissG); hissG.connect(flmGain);

    roar.start(); hiss.start(); wob.start(); wob2.start();

    beds = { engGain: engGain, sub: sub, chugT: chugT, chugF: chugF, lfo: lfo,
             flmGain: flmGain,
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
    beds.engGain.gain.setTargetAtTime(0.006 + d * 0.026, t, 0.12);
    beds.lfo.frequency.setTargetAtTime(7 + d * 13, t, 0.18);
    var f0 = 33 + d * 15;                       // the engine's own low tone
    beds.sub.frequency.setTargetAtTime(f0, t, 0.18);
    beds.chugT.frequency.setTargetAtTime(f0 * 2, t, 0.18);   // locked, never beating
    beds.chugF.frequency.setTargetAtTime(250 + d * 240, t, 0.15);

    beds.clat.gain.setTargetAtTime(d * 0.008, t, 0.14);
    beds.clatLfo.frequency.setTargetAtTime(9 + d * 13, t, 0.18);

    beds.srvGain.gain.setTargetAtTime(r * 0.008, t, 0.05);
    beds.srvOsc.frequency.setTargetAtTime(280 + r * 260, t, 0.05);
  }

  /* The trigger, every frame, for the one gun that is a sound rather than a
     series of them. Fast on and slower off: fire catches at once and trails
     away as the last of the fuel burns. */
  function flame(on) {
    if (!ready || !beds) return;
    var t = now();
    var want = (on && !muted) ? 0.06 : 0;
    beds.flmGain.gain.setTargetAtTime(want, t, on ? 0.03 : 0.10);
  }

  /* The cash-out square, every frame. `inBox` is whether the tank is inside it
     at all, which is what starts the sound, and `progress` is 0..1 of the five
     seconds, which leans the hum up and speeds its tremolo so the sound itself
     tells you how close you are. Two arguments rather than one because a bare
     progress value is 0 at the moment you drive in, and that moment is exactly
     what Owen asked to be able to hear.

     On top of the hum, three Glass cues: a rising swell when you drive in
     (g.ringStart), a bell tick each second that climbs a little each time
     (g.ringTick, four of them, then the payoff is g.cashout), and a falling
     blip if you leave before it is paid (g.ringCancel). A cash-out or a death
     also empties the box, so those cancel the blip: they have their own sound. */
  var TICK_RATE = [1, 1, 1.125, 1.25, 1.5];   // index = whole seconds done
  var wasIn = false, step = 0, cancelT = 0, quietUntil = 0;

  function bank(inBox, progress) {
    if (!ready || !beds) return;
    var t = now();
    if (!inBox || muted) {
      beds.bankGain.gain.setTargetAtTime(0, t, 0.12);
      if (wasIn && !muted) leftBox();
      wasIn = false;
      return;
    }
    var p = Math.max(0, Math.min(1, progress || 0));
    beds.bankGain.gain.setTargetAtTime(0.0045 + p * 0.0075, t, 0.10);
    beds.tremLfo.frequency.setTargetAtTime(2.6 + p * 2.6, t, 0.15);

    var k = Math.min(4, Math.floor(p * 5));
    if (!wasIn) {
      wasIn = true;
      step = k;
      cue('g.ringStart', { gap: 250 });
    } else if (k > step) {
      cue('g.ringTick', { rate: TICK_RATE[k], gap: 0 });
    }
    step = k;
  }
  function leftBox() {
    if (Date.now() < quietUntil) return;
    clearTimeout(cancelT);
    cancelT = setTimeout(function () {
      cancelT = 0;
      cue('g.ringCancel', { gap: 250 });
    }, 150);
  }
  /* A cash-out or a death is why the box emptied, not the player leaving. */
  function settled() {
    clearTimeout(cancelT);
    cancelT = 0;
    quietUntil = Date.now() + 800;
  }

  /* ── the guns ───────────────────────────────────────────────────────────
     Ten weapons, ten voices. The rule each one follows is that you should be
     able to name the gun with your eyes shut: the minigun is a dry tick, the
     cannon is a body blow, the railgun is a long charged crack, the
     flamethrower is breath rather than a bang. `spread` is how far the
     playback rate wanders per shot; `gap` and `max` keep a fast gun from
     stacking (gap 0 lets every shot of a rapid gun through). */
  var SHOTS = {
    minigun:      { name: 'sh.minigun',  spread: 0.30, gap: 0,  max: 6 },
    shotgun:      { name: 'sh.shotgun',  spread: 0.12, gap: 30, max: 10 },
    ricochet:     { name: 'sh.ricochet', spread: 0.16, gap: 30, max: 10 },
    flamethrower: { name: 'sh.flame',    spread: 0.80, gap: 0,  max: 4 },
    cannon:       { name: 'sh.cannon',   spread: 0.10, gap: 30, max: 10 },
    shock:        { name: 'sh.shock',    spread: 0.14, gap: 30, max: 10 },
    rockets:      { name: 'sh.rocket',   spread: 0.10, gap: 30, max: 10 },
    laser:        { name: 'sh.laser',    spread: 0.16, gap: 30, max: 10 },
    railgun:      { name: 'sh.railgun',  spread: 0.06, gap: 30, max: 10 },
    mines:        { name: 'sh.mine',     spread: 0.10, gap: 30, max: 10 },
  };

  function gun(key) {
    if (!ready || muted) return;
    var s = Object.prototype.hasOwnProperty.call(SHOTS, key) ? SHOTS[key] : SHOTS.cannon;
    /* Nearly silent per shot on the flamethrower, on purpose. What it sounds
       like is the bed in buildBeds, held for as long as the trigger is; this
       adds only the occasional pop of something catching, and only some of the
       time, so twenty shots a second do not become a rattle. */
    if (key === 'flamethrower' && Math.random() >= 0.28) return;
    cue(s.name, { rate: vary(s.spread), gap: s.gap, max: s.max });
  }

  /* ── everything else ────────────────────────────────────────────────────── */

  var FX = {
    // A shot landing on a wall that did not break.
    hit: function () { cue('sh.wall', { rate: vary(0.25), gap: 45 }); },
    // A crate, brick or wood panel coming apart.
    breakBlock: function () { cue('sh.break', { rate: vary(0.2), gap: 60 }); },
    // A barrel, a rocket, a mine.
    boom: function () { cue('g.explode', { rate: vary(0.15), gap: 90 }); },
    coin: function () { cue('g.pickup', { rate: 0.96 + Math.random() * 0.14 }); },
    medkit: function () { cue('g.heal', { gap: 120 }); },
    // You took damage. Gapped so a burn pulses instead of buzzing.
    hurt: function () { cue('g.hurt', { rate: vary(0.1), gap: 120, max: 6 }); },
    death: function () { settled(); cue('g.death', { gap: 400 }); },
    // You destroyed someone.
    kill: function () { cue('g.kill', { gap: 150 }); },
    // Switching weapon.
    click: function () { cue('g.click', { gap: 60 }); },
    /* The five seconds in the middle paying off: the house cash-out, g.cashout,
       the same payoff the other games play. */
    banked: function () { settled(); cue('g.cashout', { gap: 400 }); },
  };

  function fx(name) {
    if (!ready || muted) return;
    if (Object.prototype.hasOwnProperty.call(FX, name)) FX[name]();
  }

  /* Silences everything: the one-shots through the engine's level, the beds
     through their own gain. */
  function setMuted(v) {
    muted = !!v;
    if (bedOut && ctx) bedOut.gain.setTargetAtTime(muted ? 0 : BED_LEVEL, now(), 0.05);
    return muted;
  }

  /* ── the Glass weapon voices ────────────────────────────────────────────────
     Layer format as in dsSfx.js. Each gun is a low sine thump plus a puff of
     filtered noise, built from g.shoot / g.shootHeavy: heavy guns lower and
     longer, the rapid gun short and light. */
  function defineSounds(S) {
    var mf = S.mf;
    var thump = function (f0, f1, d, v, at) { return { o: 's', f: [f0, f1], d: d, v: v, e: d / 3.5, at: at || 0 }; };
    var bell = function (n, at, d, v, x) {
      return Object.assign({ o: 'fm', f: mf(n), m: 3.5, i: 1.3, at: at, d: d, v: v, e: d / 3 }, x);
    };
    var zr = S.rng(53);
    var zaps = [0, 1, 2, 3, 4].map(function (k) {      // five quick glassy chirps
      return { o: 's', f: [2200 + zr() * 1800, 700], at: k * 0.035, d: 0.07, v: 0.07, e: 0.02, g: 0.05 };
    });

    S.define({
      // light, short, a dry tick (it fires ten times a second)
      'sh.minigun': [
        { o: 'n', d: 0.045, v: 0.11, e: 0.011, bp: [[2800, 1200], 0.9] },
        thump(250, 130, 0.045, 0.12)],
      // a wide blast and a pellet spray after it
      'sh.shotgun': [
        { o: 'n', d: 0.3, v: 0.26, e: 0.07, lp: [3400, 450] },
        thump(150, 48, 0.28, 0.34),
        { o: 'n', at: 0.04, d: 0.16, v: 0.08, e: 0.045, bp: [[2000, 900], 0.9] }],
      // a ping that falls, with a little bell on it
      'sh.ricochet': [
        { o: 's', f: [1050, 400], d: 0.13, v: 0.13, e: 0.04, g: 0.1 },
        bell(91, 0.01, 0.2, 0.035, { m: 2.5, i: 1 }),
        { o: 'n', d: 0.06, v: 0.07, e: 0.015, bp: [[3000, 1400], 1.5] },
        thump(220, 110, 0.06, 0.12)],
      // the occasional pop of fire catching (the roar is the bed)
      'sh.flame': [
        { o: 'n', d: 0.07, v: 0.07, a: 0.006, e: 0.022, bp: [[1500, 800], 1.2] },
        thump(130, 80, 0.06, 0.05)],
      // a body blow: low, long
      'sh.cannon': [
        { o: 'n', d: 0.36, v: 0.24, e: 0.075, lp: [2800, 350] },
        thump(125, 38, 0.36, 0.42),
        { o: 't', f: [240, 100], d: 0.14, v: 0.06, e: 0.04 }],
      // chirps over a crackle
      'sh.shock': zaps.concat([
        { o: 'n', d: 0.22, v: 0.06, e: 0.07, hp: [6000, 2500] },
        thump(210, 100, 0.1, 0.14)]),
      // a launch whoosh that opens up
      'sh.rocket': [
        { o: 'n', d: 0.6, v: 0.2, a: 0.05, e: 0.22, bp: [[450, 1700], 0.8] },
        { o: 's', f: [330, 140], d: 0.5, v: 0.1, a: 0.01, e: 0.2 },
        thump(160, 60, 0.2, 0.3)],
      // a clean falling zap
      'sh.laser': [
        { o: 's', f: [1900, 420], d: 0.17, v: 0.14, e: 0.06, g: 0.14 },
        { o: 't', f: [950, 210], d: 0.13, v: 0.05, e: 0.04, g: 0.11 },
        bell(100, 0, 0.22, 0.025, { m: 3, i: 0.8 })],
      // a charge that rises, then the crack and a long ring
      'sh.railgun': [
        { o: 's', f: [260, 1500], d: 0.2, v: 0.1, a: 0.05, e: 0.5 },
        { o: 'n', at: 0.18, d: 0.45, v: 0.28, e: 0.09, lp: [6000, 450] },
        thump(120, 34, 0.5, 0.42, 0.18),
        bell(84, 0.18, 0.8, 0.04, { i: 1.2, e: 0.25 })],
      // two soft beeps and a thud: a mine set down
      'sh.mine': [
        { o: 's', f: 622, d: 0.07, v: 0.1, e: 0.022 },
        { o: 's', f: 880, at: 0.075, d: 0.08, v: 0.09, e: 0.025 },
        thump(190, 100, 0.09, 0.16)],
      // a shot that landed on a wall that held
      'sh.wall': [
        { o: 'n', d: 0.05, v: 0.09, e: 0.012, bp: [[2400, 1300], 1.4] },
        thump(380, 210, 0.05, 0.1)],
      // a crate, brick or wood panel coming apart
      'sh.break': [
        { o: 'n', d: 0.28, v: 0.2, e: 0.07, lp: [2800, 300] },
        thump(190, 70, 0.16, 0.22),
        { o: 'n', at: 0.03, d: 0.1, v: 0.07, e: 0.03, bp: [[1500, 700], 1] }],
    });
  }
  if (root.DSSfx) defineSounds(root.DSSfx);

  root.ShooterSound = {
    init: init, unlock: unlock, gun: gun, fx: fx, rig: rig, bank: bank, flame: flame,
    setMuted: setMuted,
    get muted() { return muted; },
    get ready() { return ready; },
  };

})(typeof window !== 'undefined' ? window : globalThis);
