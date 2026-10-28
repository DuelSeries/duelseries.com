/* ─── DuelSeries sound engine (DSSfx) ────────────────────────────────────────
   One engine for every page: the lobby (public/js/v2/sounds.js) and each game.
   Sounds are synthesized here from a few lines of numbers (nothing borrowed, no
   audio files), rendered ONCE into AudioBuffers while the page loads, and a
   trigger only starts a buffer: no decoding, no node graph, no HTMLAudioElement,
   so nothing waits between the trigger and the sound (Owen 2026-10-16: "no
   delay between any of the sounds").

   One AudioContext per page, latencyHint 'interactive', made at load (silent
   until allowed) and resumed on the first pointerdown, keydown or touchend.

   DSSfx.define({name: layers, ...})   add sounds; they render in spare moments
   DSSfx.play(name, {vol, rate, pan, gap, max})   start one; false when it did not
                       (muted, hidden tab, held, too soon after itself, too many)
   DSSfx.setLevel(fn)  fn() is this page's volume (0..1), read on every play
   DSSfx.level()       that volume now, 0 while held or hidden: a live graph follows it
   DSSfx.hold(b)       true silences and suspends everything (the lobby while a game is up)
   DSSfx.context(), DSSfx.output()   for a game's own live graph (an engine hum)
   DSSfx.playIn(ctx, dest, name, vol)   one of these sounds on someone else's context
   Helpers for defining sounds: mf, arp, ticks, rng, render.

   The Glass pack (Owen's pick, 2026-10-16) is the house style: sines, triangles,
   soft bells and filtered noise. Game sounds live in dsSfxGame.js. */
