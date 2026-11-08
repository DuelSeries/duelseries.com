/* ─── Swim: the engines ───────────────────────────────────────────────────────
  Real recordings of each car's own engine (Owen 2026-11-08: "a different sound for every single vehicle ...
  identical to what they sound like in real life ... dial in the backfiring too"). One small mono file per engine
  in public/audio/swim (d.sample): an idle, the engine held at a few rpm on and off the throttle, and its own
  exhaust bangs, all cut from field recordings under CC0 or CC BY, credited in public/vendor/models/swim/CREDITS.txt
  and linked from the waiting screen. The files are made by a script from those recordings (each piece held at one
  pitch and looped, levelled against the others); the rpm of every loop is written next to it below.
  Ten engines, one per car (shared/swimLooks.js): turbo4, v8, inline6, i6jz, v6tt, v8sc, v8c8, flat6, v10, v8ft.
  The R35 (v6tt) has no recording under an open licence, so it keeps the synthesized voice built here in code from
  oscillators, noise and filters; that voice is also every car's fallback until its file is in (or if it never
  arrives).

    window.SwimEngines = {
      ids: ['v8', 'turbo4', 'flat6', 'inline6', 'v10', 'i6jz', 'v6tt', 'v8sc', 'v8c8', 'v8ft'],
      prepare(ctx, id)        fetch and decode the car's recording ahead of time (or work out the synthesized
                              voice's waves), once per context
      ready(ctx, id) -> Promise<boolean>   true once the recording is decoded, false if it failed or has none
      make(ctx, id, dest) -> engine        the recorded voice when its file is in, else the synthesized one
    }

  engine.set({ speed, throttle, rev }, at)
      Call once per animation frame.
      speed     metres per second, 0 to about 97 (350 km/h)
      throttle  -1 brake, 0 lift off, 1 gas (values in between work too)
      rev       true on the start line: out of gear, the gas only revs it (speed is 0)
      at        optional AudioContext time to schedule for; defaults to ctx.currentTime
  engine.gear()     the gear it is in (1 up), 0 on the start line (neutral)
  engine.rev()      rpm as a share of the redline, 0 to about 1
  engine.listen(fn) fn(kind, t, big) for 'up' and 'down' (a shift, on the beat it is heard) and 'pop'
                    (a backfire bang, at its audio time t), so the page can lurch the car and light a flame
  BACKFIRE: lifting off from high revs (in a race or revving on the start line) always fires a run of bangs,
  3 at about half the redline up to 7 at the redline (a recorded car: up to sample.bangs of its own), over about
  a second, scheduled a frame ahead at a time so nothing later cancels them.
  SHIFTS: each engine shifts in its own voice (shift.style): the V8 a heavy clunk and a burble, the V12 a
  quick crisp blip, the turbo four a blow-off pssh every upshift; a downshift is a softer blip.
  engine.stop()     fade out and release every node
  engine.out        the engine's output GainNode
  engine.real       true when it is the recorded voice

  The engine works out its own gear and rpm from speed. set() allocates
  nothing apart from the AudioParam automation events it schedules (and, for the recorded voice, one short
  one-shot source per backfire bang); all other nodes are built once in make() and reused. */
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
      pops: { rate: 16, decay: 0.8, win: 2.0, big: 0.35, level: 1.0 },
      shift: { cut: 0.3, dur: 0.11, clunk: 0.45, pop: 0.25, style: 'burble' },
      turbo: null,
      sample: { url: '/audio/swim/v8.mp3', trim: 2.0, bangs: 5, popLevel: 0.42, maxRate: 1.6,
        loops: [['idle', 846, 0.1500, 1.1351], ['on', 2700, 1.4851, 0.5778], ['on', 3300, 2.2628, 0.4364], ['on', 4000, 2.8992, 0.5700], ['on', 4700, 3.6692, 0.5872], ['on', 5500, 4.4564, 0.5891], ['off', 3200, 5.2455, 0.4500], ['off', 3900, 5.8955, 0.4308]],
        pops: [[6.4663, 0.1700, 1], [6.7163, 0.1600, 1], [6.9563, 0.1400, 0], [7.1763, 0.1600, 1], [7.4163, 0.1400, 0]] },
      trim: 0.358
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
      pops: { rate: 7, decay: 0.6, win: 1.2, big: 0.25, level: 0.85 },
      shift: { cut: 0.25, dur: 0.1, clunk: 0.3, pop: 0.15, style: 'pssh' },
      turbo: { lo: 2400, hi: 6400, level: 0.05, bov: 0.55 },
      sample: { url: '/audio/swim/turbo4.mp3', trim: 2.0, bangs: 4, popLevel: 0.4, maxRate: 2.3,
        loops: [['idle', 1491, 0.1500, 0.9658], ['on', 2400, 1.3158, 0.4500], ['on', 2900, 1.9658, 0.4966], ['on', 3200, 2.6624, 0.4500]],
        pops: [[3.2524, 0.1400, 1], [3.4724, 0.1400, 1], [3.6924, 0.1400, 0], [3.9124, 0.1400, 1], [4.1324, 0.1600, 1]] },
      trim: 0.288
    },
    {
      id: 'flat6',
      cyl: 6, revs: 2, idle: 950, redline: 9000, gears: 7, first: 0.27,
      // Two banks of three, each firing evenly; the bank-to-bank difference gives the howl.
      banks: [
        { slots: [0, 2, 4], amp: 1.0, amps: [1, 0.96, 1.02], pipe: 6.8, fb: 0.4 },
        { slots: [1, 3, 5], amp: 0.84, amps: [1, 1.03, 0.95], pipe: 7.9, fb: 0.38 }
      ],
      pulse: { w: 0.62, a: 1.1, b: 2.0, reb: 0.25, rw: 0.6 },
      pipeLP: 3600, wet: 0.7,
      drive: 1.3, k: 2.3, bias: 0.06,
      lp: [650, 1600, 3.5], lpQ: 1.0,
      eq: [['peaking', 700, 1.0, 3], ['peaking', 2300, 1.1, 3.5], ['highshelf', 6000, 0.7, -3]],
      lope: [0.08, 0.5], half: 0.12, jitter: 8, rough: 0.15,
      gas: [0.6, 2200, 0.8],
      intake: [0.5, 350, 1.2, 1.0],
      wail: { mult: 3, bp: 12, q: 2.2, level: 0.35 },
      pops: { rate: 7, decay: 0.6, win: 1.3, big: 0.25, level: 0.75 },
      shift: { cut: 0.35, dur: 0.08, clunk: 0.2, pop: 0.3, style: 'blip' },
      turbo: null,
      sample: { url: '/audio/swim/flat6.mp3', trim: 2.0, bangs: 5, popLevel: 0.38, maxRate: 1.75,
        loops: [['idle', 658, 0.1500, 0.7298], ['on', 2265, 1.0798, 0.4238], ['on', 2883, 1.7036, 0.4579], ['on', 5274, 2.3615, 0.4550], ['on', 4323, 3.0165, 0.4719], ['on', 4292, 3.6885, 0.4753], ['on', 5077, 4.3638, 0.3073]],
        pops: [[4.8111, 0.1600, 1], [5.0511, 0.1400, 0], [5.2711, 0.1400, 1]] },
      trim: 0.375
    },
    {
      id: 'inline6',
      // A straight six: one bank, perfectly even, silky; a light twin-turbo whistle on top.
      cyl: 6, revs: 2, idle: 800, redline: 7400, gears: 7, first: 0.28,
      banks: [
        { slots: [0, 1, 2, 3, 4, 5], amp: 1.0, amps: [1, 0.97, 1.02, 0.98, 1.01, 0.96], skew: [0, 0.01, -0.01, 0.005, 0, -0.005], pipe: 5.8, fb: 0.4 }
      ],
      pulse: { w: 0.58, a: 1.0, b: 2.2, reb: 0.2, rw: 0.55 },
      pipeLP: 3800, wet: 0.65,
      drive: 1.15, k: 2.0, bias: 0.05,
      lp: [600, 1500, 3.2], lpQ: 0.9,
      eq: [['lowshelf', 150, 0.7, 2], ['peaking', 900, 1.0, 2.5], ['highshelf', 5500, 0.7, -3]],
      lope: [0.04, 0.5], half: 0.05, jitter: 6, rough: 0.1,
      gas: [0.5, 2400, 0.75],
      intake: [0.55, 320, 1.2, 1.0],
      wail: { mult: 6, bp: 14, q: 2.0, level: 0.18 },
      pops: { rate: 6, decay: 0.55, win: 1.1, big: 0.2, level: 0.7 },
      shift: { cut: 0.3, dur: 0.09, clunk: 0.25, pop: 0.2, style: 'pssh' },
      turbo: { lo: 2000, hi: 5600, level: 0.035, bov: 0.4 },
      sample: { url: '/audio/swim/inline6.mp3', trim: 2.05, bangs: 5, popLevel: 0.36, maxRate: 1.6,
        loops: [['idle', 1870, 0.1500, 0.7058], ['on', 2565, 1.0558, 0.3275], ['on', 5612, 1.5833, 0.1711], ['on', 4765, 1.9543, 0.1763], ['on', 5801, 2.3306, 0.1655]],
        pops: [[2.6361, 0.1200, 1], [2.8361, 0.1200, 1], [3.0361, 0.1200, 1], [3.2361, 0.1200, 0], [3.4361, 0.1200, 0]] },
      trim: 0.36
    },
    {
      id: 'v10',
      // Two banks of five, even fire: a hard, rising shriek to 8,700 rpm.
      cyl: 10, revs: 2, idle: 1000, redline: 8700, gears: 7, first: 0.26,
      banks: [
        { slots: [0, 2, 4, 6, 8], amp: 1.0, amps: [1, 0.94, 1.04, 0.92, 1.02], skew: [0, 0.02, -0.02, 0.01, 0], pipe: 5.0, fb: 0.34 },
        { slots: [1, 3, 5, 7, 9], amp: 0.88, amps: [0.96, 1.03, 0.94, 1.05, 0.98], skew: [0.01, 0, 0.02, -0.01, 0.01], pipe: 5.8, fb: 0.31 }
      ],
      pulse: { w: 0.55, a: 1.1, b: 2.1, reb: 0.18, rw: 0.5 },
      pipeLP: 4600, wet: 0.6,
      drive: 1.15, k: 2.0, bias: 0.06,
      lp: [800, 1900, 3.2], lpQ: 0.85,
      eq: [['lowshelf', 150, 0.7, 2], ['peaking', 1500, 0.9, 3.5], ['highshelf', 6000, 0.7, -3]],
      lope: [0.06, 0.5], half: 0.1, jitter: 7, rough: 0.14,
      gas: [0.55, 2700, 0.7],
      intake: [0.5, 380, 1.3, 1.0],
      wail: { mult: 10, bp: 20, q: 2.4, level: 0.42 },
      pops: { rate: 6, decay: 0.5, win: 1.0, big: 0.22, level: 0.8 },
      shift: { cut: 0.38, dur: 0.06, clunk: 0.22, pop: 0.35, style: 'blip' },
      turbo: null,
      sample: { url: '/audio/swim/v10.mp3', trim: 2.0, bangs: 7, popLevel: 0.35, maxRate: 1.65,
        loops: [['idle', 976, 0.1500, 1.1068], ['on', 1400, 1.4568, 0.5143], ['on', 2040, 2.1711, 0.5882], ['on', 4000, 2.9593, 0.1800], ['on', 5000, 3.3393, 0.5760], ['on', 5450, 4.1153, 0.5945]],
        pops: [[4.8498, 0.1887, 1], [5.1185, 0.1440, 1], [5.3425, 0.1493, 0], [5.5718, 0.1740, 1], [5.8258, 0.1600, 1], [6.0658, 0.1627, 1], [6.3085, 0.1213, 0], [6.5098, 0.1400, 0]] },
      trim: 0.42
    },
    /* The cars Owen picked on 2026-11-08 (ten real cars): the 2JZ six, the twin-turbo V6, the supercharged V8, the
       mid-engine V8 and the flat-plane twin-turbo V8, built the same way as the rest. */
    {
      id: 'i6jz',
      // A big straight six on one huge turbo (the 2JZ sound): smooth and deep low down, then a long rising
      // whistle and a heavy whoosh of boost, a loud flutter on every lift.
      cyl: 6, revs: 2, idle: 850, redline: 7200, gears: 6, first: 0.29,
      banks: [
        { slots: [0, 1, 2, 3, 4, 5], amp: 1.0, amps: [1, 0.95, 1.03, 0.97, 1.02, 0.94], skew: [0, 0.015, -0.01, 0.01, -0.005, 0.005], pipe: 6.9, fb: 0.44 }
      ],
      pulse: { w: 0.62, a: 1.05, b: 2.1, reb: 0.24, rw: 0.6 },
      pipeLP: 3000, wet: 0.7,
      drive: 1.35, k: 2.2, bias: 0.07,
      lp: [520, 1350, 3.0], lpQ: 0.95,
      eq: [['lowshelf', 140, 0.7, 3], ['peaking', 750, 1.0, 2.5], ['highshelf', 5200, 0.7, -3]],
      lope: [0.06, 0.5], half: 0.06, jitter: 8, rough: 0.13,
      gas: [0.6, 2100, 0.8],
      intake: [0.6, 280, 1.1, 0.9],
      wail: { mult: 6, bp: 12, q: 2.0, level: 0.14 },
      pops: { rate: 9, decay: 0.65, win: 1.4, big: 0.3, level: 0.85 },
      shift: { cut: 0.28, dur: 0.1, clunk: 0.3, pop: 0.2, style: 'pssh' },
      turbo: { lo: 1700, hi: 5000, level: 0.075, bov: 0.75 },
      sample: { url: '/audio/swim/i6jz.mp3', trim: 2.3, bangs: 6, popLevel: 0.42, maxRate: 1.6,
        loops: [['idle', 1611, 0.1500, 0.8941], ['on', 2100, 1.2441, 0.3428], ['on', 3300, 1.7870, 0.6909], ['on', 4300, 2.6779, 0.6977], ['on', 5400, 3.5755, 0.5111], ['on', 6600, 4.2867, 0.5091], ['on', 7900, 4.9958, 0.6987], ['off', 2300, 5.8945, 0.3652], ['off', 3800, 6.4597, 0.3790], ['off', 5600, 7.0387, 0.3857], ['off', 7600, 7.6244, 0.3947]],
        pops: [[8.1591, 0.1800, 1], [8.4191, 0.1800, 1], [8.6791, 0.1600, 1], [8.9191, 0.1600, 0], [9.1591, 0.1700, 1], [9.4091, 0.1700, 1], [9.6591, 0.1700, 0]] },
      trim: 0.34
    },
    {
      id: 'v6tt',
      // A twin-turbo V6, two banks of three: drier and raspier than a six in a row, a brisk whistle and a sharp
      // blow-off between gears.
      cyl: 6, revs: 2, idle: 900, redline: 7100, gears: 6, first: 0.28,
      banks: [
        { slots: [0, 2, 4], amp: 1.0, amps: [1, 0.93, 1.05], skew: [0, 0.02, -0.015], pipe: 5.6, fb: 0.4 },
        { slots: [1, 3, 5], amp: 0.9, amps: [0.97, 1.04, 0.93], skew: [0.01, -0.01, 0.02], pipe: 6.4, fb: 0.38 }
      ],
      pulse: { w: 0.56, a: 0.95, b: 2.3, reb: 0.3, rw: 0.62 },
      pipeLP: 3400, wet: 0.66,
      drive: 1.5, k: 2.5, bias: 0.08,
      lp: [600, 1500, 3.4], lpQ: 1.0,
      eq: [['peaking', 320, 1.0, 2.5], ['peaking', 1600, 1.1, 3], ['highshelf', 5500, 0.7, -3]],
      lope: [0.08, 0.5], half: 0.08, jitter: 9, rough: 0.17,
      gas: [0.7, 2300, 0.8],
      intake: [0.6, 330, 1.2, 0.9],
      wail: { mult: 6, bp: 14, q: 2.2, level: 0.15 },
      pops: { rate: 7, decay: 0.55, win: 1.2, big: 0.25, level: 0.75 },
      shift: { cut: 0.26, dur: 0.08, clunk: 0.25, pop: 0.2, style: 'pssh' },
      turbo: { lo: 2600, hi: 6400, level: 0.05, bov: 0.6 },
      trim: 0.33
    },
    {
      id: 'v8sc',
      // A supercharged cross-plane V8: the muscle burble underneath, and over it the blower's whine, a pitch
      // that climbs with the revs (geared to the crank, so no lag and no whistle-up like a turbo).
      cyl: 8, revs: 2, idle: 800, redline: 6300, gears: 8, first: 0.27,
      banks: [
        { slots: [0, 3, 5, 6], amp: 1.0, amps: [1, 0.92, 1.05, 0.9], skew: [0, 0.03, -0.02, 0.04], pipe: 9.2, fb: 0.44 },
        { slots: [1, 2, 4, 7], amp: 0.82, amps: [0.95, 1, 0.9, 1.05], skew: [0.02, -0.03, 0.01, 0], pipe: 10.8, fb: 0.4 }
      ],
      pulse: { w: 0.95, a: 1.35, b: 2.3, reb: 0.22, rw: 0.6 },
      even: 0.65,
      pipeLP: 1500, wet: 0.75,
      drive: 1.35, k: 2.3, bias: 0.13,
      lp: [360, 880, 3.0], lpQ: 0.9,
      eq: [['lowshelf', 120, 0.7, 6], ['peaking', 90, 1.1, 3], ['peaking', 2400, 0.9, -2]],
      lope: [0.45, 0.5], half: 0.24, jitter: 16, rough: 0.24,
      gas: [0.7, 1300, 0.8],
      intake: [0.45, 170, 0.9, 0.9],
      wail: { mult: 26, bp: 26, q: 7, level: 0.32 },
      pops: { rate: 14, decay: 0.75, win: 1.8, big: 0.35, level: 0.95 },
      shift: { cut: 0.3, dur: 0.12, clunk: 0.5, pop: 0.25, style: 'burble' },
      turbo: null,
      sample: { url: '/audio/swim/v8sc.mp3', trim: 1.8, bangs: 7, popLevel: 0.3, maxRate: 1.6,
        loops: [['idle', 1162, 0.1500, 1.1357], ['on', 2100, 1.4857, 0.5142], ['on', 3000, 2.1999, 0.5200], ['on', 3800, 2.9199, 0.4737], ['on', 4600, 3.5936, 0.5478], ['on', 5400, 4.3414, 0.6000], ['on', 6200, 5.1414, 0.5806]],
        pops: [[5.8621, 0.1800, 1], [6.1221, 0.1600, 1], [6.3621, 0.1600, 1], [6.6021, 0.1600, 1], [6.8421, 0.1400, 0], [7.0621, 0.1400, 0]] },
      trim: 0.33
    },
    {
      id: 'v8c8',
      // A big pushrod V8 behind the seats: cross-plane, but tighter and higher-revving than the muscle car's,
      // more intake bark, a quick crackle on the lift.
      cyl: 8, revs: 2, idle: 900, redline: 6600, gears: 8, first: 0.27,
      banks: [
        { slots: [0, 3, 5, 6], amp: 1.0, amps: [1, 0.95, 1.03, 0.93], skew: [0, 0.02, -0.015, 0.025], pipe: 7.6, fb: 0.4 },
        { slots: [1, 2, 4, 7], amp: 0.86, amps: [0.97, 1, 0.94, 1.03], skew: [0.015, -0.02, 0.01, 0], pipe: 8.8, fb: 0.37 }
      ],
      pulse: { w: 0.85, a: 1.2, b: 2.3, reb: 0.2, rw: 0.58 },
      even: 0.8,
      pipeLP: 2100, wet: 0.72,
      drive: 1.25, k: 2.15, bias: 0.1,
      lp: [440, 1100, 3.2], lpQ: 0.9,
      eq: [['lowshelf', 140, 0.7, 4], ['peaking', 380, 1.0, 2.5], ['peaking', 2600, 0.9, -1]],
      lope: [0.3, 0.5], half: 0.16, jitter: 13, rough: 0.19,
      gas: [0.65, 1600, 0.8],
      intake: [0.6, 220, 1.0, 0.9],
      wail: { mult: 4, bp: 10, q: 2.0, level: 0.12 },
      pops: { rate: 11, decay: 0.65, win: 1.5, big: 0.3, level: 0.9 },
      shift: { cut: 0.32, dur: 0.07, clunk: 0.3, pop: 0.3, style: 'blip' },
      turbo: null,
      sample: { url: '/audio/swim/v8c8.mp3', trim: 2.0, bangs: 6, popLevel: 0.3, maxRate: 1.6,
        loops: [['idle', 1306, 0.1500, 0.9189], ['on', 1894, 1.2689, 0.3168], ['on', 2915, 1.7857, 0.4529], ['on', 3942, 2.4386, 0.1827], ['on', 5934, 2.8213, 0.1820]],
        pops: [[3.1433, 0.1600, 1], [3.3833, 0.1200, 1], [3.5833, 0.1200, 0], [3.7833, 0.1400, 0], [4.0033, 0.1600, 1], [4.2433, 0.1400, 0]] },
      trim: 0.35
    },
    {
      id: 'v8ft',
      // A flat-plane twin-turbo V8: each bank fires evenly, so no burble, a hard rising howl to 8,000 rpm,
      // a soft turbo whistle under it and a crisp blip on each shift.
      cyl: 8, revs: 2, idle: 1000, redline: 8000, gears: 7, first: 0.26,
      banks: [
        { slots: [0, 2, 4, 6], amp: 1.0, amps: [1, 0.95, 1.04, 0.96], skew: [0, 0.015, -0.01, 0.01], pipe: 5.2, fb: 0.35 },
        { slots: [1, 3, 5, 7], amp: 0.9, amps: [0.97, 1.03, 0.95, 1.02], skew: [0.01, -0.01, 0.015, 0], pipe: 5.9, fb: 0.33 }
      ],
      pulse: { w: 0.52, a: 1.1, b: 2.1, reb: 0.18, rw: 0.5 },
      pipeLP: 4400, wet: 0.62,
      drive: 1.15, k: 2.0, bias: 0.06,
      lp: [780, 1850, 3.2], lpQ: 0.85,
      eq: [['lowshelf', 150, 0.7, 2], ['peaking', 1350, 0.9, 3.5], ['highshelf', 6000, 0.7, -3]],
      lope: [0.05, 0.5], half: 0.08, jitter: 7, rough: 0.13,
      gas: [0.55, 2600, 0.7],
      intake: [0.5, 360, 1.3, 1.0],
      wail: { mult: 8, bp: 16, q: 2.4, level: 0.34 },
      pops: { rate: 6, decay: 0.5, win: 1.0, big: 0.22, level: 0.8 },
      shift: { cut: 0.38, dur: 0.06, clunk: 0.22, pop: 0.35, style: 'blip' },
      turbo: { lo: 2400, hi: 6000, level: 0.035, bov: 0.35 },
      sample: { url: '/audio/swim/v8ft.mp3', trim: 2.0, bangs: 6, popLevel: 0.36, maxRate: 1.65,
        loops: [['idle', 980, 0.1500, 0.8570], ['on', 3195, 1.2070, 0.4131], ['on', 2650, 1.8201, 0.4076], ['on', 3700, 2.4276, 0.4216], ['on', 4200, 3.0492, 0.4286], ['on', 4750, 3.6778, 0.4295], ['on', 5200, 4.3073, 0.4385]],
        pops: [[4.8857, 0.1600, 1], [5.1258, 0.1600, 1], [5.3658, 0.1400, 0], [5.5857, 0.1400, 0], [5.8057, 0.1400, 0], [6.0258, 0.1600, 1]] },
      trim: 0.4
    }
  ];

  var BY_ID = {};
  for (var di = 0; di < DEFS.length; di++) BY_ID[DEFS[di].id] = DEFS[di];
  var DEFAULT_ID = 'turbo4';
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
        waves: {}, saw: null, curves: {}, banks: {}
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
  /* THE RECORDED VOICE: the car's own engine, from real recordings (d.sample, CREDITS). Loops of the engine held at one
     rpm each (an idle, then on-throttle loops and, where the recording has them, off-throttle ones), all running at
     once, each at playbackRate = rpm / its own rpm, the two either side of the rpm heard (equal power, on a log rpm
     scale) and the throttle choosing between the on and off sets. With no off-throttle loops of its own, the car's
     on-throttle loops are heard through a lowpass when you lift. Backfires are the car's own bangs, cut from the same
     recordings, each one a short one-shot. */
  function sampledVoice(ctx, K, A, d, buf, into, popOut) {
    var S = d.sample, all = [], on = [], off = [], idle = null, i;
    for (i = 0; i < S.loops.length; i++) {
      var L = S.loops[i];
      var src = K.loop(buf, L[2]);
      src.loopStart = L[2]; src.loopEnd = L[2] + L[3];
      var g = K.gain(0);
      src.connect(g);
      var it = { kind: L[0], rpm: L[1], src: src, g: g, sg: A.add(g.gain), sr: A.add(src.playbackRate), w: 0 };
      all.push(it);
      if (it.kind === 'idle') idle = it; else if (it.kind === 'off') off.push(it); else on.push(it);
    }
    function byRpm(a, b) { return a.rpm - b.rpm; }
    on.sort(byRpm); off.sort(byRpm);
    var onList = (idle ? [idle] : []).concat(on), offList = off.length ? (idle ? [idle] : []).concat(off) : null;
    /* no off-throttle loops: the on loops also feed a lowpass, heard when off the gas */
    var dry = K.gain(1, into), wet = null, wetLP = null;
    if (!offList) {
      wetLP = K.filt('lowpass', 900, 0.6); wet = K.gain(0, into); wetLP.connect(wet);
    }
    for (i = 0; i < all.length; i++) {
      if (all[i] === idle) all[i].g.connect(into);
      else if (all[i].kind === 'off') all[i].g.connect(into);
      else { all[i].g.connect(dry); if (wetLP) all[i].g.connect(wetLP); }
    }
    var sDry = A.add(dry.gain), sWet = wet ? A.add(wet.gain) : -1, sLP = wetLP ? A.add(wetLP.frequency) : -1;
    var lo = S.minRate || 0.72, hi = S.maxRate || 1.6;

    function weigh(list, r, key) {
      var n = list.length, j;
      for (j = 0; j < n; j++) list[j][key] = 0;
      if (!n) return;
      if (r <= list[0].rpm) { list[0][key] = 1; return; }
      if (r >= list[n - 1].rpm) { list[n - 1][key] = 1; return; }
      for (j = 0; j < n - 1 && r >= list[j + 1].rpm; j++) { /* find the pair */ }
      var x = Math.log(r / list[j].rpm) / Math.log(list[j + 1].rpm / list[j].rpm);
      list[j][key] = Math.cos(x * Math.PI / 2);
      list[j + 1][key] = Math.sin(x * Math.PI / 2);
    }

    return {
      sampled: true,
      frame: function (rpm, f, onMix) {
        weigh(onList, rpm, 'wOn');
        if (offList) weigh(offList, rpm, 'wOff');
        var offMix = 1 - onMix;
        for (var k = 0; k < all.length; k++) {
          var it = all[k], w;
          if (offList) w = (it.wOn || 0) * (it.kind === 'off' ? 0 : onMix) + (it.wOff || 0) * (it.kind === 'on' ? 0 : offMix);
          else w = it.wOn || 0;
          if (it === idle && offList) w = (it.wOn || 0) * onMix + (it.wOff || 0) * offMix;
          var rate = rpm / it.rpm;
          A.put(it.sr, rate < lo ? lo : (rate > hi ? hi : rate), 0.012);
          A.put(it.sg, w, 0.03);
        }
        if (!offList) {
          A.put(sDry, Math.sqrt(onMix), 0.04);
          A.put(sWet, Math.sqrt(offMix) * 0.85, 0.04);
          A.put(sLP, 650 + 2600 * f, 0.05);
        }
      },
      /* one of the car's own bangs: a big one for the first of a run, any for the rest */
      pop: function (t, big, scale) {
        var P = S.pops, n = P.length, j, tries = 0;
        if (!n) return;
        do { j = Math.floor(Math.random() * n); } while (big && !P[j][2] && ++tries < 6);
        var s = ctx.createBufferSource(), g = ctx.createGain();
        s.buffer = buf;
        s.playbackRate.value = 0.94 + 0.12 * Math.random();
        g.gain.value = (big ? 0.8 + 0.2 * Math.random() : 0.3 + 0.35 * Math.random()) * scale * (S.popLevel || 1);
        s.connect(g); g.connect(popOut);
        s.onended = function () { try { s.disconnect(); g.disconnect(); } catch (_) {} };
        try { s.start(t, P[j][0], P[j][1]); } catch (_) {}
      }
    };
  }

  function build(ctx, d, dest) {
    var C = store(ctx), K = kit(ctx), A = automator();
    var b, i;
    var bank = d.sample ? loadBank(ctx, d) : null;
    var buf = bank && bank.buf;

    var out = K.gain(0); out.connect(dest);
    var trim = K.gain(buf ? d.sample.trim : d.trim, out);
    var engAmp = K.gain(0.3, trim);
    var cut = K.gain(1, engAmp);
    var white = K.loop(C.white, 0);
    // Gearbox clunk, either voice.
    var clBP = K.filt('bandpass', 170, 3.5), clN = K.gain(8), clAmp = K.gain(0, trim);
    white.connect(clBP); clBP.connect(clN); clN.connect(clAmp);
    if (buf) return run(ctx, d, K, A, out, engAmp, cut, clAmp, sampledVoice(ctx, K, A, d, buf, cut, trim));

    var cyc = K.constant(d.idle / (60 * d.revs));       // engine cycles per second
    function track(mult, param) { var g = K.gain(mult); cyc.connect(g); g.connect(param); return g; }

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

    var sCyc = A.add(cyc.offset), sDrv = A.add(drive.gain);
    var sBody = A.add(body.frequency), sIn = A.add(inAmp.gain), sLope = A.add(lopeG.gain);
    var sHalf = halfG ? A.add(halfG.gain) : -1, sJit = A.add(jitG.gain), sGas = A.add(gasN.gain);
    var sWail = wailAmp ? A.add(wailAmp.gain) : -1;
    var sEven = d.even && d.banks.length > 1 ? A.add(bankAmp[1].gain) : -1;
    var sTf = T ? A.add(tO.frequency) : -1, sSp = T ? A.add(spBP.frequency) : -1, sTa = T ? A.add(tAmp.gain) : -1;
    var boost = 0, bovT = -99;

    function bov(t, strength) {
      if (t - bovT < 0.35) return;
      bovT = t;
      var g = bovAmp.gain, fq = bovBP.frequency;
      hold(g, t);
      g.linearRampToValueAtTime(T.bov * Math.min(1, strength + 0.2), t + 0.012);
      g.setTargetAtTime(0, t + 0.06, 0.12);
      hold(fq, t);
      fq.setValueAtTime(5200, t);
      fq.setTargetAtTime(1600, t + 0.01, 0.16);
    }

    return run(ctx, d, K, A, out, engAmp, cut, clAmp, {
      frame: function (rpm, f, load, gasF, dt) {
        var RL = d.redline;
        A.put(sCyc, rpm / (60 * d.revs), 0.012);
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
      },
      pop: function (t, big, scale) {
        var a = (big ? 0.75 + 0.25 * Math.random() : 0.2 + 0.25 * Math.random()) * scale;
        var dec = big ? 0.018 + 0.02 * Math.random() : 0.004 + 0.007 * Math.random();
        popBP.frequency.setValueAtTime(big ? 250 + 500 * Math.random() : 900 + 1600 * Math.random(), t);
        thumpG.gain.setValueAtTime(big ? 0.45 : 0.08, t);
        var g = popAmp.gain;
        hold(g, t);
        g.linearRampToValueAtTime(a, t + 0.0015);
        g.setTargetAtTime(0, t + 0.0015, dec);
      },
      lift: function (now) { if (T && boost > 0.3) bov(now, boost); },
      blowoff: function (t) { if (T) { bov(t, Math.max(boost, 0.65)); boost *= 0.55; } }
    });
  }

  /* What both voices share: the road, the gears and rpm worked out from speed, the shifts and the backfire runs. */
  function run(ctx, d, K, A, out, engAmp, cut, clAmp, V) {
    var C = store(ctx);
    var R = buildRoad(K, C, out, A);
    var sEng = A.add(engAmp.gain);

    var ts = ctx.currentTime;
    K.start(ts);
    out.gain.setValueAtTime(0, ts);
    out.gain.setTargetAtTime(1, ts, 0.06);

    var ratios = gearRatios(d), RL = d.redline, sh = (V.sampled && d.sample.shift) || d.shift;
    var rpm = d.idle, gear = 1, gasF = 0, gasS = 0, load = 0.3, prevGas = 0;
    var liftT = -99, shiftT = -99, lastT = 0, started = false, dead = false;
    var listener = null, neutral = false, wasNeutral = false;
    /* The backfire run waiting to be heard: audio times and big or not, scheduled a frame ahead at a time. */
    var bfT = new Float64Array(8), bfBig = new Uint8Array(8), bfN = 0, bfI = 0, bfScale = 1;
    var bfMax = V.sampled && d.sample.bangs ? d.sample.bangs : 7, bfMin = Math.min(3, bfMax);
    function fire(k, t, big) { if (listener) { try { listener(k, t, !!big); } catch (_) {} } }
    function backfire(now, f) {
      var n = Math.round(bfMin + (bfMax - bfMin) * clamp01((f - 0.5) / 0.42)), at = now + 0.05;
      bfN = n; bfI = 0; bfScale = 0.9 + 0.35 * clamp01((f - 0.5) / 0.42);
      for (var i = 0; i < n; i++) {
        bfT[i] = at; bfBig[i] = i === 0 || Math.random() < 0.3 + 0.4 * f ? 1 : 0;
        at += (0.95 / n) * (0.6 + 0.8 * Math.random());
      }
    }

    function clunk(t, k) {
      var g = clAmp.gain;
      hold(g, t);
      g.linearRampToValueAtTime(Math.min(0.6, sh.clunk * k), t + 0.002);
      g.setTargetAtTime(0, t + 0.002, 0.02);
    }

    function upshift(t) {
      shiftT = t;
      var g = cut.gain;
      hold(g, t);
      g.setTargetAtTime(sh.cut, t, 0.008);
      g.setTargetAtTime(1, t + sh.dur, 0.03);
      var st = sh.style;
      if (st === 'burble') {                 // V8: a heavy clunk, then the pipes burble through the gap
        clunk(t, 1.3);
        V.pop(t + sh.dur * 0.35, true, 0.55); V.pop(t + sh.dur * 0.8, false, 0.7);
      } else if (st === 'blip') {            // quick and crisp, one sharp crack
        clunk(t, 0.8);
        V.pop(t + sh.dur * 0.4, false, sh.pop * 2.4);
      } else {                               // turbo: the blow-off valve every time
        clunk(t, 1);
        if (V.blowoff) V.blowoff(t);
      }
      fire('up', t);
    }

    function downshift(t, braking) {
      shiftT = t;
      clunk(t, 0.5);                         // softer than an upshift
      if (braking && Math.random() < 0.6) V.pop(t + 0.03, Math.random() < 0.4, 0.6);
      fire('down', t);
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
        if (V.lift) V.lift(now);
        if (rpm / RL > 0.45) backfire(now, rpm / RL);
      }
      prevGas = gas;

      /* On the start line: out of gear, the gas only revs it (the race has not started, the car is still). */
      neutral = !!s.rev;
      if (neutral) {
        gear = 1;
        var free = d.idle + gasF * (RL * 0.93 - d.idle);
        rpm += (free - rpm) * (1 - Math.exp(-dt / (free > rpm ? 0.09 : 0.16)));
      }

      // Gear choice from speed, with hysteresis.
      var since = now - shiftT, wheelNow = neutral ? 0 : v * ratios[gear - 1];
      var leaving = wasNeutral && !neutral;
      wasNeutral = neutral;
      var braking = brake > 0.1;
      var up = braking ? RL * 0.97 : RL * (0.62 + 0.35 * gasS);
      var down = braking ? RL * 0.5 : RL * (0.3 + 0.16 * gasS);
      var gap = wheelNow > RL ? 0.08 : (braking ? 0.18 : 0.25);
      if (leaving) {
        // off the start line at the race's rolling speed: straight into the gear that speed is in, no shifts heard
        gear = 1;
        while (gear < d.gears && v * ratios[gear - 1] > up) gear++;
      } else if (!neutral && since > gap) {
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
      if (neutral) { /* rpm was set above */ }
      else if (first && v > 0) {
        // joining a car that is already moving: the gear that speed would be in, at once
        while (gear < d.gears && v * ratios[gear - 1] > up) gear++;
        target = Math.max(d.idle, Math.min(RL * 1.01, v * ratios[gear - 1]));
        rpm = target;
      } else rpm += (target - rpm) * (1 - Math.exp(-dt / tau));

      var f = rpm / RL;
      A.put(sEng, (0.35 + 0.65 * load) * (0.6 + 0.4 * f), 0.04);
      if (V.sampled) {
        /* the throttle shuts for the length of an upshift, so the off-throttle sound is heard through it */
        var onMix = clamp01((load - 0.3) / 0.7);
        if (now - shiftT < sh.dur) onMix *= 0.25;
        V.frame(rpm, f, onMix);
      } else V.frame(rpm, f, load, gasF, dt);

      // The backfire run after a lift: each bang scheduled when it is under a frame away. Back on the gas ends it.
      if (gas > 0.5) bfI = bfN;
      while (bfI < bfN && bfT[bfI] <= now + 0.05) {
        var bt = Math.max(bfT[bfI], now), big = bfBig[bfI] === 1;
        V.pop(bt, big, bfScale * (big ? 1.25 : 1));
        fire('pop', bt, big);
        bfI++;
      }

      roadSet(A, R, v);
    }

    function stop() {
      if (dead) return;
      dead = true;
      fadeOut(ctx, K, out);
    }

    return { id: d.id, set: set, stop: stop, out: out, real: !!V.sampled,
      gear: function () { return neutral ? 0 : gear; },
      rev: function () { return rpm / RL; },
      listen: function (fn) { listener = typeof fn === 'function' ? fn : null; } };
  }

  /* A car's recordings: fetched and decoded once per AudioContext (they are small), the moment a page asks for the
     engine (prepare), so a race never waits for them. Until they are in (or if they never arrive) the car has its
     synthesized voice. */
  function loadBank(ctx, d) {
    var C = store(ctx), rec = C.banks[d.id];
    if (rec || !d.sample) return rec || null;
    rec = C.banks[d.id] = { buf: null, failed: false, p: null };
    if (typeof fetch !== 'function' || !ctx.decodeAudioData) { rec.failed = true; rec.p = Promise.resolve(null); return rec; }
    rec.p = fetch(d.sample.url).then(function (r) {
      if (!r.ok) throw new Error('engine sound ' + r.status);
      return r.arrayBuffer();
    }).then(function (ab) {
      return new Promise(function (res, rej) {
        var q = ctx.decodeAudioData(ab, res, rej);
        if (q && typeof q.then === 'function') q.then(res, rej);
      });
    }).then(function (b) { rec.buf = b; return b; }, function () { rec.failed = true; return null; });
    return rec;
  }

  /* Get an engine ready ahead of a race: its recordings, or for a car without any (or when they fail) the waves of
     its synthesized voice. ready() is a promise that settles when a car's recordings are in (true) or failed (false). */
  function prepare(ctx, id) {
    var d = defOf(id);
    if (d.sample) { loadBank(ctx, d); return; }
    engineWaves(ctx, store(ctx), d);
  }
  function ready(ctx, id) {
    var d = defOf(id), rec = loadBank(ctx, d);
    if (!rec) return Promise.resolve(false);
    return rec.p.then(function (b) { return !!b; });
  }

  function make(ctx, id, dest) {
    return build(ctx, defOf(id), dest || ctx.destination);
  }

  root.SwimEngines = { ids: DEFS.map(function (x) { return x.id; }), prepare: prepare, ready: ready, make: make,
    sample: function (id) { return BY_ID[id] && BY_ID[id].sample || null; } };
})(typeof window !== 'undefined' ? window : this);
