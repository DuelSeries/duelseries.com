'use strict';
/* ─── The clip recorder: P saves the last 30 seconds (Owen 2026-10-16) ─────────
   On a PC, every game page keeps the last 30 seconds of what is on screen, with
   the game's sound (and the player's mic if they turned it on in Settings). P
   saves them as an .mp4 in the player's Downloads; nothing is uploaded unless
   the player then clicks Share to DuelSeries on the card that follows (each
   share its own click, reviewed by the owner before anyone sees it). After a cash-out or a battle royale win the page
   offers to save one for 8 seconds. Owen's picks: look A (the lobby's own toast,
   top centre), an always-on small red dot, a DuelSeries.com mark in the video.

   How:
     picture  every visible canvas on the page, drawn in stacking order onto one
              hidden canvas 30 times a second (/sl draws the world, its minimap
              and its overlays on separate canvases), plus the mark
     encode   the browser's own H.264 and AAC encoders (WebCodecs), one key
              frame a second, kept in memory as encoded chunks; anything older
              than 30 seconds (from a key frame) is dropped
     sound    every node a game connects to its speakers is also connected to a
              tap (AudioNode.prototype.connect, wrapped before any game sound
              exists), mixed with the mic in one AudioContext
     save     mp4mux.js turns the kept chunks into an ordinary MP4

   Off on phones and touch screens, without WebCodecs, on fewer than 4 cores,
   when the player switched it off (localStorage dsClipsOn = '0'), and on a PC
   that dropped frames while recording (tested once a week, dsClipPerf).

   It never costs the game a frame (Owen 2026-10-16, "pretty laggy"). Measured
   on his 240 Hz PC with slither in the lobby frame: on an idle PC recording is
   free, but on a busy one (other DuelSeries tabs sharing Chrome's GPU, test
   servers) it took the game from 85 to 75 fps with 60% more late frames. So it
   steps aside: nothing at all (no picture, no sound, no encoding) while its tab
   is hidden or nobody has touched the game for 45 s, as in a tab left open in
   another window, and no picture while the game's own frames run late.

   Loaded as <script src="/js/clip/clipRec.js" data-game="slither"> after
   mp4mux.js. window.DSClip = { on, save(), offer(why) }. */
