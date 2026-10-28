/* ─── Swim: the engines ───────────────────────────────────────────────────────
  Our own synthesis, written for Swim: every sound here is built in code from
  oscillators, periodic waves, noise buffers, filters and waveshapers. No
  recordings, nothing borrowed. The three engines Owen picked (2026-10-28) from
  the picker in Claude Code Test/swim-sounds: v8, v12 and turbo4. Which one a
  player hears is chosen in Customize (shared/swimLooks.js).

    window.SwimEngines = {
      ids: ['v8', 'v12', 'turbo4'],
      prepare(ctx, id)        work out the engine's waves ahead of time (heavy, once per context)
      make(ctx, id, dest) -> engine
    }

  engine.set({ speed, throttle }, at)
      Call once per animation frame.
      speed     metres per second, 0 to about 97 (350 km/h)
      throttle  -1 brake, 0 lift off, 1 gas (values in between work too)
      at        optional AudioContext time to schedule for; defaults to ctx.currentTime
  engine.stop()     fade out and release every node
  engine.out        the engine's output GainNode

  The engine works out its own gear and rpm from speed. set() allocates
  nothing apart from the AudioParam automation events it schedules; all nodes
  are built once in make() and reused. */
(function (root) {
  'use strict';

  var V_TOP = 97;                 // top speed in m/s, about 350 km/h
  var V_GEAR_TOP = V_TOP / 0.94;  // speed at redline in top gear, so top speed sits just under redline

  // ---------------------------------------------------------------------------
  // Engine definitions. A car's whole voice lives in one of these objects.
  //   cyl, revs  pulses per engine cycle and crank turns per cycle (2 for a four-stroke)
  //   banks      firing slots per exhaust bank, each bank with its own pipe (delay ms + feedback)
  //   pulse      exhaust pulse shape: width (share of a firing gap), attack a, decay b, rebound
  //   lp         body lowpass [base Hz, extra Hz at full load, extra per firing Hz]
  //   lope       [depth at idle, rate as a multiple of cycle rate]; half = AM at half firing rate
  //   gas        pulsed exhaust gas noise [depth, band Hz, Q]
  //   intake     intake roar [level, base Hz, Hz per firing Hz, Q]
  //   even       how far the second bank catches up with the first at high rpm and load
  // ---------------------------------------------------------------------------
  var DEFS = [
    {
      id: 'v8',
      cyl: 8, revs: 2, idle: 850, redline: 6800, gears: 6, first: 0.30,
      // Firing order 1-8-4-3-6-5-7-2 puts the left bank in slots 0,3,5,6 and the right bank
      // in 1,2,4,7, so each bank alone fires unevenly. Two pipes of different length give the burble.
      banks: [
        { slots: [0, 3, 5, 6], amp: 1.0, amps: [1, 0.93, 1.04, 0.9], skew: [0, 0.03, -0.02, 0.04], pipe: 8.7, fb: 0.42 },
        { slots: [1, 2, 4, 7], amp: 0.8, amps: [0.95, 1, 0.9, 1.05], skew: [0.02, -0.03, 0.01, 0], pipe: 10.3, fb: 0.38 }
      ],
      pulse: { w: 0.95, a: 1.3, b: 2.4, reb: 0.22, rw: 0.6 },
      even: 0.7,
      pipeLP: 1600, wet: 0.75,
      drive: 1.25, k: 2.2, bias: 0.12,
      lp: [380, 900, 3.0], lpQ: 0.9,
      eq: [['lowshelf', 140, 0.7, 5], ['peaking', 95, 1.1, 3], ['peaking', 2400, 0.9, -3]],
      lope: [0.5, 0.5], half: 0.22, jitter: 18, rough: 0.22,
      gas: [0.7, 1400, 0.8],
      intake: [0.4, 180, 0.9, 0.9],
      wail: null,
      pops: { rate: 16, decay: 0.8, win: 2.0, big: 0.35, level: 0.9 },
      shift: { cut: 0.3, dur: 0.11, clunk: 0.3, pop: 0.25 },
      turbo: null,
      trim: 0.358
    },
    {
      id: 'v12',
      cyl: 12, revs: 2, idle: 1000, redline: 9500, gears: 7, first: 0.26,
      banks: [
        { slots: [0, 2, 4, 6, 8, 10], amp: 1.0, amps: [1, 0.9, 1.06, 0.94, 1.03, 0.9], skew: [0, 0.03, -0.02, 0.02, -0.03, 0.01], pipe: 4.6, fb: 0.33 },
        { slots: [1, 3, 5, 7, 9, 11], amp: 0.85, amps: [0.95, 1.05, 0.92, 1.04, 0.97, 1.02], skew: [0.01, -0.02, 0.03, 0, -0.01, 0.02], pipe: 5.3, fb: 0.3 }
      ],
      pulse: { w: 0.5, a: 1.2, b: 2.0, reb: 0.15, rw: 0.5 },
      pipeLP: 5000, wet: 0.6,
      drive: 1.0, k: 1.8, bias: 0.05,
      lp: [900, 2000, 3.0], lpQ: 0.8,
      eq: [['lowshelf', 160, 0.7, 2], ['peaking', 1800, 0.8, 3], ['highshelf', 6000, 0.7, -4]],
      lope: [0.05, 0.5], half: 0.08, jitter: 6, rough: 0.12,
      gas: [0.45, 3000, 0.7],
      intake: [0.5, 400, 1.4, 1.0],
      wail: { mult: 12, bp: 24, q: 2.5, level: 0.4 },
      pops: { rate: 5, decay: 0.5, win: 1.0, big: 0.2, level: 0.5 },
      shift: { cut: 0.4, dur: 0.07, clunk: 0.2, pop: 0.35 },
      turbo: null,
      trim: 0.5
    },
    {
      id: 'turbo4',
      cyl: 4, revs: 2, idle: 900, redline: 7200, gears: 6, first: 0.29,
      banks: [
        { slots: [0, 1, 2, 3], amp: 1.0, amps: [1, 0.92, 0.98, 0.9], skew: [0, 0.02, -0.01, 0.015], pipe: 6.2, fb: 0.45 }
      ],
      pulse: { w: 0.5, a: 0.9, b: 2.6, reb: 0.35, rw: 0.7 },
      pipeLP: 3200, wet: 0.7,
      drive: 1.7, k: 2.8, bias: 0.08,
      lp: [480, 1300, 3.0], lpQ: 1.0,
      eq: [['peaking', 240, 1.0, 3], ['peaking', 1150, 1.2, 2.5], ['highshelf', 5000, 0.7, -3]],
      lope: [0.1, 0.5], half: 0, jitter: 10, rough: 0.18,
      gas: [0.8, 2000, 0.8],
      intake: [0.6, 300, 1.2, 0.9],
      wail: null,
      pops: { rate: 7, decay: 0.6, win: 1.2, big: 0.25, level: 0.6 },
      shift: { cut: 0.25, dur: 0.1, clunk: 0.3, pop: 0.15 },
      turbo: { lo: 2400, hi: 6400, level: 0.05, bov: 0.55 },
      trim: 0.288
    }
  ];

  var BY_ID = {};
  for (var di = 0; di < DEFS.length; di++) BY_ID[DEFS[di].id] = DEFS[di];
  var DEFAULT_ID = 'v12';
  function defOf(id) { return BY_ID[id] || BY_ID[DEFAULT_ID]; }

  // ---------------------------------------------------------------------------
  // Shared material, built once per AudioContext.
  // ---------------------------------------------------------------------------
  var shared = typeof WeakMap === 'function' ? new WeakMap() : null;

  function rng(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  // White noise, or smooth random motion when cutoff is given (normalised to rms 0.4, seamless loop).
  function noiseBuffer(ctx, seconds, cutoff, seed) {
    var sr = ctx.sampleRate, n = Math.floor(sr * seconds), i;
    var fade = cutoff ? Math.floor(sr * 0.5) : 0;
    var raw = new Float32Array(n + fade), r = rng(seed);
    for (i = 0; i < raw.length; i++) raw[i] = r() * 2 - 1;
    var buf = ctx.createBuffer(1, n, sr), d = buf.getChannelData(0);
    if (!cutoff) { d.set(raw.subarray(0, n)); return buf; }
    var a = Math.exp(-2 * Math.PI * cutoff / sr), y1 = 0, y2 = 0, warm = Math.min(raw.length, sr * 2);
    for (i = 0; i < warm; i++) { y1 += (1 - a) * (raw[i] - y1); y2 += (1 - a) * (y1 - y2); }
    for (i = 0; i < raw.length; i++) { y1 += (1 - a) * (raw[i] - y1); y2 += (1 - a) * (y1 - y2); raw[i] = y2; }
    for (i = 0; i < n; i++) d[i] = raw[i];
    for (i = 0; i < fade; i++) { var w = i / fade; d[i] = raw[i] * w + raw[n + i] * (1 - w); }
    var s = 0;
    for (i = 0; i < n; i++) s += d[i] * d[i];
    var g = 0.4 / Math.sqrt(s / n || 1);
    for (i = 0; i < n; i++) d[i] *= g;
    return buf;
  }

  function store(ctx) {
    var c = shared && shared.get(ctx);
    if (!c) {
      c = {
        white: noiseBuffer(ctx, 2.5, 0, 0x2545f491),
        slow: noiseBuffer(ctx, 9, 4, 0x1b873593),
        mid: noiseBuffer(ctx, 6, 14, 0x68e31da4),
        fast: noiseBuffer(ctx, 5, 110, 0x85ebca6b),
        waves: {}, saw: null, curves: {}
      };
      if (shared) shared.set(ctx, c);
    }
    return c;
  }

  // Soft clip, slightly asymmetric for even harmonics.
  function softClip(c, k, bias) {
    var key = k + ':' + bias;
    if (c.curves[key]) return c.curves[key];
    var n = 2048, curve = new Float32Array(n), off = Math.tanh(k * bias);
    var top = Math.max(Math.tanh(k * (1 + bias)) - off, off - Math.tanh(k * (bias - 1)));
    for (var i = 0; i < n; i++) {
      var x = i / (n - 1) * 2 - 1;
      curve[i] = (Math.tanh(k * (x + bias)) - off) / top;
    }
    c.curves[key] = curve;
    return curve;
  }

  // One engine cycle drawn in the time domain (a train of exhaust pulses per bank),
  // turned into PeriodicWaves. The oscillators run at the cycle rate (rpm / 60 / revs),
  // so the firing rate and every uneven sub-rhythm come out as its harmonics.
  function engineWaves(ctx, c, d) {
    if (c.waves[d.id]) return c.waves[d.id];
    var M = 4096, H = 1024, N = d.cyl, p = d.pulse, b, j, m, n;
    var W = p.w / N, R = W * p.rw;
    var pk = p.a / (p.a + p.b), norm = Math.pow(pk, p.a) * Math.pow(1 - pk, p.b);
    var xs = [];
    for (b = 0; b < d.banks.length; b++) {
      var bank = d.banks[b], x = new Float32Array(M);
      for (j = 0; j < bank.slots.length; j++) {
        var amp = bank.amp * (bank.amps ? bank.amps[j] : 1);
        var ph = (bank.slots[j] + (bank.skew ? bank.skew[j] : 0)) / N;
        for (m = 0; m < M; m++) {
          var u = m / M - ph;
          u -= Math.floor(u);
          if (u < W) {
            var q = u / W;
            x[m] += amp * Math.pow(q, p.a) * Math.pow(1 - q, p.b) / norm;
          } else if (u < W + R) {
            x[m] -= amp * p.reb * Math.sin(Math.PI * (u - W) / R);
          }
        }
      }
      xs.push(x);
    }
    // Shared scale: the summed engine waveform (without DC) peaks at 1.
    var mean = 0, peak = 0;
    for (m = 0; m < M; m++) { var s = 0; for (b = 0; b < xs.length; b++) s += xs[b][m]; mean += s; }
    mean /= M;
    for (m = 0; m < M; m++) {
      var s2 = -mean;
      for (b = 0; b < xs.length; b++) s2 += xs[b][m];
      if (Math.abs(s2) > peak) peak = Math.abs(s2);
    }
    var scale = 2 / M / (peak || 1);
    var cosT = new Float32Array(M), sinT = new Float32Array(M);
    for (m = 0; m < M; m++) { cosT[m] = Math.cos(2 * Math.PI * m / M); sinT[m] = Math.sin(2 * Math.PI * m / M); }
    var waves = [];
    for (b = 0; b < xs.length; b++) {
      var re = new Float32Array(H + 1), im = new Float32Array(H + 1), xb = xs[b];
      for (n = 1; n <= H; n++) {
        var sr = 0, si = 0, k = 0;
        for (m = 0; m < M; m++) {
          sr += xb[m] * cosT[k];
          si += xb[m] * sinT[k];
          k = (k + n) & (M - 1);
        }
        re[n] = sr * scale;
        im[n] = si * scale;
      }
      waves.push(ctx.createPeriodicWave(re, im, { disableNormalization: true }));
    }
    c.waves[d.id] = waves;
    return waves;
  }

  function sawWave(ctx, c) {
    if (c.saw) return c.saw;
    var H = 64, re = new Float32Array(H + 1), im = new Float32Array(H + 1);
    for (var n = 1; n <= H; n++) im[n] = 1 / n;
    c.saw = ctx.createPeriodicWave(re, im);
    return c.saw;
  }

  function gearRatios(d) {
    var n = d.gears, r = new Float64Array(n), v1 = d.first * V_GEAR_TOP;
    for (var i = 0; i < n; i++) {
      var vMax = n > 1 ? v1 * Math.pow(V_GEAR_TOP / v1, i / (n - 1)) : V_GEAR_TOP;
      r[i] = d.redline / vMax;   // rpm per m/s
    }
    return r;
  }

  function hold(p, t) {
    if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t);
    else p.cancelScheduledValues(t);
  }

  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

  // Per-frame param writer: skips values that did not move, so idle frames cost nothing.
  function automator() {
    var ps = [], last = [], now = 0;
    return {
      add: function (p) { ps.push(p); last.push(NaN); return ps.length - 1; },
      at: function (t) { now = t; },
      put: function (i, v, tc) {
        var l = last[i];
        if (Math.abs(v - l) <= Math.abs(l) * 1e-4 + 1e-6) return;
        last[i] = v;
        ps[i].setTargetAtTime(v, now, tc);
      }
    };
  }

  // Node factory that remembers everything it makes so stop() can release it.
  function kit(ctx) {
    var nodes = [], srcs = [];
    return {
      nodes: nodes, srcs: srcs,
      gain: function (v, to) {
        var g = ctx.createGain(); g.gain.value = v; nodes.push(g);
        if (to) g.connect(to);
        return g;
      },
      filt: function (type, f, q, db, to) {
        var b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f;
        if (q != null) b.Q.value = q;
        if (db) b.gain.value = db;
        nodes.push(b);
        if (to) b.connect(to);
        return b;
      },
      loop: function (buf, offset) {
        var s = ctx.createBufferSource(); s.buffer = buf; s.loop = true;
        s.__off = offset % buf.duration; srcs.push(s);
        return s;
      },
      osc: function (type, freq) {
        var o = ctx.createOscillator();
        if (typeof type === 'string') o.type = type; else o.setPeriodicWave(type);
        o.frequency.value = freq || 0; srcs.push(o);
        return o;
      },
      constant: function (v) {
        var c = ctx.createConstantSource(); c.offset.value = v; srcs.push(c);
        return c;
      },
      shaper: function (curve, to) {
        var w = ctx.createWaveShaper(); w.curve = curve; w.oversample = '2x'; nodes.push(w);
        if (to) w.connect(to);
        return w;
      },
      delay: function (sec) {
        var dl = ctx.createDelay(0.1); dl.delayTime.value = sec; nodes.push(dl);
        return dl;
      },
      start: function (t) {
        for (var i = 0; i < srcs.length; i++) {
          if (srcs[i].__off != null) srcs[i].start(t, srcs[i].__off); else srcs[i].start(t);
        }
      },
      release: function () {
        var i;
        for (i = 0; i < srcs.length; i++) {
          try { srcs[i].stop(); } catch (e) { /* already stopped */ }
          try { srcs[i].disconnect(); } catch (e) { /* not connected */ }
        }
        for (i = 0; i < nodes.length; i++) {
          try { nodes[i].disconnect(); } catch (e) { /* not connected */ }
        }
      }
    };
  }

  // Tyre roll and wind. Tyre rises with speed, wind with speed squared.
  function buildRoad(K, C, out, A) {
    var road = K.gain(1, out);
    var noise = K.loop(C.white, 1.13);
    var tyBP = K.filt('bandpass', 120, 0.7);
    var tyLP = K.filt('lowpass', 1100, 0.7);
    var tyTex = K.gain(1);
    var tyAmp = K.gain(0, road);
    noise.connect(tyBP); tyBP.connect(tyLP); tyLP.connect(tyTex); tyTex.connect(tyAmp);
    var tex = K.loop(C.mid, Math.random() * 5), texG = K.gain(0.35);
    tex.connect(texG); texG.connect(tyTex.gain);
    var wiBP = K.filt('bandpass', 500, 0.5);
    var wiTex = K.gain(1);
    var wiAmp = K.gain(0, road);
    noise.connect(wiBP); wiBP.connect(wiTex); wiTex.connect(wiAmp);
    var gust = K.loop(C.slow, Math.random() * 8), gustG = K.gain(0.3);
    gust.connect(gustG); gustG.connect(wiTex.gain);
    return {
      sTA: A.add(tyAmp.gain), sTF: A.add(tyBP.frequency),
      sWA: A.add(wiAmp.gain), sWF: A.add(wiBP.frequency)
    };
  }

  function roadSet(A, R, v) {
    var x = v / V_TOP;
    A.put(R.sTA, 0.36 * Math.pow(x, 0.9), 0.05);
    A.put(R.sTF, 90 + 3.2 * v, 0.05);
    A.put(R.sWA, 0.13 * x * x, 0.05);
    A.put(R.sWF, 400 + 14 * v, 0.05);
  }

  function fadeOut(ctx, K, out) {
    var t = ctx.currentTime;
    hold(out.gain, t);
    out.gain.setTargetAtTime(0, t, 0.04);
    setTimeout(K.release, 400);
  }

  // ---------------------------------------------------------------------------
  // The engine
  // ---------------------------------------------------------------------------
  function build(ctx, d, dest) {
    var C = store(ctx), K = kit(ctx), A = automator();
    var b, i;

    var out = K.gain(0); out.connect(dest);
    var trim = K.gain(d.trim, out);
    var engAmp = K.gain(0.3, trim);
    var cut = K.gain(1, engAmp);

    var cyc = K.constant(d.idle / (60 * d.revs));       // engine cycles per second
    function track(mult, param) { var g = K.gain(mult); cyc.connect(g); g.connect(param); return g; }

    var white = K.loop(C.white, 0);
    var jit = K.loop(C.slow, Math.random() * 8), jitG = K.gain(d.jitter);
    jit.connect(jitG);
    var rough = K.loop(C.fast, Math.random() * 4), roughG = K.gain(d.rough);
    rough.connect(roughG);

    var lopeO = K.osc('sine'), lopeG = K.gain(0);
    track(d.lope[1], lopeO.frequency); lopeO.connect(lopeG);
    var halfG = null;
    if (d.half) {
      var halfO = K.osc('sine');
      halfG = K.gain(d.half);
      track(d.cyl / 2, halfO.frequency); halfO.connect(halfG);
    }

    // Exhaust banks: pulse train, then a resonant pipe (feedback comb with a damped loop).
    var pre = K.gain(0.5);
    var waves = engineWaves(ctx, C, d);
    var gasBP = K.filt('bandpass', d.gas[1], d.gas[2]), gasN = K.gain(0.5);
    white.connect(gasBP); gasBP.connect(gasN);
    var pipeIn = [], bankAmp = [];
    for (b = 0; b < d.banks.length; b++) {
      var bk = d.banks[b];
      var o = K.osc(waves[b]);
      cyc.connect(o.frequency); jitG.connect(o.detune);
      var amp = K.gain(1);
      o.connect(amp);
      roughG.connect(amp.gain); lopeG.connect(amp.gain);
      if (halfG) halfG.connect(amp.gain);
      var pin = K.gain(1, pre);
      amp.connect(pin);
      var dl = K.delay(bk.pipe / 1000), plp = K.filt('lowpass', d.pipeLP, 0.5), fb = K.gain(bk.fb);
      pin.connect(dl); dl.connect(plp); plp.connect(fb); fb.connect(dl);
      plp.connect(K.gain(d.wet, pre));
      var drift = K.gain(bk.pipe / 1000 * 0.006);
      jit.connect(drift); drift.connect(dl.delayTime);
      // exhaust gas hiss that bursts with every pulse of this bank
      var gasAmp = K.gain(0, pin), gasMod = K.gain(d.gas[0]);
      gasN.connect(gasAmp); o.connect(gasMod); gasMod.connect(gasAmp.gain);
      pipeIn.push(pin); bankAmp.push(amp);
    }

    var drive = K.gain(d.drive);
    pre.connect(drive);
    var sh = K.shaper(softClip(C, d.k, d.bias));
    drive.connect(sh);
    var body = K.filt('lowpass', d.lp[0], d.lpQ);
    sh.connect(body);
    track(d.lp[2] * d.cyl, body.frequency);
    var node = body;
    for (i = 0; i < d.eq.length; i++) {
      var e = d.eq[i], f = K.filt(e[0], e[1], e[2], e[3]);
      node.connect(f); node = f;
    }
    var hp = K.filt('highpass', 28, 0.7, 0, cut);
    node.connect(hp);

    // Intake roar, follows the pedal.
    var inBP = K.filt('bandpass', d.intake[1], d.intake[3]), inAmp = K.gain(0, cut);
    white.connect(inBP); track(d.intake[2] * d.cyl, inBP.frequency); inBP.connect(inAmp);

    // High wail layer (the V12).
    var wailAmp = null;
    if (d.wail) {
      var wo = K.osc(sawWave(ctx, C)), wbp = K.filt('bandpass', 0, d.wail.q);
      track(d.wail.mult, wo.frequency); jitG.connect(wo.detune);
      track(d.wail.bp, wbp.frequency);
      wailAmp = K.gain(0, pre);
      wo.connect(wbp); wbp.connect(wailAmp);
    }

    // Pops and crackles: a noise crack plus a low thump, one voice reused for every pop.
    var popBP = K.filt('bandpass', 600, 1.0), popN = K.gain(4);
    white.connect(popBP); popBP.connect(popN);
    var thump = K.osc('sine', 62), thumpG = K.gain(0.4);
    thump.connect(thumpG);
    var popAmp = K.gain(0);
    popN.connect(popAmp); thumpG.connect(popAmp);
    var popSh = K.shaper(softClip(C, 2, 0));
    popAmp.connect(popSh);
    popSh.connect(K.gain(d.pops.level, trim));
    popAmp.connect(K.gain(0.35, pipeIn[0]));

    // Gearbox clunk.
    var clBP = K.filt('bandpass', 170, 3.5), clN = K.gain(8), clAmp = K.gain(0, trim);
    white.connect(clBP); clBP.connect(clN); clN.connect(clAmp);

    // Turbo: whistle plus spool air, and a blow-off valve.
    var T = d.turbo, tO, tAmp, spBP, bovAmp, bovBP;
    if (T) {
      tO = K.osc('sine', T.lo); jitG.connect(tO.detune);
      spBP = K.filt('bandpass', T.lo / 2, 2.5);
      var spN = K.gain(3);
      tAmp = K.gain(0, trim);
      white.connect(spBP); spBP.connect(spN); spN.connect(tAmp); tO.connect(tAmp);
      var bovHP = K.filt('highpass', 900, 0.7);
      bovBP = K.filt('bandpass', 4000, 0.9);
      bovAmp = K.gain(0, trim);
      white.connect(bovHP); bovHP.connect(bovBP); bovBP.connect(bovAmp);
    }

    var R = buildRoad(K, C, out, A);

    var sCyc = A.add(cyc.offset), sEng = A.add(engAmp.gain), sDrv = A.add(drive.gain);
    var sBody = A.add(body.frequency), sIn = A.add(inAmp.gain), sLope = A.add(lopeG.gain);
    var sHalf = halfG ? A.add(halfG.gain) : -1, sJit = A.add(jitG.gain), sGas = A.add(gasN.gain);
    var sWail = wailAmp ? A.add(wailAmp.gain) : -1;
    var sEven = d.even && d.banks.length > 1 ? A.add(bankAmp[1].gain) : -1;
    var sTf = T ? A.add(tO.frequency) : -1, sSp = T ? A.add(spBP.frequency) : -1, sTa = T ? A.add(tAmp.gain) : -1;

    var ts = ctx.currentTime;
    K.start(ts);
    out.gain.setValueAtTime(0, ts);
    out.gain.setTargetAtTime(1, ts, 0.06);

    var ratios = gearRatios(d), RL = d.redline, P = d.pops;
    var rpm = d.idle, gear = 1, gasF = 0, gasS = 0, load = 0.3, boost = 0, prevGas = 0;
    var liftT = -99, shiftT = -99, bovT = -99, lastT = 0, started = false, dead = false;

    function pop(t, big, scale) {
      var a = (big ? 0.75 + 0.25 * Math.random() : 0.2 + 0.25 * Math.random()) * scale;
      var dec = big ? 0.018 + 0.02 * Math.random() : 0.004 + 0.007 * Math.random();
      popBP.frequency.setValueAtTime(big ? 250 + 500 * Math.random() : 900 + 1600 * Math.random(), t);
      thumpG.gain.setValueAtTime(big ? 0.45 : 0.08, t);
      var g = popAmp.gain;
      hold(g, t);
      g.linearRampToValueAtTime(a, t + 0.0015);
      g.setTargetAtTime(0, t + 0.0015, dec);
    }

    function clunk(t, k) {
      var g = clAmp.gain;
      hold(g, t);
      g.linearRampToValueAtTime(d.shift.clunk * k, t + 0.002);
      g.setTargetAtTime(0, t + 0.002, 0.02);
    }

    function bov(t, strength) {
      if (t - bovT < 0.35) return;
      bovT = t;
      var g = bovAmp.gain, f = bovBP.frequency;
      hold(g, t);
      g.linearRampToValueAtTime(T.bov * Math.min(1, strength + 0.2), t + 0.012);
      g.setTargetAtTime(0, t + 0.06, 0.12);
      hold(f, t);
      f.setValueAtTime(5200, t);
      f.setTargetAtTime(1600, t + 0.01, 0.16);
    }

    function upshift(t) {
      shiftT = t;
      var g = cut.gain;
      hold(g, t);
      g.setTargetAtTime(d.shift.cut, t, 0.008);
      g.setTargetAtTime(1, t + d.shift.dur, 0.03);
      clunk(t, 1);
      if (d.shift.pop && gasF > 0.5) pop(t + d.shift.dur * 0.4, false, d.shift.pop * 2);
      if (T && boost > 0.35) { bov(t, boost * 0.7); boost *= 0.55; }
    }

    function downshift(t, braking) {
      shiftT = t;
      clunk(t, 0.6);
      if (braking && Math.random() < 0.6) pop(t + 0.03, Math.random() < 0.4, 0.6);
    }

    function set(s, at) {
      if (dead) return;
      var now = at === undefined ? ctx.currentTime : at;
      var first = !started, dt = first ? 0 : now - lastT;
      if (dt < 0) dt = 0; else if (dt > 0.1) dt = 0.1;
      lastT = now; started = true;
      A.at(now);

      var v = +s.speed || 0; if (v < 0) v = 0;
      var th = +s.throttle || 0; if (th > 1) th = 1; else if (th < -1) th = -1;
      var gas = th > 0 ? th : 0, brake = th < 0 ? -th : 0;

      gasF += (gas - gasF) * (1 - Math.exp(-dt / 0.1));
      // quick to press, slow to forget, so a tap off the gas does not hunt gears
      gasS += (gas - gasS) * (1 - Math.exp(-dt / (gas > gasS ? 0.15 : 0.7)));
      var loadT = gas > 0 ? 0.3 + 0.7 * gas : 0.3 * (1 - brake);
      load += (loadT - load) * (1 - Math.exp(-dt / 0.08));

      if (prevGas > 0.5 && gas <= 0.5) {
        liftT = now;
        if (T && boost > 0.3) bov(now, boost);
      }
      prevGas = gas;

      // Gear choice from speed, with hysteresis.
      var since = now - shiftT, wheelNow = v * ratios[gear - 1];
      var braking = brake > 0.1;
      var up = braking ? RL * 0.97 : RL * (0.62 + 0.35 * gasS);
      var down = braking ? RL * 0.5 : RL * (0.3 + 0.16 * gasS);
      var gap = wheelNow > RL ? 0.08 : (braking ? 0.18 : 0.25);
      if (since > gap) {
        if (gear < d.gears && wheelNow > up) { gear++; upshift(now); }
        else if (gear > 1 && wheelNow < down && v * ratios[gear - 2] < Math.min(up, RL * 0.92)) { gear--; downshift(now, braking); }
      }

      var target = v * ratios[gear - 1];
      if (gear === 1) {
        var launch = d.idle + gasF * (RL * 0.5 - d.idle);   // clutch slip off the line
        if (target < launch) target = launch;
      }
      if (target < d.idle) target = d.idle;
      if (target > RL * 1.01) target = RL * 1.01;
      var tau = now - shiftT < 0.15 ? 0.045 : (target > rpm ? 0.1 : 0.14);
      if (first && v > 0) {
        // joining a car that is already moving: the gear that speed would be in, at once
        while (gear < d.gears && v * ratios[gear - 1] > up) gear++;
        target = Math.max(d.idle, Math.min(RL * 1.01, v * ratios[gear - 1]));
        rpm = target;
      } else rpm += (target - rpm) * (1 - Math.exp(-dt / tau));

      var f = rpm / RL;
      A.put(sCyc, rpm / (60 * d.revs), 0.012);
      A.put(sEng, (0.35 + 0.65 * load) * (0.6 + 0.4 * f), 0.04);
      A.put(sDrv, d.drive * (0.55 + 0.45 * load), 0.05);
      A.put(sBody, d.lp[0] + d.lp[1] * load * (0.4 + 0.6 * f), 0.05);
      A.put(sIn, d.intake[0] * (0.1 + 0.9 * gasF) * (0.2 + 0.8 * f), 0.05);
      var idleness = clamp01(1 - (rpm - d.idle) / (0.25 * RL));
      A.put(sLope, d.lope[0] * idleness * (1 - 0.6 * load), 0.08);
      if (sHalf >= 0) A.put(sHalf, d.half * (0.5 + 0.5 * (1 - f)) * (1 + 0.8 * (1 - load)), 0.08);
      A.put(sJit, d.jitter * (1 - 0.6 * f), 0.1);
      A.put(sGas, 0.3 + 0.7 * load, 0.05);
      if (sEven >= 0) A.put(sEven, 1 + d.even * (d.banks[0].amp / d.banks[1].amp - 1) * f * load, 0.08);
      if (sWail >= 0) A.put(sWail, d.wail.level * (0.2 + 0.8 * load) * Math.pow(f, 1.5), 0.05);

      if (T) {
        var bT = gasF > 0.5 ? clamp01((f - 0.18) / 0.5) * gasF : 0;
        boost += (bT - boost) * (1 - Math.exp(-dt / (bT > boost ? 0.55 : 0.15)));
        var tf = T.lo + (T.hi - T.lo) * boost;
        A.put(sTf, tf, 0.03);
        A.put(sSp, tf * 0.5, 0.03);
        A.put(sTa, T.level * Math.pow(boost, 1.5) * (0.35 + 0.65 * gasF), 0.05);
      }

      // Overrun pops after a lift, thinning out over a second or two.
      if (gas <= 0.5 && f > 0.33) {
        var ago = now - liftT;
        if (ago < P.win) {
          var rate = P.rate * Math.exp(-ago / P.decay) * f;
          if (Math.random() < rate * dt) pop(now + Math.random() * dt, Math.random() < P.big, 1);
        }
      }

      roadSet(A, R, v);
    }

    function stop() {
      if (dead) return;
      dead = true;
      fadeOut(ctx, K, out);
    }

    return { id: d.id, set: set, stop: stop, out: out };
  }

  /* The heavy part of make() (the noise loops and the engine's waves), done ahead so a race never waits for it. */
  function prepare(ctx, id) {
    var C = store(ctx);
    engineWaves(ctx, C, defOf(id));
  }

  function make(ctx, id, dest) {
    return build(ctx, defOf(id), dest || ctx.destination);
  }

  root.SwimEngines = { ids: DEFS.map(function (x) { return x.id; }), prepare: prepare, make: make };
})(typeof window !== 'undefined' ? window : this);
