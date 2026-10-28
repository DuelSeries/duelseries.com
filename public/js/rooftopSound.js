'use strict';
/* ─── Rooftop Snipers: the sound ──────────────────────────────────────────────
   The house engine (dsSfx.js) and its Glass game pack (dsSfxGame.js), plus the
   few sounds a rooftop shoot-out has, defined here the same way: a few lines of
   numbers, synthesised once at load, no files (the reference's own recordings
   are never used).

   The moments are the reference's (its AudioStreamPlayer nodes):
     a shot                rt.shot    a sharp crack with a low boom under it
     a hit                 rt.hurt    a dull punch (the reference's HurtSound, 10 dB up)
     a jump                rt.jump    a short springy hop
     the first round       rt.bell    a boxing-ring bell (StartBell)
     a point               rt.point   two rising ticks (Checkmark Sound)
     a match point round   rt.match   a three-note sting (matchPointSound)
     the round's label     rt.swoosh  a quick air swish (Swoosh)
   rooftop.js feeds it: attach() once with the socket, local() for your own shot
   and jump the moment your screen predicts them; the server's copy of those is
   then skipped. Watching a match: the roof's sounds only, no win or loss.

   THE MUSIC (Owen 2026-10-28: "our own original track where the original game
   has music"; the reference plays a background track through every match): an
   original 16-bar chiptune loop of ours (score below), a pulse lead, a triangle
   bass, a soft arpeggio and a small drum kit, synthesised once into a buffer
   by an OfflineAudioContext (off the page's thread, no audio files) and looped
   quietly under the effects. rooftop.js calls music(true) when a match is on
   screen and music(false) when it goes; it stops on its own on the result.
   Until the first tap or key the page's audio is asleep (dsSfx.js wakes it),
   so that is when it is first heard.

   MUTE: one switch for the music and the effects, remembered on this device
   under duel.rooftop.muted. The page draws it top right and binds M. */

