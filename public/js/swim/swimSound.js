/* ─── Swim: the sound ─────────────────────────────────────────────────────────
   The house Glass sounds (dsSfx.js, dsSfxGame.js) for the moments, and one live
   graph of its own for the engine and the wind (DSSfx.context / output, the
   engine-hum hook the sound engine keeps for exactly this). No files.

     match found  g.join            countdown  g.tick, g.tick, g.go
     close pass   sw.whoosh         barrier    sw.scrape (spaced out)
     your crash   g.death           their crash / win / lose  g.kill, g.win, g.lose
     losing the gap  g.warn

   swimMain.js calls SwimSound.play(name) for those and SwimSound.frame({ v, pedal, on })
   every animation frame: v is the car being followed (m/s), on is false off the road
   (waiting, result card), which fades the engine out. */
(function (root) {
  'use strict';
  const S = root.DSSfx;
  const quiet = { play() {}, frame() {}, stop() {} };
  if (!S) { root.SwimSound = quiet; return; }
  const { mf } = S;

  S.define({
    'sw.whoosh': [{ o: 'n', d: 0.32, v: 0.16, a: 0.02, e: 0.11, bp: [[500, 3200], 1.3] },
                  { o: 's', f: [mf(84), mf(96)], d: 0.16, v: 0.05, a: 0.01, e: 0.06 },
                  { o: 'fm', f: mf(103), m: 3.5, i: 1.2, at: 0.06, d: 0.3, v: 0.035, e: 0.1 }],
    'sw.scrape': [{ o: 'n', d: 0.14, v: 0.07, hp: 2200, e: 0.05, sh: 1400 }],
  });

  let ctx = null, eng = null, scrapeAt = 0;
  function build() {
    if (eng) return eng;
    try { ctx = S.context(); } catch (_) { ctx = null; }
    const out = S.output && S.output();
    if (!ctx || !out) return null;
    const master = ctx.createGain(); master.gain.value = 0; master.connect(out);
    /* The engine: a saw and a square an octave down, through a lowpass that opens with speed. */
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400; lp.Q.value = 3;
    const a = ctx.createOscillator(); a.type = 'sawtooth'; a.frequency.value = 60;
    const b = ctx.createOscillator(); b.type = 'square'; b.frequency.value = 30;
    const gb = ctx.createGain(); gb.gain.value = 0.5;
    a.connect(lp); b.connect(gb); gb.connect(lp);
    const eg = ctx.createGain(); eg.gain.value = 0.05; lp.connect(eg); eg.connect(master);
    /* The wind: looped noise through a band that rises with speed. */
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    let r = 7; for (let i = 0; i < len; i++) { r = (r * 16807) % 2147483647; d[i] = (r / 2147483647) * 2 - 1; }
    const n = ctx.createBufferSource(); n.buffer = buf; n.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 600; bp.Q.value = 0.7;
    const wg = ctx.createGain(); wg.gain.value = 0;
    n.connect(bp); bp.connect(wg); wg.connect(master);
    a.start(); b.start(); n.start();
    eng = { master, lp, a, b, eg, bp, wg };
    return eng;
  }

  /* Six gears: the pitch climbs through each and drops at the change, which is what makes speed audible. */
  const GEARS = [0, 16, 27, 39, 52, 66, 200];
  function frame(f) {
    const e = build();
    if (!e) return;
    const t = ctx.currentTime;
    const on = !!(f && f.on);
    const v = on ? Math.max(0, Number(f.v) || 0) : 0;
    let g = 0; while (g < GEARS.length - 2 && v > GEARS[g + 1]) g++;
    const frac = Math.min(1, (v - GEARS[g]) / (GEARS[g + 1] - GEARS[g]));
    const hz = 48 + 62 * frac + g * 7;
    e.a.frequency.setTargetAtTime(hz, t, 0.05);
    e.b.frequency.setTargetAtTime(hz / 2, t, 0.05);
    e.lp.frequency.setTargetAtTime(380 + v * 14 + (f && f.pedal > 0 ? 500 : 0), t, 0.08);
    e.eg.gain.setTargetAtTime(f && f.pedal > 0 ? 0.06 : 0.04, t, 0.1);
    e.bp.frequency.setTargetAtTime(500 + v * 26, t, 0.2);
    e.wg.gain.setTargetAtTime(Math.min(0.09, (v / 80) * (v / 80) * 0.09), t, 0.2);
    e.master.gain.setTargetAtTime(on ? 1 : 0, t, on ? 0.15 : 0.4);
  }

  function play(name, opt) {
    if (name === 'sw.scrape') {
      const now = Date.now();
      if (now - scrapeAt < 260) return false;
      scrapeAt = now;
    }
    return S.play(name, opt);
  }

  root.SwimSound = { play, frame, stop: () => frame({ on: false }) };
})(window);