(function (root) {
  'use strict';
  const doc = root.document;
  /* ── the synth ──────────────────────────────────────────────────────────────
     A sound is a list of layers, summed. Times in seconds.
       o   's' sine, 't' triangle, 'q' square (du = duty), 'fm' bell, 'n' noise
       f   Hz, or [from, to] glided over g seconds (default the whole layer)
       at  start, d length, v level, a attack, e decay time constant
       m,i (fm) modulator ratio and depth; the depth fades with ie (default e)
       vib [rate Hz, depth fraction]
       lp, hp, bp (noise) filter Hz, or [from, to]; q is the filter's Q
       sh  (noise) sample-and-hold rate, Hz or [from, to]: a crunchy 8-bit hiss */
  const mf = n => 440 * Math.pow(2, (n - 69) / 12);       // MIDI note to Hz (72 = C5)
  const arp = (notes, step, base) => notes.map((n, k) => Object.assign({}, base, { f: mf(n), at: (base.at || 0) + k * step }));
  function rng(seed) {                                      // small fixed PRNG: same sound every time
    return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  /* Ticks that slow down the way the money roll does (countUp.js eases out). */
  const ticks = (n, span, base, bend) => Array.from({ length: n }, (_, k) => {
    const u = k / (n - 1);
    return Object.assign({}, base, { at: span * Math.pow(u, 1.7), v: base.v * (1 - 0.55 * u),
      f: base.f && base.f * (1 + (bend || 0) * (k % 2 ? 1 : -1)) });
  });

  const glide = (f, t, g) => Array.isArray(f) ? f[0] * Math.pow(f[1] / f[0], Math.min(1, t / g)) : f;

  function biquad(type, sr) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, b0, b1, b2, a1, a2;
    return {
      set(fc, q) {
        const w = 2 * Math.PI * Math.min(fc, sr * 0.45) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
        if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; }
        else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
        else { b0 = al; b1 = 0; b2 = -al; }
        b0 /= a0; b1 /= a0; b2 /= a0; a1 = -2 * c / a0; a2 = (1 - al) / a0;
      },
      run(x) { const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; },
    };
  }

  function layer(out, L, sr, rnd) {
    const at = Math.round((L.at || 0) * sr), n = Math.round(L.d * sr), a = L.a || 0.002, e = L.e || L.d / 4;
    const g = L.g || L.d, fade = 0.004, du = L.du || 0.5;
    let ph = 0, mph = 0, held = 0, hold = 0;
    const k = L.o === 'n' ? (L.bp ? 'bp' : L.lp ? 'lp' : L.hp ? 'hp' : null) : null;
    const filt = k && biquad(k, sr), fspec = k === 'bp' ? L.bp[0] : L[k], fq = k === 'bp' ? L.bp[1] : (L.q || 0.707);
    for (let s = 0; s < n && at + s < out.length; s++) {
      const t = s / sr;
      const env = (t < a ? t / a : Math.exp(-(t - a) / e)) * Math.min(1, (L.d - t) / fade);
      let x;
      if (L.o === 'n') {
        if (L.sh) { hold -= glide(L.sh, t, g) / sr; if (hold <= 0) { held = rnd() * 2 - 1; hold += 1; } x = held; }
        else x = rnd() * 2 - 1;
        if (filt) { if ((s & 31) === 0) filt.set(glide(fspec, t, g), fq); x = filt.run(x); }
      } else {
        let f = glide(L.f, t, g);
        if (L.vib) f *= 1 + L.vib[1] * Math.sin(2 * Math.PI * L.vib[0] * t);
        ph += f / sr;
        const p = ph - Math.floor(ph);
        if (L.o === 'fm') {
          mph += f * L.m / sr;
          const idx = L.i * Math.exp(-t / (L.ie || e));
          x = Math.sin(2 * Math.PI * p + idx * Math.sin(2 * Math.PI * mph));
        } else if (L.o === 't') x = 1 - 4 * Math.abs(p - 0.5);
        else if (L.o === 'q') x = p < du ? 1 : -1;
        else x = Math.sin(2 * Math.PI * p);
      }
      out[at + s] += x * env * L.v;
    }
  }

  function render(layers, sr) {
    const len = Math.max.apply(null, layers.map(L => (L.at || 0) + L.d));
    const out = new Float32Array(Math.ceil(len * sr) + 1);
    const rnd = rng(7);
    layers.forEach(L => layer(out, L, sr, rnd));
    let peak = 0;
    for (let s = 0; s < out.length; s++) peak = Math.max(peak, Math.abs(out[s]));
    if (peak > 0.95) for (let s = 0; s < out.length; s++) out[s] *= 0.95 / peak;
    return out;
  }

  /* ── the engine ───────────────────────────────────────────────────────────── */
  const DEFS = {}, BUF = {}, todo = [], last = {};
  let ctx = null, out = null, level = () => 1, held = false, voices = 0, warming = false;
  const now = () => (root.performance ? root.performance.now() : Date.now());
  const noop = () => {};

  function context() {
    if (ctx) return ctx;
    const AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC({ latencyHint: 'interactive' }); } catch (_) { try { ctx = new AC(); } catch (__) { return null; } }
    out = ctx.createGain();
    out.connect(ctx.destination);
    return ctx;
  }
  function wake() {
    const c = context();
    if (c && !held && c.state === 'suspended') c.resume().catch(noop);
  }
  function hold(b) {
    held = !!b;
    if (!ctx) return;
    if (held) { if (ctx.state === 'running') ctx.suspend().catch(noop); }
    else if (ctx.state === 'suspended') ctx.resume().catch(noop);
  }

  function define(map) {
    Object.keys(map).forEach(k => { DEFS[k] = map[k]; delete BUF[k]; todo.push(k); });
    warm();
  }
  /* A few milliseconds at a time in idle moments, so a game's frames never wait. */
  function warm() {
    if (warming || !todo.length) return;
    warming = true;
    (root.requestIdleCallback || (f => setTimeout(f, 16)))(() => {
      warming = false;
      if (!context()) return;
      const t0 = now();
      while (todo.length && now() - t0 < 4) buf(todo.shift());
      warm();
    });
  }
  function buf(name) {
    if (BUF[name]) return BUF[name];
    const L = DEFS[name];
    if (!L || !context()) return null;
    const d = render(L, ctx.sampleRate);
    const b = ctx.createBuffer(1, d.length, ctx.sampleRate);
    b.getChannelData(0).set(d);
    return (BUF[name] = b);
  }

  function play(name, o) {
    o = o || {};
    if (held || (doc && doc.hidden)) return false;
    const lv = level() * (o.vol == null ? 1 : o.vol);
    if (!(lv > 0)) return false;
    const c = context();
    if (!c) return false;
    const t = now(), gap = o.gap == null ? 30 : o.gap;
    if (last[name] != null && t - last[name] < gap) return false;
    if (voices >= (o.max || 10)) return false;
    const b = buf(name);
    if (!b) return false;
    if (c.state === 'suspended') c.resume().catch(noop);
    last[name] = t;
    const s = c.createBufferSource(), g = c.createGain();
    s.buffer = b;
    if (o.rate) s.playbackRate.value = o.rate;
    g.gain.value = lv;
    s.connect(g);
    let end = g;
    if (o.pan && c.createStereoPanner) { end = c.createStereoPanner(); end.pan.value = Math.max(-1, Math.min(1, o.pan)); g.connect(end); }
    end.connect(out);
    voices++;
    s.onended = () => { voices--; try { s.disconnect(); g.disconnect(); if (end !== g) end.disconnect(); } catch (_) {} };
    s.start();
    return true;
  }

  /* For code that brings its own context (the shared cash-out fanfare's old API). */
  const foreign = new WeakMap();
  function playIn(c, dest, name, vol) {
    if (!c || !DEFS[name]) return false;
    if (c === ctx) return play(name, { vol: vol });
    let m = foreign.get(c);
    if (!m) foreign.set(c, (m = {}));
    if (!m[name]) {
      const d = render(DEFS[name], c.sampleRate);
      m[name] = c.createBuffer(1, d.length, c.sampleRate);
      m[name].getChannelData(0).set(d);
    }
    const s = c.createBufferSource(), g = c.createGain();
    s.buffer = m[name];
    g.gain.value = vol == null ? 1 : vol;
    s.connect(g); g.connect(dest || c.destination);
    s.start();
    return true;
  }

  if (root.addEventListener) {
    ['pointerdown', 'keydown', 'touchend', 'mousedown'].forEach(t => root.addEventListener(t, wake, { capture: true, passive: true }));
  }
  if (doc) context();                     // made now, silent until the first gesture; the sounds render meanwhile

  root.DSSfx = {
    define: define, play: play, playIn: playIn, hold: hold, wake: wake,
    setLevel: fn => { level = typeof fn === 'function' ? fn : () => +fn || 0; },
    level: () => { if (held || (doc && doc.hidden)) return 0; const v = +level(); return v > 0 ? v : 0; },
    context: () => context(), output: () => (context(), out),
    has: name => !!DEFS[name], names: () => Object.keys(DEFS), def: name => DEFS[name],
    ready: name => !!BUF[name],
    mf: mf, arp: arp, ticks: ticks, rng: rng, render: render,
  };
})(typeof window !== 'undefined' ? window : globalThis);
