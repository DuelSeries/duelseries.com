/* ─── Swim: the sound ─────────────────────────────────────────────────────────
   The house Glass sounds (dsSfx.js, dsSfxGame.js) for the moments, and one
   live engine for your own car (swimEngines.js, our own synthesis) on the
   sound engine's context and output (DSSfx.context / output, kept for exactly
   this). No files.

     match found  g.join            countdown  g.tick, g.tick, g.go
     close pass   sw.whoosh         barrier    sw.scrape (spaced out)
     your crash   g.death           their crash / win / lose  g.kill, g.win, g.lose
     losing the gap  g.warn

   swimMain.js calls SwimSound.play(name) for those and SwimSound.frame({ v, pedal, on, rev })
   every animation frame: v is the car being followed (m/s), pedal is -1 brake,
   0 cruise, 1 gas, and on is false off the road (crash, result card, watching),
   which fades the engine out. rev is true on the start line (your own car in the
   countdown): the engine is out of gear and the gas only revs it, speed 0.

   SwimSound.state() is what the engine is doing, for the HUD and the scene: its
   gear (0 on the start line or with no engine running), rpm as a share of the
   redline, and running counts of upshifts, downshifts and backfire bangs, each
   counted when it is heard (one object, reused).

   THE ENGINE is the one picked in Customize (shared/swimLooks.js, kept under
   duel.swim.engine), read each time a race starts; nothing or anything unknown
   is the car's own, the V12. Only ever one engine: the other car is silent (the
   same engine twice risks phasing). It is made when a race starts and let go
   two seconds after it ends, so nothing runs on the audio thread between races;
   its waves are worked out while the page waits, so the start line never waits.

   QUIET: the engine's level is DSSfx.level() (the page's setLevel volume, 0
   while held), times on, and 0 while the tab is hidden, so it follows every
   mute the one-shots follow. DSSfx.hold also suspends the whole context. */