(function () {
  const SCRIPT = document.currentScript;
  const GAME = (SCRIPT && SCRIPT.dataset.game) || 'game';
  const DOT = (SCRIPT && SCRIPT.dataset.dot) || 'tl';      // where the red dot sits: top left, or bottom left (bl)
  const KEEP_US = 30e6;          // what a clip holds
  const FPS = 30;
  const KEY_US = 1e6;            // a key frame each second of time, so a clip starts at most 1 s early
  const MAX_W = 1920, MAX_H = 1080;
  const OFFER_MS = 8000;
  const IDLE_MS = 45000;         // no key, click or mouse move for this long: nobody is playing this tab
  const LS_ON = 'dsClipsOn', LS_MIC = 'dsClipsMic', LS_PERF = 'dsClipPerf';
  const PERF_PASS_MS = 7 * 864e5, PERF_FAIL_MS = 864e5;

  const DSClip = { on: false, save: () => false, offer: () => {} };
  window.DSClip = DSClip;

  const ls = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
  const touchOnly = matchMedia('(hover:none) and (pointer:coarse)').matches;
  const mobileUA = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    || (navigator.userAgentData && navigator.userAgentData.mobile);
  const webcodecs = typeof VideoEncoder === 'function' && typeof VideoFrame === 'function'
    && typeof AudioEncoder === 'function' && typeof AudioData === 'function' && !!window.DSMp4;
  if (touchOnly || mobileUA || !webcodecs || (navigator.hardwareConcurrency || 8) < 4 || ls(LS_ON) === '0') return;
  const perf = (() => { try { return JSON.parse(ls(LS_PERF) || 'null'); } catch (_) { return null; } })();
  const perfFresh = perf && Date.now() - perf.at < (perf.ok ? PERF_PASS_MS : PERF_FAIL_MS);
  if (perfFresh && !perf.ok) return;

  /* ── sound: tap every connection to the speakers, from the start ───────── */
  let mixer = null, mixDest = null;
  const taps = new WeakMap();      // game AudioContext -> its MediaStreamAudioDestinationNode
  const origConnect = AudioNode.prototype.connect;
  function tapFor(ctx) {
    let t = taps.get(ctx);
    if (t) return t;
    t = ctx.createMediaStreamDestination();
    taps.set(ctx, t);
    if (mixer) mixer.createMediaStreamSource(t.stream).connect(mixDest);
    else pendingTaps.push(t);
    return t;
  }
  const pendingTaps = [];
  AudioNode.prototype.connect = function (dest) {
    const r = origConnect.apply(this, arguments);
    try {
      if (dest instanceof AudioDestinationNode && dest.context && dest.context !== mixer) origConnect.call(this, tapFor(dest.context));
    } catch (_) { /* a recorder problem never breaks a game's sound */ }
    return r;
  };

  /* ── state ─────────────────────────────────────────────────────────────── */
  let vEnc = null, aEnc = null, vDesc = null, aDesc = null, aRate = 48000;
  let vChunks = [], aChunks = [];
  let mirror = null, mctx = null, W = 0, H = 0;
  let T0 = performance.now(), frameNo = 0, lastKey = 0, lastCap = 0, running = false, failed = false;
  let layers = [], layersAt = 0;
  const usNow = () => Math.round((performance.now() - T0) * 1000);

  /* ── the picture ───────────────────────────────────────────────────────── */
  function size() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
    const k = Math.min(1, MAX_W / w, MAX_H / h);
    w = Math.max(2, Math.round((w * k) / 2) * 2); h = Math.max(2, Math.round((h * k) / 2) * 2);
    return [w, h];
  }
  // A canvas's place in the stacking order: its own z-index, or the nearest positioned ancestor's.
  function zOf(el) {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const z = parseInt(getComputedStyle(n).zIndex, 10);
      if (!Number.isNaN(z)) return z;
    }
    return 0;
  }
  function visible(el) {
    if (!el.width || !el.height) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const p = getComputedStyle(n);
      if (p.display === 'none' || p.visibility === 'hidden' || Number(p.opacity) === 0) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
  }
  function findLayers() {
    layers = Array.from(document.querySelectorAll('canvas'))
      .filter(c => c !== mirror && visible(c))
      .map((c, i) => ({ c, z: zOf(c), i }))
      .sort((a, b) => a.z - b.z || a.i - b.i)
      .map(x => { const o = Number(getComputedStyle(x.c).opacity); return { c: x.c, o: Number.isFinite(o) ? o : 1, r: x.c.getBoundingClientRect() }; });
    layersAt = performance.now();
  }
  let bg = '#000';
  function composite() {
    if (performance.now() - layersAt > 1000) {
      findLayers();
      const b = getComputedStyle(document.body).backgroundColor;
      bg = b && b !== 'rgba(0, 0, 0, 0)' && b !== 'transparent' ? b : '#000';
    }
    const kx = W / innerWidth, ky = H / innerHeight;
    mctx.globalAlpha = 1;
    mctx.fillStyle = bg;
    mctx.fillRect(0, 0, W, H);
    // Where each canvas sits is read once a second (findLayers), not per frame: a read here would force a layout of
    // the game's HUD 30 times a second.
    for (const { c, o, r } of layers) {
      mctx.globalAlpha = o;
      try { mctx.drawImage(c, r.left * kx, r.top * ky, r.width * kx, r.height * ky); } catch (_) {}
    }
    mctx.globalAlpha = 1;
    mark();
  }
  /* DuelSeries.com, bottom left (Owen: free advertising on every post), on a soft dark pill so it reads on
     slither's dark floor and on Paper.io's white one alike. */
  function mark() {
    const px = Math.max(14, Math.round(H * 0.022));
    mctx.font = '700 ' + px + 'px Archivo, "Segoe UI", system-ui, sans-serif';
    mctx.textBaseline = 'middle';
    const a = mctx.measureText('Duel').width, b = mctx.measureText('Series').width, c = mctx.measureText('.com').width;
    const padX = px * 0.6, h = px * 1.7, x = Math.round(px), y = H - Math.round(px) - h;
    mctx.fillStyle = 'rgba(16,14,11,.42)';
    mctx.beginPath();
    if (mctx.roundRect) mctx.roundRect(x, y, a + b + c + padX * 2, h, h / 2); else mctx.rect(x, y, a + b + c + padX * 2, h);
    mctx.fill();
    const tx = x + padX, ty = y + h / 2 + px * 0.04;
    mctx.fillStyle = 'rgba(245,241,232,.8)';
    mctx.fillText('Duel', tx, ty);
    mctx.fillStyle = 'rgba(240,168,48,.9)';
    mctx.fillText('Series', tx + a, ty);
    mctx.fillStyle = 'rgba(245,241,232,.8)';
    mctx.fillText('.com', tx + a + b, ty);
  }

  /* ── encoders ──────────────────────────────────────────────────────────── */
  async function pickCodec(w, h, bitrate) {
    for (const codec of ['avc1.640028', 'avc1.4D4028', 'avc1.42E028', 'avc1.42E01F']) {
      const cfg = { codec, width: w, height: h, bitrate, framerate: FPS, avc: { format: 'avc' }, latencyMode: 'realtime' };
      try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch (_) {}
    }
    return null;
  }
  async function startVideo() {
    [W, H] = size();
    if (!mirror) { mirror = document.createElement('canvas'); mctx = mirror.getContext('2d', { alpha: false }); }
    mirror.width = W; mirror.height = H;
    const bitrate = Math.round(Math.min(8e6, Math.max(2.5e6, W * H * FPS * 0.1)));
    const cfg = await pickCodec(W, H, bitrate);
    if (!cfg) { stop('no H.264 encoder'); return false; }
    if (vEnc) { try { vEnc.close(); } catch (_) {} }
    vChunks = []; vDesc = null; frameNo = 0;
    vEnc = new VideoEncoder({
      output: (chunk, meta) => {
        if (meta && meta.decoderConfig && meta.decoderConfig.description) vDesc = new Uint8Array(meta.decoderConfig.description);
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        vChunks.push({ data, ts: chunk.timestamp, key: chunk.type === 'key' });
        prune();
      },
      error: (e) => stop('video encoder: ' + (e && e.message)),
    });
    vEnc.configure(cfg);
    return true;
  }

  async function startAudio() {
    try {
      mixer = new AudioContext();
      mixDest = mixer.createMediaStreamDestination();
      aRate = mixer.sampleRate;
      // A silent source keeps the stream running before the game makes any sound (with no input Chrome sends nothing),
      // so every clip has one unbroken sound track.
      const hush = mixer.createConstantSource();
      hush.offset.value = 0;
      hush.connect(mixDest);
      hush.start();
      pendingTaps.splice(0).forEach(t => mixer.createMediaStreamSource(t.stream).connect(mixDest));
      if (ls(LS_MIC) === '1' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
          .then(s => { mixer.createMediaStreamSource(s).connect(mixDest); })
          .catch(() => { /* not allowed: game sound only */ });
      }
      const cfg = { codec: 'mp4a.40.2', sampleRate: aRate, numberOfChannels: 2, bitrate: 128000 };
      if (!(await AudioEncoder.isConfigSupported(cfg)).supported || typeof MediaStreamTrackProcessor !== 'function') return;
      aEnc = new AudioEncoder({
        output: (chunk, meta) => {
          if (meta && meta.decoderConfig && meta.decoderConfig.description) aDesc = new Uint8Array(meta.decoderConfig.description);
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          aChunks.push({ data, ts: chunk.timestamp });
          // prune() trims the sound with the picture; this bounds it while there is no picture (a late stretch).
          const old = chunk.timestamp - KEEP_US - 2e6;
          if (aChunks[0].ts < old) { let j = 0; while (j < aChunks.length && aChunks[j].ts < old) j++; aChunks.splice(0, j); }
        },
        error: () => { aEnc = null; aChunks = []; },
      });
      aEnc.configure(cfg);
      const reader = new MediaStreamTrackProcessor({ track: mixDest.stream.getAudioTracks()[0] }).readable.getReader();
      pumpAudio(reader);
      // The mixer only runs once the page has had a gesture; games get one at the first key or click.
      const wake = () => { if (mixer && mixer.state === 'suspended' && !asleep) mixer.resume().catch(() => {}); };
      if (asleep) mixer.suspend().catch(() => {});
      wake();
      ['keydown', 'pointerdown'].forEach(t => addEventListener(t, wake, { capture: true, passive: true }));
    } catch (_) { aEnc = null; }
  }
  /* Restamped on this page's clock, so sound and picture line up: samples are counted from where the first one
     landed, and re-anchored if the stream ever falls more than 150 ms off (a hidden tab, a stall). */
  async function pumpAudio(reader) {
    let base = null, count = 0;
    for (;;) {
      let r;
      try { r = await reader.read(); } catch (_) { return; }
      if (r.done || !running && failed) { if (r.value) r.value.close(); return; }
      const ad = r.value;
      if (!aEnc || !running || asleep) { ad.close(); continue; }
      const n = ad.numberOfFrames, ch = Math.min(2, ad.numberOfChannels);
      const durUs = (n / ad.sampleRate) * 1e6;
      const arrive = usNow() - durUs;
      let ts = base === null ? null : base + (count / ad.sampleRate) * 1e6;
      if (ts === null || Math.abs(ts - arrive) > 150000) { base = arrive; count = 0; ts = arrive; }
      count += n;
      try {
        const buf = new Float32Array(n * 2);
        ad.copyTo(buf.subarray(0, n), { planeIndex: 0, format: 'f32-planar' });
        ad.copyTo(buf.subarray(n), { planeIndex: ch > 1 ? 1 : 0, format: 'f32-planar' });
        const out = new AudioData({ format: 'f32-planar', sampleRate: ad.sampleRate, numberOfFrames: n,
                                    numberOfChannels: 2, timestamp: Math.round(ts), data: buf });
        aEnc.encode(out);
        out.close();
      } catch (_) { /* one block lost, not the recorder */ }
      ad.close();
    }
  }

  // Keep 30 seconds from a key frame; sound from just before the first kept frame.
  function prune() {
    while (vChunks.length && !vChunks[0].key) vChunks.shift();
    if (vChunks.length < 2) return;
    const cut = vChunks[vChunks.length - 1].ts - KEEP_US;
    let k = 0;
    for (let i = 0; i < vChunks.length; i++) {
      if (vChunks[i].ts > cut) break;
      if (vChunks[i].key) k = i;
    }
    if (k > 0) vChunks.splice(0, k);
    const a0 = vChunks[0].ts - 200000;
    let j = 0;
    while (j < aChunks.length && aChunks[j].ts < a0) j++;
    if (j) aChunks.splice(0, j);
  }

  /* ── the loop ──────────────────────────────────────────────────────────── */
  function tick(now) {
    if (!running) return;
    requestAnimationFrame(tick);
    sampleFps(now);
    pace(now);
    if (!asleep && now - lastInput > IDLE_MS) doze();
    if (asleep || now < lateUntil || !capturing || now - lastCap < 1000 / FPS - 3) return;
    lastCap = now;
    if (vEnc.encodeQueueSize > 4) { slow++; if (slow > FPS * 3) stop('the encoder cannot keep up', true); return; }
    slow = 0;
    const [w, h] = size();
    if (w !== W || h !== H) { capturing = false; startVideo().then(ok => { capturing = ok; }); return; }
    composite();
    let f;
    try {
      const ts = usNow();
      // By time, not by frame count: a stretch with no picture (the game came first) must not stretch the key frames.
      const key = frameNo === 0 || ts - lastKey >= KEY_US - 20000;
      if (key) lastKey = ts;
      f = new VideoFrame(mirror, { timestamp: ts });
      vEnc.encode(f, { keyFrame: key });
      frameNo++;
    } catch (_) { /* a frame lost */ }
    if (f) f.close();
  }
  let capturing = false, slow = 0;

  /* ── the game first ────────────────────────────────────────────────────── */
  /* The game's own pace: each second's median frame time; the best of the last 10 s is the screen's pace (240 Hz,
     60 Hz, whatever this window is on). A frame is late when it is a stutter you can see: over 1.5x that pace and
     over 20 ms (at 240 Hz one missed refresh is 8 ms and still smooth). A second with over 5% of its frames late
     means the PC is short of time, and the picture stops for 2 s, then 4, 8, up to 16 s while it stays short (calm
     again for 10 s resets it). The clip holds a still frame over that stretch; the sound keeps going. */
  let paceMed = [], gaps = [], secAt = 0, lastNow = 0, lateUntil = 0, lateBack = 2000, yields = 0;
  function pace(now) {
    if (lastNow) gaps.push(now - lastNow);
    lastNow = now;
    if (now - secAt < 1000) return;
    secAt = now;
    const g = gaps.sort((a, b) => a - b);
    gaps = [];
    if (g.length < 5) return;
    paceMed.push(g[g.length >> 1]);
    if (paceMed.length > 10) paceMed.shift();
    const lim = Math.max(Math.min.apply(null, paceMed) * 1.5, 20);
    let late = 0;
    for (const x of g) if (x > lim) late++;
    if (paceMed.length >= 2 && late > g.length * 0.05) { lateUntil = now + lateBack; lateBack = Math.min(16000, lateBack * 2); yields++; }
    else if (now > lateUntil + 10000) lateBack = 2000;
  }

  /* Asleep: no picture, no sound, no encoding. While the tab is hidden (a gap would be one frame lasting minutes)
     and after IDLE_MS with no input. Waking starts the buffer again. */
  let asleep = false, lastInput = performance.now();
  function doze() {
    if (asleep) return;
    asleep = true;
    if (mixer && mixer.state === 'running') mixer.suspend().catch(() => {});
  }
  function rouse() {
    if (!asleep || !running || document.hidden) return;
    asleep = false;
    vChunks = []; aChunks = []; frameNo = 0;
    lastNow = 0; gaps = []; secAt = performance.now();
    if (mixer && mixer.state === 'suspended') mixer.resume().catch(() => {});
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) doze();
    else if (performance.now() - lastInput < IDLE_MS) rouse();
  });
  const touched = () => { lastInput = performance.now(); if (asleep) rouse(); };
  ['pointermove', 'pointerdown', 'keydown', 'wheel'].forEach(t => addEventListener(t, touched, { capture: true, passive: true }));

  /* ── does recording cost this PC frames? (once a week) ─────────────────── */
  let fpsStamps = [];
  function sampleFps(now) {
    fpsStamps.push(now);
    if (fpsStamps.length > 240) fpsStamps.splice(0, fpsStamps.length - 240);
  }
  function fpsOver(ms) {
    const now = performance.now();
    const s = fpsStamps.filter(t => now - t <= ms);
    return s.length > 1 ? ((s.length - 1) * 1000) / (s[s.length - 1] - s[0]) : 0;
  }
  async function perfTest() {
    await new Promise(r => setTimeout(r, 2500));
    const off = fpsOver(2000);
    capturing = true;
    await new Promise(r => setTimeout(r, 3000));
    const on = fpsOver(2000);
    if (!running) return;
    const ok = !(off > 0 && on < off * 0.8 && on < 50);
    lsSet(LS_PERF, JSON.stringify({ ok: ok ? 1 : 0, at: Date.now(), off: Math.round(off), on: Math.round(on) }));
    if (!ok) stop('drops frames', true);
  }

  function stop(why, tell) {
    running = false; capturing = false; failed = true; DSClip.on = false;
    try { if (vEnc) vEnc.close(); } catch (_) {}
    try { if (aEnc) aEnc.close(); } catch (_) {}
    vEnc = aEnc = null; vChunks = []; aChunks = [];
    dot(false);
    if (tell) toast('err', 'Clips are off on this PC', 'It was dropping frames while recording.');
    if (window.console) console.warn('[clips] off: ' + why);
  }

  /* ── saving ────────────────────────────────────────────────────────────── */
  let lastSave = 0;
  let last = null;      // the clip last built, kept so its Share button sends exactly that one
  const isBr = () => { const sl = window.DuelSlither && window.DuelSlither.slx; return !!(sl && typeof sl.brAuth === 'function'); };
  const muxOf = (v, a) => window.DSMp4.mux({
    video: { width: W, height: H, description: vDesc, chunks: v },
    audio: a ? { sampleRate: aRate, channels: 2, description: aDesc, chunks: a } : null,
  });
  // The clip held right now, as an MP4 plus a still of its last frame for the card on the Clips wall.
  function build() {
    const v = vChunks.slice();
    while (v.length && !v[0].key) v.shift();     // frames still in the encoder when the buffer restarted
    if (!v.length) throw new Error('no key frame yet');
    const a = aEnc && aChunks.length ? aChunks.slice() : null;
    const bytes = muxOf(v, a);
    const secs = Math.max(1, Math.round((v[v.length - 1].ts - v[0].ts) / 1e6));
    return { v, a, bytes, secs, game: isBr() ? 'br' : GAME, poster: still(), shared: false, sharing: false };
  }
  // A 640-wide JPEG of the picture as it is now (the last frame of the clip), or null.
  function still() {
    return new Promise((resolve) => {
      try {
        const k = Math.min(1, 640 / W);
        const c = document.createElement('canvas');
        c.width = Math.round(W * k); c.height = Math.round(H * k);
        c.getContext('2d').drawImage(mirror, 0, 0, c.width, c.height);
        c.toBlob((b) => resolve(b && b.size > 0 && b.size <= 380 * 1024 ? b : null), 'image/jpeg', 0.8);
      } catch (_) { resolve(null); }
    });
  }
  function save() {
    if (!running || !vChunks.length || !vDesc) { toast('info', 'Nothing to save yet', 'Clips start a few seconds into a game.'); return false; }
    if (performance.now() - lastSave < 2000) return false;
    lastSave = performance.now();
    hideOffer();
    try {
      const clip = build();
      last = clip;
      const url = URL.createObjectURL(new Blob([clip.bytes], { type: 'video/mp4' }));
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const name = 'duelseries-' + (clip.game === 'br' ? 'battle-royale' : GAME) + '-' + d.getFullYear() + '-' + p2(d.getMonth() + 1)
        + '-' + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()) + '.mp4';
      const a2 = document.createElement('a');
      a2.href = url; a2.download = name; a2.style.display = 'none';
      document.documentElement.appendChild(a2);
      a2.click();
      a2.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      askShare(clip);
      return true;
    } catch (e) {
      toast('err', 'Could not save the clip', 'Try again in a moment.');
      return false;
    }
  }
  DSClip.save = save;

  /* ── sharing to DuelSeries (Owen 2026-10-16) ─────────────────────────────
     The clip goes from this browser straight to DuelSeries' clip storage with a
     link the server signs for exactly its size (server/clips.js), so it never
     passes through the game server. The server then checks it really is a short
     MP4 and it waits for the owner's approval before anyone else can see it.
     Needs the player logged in: the lobby (this page's parent) holds the wallet
     that signs the request, the same one every game uses to say who is playing. */
  const UP_MAX = 25 * 1024 * 1024;
  function lobby() {
    try {
      const h = window.parent && window.parent !== window ? window.parent : window;
      const w = h.duelWallet || {};
      return w.authenticated && w.address && typeof h.duelWalletSignAction === 'function' ? h : null;
    } catch (_) { return null; }      // a parent on another origin
  }
  // Over the size a share may be: the oldest seconds go, a key frame at a time, until it fits.
  function fit(clip) {
    if (clip.bytes.length <= UP_MAX) return clip.bytes;
    let v = clip.v;
    for (let tries = 0; tries < 40; tries++) {
      const over = muxOf(v, clip.a).length - UP_MAX;
      if (over <= 0) return muxOf(v, clip.a);
      let cut = 0, i = 1;
      for (; i < v.length; i++) { cut += v[i - 1].data.byteLength; if (v[i].key && cut >= over * 0.6) break; }
      if (i >= v.length) break;
      v = v.slice(i);
    }
    return null;
  }
  async function post(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let j = {};
    try { j = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error(j.error || 'Something went wrong. Try again.');
    return j;
  }
  function put(url, blob, type, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('PUT', url);
      x.setRequestHeader('Content-Type', type);
      x.setRequestHeader('If-None-Match', '*');      // the link is signed to write its file once
      x.timeout = 5 * 60 * 1000;
      if (onProgress) x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      x.onload = () => (x.status >= 200 && x.status < 300 ? resolve() : reject(new Error('The upload was refused. Try again.')));
      x.onerror = x.ontimeout = () => reject(new Error('The upload did not finish. Check your connection and try again.'));
      x.send(blob);
    });
  }
  async function share(clip) {
    if (!clip || clip.sharing) return;
    if (clip.shared) { toast('info', 'Already shared', 'DuelSeries reviews it before anyone else can see it.'); return; }
    const host = lobby();
    if (!host) { toast('err', 'Log in to share clips', 'Log in on DuelSeries, then press P again.'); return; }
    clip.sharing = true;
    hideOffer();
    const bar = progress('Sharing clip');
    try {
      const bytes = fit(clip);
      if (!bytes) throw new Error('This clip is too big to share.');
      const poster = await clip.poster;
      const args = { size: bytes.length, psize: poster ? poster.size : 0, game: clip.game };
      const proof = await Promise.race([
        host.duelWalletSignAction('clip:upload', args),
        new Promise((_, no) => setTimeout(() => no(new Error('The wallet did not answer. Try again.')), 10000)),
      ]);
      if (!proof) throw new Error('Log in on DuelSeries, then try again.');
      const up = await post('/api/clips/upload', proof);
      await put(up.video, new Blob([bytes], { type: 'video/mp4' }), 'video/mp4', (f) => bar(f * 0.95));
      if (poster && up.poster) await put(up.poster, poster, 'image/jpeg').catch(() => {});   // the card falls back to game art
      bar(1);
      const done = await post('/api/clips/uploaded', { id: up.id, ticket: up.ticket });
      clip.shared = true;
      toast('ok', 'Sent for review', 'It shows in Clips once it is approved. Delete it there any time.');
    } catch (e) {
      toast('err', 'Could not share the clip', (e && e.message) || 'Try again in a moment.');
    } finally { clip.sharing = false; }
  }
  DSClip.share = () => share(last);
  // For a console check: what is being recorded right now.
  DSClip.stats = () => ({ on: running, capturing, asleep, late: performance.now() < lateUntil, yields, size: W + 'x' + H, layers: layers.length,
    seconds: vChunks.length > 1 ? Math.round((vChunks[vChunks.length - 1].ts - vChunks[0].ts) / 1e5) / 10 : 0,
    audio: !!aEnc && aChunks.length > 0, mixer: mixer ? mixer.state : 'none', hooked, mb: Math.round(vChunks.concat(aChunks).reduce((n, c) => n + c.data.length, 0) / 1e5) / 10 });

  /* ── what the player sees (look A: the lobby's toast, top centre) ─────── */
  const CSS = `
.dsclip-t{position:fixed;left:50%;top:14px;z-index:2147483000;display:flex;gap:11px;align-items:center;
  padding:10px 12px 10px 14px;border-radius:14px;color:#f5f1e8;font:500 13px/1.3 Archivo,"Segoe UI",system-ui,sans-serif;
  background:linear-gradient(var(--tint),var(--tint)),rgba(23,20,15,.94);border:1px solid var(--edge);
  box-shadow:0 10px 30px rgba(0,0,0,.5);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);white-space:nowrap;
  opacity:0;transform:translate(-50%,-10px);transition:opacity .22s,transform .3s cubic-bezier(.2,.9,.3,1);pointer-events:auto}
.dsclip-t.on{opacity:1;transform:translate(-50%,0)}
.dsclip-t.ok{--tc:#8ed081;--tint:rgba(142,208,129,.14);--edge:rgba(142,208,129,.45)}
.dsclip-t.info{--tc:#f5f1e8;--tint:rgba(245,241,232,.07);--edge:rgba(245,241,232,.2)}
.dsclip-t.err{--tc:#e0705f;--tint:rgba(224,112,95,.14);--edge:rgba(224,112,95,.5)}
.dsclip-t .ic{color:var(--tc);font-weight:700;width:14px;text-align:center}
.dsclip-t b{font-size:13.5px;font-weight:620}
.dsclip-t .ln{font-size:12px;color:#a89c8a;margin-left:6px}
.dsclip-t button{border:0;cursor:pointer;background:#f4f1ea;color:#100e0b;font:650 12px/1 Archivo,"Segoe UI",system-ui,sans-serif;
  padding:7px 10px;border-radius:8px;display:inline-flex;gap:6px;align-items:center}
.dsclip-t button:hover{background:#fff}
.dsclip-t button.sec{background:rgba(245,241,232,.12);color:#f5f1e8}
.dsclip-t button.sec:hover{background:rgba(245,241,232,.22)}
.dsclip-t .num{font-variant-numeric:tabular-nums}
.dsclip-t .th{position:relative;flex:none;width:96px;height:54px;border-radius:8px;overflow:hidden;background:#000}
.dsclip-t .th img,.dsclip-t .th video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.dsclip-t .tx{display:flex;flex-direction:column;gap:4px}
.dsclip-t .q{font-size:12px;color:#d9d1c3}
.dsclip-t button:focus-visible{outline:2px solid #f4f1ea;outline-offset:2px}
.dsclip-t .key{display:inline-grid;place-items:center;min-width:20px;height:20px;padding:0 5px;border-radius:5px;
  font:600 11.5px/1 "IBM Plex Mono",ui-monospace,Consolas,monospace;background:rgba(245,241,232,.12);
  border:1px solid rgba(245,241,232,.28);color:#f5f1e8;margin-left:4px}
.dsclip-t .bar{position:absolute;left:14px;right:14px;bottom:4px;height:2px;border-radius:2px;background:rgba(245,241,232,.12);overflow:hidden}
.dsclip-t .bar i{position:absolute;inset:0;background:#a89c8a;transform-origin:left;animation:dsclip-bar linear forwards}
@keyframes dsclip-bar{from{transform:scaleX(1)}to{transform:scaleX(0)}}
.dsclip-dot{position:fixed;left:12px;top:10px;z-index:2147482999;display:flex;gap:6px;align-items:center;pointer-events:none;
  font:600 10.5px/1 "IBM Plex Mono",ui-monospace,Consolas,monospace;color:rgba(255,255,255,.8);text-shadow:0 1px 2px rgba(0,0,0,.6)}
.dsclip-dot.bl{top:auto;bottom:10px}
.dsclip-dot i{width:7px;height:7px;border-radius:50%;background:#e5534b;box-shadow:0 0 0 2px rgba(0,0,0,.25)}
@media (prefers-reduced-motion:reduce){.dsclip-t{transition:none}.dsclip-t .bar i{animation:none}}`;
  let styled = false;
  function style() {
    if (styled) return;
    const s = document.createElement('style');
    s.textContent = CSS;
    document.head.appendChild(s);
    styled = true;
  }
  let card = null, cardTimer = 0, offering = false;
  function show(kind, build, ms) {
    style();
    if (!card) {
      card = document.createElement('div');
      card.setAttribute('role', 'status');
      card.setAttribute('aria-live', 'polite');
      document.documentElement.appendChild(card);
    }
    clearTimeout(cardTimer);
    if (asking) { asking(); asking = null; }
    card.onmouseenter = card.onmouseleave = null;
    card.className = 'dsclip-t ' + kind;
    card.textContent = '';
    build(card);
    requestAnimationFrame(() => card && card.classList.add('on'));
    cardTimer = setTimeout(hide, ms);
  }
  function hide() {
    offering = false;
    if (card) card.classList.remove('on');
  }
  function hideOffer() { if (offering) hide(); }
  const el = (t, cls, text) => { const n = document.createElement(t); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  // A toast that stays up while a clip uploads; returns a function taking the fraction done.
  function progress(title) {
    offering = false;
    let pct = null;
    show('info', (c) => {
      c.appendChild(el('span', 'ic', '\u2191'));
      const t = el('div');
      t.appendChild(el('b', '', title));
      pct = el('span', 'ln num', '0%');
      t.appendChild(pct);
      c.appendChild(t);
    }, 6 * 60 * 1000);
    return (f) => { if (pct) pct.textContent = Math.round(Math.max(0, Math.min(1, f)) * 100) + '%'; };
  }
  function toast(kind, title, line, opts) {
    const o = opts || {};
    offering = false;
    show(kind, (c) => {
      c.appendChild(el('span', 'ic', kind === 'ok' ? '\u2713' : kind === 'err' ? '\u2715' : 'i'));
      const t = el('div');
      t.appendChild(el('b', '', title));
      if (line) t.appendChild(el('span', 'ln', line));
      c.appendChild(t);
      if (o.post) {
        const b = el('button', 'sec', null);
        b.type = 'button';
        b.appendChild(el('span', '', 'X'));
        b.appendChild(document.createTextNode('Post'));
        b.title = 'Opens X with the text ready; attach the clip from your Downloads';
        b.onclick = (e) => {
          e.stopPropagation();
          window.open('https://x.com/intent/post?text=' + encodeURIComponent('A clip from DuelSeries')
            + '&url=' + encodeURIComponent('https://duelseries.com'), '_blank', 'noopener,noreferrer');
        };
        c.appendChild(b);
      }
    }, kind === 'err' ? 5200 : 6000);
  }
  /* After P saved a clip: should it also go to DuelSeries? (Owen 2026-10-16: P alone never uploads; sharing is
     its own deliberate click, with a look at the clip and a plain word that it is reviewed first.) The same top
     centre card as every clip note, never a window over the game: it takes no keys and no focus, waits while the
     pointer is on it, and goes by itself after a few seconds, which shares nothing, like Not now. */
  const ASK_MS = 12000;
  function askShare(clip) {
    offering = false;
    let thumbUrl = '', vidUrl = '';
    show('ok', (c) => {
      const pic = el('span', 'th');
      const img = el('img');
      img.alt = '';
      pic.appendChild(img);
      clip.poster.then((b) => { if (b && card && card.contains(img)) { thumbUrl = URL.createObjectURL(b); img.src = thumbUrl; } });
      // The clip itself plays, muted, only while the pointer is on its picture.
      pic.onmouseenter = () => {
        if (pic.querySelector('video')) return;
        const v = el('video');
        v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true;
        vidUrl = vidUrl || URL.createObjectURL(new Blob([clip.bytes], { type: 'video/mp4' }));
        v.src = vidUrl;
        pic.appendChild(v);
      };
      pic.onmouseleave = () => { const v = pic.querySelector('video'); if (v) { v.pause(); v.remove(); } };
      c.appendChild(pic);
      const t = el('div', 'tx');
      const top = el('div');
      top.appendChild(el('b', '', 'Clip saved'));
      top.appendChild(el('span', 'ln', 'last ' + clip.secs + ' s, in Downloads'));
      t.appendChild(top);
      t.appendChild(el('span', 'q', 'Share it to DuelSeries? It is reviewed before anyone else can see it.'));
      c.appendChild(t);
      const yes = el('button', '', 'Share to DuelSeries');
      yes.type = 'button';
      yes.onclick = (e) => { e.stopPropagation(); share(clip); };
      const no = el('button', 'sec', 'Not now');
      no.type = 'button';
      no.onclick = (e) => { e.stopPropagation(); hide(); };
      const x = el('button', 'sec', 'X');
      x.type = 'button';
      x.title = 'Post on X: opens X with the text ready; attach the clip from your Downloads';
      x.setAttribute('aria-label', 'Post on X');
      x.onclick = (e) => {
        e.stopPropagation();
        window.open('https://x.com/intent/post?text=' + encodeURIComponent('A clip from DuelSeries')
          + '&url=' + encodeURIComponent('https://duelseries.com'), '_blank', 'noopener,noreferrer');
      };
      c.appendChild(yes); c.appendChild(no); c.appendChild(x);
      // Waits while the pointer is on it.
      c.onmouseenter = () => clearTimeout(cardTimer);
      c.onmouseleave = () => { clearTimeout(cardTimer); cardTimer = setTimeout(hide, 5000); };
    }, ASK_MS);
    asking = () => { if (thumbUrl) URL.revokeObjectURL(thumbUrl); if (vidUrl) URL.revokeObjectURL(vidUrl); thumbUrl = vidUrl = ''; };
  }
  let asking = null;      // frees the prompt's picture and video once another card replaces it

  // After a cash-out or a win: an offer that runs out by itself.
  function offer() {
    if (!running || !vChunks.length) return;
    show('info', (c) => {
      const t = el('div');
      t.appendChild(el('b', '', 'Save this as a clip?'));
      const ln = el('span', 'ln', 'press');
      ln.appendChild(el('span', 'key', 'P'));
      t.appendChild(ln);
      c.appendChild(t);
      const b = el('button', '', 'Save clip');
      b.type = 'button';
      b.onclick = (e) => { e.stopPropagation(); save(); };
      c.appendChild(b);
      const bar = el('span', 'bar');
      const i = el('i');
      i.style.animationDuration = OFFER_MS + 'ms';
      bar.appendChild(i);
      c.appendChild(bar);
    }, OFFER_MS);
    offering = true;
  }
  DSClip.offer = offer;

  let dotEl = null;
  function dot(on) {
    if (!on) { if (dotEl) dotEl.remove(); dotEl = null; return; }
    style();
    if (dotEl) return;
    dotEl = el('div', 'dsclip-dot' + (DOT === 'bl' ? ' bl' : ''));
    dotEl.setAttribute('aria-hidden', 'true');
    dotEl.appendChild(el('i'));
    dotEl.appendChild(document.createTextNode('P clip'));
    document.documentElement.appendChild(dotEl);
  }

  /* ── P, and the big moments of each game ──────────────────────────────── */
  addEventListener('keydown', (e) => {
    if (e.code !== 'KeyP' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    // Typing a chat line or a name: only a field on screen. slither keeps focus in its hidden nickname box all game.
    const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (typing && t.getClientRects().length && getComputedStyle(t).visibility !== 'hidden') return;
    if (!running) return;
    e.preventDefault();
    save();
  }, true);

  // Hooks onto each game's own events once its object exists; nothing in the games is edited for this.
  function hookGames() {
    let done = false;
    const sl = window.DuelSlither && window.DuelSlither.slx;
    if (sl && typeof sl.on === 'function') {
      sl.on('x:cashed', () => offer());
      hooked = 'slither';
      done = true;
    }
    const ag = window.duelAgar;
    if (ag && typeof ag.onServer === 'function') { ag.onServer('ag:cashedout', () => offer()); hooked = 'agar'; done = true; }
    const pp = window.DuelPaperLib && window.DuelPaperLib.arena;
    if (pp && pp.net && typeof pp.net.on === 'function') { pp.net.on('pp:cashedout', () => offer()); hooked = 'paper'; done = true; }
    return done;
  }
  let hookTries = 0, hooked = '';
  const hookTimer = setInterval(() => { if (hookGames() || ++hookTries > 60) clearInterval(hookTimer); }, 500);

  /* ── start ─────────────────────────────────────────────────────────────── */
  async function start() {
    if (running || failed) return;
    T0 = performance.now();
    if (!(await startVideo())) return;
    running = true;
    DSClip.on = true;
    if (document.hidden) doze();
    dot(true);
    requestAnimationFrame(tick);
    startAudio();
    if (perfFresh) capturing = true; else perfTest();
  }
  if (document.readyState === 'complete') setTimeout(start, 500);
  else addEventListener('load', () => setTimeout(start, 500), { once: true });
})();
