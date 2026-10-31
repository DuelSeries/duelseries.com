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
              hidden canvas of at most 1280x720, 30 times a second (/sl draws the world, its minimap
              and its overlays on separate canvases), the page's HTML over the game (end card, chat,
              HUD, the lobby's toasts: "what is over the game" below), plus the mark
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

   A smaller picture (2026-10-28): the hidden canvas was up to 1920x1080 and is
   now at most 1280x720 (a 1080p or bigger screen records 1280x720, a 1280x800
   window 1152x720). Nearly all of the picture's cost is the encoder taking each
   frame, and that grows with the pixels; copying the game's canvases onto the
   hidden one costs next to nothing. Measured in headless Chrome at 1920x1080 and
   240 Hz, against the same page with recording off (in-page A/B on a busy 2D
   canvas): the game's thread paid 71 ms a second more, now 39; Chrome's GPU
   process 227, now 134. In the games themselves (same A/B, noisier) the GPU
   process paid 337 more on Agar.io, now 214, and 344 on Paper.io, now 202.
   960x540 or 24 a second saved nothing more measurable.
   The rest is the sound (12 ms a second) and the frame watch above (4). The
   graphics card's encoder is already used: no hardwareAcceleration means try it
   first and fall back to software if it fails, where prefer-hardware would stop
   the recorder instead (prefer-software moved 250 ms a second onto the CPU).

   Loaded as <script src="/js/clip/clipRec.js" data-game="slither"> after
   mp4mux.js. window.DSClip = { on, save(), offer(why) }.

   The whole screen (Owen 2026-10-17, "it should show my mouse and everything
   that my screen sees"): the lobby loads this too, with data-top="1". There it
   records nothing until the player turns on Settings > Clips > Record the whole
   screen; then, at that click or the next P, the browser asks once to share this
   tab (getDisplayMedia, preferCurrentTab), and the lobby keeps the same 30
   seconds of the tab itself: lobby, games, end cards, toasts, with the tab's
   sound and a drawn mouse (tab capture leaves the cursor out). The lobby page
   never reloads between games, so one permission lasts the visit. While it
   records, each game's own recorder stands down and hands P, the cash-out offer,
   its mouse and its input to it; a no, a missing API or Stop sharing leaves the
   game's own recorder doing what it always did. */
(function () {
  const SCRIPT = document.currentScript;
  const GAME = (SCRIPT && SCRIPT.dataset.game) || 'game';
  const DOT = (SCRIPT && SCRIPT.dataset.dot) || 'tl';      // where the red dot sits: top left, or bottom left (bl)
  // data-light: the game's map is light (Agar.io, Paper.io), so the hint is dark text; white on it was near invisible
  // (site sweep 2026-10-28).
  const LIGHT = !!(SCRIPT && SCRIPT.dataset.light);
  const TOP = !!(SCRIPT && SCRIPT.dataset.top);            // the lobby: whole-tab recording only, when switched on
  const KEEP_US = 30e6;          // what a clip holds
  const FPS = 30;
  const KEY_US = 1e6;            // a key frame each second of time, so a clip starts at most 1 s early
  const MAX_W = 1280, MAX_H = 720;     // was 1920x1080: half the encoding cost, see "A smaller picture" above
  const OFFER_MS = 8000;
  const IDLE_MS = 45000;         // no key, click or mouse move for this long: nobody is playing this tab
  const LS_ON = 'dsClipsOn', LS_MIC = 'dsClipsMic', LS_PERF = 'dsClipPerf';
  const LS_TAB = 'dsClipsTab';
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
  // The lobby's copy reads the switch at the click and at P instead, so turning clips on needs no reload.
  if (touchOnly || mobileUA || !webcodecs || (navigator.hardwareConcurrency || 8) < 4 || (!TOP && ls(LS_ON) === '0')) return;
  const perf = (() => { try { return JSON.parse(ls(LS_PERF) || 'null'); } catch (_) { return null; } })();
  const perfFresh = perf && Date.now() - perf.at < (perf.ok ? PERF_PASS_MS : PERF_FAIL_MS);
  if (perfFresh && !perf.ok && !TOP) return;

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
  // Not in the lobby: the tab's own sound track already holds everything the tab plays.
  if (!TOP) AudioNode.prototype.connect = function (dest) {
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
  function zOf(el, win) {
    for (let n = el; n && n !== n.ownerDocument.documentElement; n = n.parentElement) {
      const z = parseInt((win || window).getComputedStyle(n).zIndex, 10);
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
  // A canvas inside a positioned box (slither's minimap in its round frame) is drawn over that box's picture.
  function boxed(c) {
    for (let n = c.parentElement; n && n !== document.body; n = n.parentElement) if (getComputedStyle(n).position !== 'static') return true;
    return false;
  }
  function findLayers() {
    layers = Array.from(document.querySelectorAll('canvas'))
      .filter(c => c !== mirror && visible(c))
      .map((c, i) => ({ c, z: zOf(c), i }))
      .sort((a, b) => a.z - b.z || a.i - b.i)
      .map(x => { const o = Number(getComputedStyle(x.c).opacity); return { c: x.c, z: x.z, o: Number.isFinite(o) ? o : 1, r: x.c.getBoundingClientRect(),
        boxed: boxed(x.c), w: x.c.width, h: x.c.height }; });
    // The game itself: the biggest canvas not in a box. What is over it is drawn as the page's picture (overlays below).
    base = null;
    for (const L of layers) if (!L.boxed && (!base || L.r.width * L.r.height > base.r.width * base.r.height)) base = L;
    layersAt = performance.now();
  }
  let bg = '#000', base = null;
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
    // the game's HUD 30 times a second. A canvas that changed size (slither's ring grows when a hold starts) is
    // found again at the next frame.
    const own = ovs[0], top = ovs[1];
    const over = own && own.ready ? own.zTop : Infinity;
    for (const L of layers) if (!L.boxed && L.z <= over) draw(L, kx, ky);
    mctx.globalAlpha = 1;
    if (own && own.ready) mctx.drawImage(own.c, 0, 0, W, H);
    for (const L of layers) if (L.boxed || L.z > over) draw(L, kx, ky);
    mctx.globalAlpha = 1;
    if (top && top.ready) mctx.drawImage(top.c, 0, 0, W, H);
    mark();
  }
  function draw(L, kx, ky) {
    const { c, o, r } = L;
    if (c.width !== L.w || c.height !== L.h) layersAt = 0;
    mctx.globalAlpha = o;
    try { mctx.drawImage(c, r.left * kx, r.top * ky, r.width * kx, r.height * ky); } catch (_) {}
  }
  /* DuelSeries.com, bottom left (Owen: free advertising on every post), on a soft dark pill so it reads on
     slither's dark floor and on Paper.io's white one alike. Over a game it steps up above any of the game's own
     words in that corner (Paper's chat hint), now that those are in the video too (liftFor, below). */
  let markBox = null;
  function mark() {
    const px = Math.max(14, Math.round(H * 0.022));
    mctx.font = '700 ' + px + 'px Archivo, "Segoe UI", system-ui, sans-serif';
    mctx.textBaseline = 'middle';
    const a = mctx.measureText('Duel').width, b = mctx.measureText('Series').width, c = mctx.measureText('.com').width;
    const lift = ovs.length && ovs[0].ready ? Math.round(ovs[0].lift * (H / innerHeight)) : 0;
    const padX = px * 0.6, h = px * 1.7, x = Math.round(px), y = H - Math.round(px) - h - lift;
    markBox = { x, w: a + b + c + padX * 2, h, m: Math.round(px) };
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

  /* ── what is over the game (Owen 2026-10-30) ─────────────────────────────
     "Everything a player sees in a game": the end card with its coin and amount, the chat, the leaderboard and HUD,
     scores, timers, the kill feed, the Spectate bar, and the lobby's toasts over the game's frame. Tab capture shows
     all that but makes Chrome put up its "sharing this tab" bar, so a clip draws it instead: a copy of the page's
     HTML over the game, with the page's own styles and fonts, inside an SVG image, which the browser lays out exactly
     as on screen. That picture goes between the game's canvases and any canvas boxed inside it (slither's minimap).
     It is made again only when something in it changes (a MutationObserver; a short CSS motion, like the end card
     rising, gets one picture once it has settled, a longer one a picture each time, held where it was), at most 10
     times a second and 2% of the page's time, in the browser's idle time; every frame in between reuses the last one. Left out: the ping and FPS readout, this recorder's own
     notes, and any wallet address.
     The lobby's copy (the whole tab) has none of this: the tab capture holds it already. */
  const OV_HIDE = '.dsp-hud,.dsclip-t,.dsclip-dot,[data-clip-hide]';
  const B58 = '[1-9A-HJ-NP-Za-km-z]';
  // A Solana address, whole or as the lobby shortens it (7xKp…3fA2), wherever it shows (a chat line, a toast).
  const OV_ADDR = new RegExp(B58 + '{32,44}|' + B58 + '{4,8}\u2026' + B58 + '{4,8}', 'g');
  const OV_SKIP = /^(SCRIPT|STYLE|LINK|META|NOSCRIPT|TEMPLATE|IFRAME|FRAME|VIDEO|AUDIO|OBJECT|EMBED)$/;
  const OV_GAP = 100, OV_SHARE = 0.02;
  // In the copy: no motion of its own (see freeze below), no page colour over the game, no text cursor.
  const OV_CSS = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'
    + 'html,body{background:transparent!important}';
  // A box the game is drawn over: only what is above the game shows, its own paint is under it.
  const FLAT = 'background:none!important;border-color:transparent!important;box-shadow:none!important;outline:none!important;';
  const XHTML = 'http://www.w3.org/1999/xhtml';
  const kebab = (p) => (p.startsWith('--') ? p : p.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()));
  const unq = (s) => String(s || '').trim().replace(/^["']|["']$/g, '');
  const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 250 }) : setTimeout(fn, 0));
  const ovs = [];
  /* Pictures and font files the copy uses, as data: URLs (an SVG image loads nothing from outside itself). Read once
     each from where the page itself got them; a picture that cannot be read is left out. */
  const files = new Map();      // address -> data: URL, '' while it loads, null when it cannot be read
  function dataOf(u, then) {
    if (!u || u.startsWith('data:')) return u || null;
    const d = files.get(u);
    if (d !== undefined) return d;
    files.set(u, '');
    fetch(u, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => b && new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(b); }))
      .catch(() => null)
      .then((x) => { files.set(u, x || null); if (then) then(); });
    return '';
  }
  // Every url(...) in a computed value, swapped for its data: URL (none while it loads).
  const urlsIn = (v, then) => v.replace(/url\("?([^")]*)"?\)/g, (m, u) => { const d = dataOf(u, then); return d ? 'url("' + d + '")' : 'none'; });

  function overlay(doc, frame) {
    const o = { doc, win: doc.defaultView, frame, c: document.createElement('canvas'), x: null, ready: false, dirty: true, busy: false,
      next: 0, cost: 0, pace: 0, n: 0, same: 0, fails: 0, off: false, safe: false, held: false, lift: 0, zTop: Infinity, roots: new Set(), last: '',
      sheetKey: null, rules: [], faces: [], fontKey: null, fontCss: '' };
    o.x = o.c.getContext('2d');
    const kick = () => { o.dirty = true; };
    o.kick = kick;
    const body = doc.body;
    const mo = new MutationObserver((list) => {
      if (o.dirty) return;
      for (const r of list) {
        let t = r.target;
        // slither sets the same styles again every frame: only a real change counts
        if (r.type === 'attributes' ? r.oldValue === t.getAttribute(r.attributeName) : r.type === 'characterData' && r.oldValue === t.nodeValue) continue;
        if (t.nodeType !== 1) t = t.parentElement;
        if (!t) continue;
        if (frame) {      // the lobby: only a change in what sits over the frame (or in the page's own boxes)
          if (t === body || (t.parentElement === body && r.type === 'attributes')) { kick(); return; }
          let n = t;
          while (n && n.parentElement !== body) n = n.parentElement;
          if (n && o.roots.has(n)) { kick(); return; }
          continue;
        }
        if (r.type === 'attributes' && t.tagName === 'CANVAS') continue;      // drawn from the canvas itself
        if (t.closest && t.closest(OV_HIDE)) continue;
        kick();
        return;
      }
    });
    mo.observe(frame ? body : doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true,
      attributeOldValue: true, characterDataOldValue: true });
    const fontsIn = () => { o.fontKey = null; kick(); };
    try { doc.fonts.addEventListener('loadingdone', fontsIn); } catch (_) {}
    // The game's frame closes while the lobby stays open: let go of the lobby, or each game played would stay in memory.
    if (frame) addEventListener('pagehide', () => { mo.disconnect(); try { doc.fonts.removeEventListener('loadingdone', fontsIn); } catch (_) {} });
    return o;
  }
  function ovStart() {
    if (ovs.length) return;
    ovs.push(overlay(document, null));
    // The lobby around this game's frame: its toasts and anything else it puts over the game.
    try { const fe = window.frameElement; if (fe && fe.ownerDocument && fe.ownerDocument.body) ovs.push(overlay(fe.ownerDocument, fe)); } catch (_) {}
    addEventListener('resize', () => ovs.forEach((o) => o.kick()));
  }
  // Called in the frame loop, only while frames are being kept: a picture that is due is made in idle time.
  function ovTick(now) {
    for (const o of ovs) {
      if (o.off || !o.dirty || o.busy || now < o.next) continue;
      o.busy = true;
      o.dirty = false;
      idle(() => { try { snap(o); } catch (e) { done(o, false, e); } });
    }
  }

  /* The page's styles, kept as text and read again only when its sheets change. A rule is copied only when the
     copy holds one of its classes or ids (or it names none, like * or :root), so the picture stays small. A sheet
     from another site (Google's fonts) is fetched once for its @font-face rules. */
  const remote = new Map();      // a sheet's address -> its @font-face rules
  function sheets(o) {
    const list = o.doc.styleSheets;
    let key = '';
    for (const s of list) { let n = 'x'; try { n = s.cssRules.length; } catch (_) {} key += n + (s.disabled ? 'd' : '') + ','; }
    if (key === o.sheetKey) return;
    o.sheetKey = key;
    const rules = [], faces = [];
    const walk = (rs, at) => {
      for (const r of rs) {
        if (r.type === 1) {
          rules.push({ t: r.cssText, k: toks(r.selectorText) });
          // The focused button's ring (the end card's Play again): the copy has no focus, so a mark stands in for it.
          if (r.selectorText.includes(':focus')) {
            const t = r.cssText.replace(/:focus-visible/g, '[data-dsclip-fv]').replace(/:focus(?![-\w])/g, '[data-dsclip-focus]');
            if (t !== r.cssText) rules.push({ t, k: toks(r.selectorText) });
          }
        }
        else if (r.type === 5) faces.push(face((p) => r.style.getPropertyValue(p), at));
        else if (r.type === 3) { try { if (r.styleSheet) walk(r.styleSheet.cssRules, r.styleSheet.href || at); } catch (_) {} }
        else if (r.type === 7) continue;      // @keyframes: the copy plays no motion
        else if (r.cssRules) {      // @media, @supports, @layer: kept whole when any rule inside may match
          let k = [];
          for (const x of r.cssRules) { const t = x.type === 1 ? toks(x.selectorText) : null; if (!t) { k = null; break; } k = k.concat(t); }
          rules.push({ t: r.cssText, k });
        } else rules.push({ t: r.cssText, k: null });
      }
    };
    for (const s of list) {
      if (s.disabled) continue;
      let rs = null;
      try { rs = s.cssRules; } catch (_) { rs = null; }
      if (rs) { walk(rs, s.href || o.doc.baseURI); continue; }
      if (!s.href) continue;
      const got = remote.get(s.href);
      if (got) { faces.push(...got); continue; }
      if (got === undefined) {
        remote.set(s.href, null);
        fetch(s.href).then((r) => (r.ok ? r.text() : '')).catch(() => '').then((css) => {
          const fs = [];
          for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
            const d = m[1];
            fs.push(face((p) => { const x = new RegExp('(?:^|;)\\s*' + p + '\\s*:\\s*([^;]*)').exec(d); return x ? x[1].trim() : ''; }, s.href));
          }
          remote.set(s.href, fs);
          ovs.forEach((x) => { x.sheetKey = null; x.fontKey = null; x.kick(); });
        });
      }
    }
    o.rules = rules;
    o.faces = faces;
    o.fontKey = null;
  }
  // The classes and ids a selector needs (any one of them present keeps the rule), or null when it may match anything.
  function toks(sel) {
    const out = [];
    for (const part of String(sel || '').split(',')) {
      if (part.includes('\\')) return null;
      const m = part.replace(/:(?:not|where|is|has)\([^()]*\)/g, '').match(/[.#]-?[_a-zA-Z -￿][\w -￿-]*/g);
      if (!m) return null;
      out.push(...m);
    }
    return out;
  }
  function face(get, at) {
    const src = get('src');
    const urls = [...src.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)\s*(?:format\(\s*["']?([\w-]+)["']?\s*\))?/g)];
    const best = urls.find((u) => u[2] === 'woff2') || urls[0];
    let url = null;
    try { url = best ? new URL(best[1], at).href : null; } catch (_) {}
    return { family: unq(get('font-family')), style: get('font-style') || 'normal', weight: get('font-weight') || 'normal',
      range: get('unicode-range') || '', stretch: get('font-stretch') || '', url, fmt: best && best[2] };
  }
  // The faces the page has loaded, each as an @font-face with its file inside; others are never used on screen.
  function fonts(o) {
    const loaded = new Set();
    o.doc.fonts.forEach((f) => { if (f.status === 'loaded') loaded.add(unq(f.family) + '|' + f.style + '|' + f.weight + '|' + f.unicodeRange); });
    const key = [...loaded].sort().join(';') + '#' + o.faces.length;
    if (key === o.fontKey) return;
    let css = '', waiting = false;
    for (const f of o.faces) {
      if (!f.url) continue;
      let k;
      try {
        const ff = new FontFace(f.family, 'local("x")', { style: f.style, weight: f.weight, unicodeRange: f.range || 'U+0-10FFFF' });
        k = unq(ff.family) + '|' + ff.style + '|' + ff.weight + '|' + ff.unicodeRange;
      } catch (_) { continue; }
      if (!loaded.has(k)) continue;
      const d = dataOf(f.url, () => { o.fontKey = null; o.kick(); });
      if (d === '') { waiting = true; continue; }
      if (!d) continue;
      css += '@font-face{font-family:"' + f.family + '";font-style:' + f.style + ';font-weight:' + f.weight
        + (f.stretch ? ';font-stretch:' + f.stretch : '') + (f.range ? ';unicode-range:' + f.range : '')
        + ';src:url(' + d + ')' + (f.fmt ? ' format("' + f.fmt + '")' : '') + '}';
    }
    o.fontCss = css;
    o.fontKey = waiting ? null : key;
  }

  /* The copy. Kept: what is drawn over the game, in the page's own stacking order (a box with a z-index under the
     game's canvas is under the game on screen too). A box that holds the game, or sits in the page under it, keeps
     only its shape, so what is over the game still lays out in the same place. Motion is frozen where it is: each
     moving part gets the values it shows right now, and while it moves the picture is made again (motion that
     never ends, like a pending dot, is held still). */
  function copy(n, st, above) {
    if (n.nodeType === 3) {
      if (!above) return null;
      const t = n.nodeValue;
      return n.ownerDocument.createTextNode(t.search(OV_ADDR) >= 0 ? t.replace(OV_ADDR, '') : t);
    }
    if (n.nodeType !== 1) return null;
    const tag = n.tagName;
    if (OV_SKIP.test(tag) || n === mirror || n === st.frame || n.matches(OV_HIDE)) return null;
    const cs = st.win.getComputedStyle(n);
    if (cs.display === 'none') return null;
    let flat = false;
    if (!above) {
      if (st.base && n.contains(st.base)) flat = true;
      else if (cs.position !== 'static') {
        const z = parseInt(cs.zIndex, 10), zz = Number.isNaN(z) ? 0 : z;
        if (zz > st.z || (zz === st.z && (!st.base || st.base.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING))) {
          above = true;
          if (zz > st.zTop || st.zTop === Infinity) st.zTop = zz;
        } else if (!Number.isNaN(z)) return null;
        else flat = true;
      } else flat = true;
    }
    if (st.moving.has(n)) st.stillMoving = true;
    if (n.namespaceURI !== XHTML) {      // an inline SVG icon: copied whole
      if (!above) return null;
      const c = n.cloneNode(true);
      for (const x of [n, ...n.querySelectorAll('[class],[id]')]) note(x, st);
      return c;
    }
    if (flat && (tag === 'IMG' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'SELECT')) return null;
    const c = n.cloneNode(false);
    note(n, st);
    let add = flat ? FLAT : '';
    if (above) {
      const bi = cs.backgroundImage;
      if (bi && bi.includes('url(')) add += 'background-image:' + urlsIn(bi, st.kick) + '!important;';
      const mi = cs.webkitMaskImage || cs.maskImage;
      if (mi && mi.includes('url(')) add += '-webkit-mask-image:' + urlsIn(mi, st.kick) + '!important;mask-image:' + urlsIn(mi, st.kick) + '!important;';
    }
    const moved = st.anims.get(n);
    if (moved) {
      const pe = {};
      for (const p of moved) {
        const i = p.indexOf('|');
        if (i < 0) add += p + ':' + cs.getPropertyValue(p) + '!important;';
        else (pe[p.slice(0, i)] = pe[p.slice(0, i)] || []).push(p.slice(i + 1));
      }
      for (const k in pe) {
        const id = 'm' + (st.pid++), ps = st.win.getComputedStyle(n, k);
        c.setAttribute('data-dsclip', id);
        st.css += '[data-dsclip="' + id + '"]' + k + '{' + pe[k].map((p) => p + ':' + ps.getPropertyValue(p) + '!important').join(';') + '}';
      }
    }
    if (n === st.focus) {
      c.setAttribute('data-dsclip-focus', '');
      try { if (n.matches(':focus-visible')) c.setAttribute('data-dsclip-fv', ''); } catch (_) {}
    }
    if (tag === 'IMG') {
      const d = dataOf(n.currentSrc || n.src, st.kick);
      c.removeAttribute('srcset');
      if (d) c.setAttribute('src', d); else c.removeAttribute('src');
      add += 'width:' + n.width + 'px!important;height:' + n.height + 'px!important;';
    } else if (tag === 'INPUT') {
      if (n.type === 'password') c.removeAttribute('value'); else c.setAttribute('value', n.value);
      if (n.checked) c.setAttribute('checked', ''); else c.removeAttribute('checked');
    } else if (tag === 'CANVAS') {
      add += 'width:' + n.clientWidth + 'px!important;height:' + n.clientHeight + 'px!important;';
    }
    if (add) c.setAttribute('style', (c.getAttribute('style') || '') + ';' + add);
    if (tag === 'TEXTAREA') { c.textContent = n.value; return c; }
    // A box scrolled down (a chat list) shows the same lines it shows on screen.
    const sx = above ? n.scrollLeft : 0, sy = above ? n.scrollTop : 0;
    let words = false;
    for (let ch = n.firstChild; ch; ch = ch.nextSibling) {
      const k = copy(ch, st, above);
      if (!k) continue;
      if (k.nodeType === 3 && /\S/.test(k.nodeValue)) words = true;
      if ((sx || sy) && k.nodeType === 1) k.style.setProperty('translate', -sx + 'px ' + -sy + 'px', 'important');
      c.appendChild(k);
    }
    if (words && above) st.words.push(n);
    return c;
  }
  /* How far the mark steps up (CSS px) so none of the game's words on screen sit under it: just above the highest
     line it would cover. More than a third of the screen and it stays in its corner. Read in idle time, with the
     picture, never per frame. */
  function liftFor(els) {
    if (!markBox || !H) return 0;
    const k = innerHeight / H, x0 = markBox.x * k, x1 = (markBox.x + markBox.w) * k, hgt = markBox.h * k, gap = 6;
    const bottom = innerHeight - markBox.m * k;
    const rs = [];
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width && r.right > x0 && r.left < x1 && r.bottom > innerHeight * 0.6
        && (!el.checkVisibility || el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))) rs.push(r);
    }
    let lift = 0;
    for (let again = true; again;) {
      again = false;
      for (const r of rs) {
        if (r.top < bottom - lift + gap && r.bottom > bottom - lift - hgt - gap) { lift = bottom - r.top + gap; again = true; }
      }
      if (lift > innerHeight / 3) return 0;
    }
    return lift;
  }
  function note(n, st) {
    if (n.id) st.toks.add('#' + n.id);
    if (n.classList) for (const k of n.classList) st.toks.add('.' + k);
  }
  // What moves on the page right now: element -> the properties its motion is changing ('::before|opacity' on a part).
  function motion(doc, st) {
    for (const a of doc.getAnimations()) {
      const ef = a.effect, t = ef && ef.target;
      if (!t) continue;
      let ps = [];
      if (a.transitionProperty) ps = [a.transitionProperty];
      else { try { for (const k of ef.getKeyframes()) for (const p in k) if (!/^(offset|computedOffset|easing|composite)$/.test(p)) ps.push(kebab(p)); } catch (_) {} }
      const pe = ef.pseudoElement;
      const list = st.anims.get(t) || [];
      for (const p of ps) list.push(pe ? pe + '|' + p : p);
      st.anims.set(t, list);
      let end = Infinity, at = 0;
      try { const ct = ef.getComputedTiming(); end = ct.endTime; at = ct.localTime || 0; } catch (_) {}
      if (a.playState === 'running' && end !== Infinity && !(t.closest && t.closest(OV_HIDE))) {
        st.moving.add(t);
        st.settle = Math.max(st.settle, end - at);
      }
    }
  }

  // One picture: the copy as an SVG image (made in this idle slice), drawn once it has loaded (in another).
  function snap(o) {
    const t0 = performance.now();
    const doc = o.doc;
    const st = { win: o.win, frame: o.frame, base: null, z: 0, zTop: Infinity, toks: new Set(), anims: new Map(), moving: new Set(),
      stillMoving: false, settle: 0, css: '', pid: 0, kick: o.kick, focus: doc.activeElement, words: [] };
    let vw = innerWidth, vh = innerHeight, box = [0, 0, innerWidth, innerHeight];
    let roots = null;
    if (o.frame) {
      // The lobby: only its boxes over the game's frame (fixed or absolute, stacked above it), none: no picture.
      const fe = o.frame, fz = zOf(fe, o.win), r = fe.getBoundingClientRect();
      vw = o.win.innerWidth; vh = o.win.innerHeight;
      box = [r.left + fe.clientLeft, r.top + fe.clientTop, fe.clientWidth || r.width, fe.clientHeight || r.height];
      roots = [];
      o.roots = new Set();      // watched for changes, the empty toast list too
      for (const e of doc.body.children) {
        if (e === fe || OV_SKIP.test(e.tagName) || e.contains(fe)) continue;
        const cs = o.win.getComputedStyle(e);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'static') continue;
        const z = parseInt(cs.zIndex, 10) || 0;
        if (z < fz || (z === fz && !(fe.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING))) continue;
        o.roots.add(e);
        const b = e.getBoundingClientRect();
        if (!e.childElementCount && (b.width < 1 || b.height < 1)) continue;
        roots.push(e);
      }
      if (!roots.length) { o.ready = false; o.last = ''; o.busy = false; o.next = performance.now() + OV_GAP; return; }
    } else if (base) {
      st.base = base.c;
      st.z = base.z;
    }
    const t1 = performance.now();
    sheets(o);      // read again only when the page's sheets or fonts change: not counted in the picture's cost
    fonts(o);
    const prep = performance.now() - t1;
    motion(doc, st);
    /* Something is still moving into place (the end card rising, a toast sliding in): one picture once it has
       settled rather than several on the way, since that is the busiest moment of a game. Once per change, so
       motion that keeps starting again still gets pictures. */
    if (st.settle > 0 && st.settle < 1000 && !o.held) {
      o.held = true; o.busy = false; o.dirty = true; o.next = performance.now() + st.settle + 20;
      return;
    }
    o.held = false;
    const html = doc.documentElement.cloneNode(false);
    html.setAttribute('style', (html.getAttribute('style') || '') + ';' + FLAT);
    note(doc.documentElement, st);
    const head = doc.createElement('head'), style = doc.createElement('style');
    head.appendChild(style);
    html.appendChild(head);
    let body;
    if (roots) {
      body = doc.body.cloneNode(false);
      body.setAttribute('style', (body.getAttribute('style') || '') + ';' + FLAT);
      note(doc.body, st);
      for (const e of roots) { const k = copy(e, st, true); if (k) body.appendChild(k); }
    } else body = copy(doc.body, st, false) || doc.createElement('body');
    html.appendChild(body);
    let css = o.fontCss;
    for (const r of o.rules) if (!r.k || r.k.some((k) => st.toks.has(k))) css += r.t;
    style.textContent = css + st.css + OV_CSS;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + vw + '" height="' + vh + '" viewBox="' + box.join(' ')
      + '" preserveAspectRatio="none"><foreignObject x="0" y="0" width="' + vw + '" height="' + vh + '">'
      + new XMLSerializer().serializeToString(html) + '</foreignObject></svg>';
    if (st.stillMoving) o.dirty = true;
    o.zTop = roots ? Infinity : st.zTop;
    if (!roots) o.lift = liftFor(st.words);
    const made = performance.now() - t0 - prep;
    // The same as the picture on hand (a leaderboard written again with the same rows): nothing to draw.
    if (svg === o.last && o.ready) { o.same++; o.busy = false; o.next = performance.now() + Math.max(OV_GAP, made / OV_SHARE); return; }
    o.last = svg;
    // A data: URL, not a blob: one: Chrome marks a blob SVG holding HTML as another site's, which no video may hold.
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    img.decode().then(() => idle(() => {
      const t2 = performance.now();
      try {
        if (o.c.width !== W || o.c.height !== H) { o.c.width = W; o.c.height = H; }
        o.x.clearRect(0, 0, o.c.width, o.c.height);
        o.x.drawImage(img, 0, 0, o.c.width, o.c.height);
        // Never draw a picture the page may not read back: it would stop the recorder (a VideoFrame refuses it).
        if (!o.safe) { o.x.getImageData(0, 0, 1, 1); o.safe = true; }
        o.cost = made + performance.now() - t2;
        // Paced by the usual cost: the first picture (cold caches, the page's first fonts) is no guide.
        o.pace = o.n ? o.pace * 0.75 + o.cost * 0.25 : Math.min(o.cost, 4);
        done(o, true);
      } catch (e) { o.off = true; done(o, false, e); }
    }), (e) => done(o, false, e));
  }
  function done(o, ok, why) {
    o.busy = false;
    if (ok) { o.n++; o.fails = 0; o.ready = !o.off; } else o.last = '';
    if (!ok && (++o.fails >= 3 || o.off)) {
      if (window.console && !o.told) { o.told = true; console.warn('[clips] no picture of the page: ' + (why && why.message || why)); }
      o.off = true; o.ready = false;
    }
    o.next = performance.now() + Math.max(OV_GAP, o.pace / OV_SHARE);
  }

  /* ── encoders ──────────────────────────────────────────────────────────── */
  async function pickCodec(w, h, bitrate) {
    // The whole tab asks for the graphics card's encoder first: it runs beside a game that is already busy.
    for (const hw of TOP ? ['prefer-hardware', ''] : ['']) {
      for (const codec of ['avc1.640028', 'avc1.4D4028', 'avc1.42E028', 'avc1.42E01F']) {
        const cfg = { codec, width: w, height: h, bitrate, framerate: FPS, avc: { format: 'avc' }, latencyMode: 'realtime' };
        if (hw) cfg.hardwareAcceleration = hw;
        try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch (_) {}
      }
    }
    return null;
  }
  async function startVideo(w, h) {
    [W, H] = w ? [w, h] : size();
    if (!mirror) { mirror = document.createElement('canvas'); mctx = mirror.getContext('2d', { alpha: false }); }
    mirror.width = W; mirror.height = H;
    const bitrate = Math.round(Math.min(TOP ? 6e6 : 8e6, Math.max(2.5e6, W * H * FPS * 0.1)));
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

  async function startAudio(tabSound) {
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
      if (tabSound) mixer.createMediaStreamSource(new MediaStream([tabSound])).connect(mixDest);
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
      if (tabbed) { ad.close(); continue; }      // the lobby is recording the whole tab, sound included
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
    // The lobby is recording the whole tab: this game's recorder stands down, and starts its buffer afresh after.
    const T = topClip();
    if (T && T.tab) { if (!tabbed) { vChunks = []; aChunks = []; } tabbed = true; return; }
    if (tabbed) { tabbed = false; vChunks = []; aChunks = []; frameNo = 0; lastNow = 0; gaps = []; }
    sampleFps(now);
    pace(now);
    if (!asleep && now - lastInput > IDLE_MS) doze();
    if (TOP) return;      // the lobby's pictures come from the tab itself (pumpTab)
    if (asleep || now < lateUntil || !capturing || now - lastCap < 1000 / FPS - 3) return;
    lastCap = now;
    if (vEnc.encodeQueueSize > 4) { slow++; if (slow > FPS * 3) stop('the encoder cannot keep up', true); return; }
    slow = 0;
    const [w, h] = size();
    if (w !== W || h !== H) { capturing = false; startVideo().then(ok => { capturing = ok; }); return; }
    ovTick(now);
    composite();
    encodeMirror();
  }
  function encodeMirror() {
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
  let capturing = false, slow = 0, tabbed = false;

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
  const touched = () => { lastInput = performance.now(); if (asleep) rouse(); const T = topClip(); if (T && T.on) T.touch(); };
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
    running = false; capturing = false; failed = !TOP; DSClip.on = false;
    try { if (vEnc) vEnc.close(); } catch (_) {}
    try { if (aEnc) aEnc.close(); } catch (_) {}
    vEnc = aEnc = null; vChunks = []; aChunks = [];
    dot(false);
    if (TOP) {      // the lobby can start again later this visit
      const s = tabStream;
      tabStream = null; vDesc = null; W = H = 0;
      if (s) s.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
      if (mixer) { mixer.close().catch(() => {}); mixer = mixDest = null; }
    }
    if (tell && TOP) toast('err', 'Whole-screen recording stopped', 'Your PC could not keep up. Clips record the game only.');
    else if (tell) toast('err', 'Clips are off on this PC', 'It was dropping frames while recording.');
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
  function build(game) {
    const v = vChunks.slice();
    while (v.length && !v[0].key) v.shift();     // frames still in the encoder when the buffer restarted
    if (!v.length) throw new Error('no key frame yet');
    const a = aEnc && aChunks.length ? aChunks.slice() : null;
    const bytes = muxOf(v, a);
    const secs = Math.max(1, Math.round((v[v.length - 1].ts - v[0].ts) / 1e6));
    return { v, a, bytes, secs, game: game || (isBr() ? 'br' : GAME), poster: still(), shared: false, sharing: false };
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
  // game: the lobby is told which game is on screen by that game's recorder (none: the lobby itself).
  function save(game) {
    if (!TOP) { const T = topClip(); if (T && T.tab) return T.save(gameNow()); }
    const g = TOP ? (/^(slither|agar|paper|br)$/.test(game) ? game : 'other') : '';
    if (!running || !vChunks.length || !vDesc) { toast('info', 'Nothing to save yet', 'Clips start a few seconds into a game.'); return false; }
    if (performance.now() - lastSave < 2000) return false;
    lastSave = performance.now();
    hideOffer();
    try {
      const clip = build(g);
      last = clip;
      const url = URL.createObjectURL(new Blob([clip.bytes], { type: 'video/mp4' }));
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const name = 'duelseries-' + (clip.game === 'br' ? 'battle-royale' : clip.game === 'other' ? 'lobby' : clip.game) + '-' + d.getFullYear() + '-' + p2(d.getMonth() + 1)
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
    audio: !!aEnc && aChunks.length > 0, mixer: mixer ? mixer.state : 'none', hooked,
    overlays: ovs.map((o) => ({ pictures: o.n, ms: Math.round(o.cost * 10) / 10, same: o.same, shown: o.ready, off: o.off })), mb: Math.round(vChunks.concat(aChunks).reduce((n, c) => n + c.data.length, 0) / 1e5) / 10 });

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
.dsclip-dot{position:fixed;left:12px;top:64px;z-index:2147482999;display:flex;gap:6px;align-items:center;pointer-events:none;
  font:600 10.5px/1 "IBM Plex Mono",ui-monospace,Consolas,monospace;color:rgba(255,255,255,.8);text-shadow:0 1px 2px rgba(0,0,0,.6)}
.dsclip-dot.bl{top:auto;bottom:10px}
.dsclip-dot.lt{color:rgba(16,14,11,.82);text-shadow:0 1px 1px rgba(255,255,255,.55)}
.dsclip-dot i{width:7px;height:7px;border-radius:50%;background:#e5534b;box-shadow:0 0 0 2px rgba(0,0,0,.25)}
/* The time-left bar keeps running under reduced motion: Owen's PC reports it, and a still bar says nothing (site sweep). */
@media (prefers-reduced-motion:reduce){.dsclip-t{transition:none}}`;
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
      // In the lobby, a click on the card hands the keys straight back to the game under it.
      if (TOP) card.addEventListener('click', () => setTimeout(focusGame, 0));
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
  function offer(game) {
    if (!TOP) { const T = topClip(); if (T && T.tab) { T.offer(gameNow()); return; } }
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
      b.onclick = (e) => { e.stopPropagation(); save(game); };
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
    dotEl = el('div', 'dsclip-dot' + (DOT === 'bl' ? ' bl' : '') + (LIGHT ? ' lt' : ''));
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
    // Whole screen switched on but not recording yet: this P (it counts as a click) asks for the tab, once a visit.
    if (TOP && !running) { if (tabWanted()) { e.preventDefault(); tabStart(); } return; }
    const T = topClip();
    if (T && !T.on && T.wanted()) T.start();
    if (!running && !(T && T.tab)) return;
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
  const hookTimer = TOP ? 0 : setInterval(() => { if (hookGames() || ++hookTries > 60) clearInterval(hookTimer); }, 500);

  /* ── the whole tab (the lobby's copy, Owen 2026-10-17) ─────────────────── */
  // In a game: the lobby's recorder, once it is past its own checks (else null).
  let topRec = null;
  function topClip() {
    if (TOP) return null;
    if (topRec) return topRec;
    try { const p = window.parent; const c = p !== window && p.DSClip; if (c && c.top) topRec = c; } catch (_) { /* another origin */ }
    return topRec;
  }
  const gameNow = () => (isBr() ? 'br' : GAME);
  // A game's mouse, in the lobby's own pixels (where its frame sits is read once a second, not per move).
  let frameBox = null, frameBoxAt = 0;
  if (!TOP) addEventListener('pointermove', (e) => {
    const T = topClip();
    if (!T || !T.on) return;
    const now = performance.now();
    if (!frameBox || now - frameBoxAt > 1000) {
      try {
        const fe = window.frameElement;
        if (!fe) return;
        const r = fe.getBoundingClientRect();
        frameBox = { x: r.left + fe.clientLeft, y: r.top + fe.clientTop, k: fe.clientWidth / innerWidth || 1 };
      } catch (_) { return; }
      frameBoxAt = now;
    }
    T.pointer(frameBox.x + e.clientX * frameBox.k, frameBox.y + e.clientY * frameBox.k);
  }, { capture: true, passive: true });

  let tabStream = null, tabStarting = false, tabDeclined = false, sizing = false;
  let ptrX = -1, ptrY = -1;
  const tabWanted = () => ls(LS_TAB) === '1' && ls(LS_ON) !== '0' && !tabDeclined;
  // The game on screen, so P and the card's buttons go back to it after a click on a lobby card.
  function focusGame() {
    for (const id of ['game-frame', 'agar-frame']) {
      const f = document.getElementById(id);
      if (f && f.style.display !== 'none' && f.contentWindow) { try { f.contentWindow.focus(); } catch (_) {} return; }
    }
  }
  /* Must run inside a click or key press (the switch, or P here or in a game: a press in a game counts for the
     lobby too). A no, or a browser without tab capture, changes nothing: the game's own recorder carries on, and
     P stops asking until the next visit (the Settings switch asks again). */
  async function tabStart(force) {
    if (force) tabDeclined = false;
    if (!TOP || running || tabStarting || !tabWanted()) return false;
    const md = navigator.mediaDevices;
    if (!md || typeof md.getDisplayMedia !== 'function' || typeof MediaStreamTrackProcessor !== 'function') { tabDeclined = true; return false; }
    tabStarting = true;
    let s = null;
    try {
      s = await md.getDisplayMedia({
        video: { frameRate: { ideal: FPS, max: FPS }, width: { max: MAX_W }, height: { max: MAX_H } },
        audio: { suppressLocalAudioPlayback: false },
        preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude',
        monitorTypeSurfaces: 'exclude', systemAudio: 'exclude',
      });
    } catch (_) { s = null; }
    tabStarting = false;
    const vt = s && s.getVideoTracks()[0];
    const surf = vt && vt.getSettings ? vt.getSettings().displaySurface : 'browser';
    if (!vt || (surf && surf !== 'browser') || running) {      // only ever this tab, never a window or a screen
      if (s) s.getTracks().forEach(t => t.stop());
      tabDeclined = true;
      return false;
    }
    tabStream = s;
    vt.addEventListener('ended', () => { if (tabStream === s) { tabDeclined = true; stop('stopped sharing'); } });
    T0 = performance.now(); lastCap = 0; frameNo = 0; vChunks = []; aChunks = []; W = H = 0;
    lastInput = performance.now(); asleep = false; lateUntil = 0; lastNow = 0; gaps = [];
    running = true; DSClip.on = true;
    requestAnimationFrame(tick);
    startAudio(s.getAudioTracks()[0] || null);
    pumpTab(new MediaStreamTrackProcessor({ track: vt }).readable.getReader(), s);
    toast('ok', 'Recording the whole screen', 'Press P any time to save the last 30 seconds.');
    return true;
  }
  /* Each frame of the tab, at most 30 a second: scaled onto the hidden canvas, the mouse and the mark drawn on
     top, then encoded. Asleep or while the game's frames run late, frames are dropped unread, as in a game. */
  async function pumpTab(reader, s) {
    for (;;) {
      let r;
      try { r = await reader.read(); } catch (_) { break; }
      const f = r.value;
      if (r.done || tabStream !== s) { if (f) f.close(); break; }
      const now = performance.now();
      if (asleep || sizing || now < lateUntil || now - lastCap < 1000 / FPS - 3) { f.close(); continue; }
      let w = f.displayWidth, h = f.displayHeight;
      const k = Math.min(1, MAX_W / w, MAX_H / h);
      w = Math.max(2, Math.round((w * k) / 2) * 2); h = Math.max(2, Math.round((h * k) / 2) * 2);
      if (w !== W || h !== H) {
        f.close();
        sizing = true;
        startVideo(w, h).then((ok) => { sizing = false; if (!ok) tabDeclined = true; });
        continue;
      }
      lastCap = now;
      if (!vEnc || vEnc.encodeQueueSize > 4) { f.close(); slow++; if (slow > FPS * 3) stop('the encoder cannot keep up', true); continue; }
      slow = 0;
      try { mctx.drawImage(f, 0, 0, W, H); } catch (_) {}
      f.close();
      cursor();
      mark();
      encodeMirror();
    }
  }
  // The mouse: tab capture leaves the real one out, so a plain arrow is drawn where it is, in the video only.
  function cursor() {
    if (ptrX < 0) return;
    const s = Math.max(16, Math.round(H * 0.024));
    const x = (ptrX * W) / innerWidth, y = (ptrY * H) / innerHeight;
    const P = [[0, 0], [0, 0.95], [0.24, 0.73], [0.4, 1.08], [0.54, 1.02], [0.38, 0.68], [0.68, 0.68]];
    mctx.beginPath();
    P.forEach(([px, py], i) => (i ? mctx.lineTo : mctx.moveTo).call(mctx, x + px * s, y + py * s));
    mctx.closePath();
    mctx.lineJoin = 'round';
    mctx.lineWidth = Math.max(1.5, s * 0.08);
    mctx.strokeStyle = 'rgba(0,0,0,.85)';
    mctx.fillStyle = '#fff';
    mctx.fill();
    mctx.stroke();
  }
  if (TOP) {
    addEventListener('pointermove', (e) => { ptrX = e.clientX; ptrY = e.clientY; }, { capture: true, passive: true });
    DSClip.top = true;
    Object.defineProperty(DSClip, 'tab', { get: () => running && !asleep && !!vDesc && vChunks.length > 0 });
    DSClip.wanted = tabWanted;
    DSClip.start = tabStart;
    DSClip.stop = () => { if (running) stop('switched off'); };
    DSClip.touch = () => {
      lastInput = performance.now();
      if (asleep) rouse();
      else if (mixer && mixer.state === 'suspended') mixer.resume().catch(() => {});
    };
    DSClip.pointer = (x, y) => { ptrX = x; ptrY = y; };
  }

  /* ── start ─────────────────────────────────────────────────────────────── */
  async function start() {
    if (running || failed) return;
    T0 = performance.now();
    if (!(await startVideo())) return;
    running = true;
    DSClip.on = true;
    if (document.hidden) doze();
    dot(true);
    ovStart();
    requestAnimationFrame(tick);
    startAudio();
    if (perfFresh) capturing = true; else perfTest();
  }
  if (TOP) return;
  if (document.readyState === 'complete') setTimeout(start, 500);
  else addEventListener('load', () => setTimeout(start, 500), { once: true });
})();