(function (root) {
  'use strict';
  const S = root.DSSfx;
  const quiet = { play() {}, frame() {}, stop() {} };
  if (!S) { root.SwimSound = quiet; return; }
  const { mf } = S;
  const E = root.SwimEngines, L = root.DS_SWIM_LOOKS, doc = root.document;

  S.define({
    'sw.whoosh': [{ o: 'n', d: 0.32, v: 0.16, a: 0.02, e: 0.11, bp: [[500, 3200], 1.3] },
                  { o: 's', f: [mf(84), mf(96)], d: 0.16, v: 0.05, a: 0.01, e: 0.06 },
                  { o: 'fm', f: mf(103), m: 3.5, i: 1.2, at: 0.06, d: 0.3, v: 0.035, e: 0.1 }],
    'sw.scrape': [{ o: 'n', d: 0.14, v: 0.07, hp: 2200, e: 0.05, sh: 1400 }],
  });

  const VOL = 0.35;         // the engine under the one-shots: about as loud as g.go, measured
  const CRUISE = 0.4;       // the pedal left alone still holds the cruise: part throttle, not a lift
  const LET_GO = 2;         // seconds off the road before the engine is let go

  let ctx = null, bus = null, gain = -1, eng = null, engId = '', was = false, offAt = 0, ease = 0, lastT = 0;
  let scrapeAt = 0;
  /* Engine moments waiting to be heard: kind (1 up, 2 down, 3 pop) and audio time, in a small ring. */
  const evK = new Uint8Array(32), evT = new Float64Array(32);
  let evH = 0, evN = 0;
  const ST = { gear: 0, rev: 0, up: 0, down: 0, pops: 0 };
  function onEngine(k, t) {
    if (evN >= 32) return;
    const i = (evH + evN) % 32;
    evK[i] = k === 'up' ? 1 : k === 'down' ? 2 : 3; evT[i] = t; evN++;
  }

  /* The engine for this race: the Customize pick, else the car's own. */
  function chosen() {
    let id = null;
    try { id = root.localStorage.getItem(L ? L.KEY : 'duel.swim.engine'); } catch (_) {}
    return L ? L.pick(id) : 'v12';
  }
  function level() {
    const v = S.level ? Number(S.level()) : 1;
    return v > 0 ? Math.min(1, v) : 0;
  }
  /* One bus on the sound engine's output, with a limiter so a pop never clips. */
  function context() {
    if (bus) return ctx;
    if (!E) return null;
    try { ctx = S.context(); } catch (_) { ctx = null; }
    const out = S.output && S.output();
    if (!ctx || !out) return null;
    bus = ctx.createGain(); bus.gain.value = 0;
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -8; lim.knee.value = 6; lim.ratio.value = 10; lim.attack.value = 0.003; lim.release.value = 0.15;
    bus.connect(lim); lim.connect(out);
    return ctx;
  }
  function setGain(v, tc) {
    if (!bus || Math.abs(v - gain) < 1e-3) return;
    gain = v;
    bus.gain.setTargetAtTime(v, ctx.currentTime, tc);
  }
  function start() {
    if (!context()) return;
    const id = chosen();
    if (eng && engId === id) { offAt = 0; return; }
    if (eng) eng.stop();
    try { eng = E.make(ctx, id, bus); engId = id; } catch (_) { eng = null; engId = ''; return; }
    if (eng.listen) eng.listen(onEngine);
    evN = 0;
    lastT = ctx.currentTime; offAt = 0;
  }
  function release() {
    if (eng) eng.stop();
    eng = null; engId = ''; offAt = 0; ease = 0; evN = 0; ST.gear = 0; ST.rev = 0;
  }

  function frame(f) {
    const on = !!(f && f.on);
    if (on && !was) start();              // a race just started: the engine you picked
    was = on;
    if (!eng) return;
    const t = ctx.currentTime, dt = Math.min(0.1, Math.max(0, t - lastT));
    lastT = t;
    if (on) ease = Math.max(0, Number(f.v) || 0);
    else ease *= Math.exp(-dt / 0.6);      // off the road the revs drop away under the fade
    const pedal = on ? Math.max(-1, Math.min(1, Number(f.pedal) || 0)) : 0;
    const rev = on && !!f.rev;
    if (rev) ease = 0;                     // the start line: the car is still, only the revs move
    eng.set({ speed: ease, throttle: !on ? 0 : rev ? (pedal > 0 ? 1 : 0) : pedal > 0 ? 1 : pedal < 0 ? -1 : CRUISE, rev });
    /* What is heard by now is counted; a suspended context (a held page) moves nothing, so no gear is shown. */
    while (evN > 0 && evT[evH] <= t + 0.012) {
      const k = evK[evH];
      if (k === 1) ST.up++; else if (k === 2) ST.down++; else ST.pops++;
      evH = (evH + 1) % 32; evN--;
    }
    const live = ctx.state === 'running';
    ST.gear = live && eng.gear ? eng.gear() : 0;
    ST.rev = live && eng.rev ? eng.rev() : 0;
    const lv = on && !(doc && doc.hidden) ? level() * VOL : 0;
    setGain(lv, lv > 0 ? 0.08 : on ? 0.03 : 0.3);   // a mute is at once; the end of a race fades
    if (on) offAt = 0;
    else if (!offAt) offAt = t;
    else if (t - offAt > LET_GO) release();
  }

  function stop() {
    was = false;
    setGain(0, 0.05);
    release();
  }

  function play(name, opt) {
    if (name === 'sw.scrape') {
      const now = Date.now();
      if (now - scrapeAt < 260) return false;
      scrapeAt = now;
    }
    return S.play(name, opt);
  }

  /* A hidden tab stops the frames, so the engine is hushed here, not left droning at its last note. */
  if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', () => { if (doc.hidden) setGain(0, 0.03); });
  if (root.addEventListener) root.addEventListener('pagehide', stop);
  /* The engine's waves take a moment to work out: done while the page waits for a race. */
  const idle = root.requestIdleCallback ? (fn) => root.requestIdleCallback(fn, { timeout: 4000 }) : (fn) => setTimeout(fn, 1500);
  idle(() => { try { if (context() && E.prepare) E.prepare(ctx, chosen()); } catch (_) {} });

  root.SwimSound = { play, frame, stop, engine: () => engId, state: () => ST };
})(window);