(function (root) {
  const S = root.DSSfx;
  if (!S) return;
  const MUTE_KEY = 'duel.rooftop.muted';
  let muted = (() => { try { return root.localStorage.getItem(MUTE_KEY) === '1'; } catch (_) { return false; } })();
  S.setLevel(function () { return muted ? 0 : 1; });

  S.define({
    'rt.shot':  [{ o: 'n', d: 0.16, v: 0.34, a: 0.001, e: 0.05, lp: [7000, 1200] },
                 { o: 's', f: [150, 45], d: 0.22, v: 0.3, e: 0.07 },
                 { o: 'n', d: 0.45, v: 0.06, a: 0.01, e: 0.2, lp: 900 }],
    'rt.hurt':  [{ o: 's', f: [220, 70], d: 0.16, v: 0.34, e: 0.05 },
                 { o: 'n', d: 0.07, v: 0.14, lp: [1800, 400], e: 0.02 }],
    'rt.jump':  [{ o: 's', f: [260, 620], d: 0.12, v: 0.13, e: 0.05, g: 0.04 },
                 { o: 't', f: [130, 310], d: 0.1, v: 0.05, e: 0.04 }],
    'rt.bell':  [0, 0.16, 0.32].map((at) => ({ o: 'fm', f: 1320, m: 1.41, i: 2.2, at: at, d: 0.9, v: 0.1, e: 0.35, ie: 0.15 })),
    'rt.point': [{ o: 't', f: 880, d: 0.09, v: 0.14, e: 0.05 }, { o: 't', f: 1320, at: 0.09, d: 0.2, v: 0.14, e: 0.12 }],
    'rt.match': [{ o: 'q', f: 392, du: 0.5, d: 0.16, v: 0.07, e: 0.08 }, { o: 'q', f: 523, du: 0.5, at: 0.15, d: 0.16, v: 0.07, e: 0.08 },
                 { o: 'q', f: 784, du: 0.5, at: 0.3, d: 0.42, v: 0.08, e: 0.3 }],
    'rt.boom':  [{ o: 'n', d: 0.6, v: 0.36, a: 0.002, e: 0.25, lp: [2400, 300] }, { o: 's', f: [90, 32], d: 0.5, v: 0.34, e: 0.2 }],
    'rt.launch': [{ o: 'n', d: 0.35, v: 0.16, a: 0.01, e: 0.15, bp: [[900, 2400], 0.8] }, { o: 's', f: [180, 90], d: 0.18, v: 0.16, e: 0.06 }],
    'rt.toss':  [{ o: 'n', d: 0.18, v: 0.12, a: 0.01, e: 0.08, bp: [[1800, 500], 1.2] }, { o: 's', f: [340, 180], d: 0.12, v: 0.06, e: 0.05 }],
    'rt.swoosh': [{ o: 'n', d: 0.22, v: 0.08, a: 0.06, e: 0.1, bp: [[600, 3200], 1.4] }],
  });

  /* ── the music ───────────────────────────────────────────────────────────────
     Ours, written for this game: 128 beats a minute in A minor, 16 bars (30 s), then round again.
       A  Am  F  C  G  | Am  F  G  E        B  F  G  Em  Am | F  G  E  E
     Every note ends inside its own slot, so the loop's seam is silent. */
  const BPM = 128, E8 = 60 / BPM / 2, BAR = E8 * 8, BARS = 16, LOOP = BAR * BARS;
  const MUSIC_LEVEL = 0.18;          // the loop's peak, against effects that peak near 1: under them, never over
  const CHORDS = [
    [57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62], [57, 60, 64], [53, 57, 60], [55, 59, 62], [56, 59, 64],
    [53, 57, 60], [55, 59, 62], [52, 55, 59], [57, 60, 64], [53, 57, 60], [55, 59, 62], [56, 59, 64], [56, 59, 64],
  ];
  const ROOTS = [45, 41, 36, 43, 45, 41, 43, 40, 41, 43, 40, 45, 41, 43, 40, 40];
  const BASS_STEP = [0, 0, 12, 0, 0, 12, 7, 12];    // the bass's eighths over each bar's root
  // The tune, bar by bar: [MIDI note, eighths], 0 a rest.
  const LEAD = [
    [[76, 2], [81, 1], [79, 1], [76, 2], [74, 1], [72, 1]],
    [[69, 2], [72, 1], [74, 1], [72, 2], [69, 2]],
    [[67, 1], [72, 1], [76, 1], [79, 1], [76, 2], [72, 2]],
    [[74, 3], [71, 1], [67, 2], [0, 2]],
    [[76, 2], [81, 1], [83, 1], [84, 2], [83, 1], [81, 1]],
    [[81, 2], [77, 1], [81, 1], [84, 2], [81, 2]],
    [[83, 1], [81, 1], [79, 1], [74, 1], [79, 2], [83, 2]],
    [[80, 2], [76, 2], [71, 2], [68, 2]],
    [[84, 3], [81, 1], [77, 2], [81, 2]],
    [[83, 3], [79, 1], [74, 2], [79, 2]],
    [[79, 2], [76, 1], [79, 1], [83, 2], [81, 1], [79, 1]],
    [[81, 4], [76, 2], [72, 2]],
    [[77, 1], [81, 1], [84, 1], [81, 1], [77, 2], [76, 2]],
    [[74, 1], [79, 1], [83, 1], [79, 1], [86, 2], [83, 2]],
    [[80, 3], [83, 1], [88, 2], [86, 1], [83, 1]],
    [[80, 2], [76, 2], [71, 2], [0, 2]],
  ];
  const hz = (n) => 440 * Math.pow(2, (n - 69) / 12);

  /* The whole loop into one graph on an OfflineAudioContext: a square lead, a triangle bass, a 25% pulse arpeggio in
     sixteenths, a sine kick and filtered-noise snare and hats. */
  function score(oc) {
    const out = oc.destination;
    const N = 24, re = new Float32Array(N + 1), im = new Float32Array(N + 1);   // the 25% pulse's Fourier series
    for (let n = 1; n <= N; n++) {
      re[n] = Math.sin(2 * Math.PI * n * 0.25) / (n * Math.PI);
      im[n] = (1 - Math.cos(2 * Math.PI * n * 0.25)) / (n * Math.PI);
    }
    const pulse = oc.createPeriodicWave(re, im);
    const rnd = S.rng(11), noise = oc.createBuffer(1, oc.sampleRate, oc.sampleRate), nd = noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = rnd() * 2 - 1;      // the same second of noise every time
    let hits = 0;
    function tone(type, n, t, d, v, a, sus) {
      const o = oc.createOscillator(), g = oc.createGain();
      if (type === 'pulse') o.setPeriodicWave(pulse); else o.type = type;
      o.frequency.value = hz(n);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(v, t + a);
      g.gain.linearRampToValueAtTime(v * sus, t + Math.max(a + 0.01, d * 0.5));
      g.gain.linearRampToValueAtTime(0, t + d);
      o.connect(g); g.connect(out);
      o.start(t); o.stop(t + d + 0.01);
    }
    function hit(t, d, v, type, f, q) {
      const s = oc.createBufferSource(), fl = oc.createBiquadFilter(), g = oc.createGain();
      s.buffer = noise; fl.type = type; fl.frequency.value = f; fl.Q.value = q;
      g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + d); g.gain.linearRampToValueAtTime(0, t + d + 0.004);
      s.connect(fl); fl.connect(g); g.connect(out);
      s.start(t, ((hits++) * 0.137) % 0.8); s.stop(t + d + 0.01);
    }
    function kick(t) {
      const o = oc.createOscillator(), g = oc.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.6, t + 0.003);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.16); g.gain.linearRampToValueAtTime(0, t + 0.165);
      o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.17);
    }
    for (let b = 0; b < BARS; b++) {
      const t0 = b * BAR, ch = CHORDS[b], arp = [ch[0], ch[1], ch[2], ch[0] + 12], fill = b === 7 || b === 15;
      let at = t0;
      for (const [n, len] of LEAD[b]) { if (n) tone('square', n, at, len * E8 - 0.02, 0.2, 0.005, 0.7); at += len * E8; }
      for (let k = 0; k < 8; k++) tone('triangle', ROOTS[b] + BASS_STEP[k], t0 + k * E8, E8 * 0.85, 0.32, 0.004, 0.75);
      for (let k = 0; k < 16; k++) tone('pulse', arp[k % 4], t0 + k * E8 / 2, E8 / 2 * 0.7, 0.06, 0.003, 0.4);
      for (let k = 0; k < 8; k++) {
        const t = t0 + k * E8;
        if (k === 0 || k === 4 || (k === 3 && b % 2 === 1)) kick(t);
        if (k === 2 || k === 6 || (fill && k === 7)) hit(t, 0.13, 0.5, 'bandpass', 1900, 0.9);
        hit(t, 0.04, k % 2 ? 0.1 : 0.06, 'highpass', 7000, 0.7);
      }
    }
  }

  let tune = null, building = false, wantMusic = false, src = null, mgain = null;
  const doc = root.document;
  const musicLevel = () => (muted || (doc && doc.hidden) ? 0 : MUSIC_LEVEL);
  // Rendered once, a beat after the page loads (the wait card is up then), and kept for every match on this page.
  function build() {
    if (tune || building) return;
    const c = S.context(), OAC = root.OfflineAudioContext || root.webkitOfflineAudioContext;
    if (!c || !OAC) return;
    building = true;
    let oc;
    try { oc = new OAC(1, Math.ceil(LOOP * c.sampleRate), c.sampleRate); score(oc); } catch (_) { building = false; return; }
    const done = (b) => {
      building = false;
      if (!b) return;
      const d = b.getChannelData(0);                         // to a peak of 1, so MUSIC_LEVEL is the loop's peak
      let peak = 0;
      for (let i = 0; i < d.length; i++) { const v = d[i] < 0 ? -d[i] : d[i]; if (v > peak) peak = v; }
      if (peak > 0) for (let i = 0; i < d.length; i++) d[i] /= peak;
      tune = b;
      startLoop();
    };
    try {
      const p = oc.startRendering();
      if (p && typeof p.then === 'function') p.then(done, () => { building = false; });
      else oc.oncomplete = (e) => done(e && e.renderedBuffer);
    } catch (_) { building = false; }
  }
  /* Started on the page's context even while it still sleeps: it is first heard when the first tap or key wakes it. */
  function startLoop() {
    if (!wantMusic || src || !tune) return;
    const c = S.context();
    if (!c) return;
    mgain = c.createGain();
    mgain.gain.value = 0;
    mgain.connect(S.output());
    src = c.createBufferSource();
    src.buffer = tune; src.loop = true;
    src.connect(mgain);
    src.start();
    mgain.gain.setTargetAtTime(musicLevel(), c.currentTime, 0.35);   // a short fade in
  }
  function music(on) {
    wantMusic = !!on;
    if (wantMusic) { if (tune) startLoop(); else build(); return; }
    if (!src) return;
    const c = S.context(), s = src, g = mgain, t = c.currentTime;
    src = null; mgain = null;
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.linearRampToValueAtTime(0, t + 0.4);
    s.onended = () => { try { s.disconnect(); g.disconnect(); } catch (_) {} };
    try { s.stop(t + 0.45); } catch (_) {}
  }
  function follow() {
    if (!mgain) return;
    const c = S.context();
    mgain.gain.cancelScheduledValues(c.currentTime);
    mgain.gain.setTargetAtTime(musicLevel(), c.currentTime, 0.08);
  }
  if (doc) doc.addEventListener('visibilitychange', follow);    // a hidden tab plays no music

  function setMuted(v) {
    muted = !!v;
    try { root.localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (_) { /* storage blocked: this visit only */ }
    follow();
    return muted;
  }

  const now = () => (root.performance ? root.performance.now() : Date.now());
  const play = (name, opt) => S.play(name, opt);
  let get = () => ({});
  const view = () => { try { return get() || {}; } catch (_) { return {}; } };
  const panAt = (x) => (typeof x === 'number' ? Math.max(-1, Math.min(1, x / 640)) * 0.4 : 0);

  // Your own shot and jump, already heard from your own screen: the server's copy is skipped.
  const heard = { shot: -1e9, jump: -1e9 };

  function shot(side, x, hit, local) {
    const v = view(), mine = !v.watch && side === v.mySide;
    if (mine && !local && now() - heard.shot < 500) { if (hit) play('rt.hurt', { vol: 0.9, gap: 80 }); return; }
    if (local) heard.shot = now();
    play('rt.shot', { vol: mine ? 1 : 0.85, rate: 0.95 + Math.random() * 0.1, pan: panAt(x), gap: 60 });
    if (hit && !local) play('rt.hurt', { vol: 0.9, pan: panAt(x), gap: 80 });
  }
  function jump(side, x, local) {
    const v = view(), mine = !v.watch && side === v.mySide;
    if (mine && !local && now() - heard.jump < 450) return;
    if (local) heard.jump = now();
    play('rt.jump', { vol: mine ? 1 : 0.7, pan: panAt(x), gap: 80 });
  }

  function attach(socket, getter) {
    if (typeof getter === 'function') get = getter;
    socket.on('rt:start', () => { if (!view().watch) play('g.join'); });
    socket.on('rt:go', () => play('rt.bell', { vol: 0.8, gap: 500 }));
    socket.on('rt:ev', (list) => {
      if (!Array.isArray(list)) return;
      for (let i = 0; i < list.length && i < 6; i++) {
        const e = list[i];
        if (!Array.isArray(e) || typeof e[0] !== 'string') continue;
        if (e[0] === 'shot') shot(e[1], e[2], !!e[6], false);
        else if (e[0] === 'jump') jump(e[1], view().xOf ? view().xOf(e[1]) : 0, false);
        else if (e[0] === 'rocket') { const v = view(); if (v.watch || e[1] !== v.mySide || now() - heard.shot > 500) play('rt.launch', { gap: 60 }); }
        else if (e[0] === 'toss') { const v = view(); if (v.watch || e[1] !== v.mySide || now() - heard.shot > 500) play('rt.toss', { gap: 60 }); }
        else if (e[0] === 'boom') { play('rt.boom', { pan: panAt(e[2]), gap: 80 }); if (e[4]) play('rt.hurt', { vol: 0.9, gap: 80 }); }
        else if (e[0] === 'ready') play('g.tick', { vol: 0.6, gap: 120 });
      }
    });
    socket.on('rt:point', () => play('rt.point', { gap: 400 }));
    socket.on('rt:round', (m) => {
      play('rt.swoosh', { vol: 0.8, gap: 300 });
      const v = view();
      if (m && v.matchPoint && v.matchPoint()) root.setTimeout(() => play('rt.match', { gap: 600 }), 120);
    });
    socket.on('rt:refused', () => play('g.err', { vol: 0.7 }));
    socket.on('rt:over', (m) => {
      music(false);                     // the result card has no music under it
      const v = view();
      if (v.watch || !m) return;
      play(m.winnerId && m.winnerId === v.me ? 'g.win' : m.winnerId ? 'g.lose' : 'g.turn');
    });
    (root.requestIdleCallback || ((f) => root.setTimeout(f, 300)))(build);   // the loop renders while the wait card is up
  }

  // The page's own predicted shot or jump for your seat.
  function local(name, side, x, hit) {
    if (name === 'shot') shot(side, x, hit, true);
    else if (name === 'jump') jump(side, x, true);
    else if (name === 'rocket') { heard.shot = now(); play('rt.launch', { gap: 60 }); }
    else if (name === 'toss') { heard.shot = now(); play('rt.toss', { gap: 60 }); }
  }

  root.RooftopSound = { attach, local, music, setMuted, muted: () => muted, toggle: () => setMuted(!muted),
    playing: () => !!src };            // read only, for a headless check: is the loop on
})(window);
