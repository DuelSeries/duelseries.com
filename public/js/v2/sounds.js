/* ─── Lobby sounds ────────────────────────────────────────────────────────────
   A short sound for almost everything clicked in the lobby (Owen, 2026-10-16:
   "make a sound effect for pretty much everything you click"). Every sound is
   synthesized here from a few lines of numbers, so nothing is borrowed from
   another game and there is no audio file to download.

   How it works
     One AudioContext, made on the first tap (browsers refuse sound before one).
     Each sound is rendered once into an AudioBuffer, then a tap just starts a
     buffer: no work on the click itself, so phone swipes stay smooth.
     A capture listener on window picks a sound for whatever was clicked (MAP),
     before the click's own handler runs, so a switch knows its old state.
     toasts.js, countUp.js and swipe.js call DSSound for the things that are not
     clicks: a card arriving, money rolling up, a swipe landing.

   Rules
     Silent while a game is up (the game has its own sounds) and in a hidden tab.
     The same sound twice inside its gap is one sound, and at most 6 play at
     once, so fast clicking never turns into a buzz.
     Settings has the switch and the volume, remembered per device (dsSnd,
     dsSndVol). On by default.

   DSSound.play(name, {rate, vol})   rate 1.06 is a touch higher (next arrow)
   DSSound.toast(kind, sticky)       kind is the toast's: ok | money | err | info
   DSSound.roll()                    money counting up (only right after a click)
   DSSound.on() / setOn(b)  vol() / setVol(0..1) */
