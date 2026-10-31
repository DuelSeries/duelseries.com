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
   0 coasting, 1 gas, and on is false off the road (crash, result card, watching),
   which fades the engine out. rev is true on the start line (your own car in the
   countdown): the engine is out of gear and the gas only revs it, speed 0.

   SwimSound.state() is what the engine is doing, for the HUD and the scene: its
   gear (0 on the start line or with no engine running), rpm as a share of the
   redline, and running counts of upshifts, downshifts and backfire bangs, each
   counted when it is heard (one object, reused).

   THE ENGINE is your car's own (shared/swimLooks.js: the car picked in Customize,
   kept under duel.swim.car), read each time a race starts; nothing or anything
   unknown is the supercar's, the V12. Watching, it is the watched car's: the page
   names it (f.engine). It is made when a race starts and let go two seconds after
   it ends, so nothing runs on the audio thread between races; its waves are
   worked out while the page waits, so the start line never waits.

   THE OTHER CARS (Owen 2026-10-30: "hear the other cars around you"). f.others
   lists the cars near the one the camera rides with ({ key, engine, v, thr, dx,
   dz, alive }: dx metres to the right of it, dz metres ahead). The nearest ones
   get an engine of their own, at most VOICES at once (2 on a phone), each through
   its own level, a lowpass and a stereo pan: a car beside you is clear and on its
   side, a far one quieter and duller, and never as loud as your own (OTHER_MAX of
   it at most). A voice keeps its car while it stays among the nearest (no
   swapping back and forth), and each runs a hair off its car's speed so two of the
   same engine never phase. Plain StereoPanner and gain, so phone speakers and
   headphones both hear it; nothing at all where StereoPanner is missing but the
   level. Voices with no car fade and are let go after a second.

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
  const PHONE = (() => { try { return root.matchMedia('(pointer: coarse)').matches; } catch (_) { return false; } })();
  const VOICES = PHONE ? 2 : 3;   // other cars' engines heard at once (each is a whole engine on the audio thread)
  const OTHER_MAX = 0.55;  // the nearest other car, as a share of your own car's level
  const NEAR = 14;          // metres at which another car is at half its loudest
  const FAR = 120;          // metres past which another car is not heard at all
  const PAN_M = 9;          // metres to the side at which a car is fully on that side
  const CRUISE = 0;         // no pedal is a lift: the car coasts, nothing holds a cruise (2026-10-28)
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

  /* The engine for this race: the engine of the car picked in Customize. */
  function chosen() {
    let car = null;
    try { car = root.localStorage.getItem(L ? L.KEY : 'duel.swim.car'); } catch (_) {}
    return L ? L.engineOf(car) : 'v12';
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
  function start(want) {
    if (!context()) return;
    const id = want || chosen();
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
    const want = f && typeof f.engine === 'string' && f.engine ? f.engine : '';
    if (on && !was) start(want);          // a race just started: the engine you picked (or the watched car's)
    else if (on && eng && want && want !== engId) start(want);   // watching another car now
    was = on;
    others(f && Array.isArray(f.others) ? f.others : null, on);
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
    for (const vc of voices) dropVoice(vc);
    voices.length = 0;
  }

  /* ── the other cars ─────────────────────────────────────────────────── */
  const voices = [];        // { key, id, eng, gain, lp, pan, detune, idleAt }
  const pick = [];
  function att(d) { return d >= FAR ? 0 : 1 / (1 + (d / NEAR) * (d / NEAR)) * (1 - d / FAR); }
  function makeVoice() {
    const g = ctx.createGain(); g.gain.value = 0;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 6000; lp.Q.value = 0.5;
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    g.connect(lp);
    if (pan) { lp.connect(pan); pan.connect(bus); } else lp.connect(bus);
    return { key: null, id: '', eng: null, gain: g, lp, pan, detune: 0.985 + Math.random() * 0.03, idleAt: 0 };
  }
  function dropVoice(vc) {
    try { if (vc.eng) vc.eng.stop(); } catch (_) {}
    vc.eng = null; vc.id = '';
    setTimeout(() => { try { vc.gain.disconnect(); vc.lp.disconnect(); if (vc.pan) vc.pan.disconnect(); } catch (_) {} }, 1500);
  }
  function others(list, on) {
    if (!ctx || !bus) { if (!list || !list.length || !on || !context()) return; }
    const t = ctx.currentTime;
    /* The nearest cars still going, a voice's own car first when it is still among them. */
    pick.length = 0;
    if (on && list) {
      for (const o of list) {
        if (!o || o.alive === false || !(o.v >= 0)) continue;
        const d = Math.hypot(o.dx || 0, o.dz || 0);
        if (d >= FAR) continue;
        o._d = d - (voices.some(vc => vc.key === o.key) ? 6 : 0);   // a little stickiness, so close calls do not swap
        pick.push(o);
      }
      pick.sort((a, b) => a._d - b._d);
      if (pick.length > VOICES) pick.length = VOICES;
    }
    for (const vc of voices) vc.used = false;
    for (const o of pick) {
      let vc = voices.find(x => x.key === o.key) || voices.find(x => !x.used && (x.key === null || !pick.some(p => p.key === x.key)));
      if (!vc) { if (voices.length >= VOICES) continue; vc = makeVoice(); voices.push(vc); }
      vc.used = true;
      const id = typeof o.engine === 'string' && o.engine ? o.engine : 'v12';
      if (!vc.eng || vc.id !== id) {
        if (vc.eng) { try { vc.eng.stop(); } catch (_) {} }
        try { vc.eng = E.make(ctx, id, vc.gain); vc.id = id; } catch (_) { vc.eng = null; vc.id = ''; continue; }
      }
      vc.key = o.key; vc.idleAt = 0;
      const d = Math.hypot(o.dx || 0, o.dz || 0), a = att(d);
      vc.eng.set({ speed: Math.max(0, o.v * vc.detune), throttle: o.thr === undefined ? 1 : o.thr, rev: false });
      const lv = !(doc && doc.hidden) ? level() * VOL * OTHER_MAX * a : 0;
      vc.gain.gain.setTargetAtTime(lv, t, 0.06);
      vc.lp.frequency.setTargetAtTime(900 + 7000 * Math.sqrt(a), t, 0.08);
      if (vc.pan) vc.pan.pan.setTargetAtTime(Math.max(-0.9, Math.min(0.9, (o.dx || 0) / PAN_M)), t, 0.05);
    }
    /* Voices with nobody to play: quiet now, let go after a second. */
    for (let i = voices.length - 1; i >= 0; i--) {
      const vc = voices[i];
      if (vc.used) continue;
      vc.gain.gain.setTargetAtTime(0, t, 0.08);
      if (!vc.idleAt) vc.idleAt = t;
      else if (t - vc.idleAt > 1.2) { dropVoice(vc); voices.splice(i, 1); }
    }
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
  idle(() => {
    try {
      if (!context() || !E.prepare) return;
      E.prepare(ctx, chosen());
      /* The other engines too, one at a time, so the first car you hear never waits for its waves. */
      (E.ids || []).filter(id => id !== chosen()).forEach((id, i) => setTimeout(() => { try { E.prepare(ctx, id); } catch (_) {} }, 800 * (i + 1)));
    } catch (_) {}
  });

  root.SwimSound = { play, frame, stop, engine: () => engId, state: () => ST,
    voices: () => voices.map(vc => ({ key: vc.key, id: vc.id, gain: Math.round(vc.gain.gain.value * 1000) / 1000, pan: vc.pan ? Math.round(vc.pan.pan.value * 100) / 100 : null })) };
})(window);