(function () {
  'use strict';
  const LS_ON = 'dsSnd', LS_VOL = 'dsSndVol';
  const FRAMES = ['game-frame', 'agar-frame'];

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

  /* ── the pack ───────────────────────────────────────────────────────────────
     A pecking order: ticks for small things, a clear confirm for Play, the
     richest sound for money, a gentle error. Owen picked Glass (2026-10-16) over
     Arcade and Lounge; all three are in the picker in the session notes
     (lobby-sounds/picker.html) if he ever wants to swap. */
  const PACKS = {};

  /* Glass: soft and modern, sine tones like a well-made phone app. */
  (() => {
    const play = [].concat(
      arp([72, 76, 79, 84], 0.045, { o: 't', d: 0.34, v: 0.16, e: 0.11 }),
      [{ o: 's', f: [190, 85], d: 0.2, v: 0.32, e: 0.05, g: 0.12 },
       { o: 's', f: mf(96), at: 0.15, d: 0.45, v: 0.045, e: 0.16 }]);
    PACKS.glass = {
      tap:       [{ o: 's', f: [2100, 1700], d: 0.03, v: 0.16, e: 0.008 }, { o: 'n', d: 0.012, v: 0.04, bp: [4200, 1.2], e: 0.003 }],
      tab:       [{ o: 's', f: [1180, 1320], d: 0.06, v: 0.2, e: 0.018 }, { o: 's', f: 2640, d: 0.04, v: 0.04, e: 0.01 }],
      arrow:     [{ o: 's', f: 1500, d: 0.035, v: 0.15, e: 0.009 }, { o: 'n', d: 0.01, v: 0.03, bp: [5000, 1.5], e: 0.002 }],
      select:    [{ o: 's', f: mf(84), d: 0.05, v: 0.15, e: 0.015 }, { o: 's', f: mf(91), at: 0.035, d: 0.08, v: 0.15, e: 0.02 }],
      card:      [{ o: 's', f: [380, 980], d: 0.1, v: 0.24, e: 0.03, g: 0.045 }, { o: 'n', d: 0.03, v: 0.04, lp: 2500, e: 0.01 }],
      swipe:     [{ o: 'n', d: 0.2, v: 0.2, a: 0.05, e: 0.06, bp: [[600, 2600], 0.9] }],
      open:      [{ o: 's', f: [620, 990], d: 0.13, v: 0.18, a: 0.004, e: 0.04, g: 0.06 }, { o: 's', f: 1980, at: 0.04, d: 0.12, v: 0.045, e: 0.035 }],
      close:     [{ o: 's', f: [980, 560], d: 0.1, v: 0.16, e: 0.035, g: 0.06 }],
      toggleOn:  [{ o: 's', f: mf(88), d: 0.05, v: 0.14, e: 0.015 }, { o: 's', f: mf(95), at: 0.045, d: 0.09, v: 0.14, e: 0.025 }],
      toggleOff: [{ o: 's', f: mf(83), d: 0.05, v: 0.13, e: 0.015 }, { o: 's', f: mf(76), at: 0.045, d: 0.09, v: 0.12, e: 0.025 }],
      copy:      [{ o: 's', f: 2600, d: 0.025, v: 0.1, e: 0.006 }, { o: 's', f: 3300, at: 0.05, d: 0.045, v: 0.1, e: 0.01 }],
      play: play,
      playPaid:  play.concat([{ o: 'fm', f: mf(100), m: 3.5, i: 2, at: 0.16, d: 0.65, v: 0.1, e: 0.18 },
                              { o: 'fm', f: mf(103), m: 3.5, i: 2, at: 0.23, d: 0.7, v: 0.08, e: 0.2 }]),
      spectate:  [{ o: 'n', d: 0.26, v: 0.08, a: 0.06, e: 0.08, bp: [[400, 1800], 1.5] }, { o: 's', f: [520, 780], d: 0.24, v: 0.12, a: 0.03, e: 0.08, g: 0.15 }],
      confirm:   [{ o: 't', f: mf(79), d: 0.12, v: 0.18, e: 0.05 }, { o: 't', f: mf(86), at: 0.07, d: 0.24, v: 0.18, e: 0.08 }],
      buy:       [{ o: 'n', d: 0.02, v: 0.1, hp: 3000, e: 0.005 }, { o: 's', f: [240, 110], d: 0.12, v: 0.22, e: 0.04 },
                  { o: 'fm', f: mf(100), m: 3.5, i: 2.5, at: 0.02, d: 0.75, v: 0.13, e: 0.2 },
                  { o: 'fm', f: mf(105), m: 3.5, i: 2.5, at: 0.1, d: 0.85, v: 0.11, e: 0.25 }],
      money:     arp([84, 88, 91, 96, 100], 0.05, { o: 'fm', m: 3.5, i: 1.6, d: 0.55, v: 0.1, e: 0.16 })
                  .concat([{ o: 's', f: mf(60), d: 0.3, v: 0.12, e: 0.1 }, { o: 'n', at: 0.2, d: 0.4, v: 0.025, hp: 6000, a: 0.05, e: 0.12 }]),
      ok:        [{ o: 's', f: mf(86), d: 0.1, v: 0.13, e: 0.04 }, { o: 's', f: mf(93), at: 0.08, d: 0.26, v: 0.13, e: 0.09 }],
      err:       [{ o: 't', f: mf(69), d: 0.14, v: 0.16, e: 0.05 }, { o: 't', f: mf(65), at: 0.12, d: 0.26, v: 0.16, e: 0.09 }],
      info:      [{ o: 'fm', f: mf(91), m: 2, i: 0.8, d: 0.36, v: 0.1, e: 0.12 }],
      roll:      ticks(16, 0.9, { o: 's', f: 3200, d: 0.016, v: 0.07, e: 0.004 }, 0.04),
    };
  })();

  let PACK = 'glass';

  /* ── playing ──────────────────────────────────────────────────────────────── */
  const GAP = { tap: 45, arrow: 45, select: 45, tab: 60, roll: 1500, money: 500, buy: 500, err: 250, ok: 250, info: 250, swipe: 120 };
  const lsGet = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lsPut = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
  let on = lsGet(LS_ON) !== '0';
  let vol = (() => { const v = parseFloat(lsGet(LS_VOL)); return isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.7; })();
  let ctx = null, master = null, bufs = {}, last = {}, voices = 0, lastClick = -1e9;

  const ingame = () => (document.body && document.body.classList.contains('ingame'))
    || FRAMES.some(id => { const f = document.getElementById(id); return !!f && f.style.display === 'block'; });
  const quiet = () => !on || vol <= 0 || document.hidden || ingame();

  function unlock() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC({ latencyHint: 'interactive' }); } catch (_) { try { ctx = new AC(); } catch (__) { return null; } }
      master = ctx.createGain();
      master.gain.value = vol;
      master.connect(ctx.destination);
      warm();
    }
    if (ctx.state === 'suspended' && !ingame()) ctx.resume().catch(() => {});
    return ctx;
  }
  /* Render the rest in spare moments, one sound at a time, so the first tap of
     each is as quick as the hundredth and a swipe never shares a frame with it. */
  function warm() {
    const names = Object.keys(PACKS[PACK]).filter(n => !bufs[PACK + n]);
    if (!names.length) return;
    const idle = window.requestIdleCallback || (f => setTimeout(f, 30));
    idle(() => { buf(names[0]); warm(); });
  }
  function buf(name, pack) {
    pack = pack || PACK;
    const key = pack + name;
    if (bufs[key]) return bufs[key];
    const layers = PACKS[pack] && PACKS[pack][name];
    if (!layers || !ctx) return null;
    const data = render(layers, ctx.sampleRate);
    const b = ctx.createBuffer(1, data.length, ctx.sampleRate);
    b.getChannelData(0).set(data);
    return (bufs[key] = b);
  }

  function start(name, opt, pack) {
    if (!unlock()) return false;
    const b = buf(name, pack);
    if (!b || voices >= 6) return false;
    const src = ctx.createBufferSource();
    src.buffer = b;
    if (opt && opt.rate) src.playbackRate.value = opt.rate;
    let out = master;
    if (opt && opt.vol != null && opt.vol !== 1) { out = ctx.createGain(); out.gain.value = opt.vol; out.connect(master); }
    src.connect(out);
    voices++;
    src.onended = () => { voices--; try { src.disconnect(); if (out !== master) out.disconnect(); } catch (_) {} };
    src.start();
    return true;
  }

  function play(name, opt) {
    if (quiet()) return false;
    const now = performance.now();
    if (last[name] != null && now - last[name] < (GAP[name] || 70)) return false;
    last[name] = now;
    return start(name, opt);
  }

  /* A toast that a click just caused (Copied, Saved) already had its click
     sound; only money and errors speak over it. A busy "working" card is quiet. */
  function toast(kind, sticky) {
    if (sticky && kind === 'info') return;
    const name = { ok: 'ok', money: 'money', err: 'err', info: 'info' }[kind] || 'ok';
    if ((name === 'ok' || name === 'info') && performance.now() - lastClick < 300) return;
    play(name);
  }
  /* Money counting up sounds only right after a click (opening Wallet, say),
     never for a leaderboard quietly redrawing in the background. */
  function roll() {
    if (performance.now() - lastClick > 1500) return;
    play('roll', { vol: 0.8 });
  }

  /* ── what each click sounds like ──────────────────────────────────────────
     First match wins. A function gets the element and returns a name, or a
     [name, {rate}] pair. Anything clickable that is not listed gets 'tap'. */
  const att = (el, a) => el.getAttribute(a) || '';
  const MAP = [
    ['.sw[role="switch"]', el => att(el, 'aria-checked') === 'true' ? 'toggleOff' : 'toggleOn'],
    ['#gobtn', el => el.classList.contains('paid') ? 'playPaid' : 'play'],
    ['#specbtn,#ev-watch,.evwatch,[onclick*="spectate" i]', 'spectate'],
    ['#ev-join,.evgo,.howgo,.enter', 'play'],
    ['#bs-go,[onclick^="confirmBuy"]', 'buy'],
    ['.stk', 'select'],
    ['.card', 'card'],
    ['.ni,.logo,.mewal', el => el.classList.contains('on') ? 'tap' : 'tab'],
    ['[role="tab"]', 'tab'],
    ['#ap-prev,.nb.l,.upnav.prev,[onclick="spin(-1)"],[onclick*="cycleLook(-1)"]', ['arrow', { rate: 0.89 }]],
    ['.ap-arrow,.nb,.upnav,[onclick^="spin"],[onclick^="cycleLook"]', ['arrow', { rate: 1.06 }]],
    ['.ap-save-btn,.acctbtn:not(.out),[onclick*="confirmCash"],[onclick*="submitCash"],[onclick*="confirmConvert"],.clsend:not(.sec),#cl-send', 'confirm'],
    ['.back,.howx,.upx,.lb-x,.earn-x,.bs-no,.ap-back-btn,[onclick^="close"],[onclick*=".close"],[onclick*="cancel"],[onclick*="backCash"],.acctbtn.out,#me-out', 'close'],
    ['.waddr .cp,.jn-ls:has(.jn-cp),[data-copy],.cp', 'copy'],
    ['[onclick*="V2Wallet.fund"],[onclick*="cashOut"],[onclick*="V2Wallet.convert"],[onclick^="open"],[onclick*="headerTap"],[onclick*="openUpload"],[onclick*="openSubmit"],#wbtn,.wbtn,#mebtn,.lookrow,.lbrow,.lb-all,.evhow,.allbtn,.mebt,.upcard,.jn-big', 'open'],
    ['.czb,.maxbtn', 'select'],
  ];
  function pick(el) {
    for (const [sel, s] of MAP) {
      let hit = false;
      try { hit = el.matches(sel); } catch (_) {}        // an old browser without :has() just skips that row
      if (hit) return typeof s === 'function' ? s(el) : s;
    }
    return 'tap';
  }
  const CLICKABLE = 'button,a[href],[role="button"],[role="switch"],[role="tab"],[onclick],summary,label,input[type="checkbox"],input[type="radio"]';
  const BACKDROPS = '.howveil,.meveil,#bsheet';

  function onClick(e) {
    if (!on || e.button > 0) return;
    let el = e.target && e.target.closest ? e.target.closest(CLICKABLE) : null;
    let s;
    if (!el && e.target && e.target.matches && e.target.matches(BACKDROPS)) s = 'close';   // tapping outside a sheet closes it
    else if (!el || el.disabled || att(el, 'aria-disabled') === 'true') return;
    else s = pick(el);
    const [name, opt] = Array.isArray(s) ? s : [s, null];
    play(name, opt);
    lastClick = performance.now();
  }

  /* The first tap anywhere makes the AudioContext (browsers allow it only then). */
  function firstGesture() { if (on) unlock(); }
  window.addEventListener('pointerdown', firstGesture, { capture: true, passive: true });
  window.addEventListener('touchend', firstGesture, { capture: true, passive: true });   // iOS unlocks audio here
  window.addEventListener('keydown', firstGesture, { capture: true, passive: true });
  window.addEventListener('click', onClick, { capture: true, passive: true });

  /* A game opening suspends the lobby's audio entirely; it wakes on the way back. */
  function syncGame() {
    if (!ctx) return;
    if (ingame()) { if (ctx.state === 'running') ctx.suspend().catch(() => {}); }
    else if (on && ctx.state === 'suspended') ctx.resume().catch(() => {});
  }
  function watchBody() {
    if (!document.body) return;
    new MutationObserver(syncGame).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }
  if (document.body) watchBody(); else document.addEventListener('DOMContentLoaded', watchBody);

  function setOn(b) {
    on = !!b;
    lsPut(LS_ON, on ? '1' : '0');
    if (on) { unlock(); last = {}; play('toggleOn'); }
    else if (ctx) setTimeout(() => { if (!on && ctx) ctx.suspend().catch(() => {}); }, 400);   // let the switch's own click finish
  }
  function setVol(v) {
    vol = Math.max(0, Math.min(1, +v || 0));
    lsPut(LS_VOL, String(vol));
    if (master) master.gain.setTargetAtTime(vol, ctx.currentTime, 0.015);
  }

  window.DSSound = {
    play: play, toast: toast, roll: roll,
    on: () => on, setOn: setOn, vol: () => vol, setVol: setVol,
    /* For the picker page and tests: any pack, any sound, ignoring the switch. */
    names: () => Object.keys(PACKS[PACK]), packs: () => Object.keys(PACKS),
    preview: (pack, name) => start(name, null, pack),
    _pick: pick, _render: (pack, name, sr) => render(PACKS[pack][name], sr || 48000),
  };
})();
