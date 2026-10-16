/* ─── Money that fills up ─────────────────────────────────────────────────────
   Marked dollar figures count up from $0 when their screen opens, and a live
   change while the screen is up (a balance tick, a leaderboard refresh) rolls
   from the old figure to the new one (Owen, 2026-10-16, pick C "Roll").
   ONLY three places (Owen: "the podium, the leaderboards and the wallets
   balances"): the Events podium prize; Leaderboards' Global player winnings,
   top 3, full board and a profile's total; the header and Wallet balances.
   Everything else with a $ stays static, so do not mark more without asking.

   DISPLAY ONLY. Nothing here is ever read back as money: the renderers keep
   their own numbers for balances, buttons and checks, and only the text node
   of a marked figure is animated. The last frame is always the renderer's own
   string, so the cents shown at rest are exactly what they were before.

   How a renderer uses it, nothing else to call:
     <span data-cu="key">$12.50</span>   the element's whole text is the figure
   Write the final text as usual (innerHTML or textContent). A MutationObserver
   sees it and animates it before the next paint. The key says "the same figure
   as last time" across a rebuild, so a poll that redraws the same rows tweens
   or does nothing instead of restarting from $0. An element with an id and an
   empty data-cu uses its id. Keys are per screen: a key only has to be unique
   inside the screen (or sheet) that DSCount.open was last called on.

     data-cu-rise   only a rise animates; a drop is a correction, shown as is.

   DSCount.open(root)   root has just been shown: every figure inside it counts
                        from $0 again, and so does any that arrives inside it later.
   DSCount.ms(from, to) how long a roll between those two values takes.

   Text with no "$" before the first digit (Free, a dash, an SOL amount) is left
   alone, and $0 shows at once. Nothing moves while a game is up (the game shares
   this main thread, see _pauseLobbyAnims in v2.html), in a hidden tab, or on a
   hidden screen: those land on the final figure. It runs for everyone, reduced
   motion included (Owen, 2026-10-16): only digits change, nothing slides, and
   his own PC has Windows animation effects off. */
(function () {
  const BASE = 1200;
  // Expo out: fast off the mark, then a long glide in, the cents rolling last.
  const ease = k => (k >= 1 ? 1 : 1 - Math.pow(2, -10 * k));
  // Bigger amounts take a little longer: x0.85 for cents, capped at x1.15 (about 1.4 s).
  const ms = (from, to) => BASE * Math.min(1.15, 0.85 + 0.075 * Math.log10(1 + Math.abs(to - from)));

  const S = '__cu';                       // per-element state: what we wrote, the final text, any roll
  const scopes = new WeakMap();           // screen root -> Map(key -> { v, pre, suf, anim })
  const docMem = new Map();               // figures outside any opened screen (the header)
  const running = new Set();
  let raf = 0, queued = false;
  const pending = new Set();

  const ingame = () => document.body && document.body.classList.contains('ingame');

  // "$1,234.56" -> { pre: '$', v: 1234.56, dec: 2, group: true, suf: '' }. Null when it is not money.
  function parse(t) {
    const m = /^(\D*)(\d[\d,]*(?:\.\d+)?)([\s\S]*)$/.exec(t);
    if (!m || m[1].indexOf('$') < 0) return null;
    const v = parseFloat(m[2].replace(/,/g, ''));
    if (!isFinite(v)) return null;
    const dot = m[2].indexOf('.');
    return { pre: m[1], suf: m[3], v: v, dec: dot < 0 ? 0 : m[2].length - dot - 1,
             // A figure of 1000 or more printed without a comma is the toFixed style; keep it.
             group: m[2].indexOf(',') >= 0 || v < 1000 };
  }
  function fmt(p, v) {
    const s = p.group
      ? v.toLocaleString('en-US', { minimumFractionDigits: p.dec, maximumFractionDigits: p.dec })
      : v.toFixed(p.dec);
    return p.pre + s + p.suf;
  }
  const st = el => el[S] || (el[S] = { shown: null, fin: null, anim: null, own: null, saved: null });

  function write(el, txt) {
    st(el).shown = txt;
    const n = el.firstChild;
    // Through the text node where there is one: a characterData change, which the observer ignores.
    if (n && n.nodeType === 3 && !n.nextSibling) { if (n.data !== txt) n.data = txt; }
    else if (el.textContent !== txt) el.textContent = txt;
  }

  // The memory a figure belongs to: its screen's map under its key, or the element itself.
  function slot(el) {
    const key = el.getAttribute('data-cu') || el.id;
    if (!key) return { get: () => st(el).own, set: e => { st(el).own = e; } };
    const root = el.closest('[data-cu-scope]');
    let map = root ? scopes.get(root) : docMem;
    if (!map) { map = new Map(); scopes.set(root, map); }
    return { get: () => map.get(key), set: e => { map.set(key, e); } };
  }

  /* Progress is held to 0..1. A frame is handed its START time, which can be a
     few ms before the performance.now() a roll began at, and the expo ease is
     below 0 for negative progress: a roll up from $0 drew "$-1" for a frame. */
  const valueAt = (a, now) => a.from + (a.to - a.from) * ease(Math.min(1, Math.max(0, (now - a.t0) / a.d)));

  // Width is held at the widest the figure will be, so nothing beside it moves.
  function hold(el) {
    const s = st(el);
    if (!s.saved) s.saved = { minWidth: el.style.minWidth, display: el.style.display };
    if (getComputedStyle(el).display === 'inline') el.style.display = 'inline-block';
  }
  function release(el) {
    const s = st(el);
    if (s.saved) { el.style.minWidth = s.saved.minWidth; el.style.display = s.saved.display; s.saved = null; }
  }
  function stop(el) {
    const s = st(el), a = s.anim;
    if (a) { running.delete(a); if (a.entry.anim === a) a.entry.anim = null; s.anim = null; }
    release(el);
  }

  function frame(now) {
    raf = 0;
    const halt = ingame() || document.hidden;
    running.forEach(a => {
      const done = halt || now - a.t0 >= a.d;
      if (done) {
        running.delete(a);
        if (a.entry.anim === a) a.entry.anim = null;
        const s = st(a.el);
        if (s.anim === a) { s.anim = null; write(a.el, a.fin); release(a.el); }
      } else {
        write(a.el, fmt(a.p, Math.round(valueAt(a, now) * 1e6) / 1e6));
      }
    });
    if (running.size) raf = requestAnimationFrame(frame);
  }

  function queue(el) {
    pending.add(el);
    if (!queued) { queued = true; queueMicrotask(flush); }
  }
  function ingest(records) {
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (r.target.nodeType === 1) {
        const host = r.target.closest('[data-cu]');
        if (host) queue(host);
      }
      r.addedNodes.forEach(n => {
        if (n.nodeType !== 1) return;
        if (n.matches('[data-cu]')) queue(n);
        n.querySelectorAll('[data-cu]').forEach(e => queue(e));
      });
    }
  }

  function flush() {
    queued = false;
    if (mo) ingest(mo.takeRecords());     // a render in the same tick as an open() is not lost
    const els = Array.from(pending); pending.clear();
    const now = performance.now();
    const still = ingame() || document.hidden;
    const jobs = [];

    // Reads first (text, visibility), so the page is laid out once, not once per figure.
    const seen = els.filter(el => el.isConnected).map(el => {
      const s = st(el), cur = el.textContent;
      // A parked Play screen (v2.html parkScreen) has boxes but is off to the side: not visible.
      return { el, fin: cur === s.shown && s.fin != null ? s.fin : cur, vis: el.getClientRects().length > 0 && !el.closest('.scr-park') };
    });

    seen.forEach(({ el, fin, vis }) => {
      const s = st(el), mem = slot(el), p = parse(fin);
      s.fin = fin;
      let e = mem.get();
      if (!p) { stop(el); write(el, fin); if (e) e.anim = null; mem.set(null); return; }
      if (!e || e.pre !== p.pre || e.suf !== p.suf) { e = { v: 0, pre: p.pre, suf: p.suf, anim: null }; }
      mem.set(e);
      const from = e.anim ? valueAt(e.anim, now) : e.v;
      const heading = e.anim && e.anim.to === p.v ? e.anim : null;
      e.v = p.v;
      const drop = p.v < from && el.hasAttribute('data-cu-rise');
      if (still || !vis || p.v === 0 || drop || (!heading && from === p.v)) {
        if (e.anim) { const o = e.anim.el; stop(o); if (o !== el && o.isConnected) write(o, st(o).fin); }
        stop(el); write(el, fin);
        return;
      }
      let a = heading;
      if (a && a.el !== el && a.el.isConnected) {
        // Two figures under one key (two lobbies at the same stake): roll this one in step.
        a = { el, p, fin, from: a.from, to: a.to, t0: a.t0, d: a.d, entry: e };
      } else if (a) {                        // already rolling there: carry on in the redrawn element
        if (a.el !== el) { const o = a.el; st(o).anim = null; release(o); }
        a.el = el; a.p = p; a.fin = fin;
      } else {
        if (e.anim) stop(e.anim.el);
        a = { el, p, fin, from, to: p.v, t0: now, d: ms(from, p.v), entry: e };
        e.anim = a;
      }
      if (s.anim && s.anim !== a) { running.delete(s.anim); if (s.anim.entry.anim === s.anim) s.anim.entry.anim = null; }
      s.anim = a;
      running.add(a);
      jobs.push(a);
    });
    if (!jobs.length) return;
    if (window.DSSound) DSSound.roll();   // the tick-tick of money rolling (sounds.js plays it only after a click)

    // Hold each figure at its widest text, measured in one pass, then show the first frame.
    jobs.forEach(a => { hold(a.el); write(a.el, a.to >= a.from ? a.fin : fmt(a.p, a.from)); });
    const widths = jobs.map(a => {
      const cs = getComputedStyle(a.el), w = a.el.getBoundingClientRect().width;
      return cs.boxSizing === 'border-box' ? w
        : w - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
            - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
    });
    jobs.forEach((a, i) => {
      a.el.style.minWidth = widths[i] + 'px';
      write(a.el, fmt(a.p, Math.round(valueAt(a, now) * 1e6) / 1e6));
    });
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function open(root) {
    if (!root || root.nodeType !== 1) return;
    root.setAttribute('data-cu-scope', '');
    scopes.set(root, new Map());
    root.querySelectorAll('[data-cu-scope]').forEach(r => scopes.set(r, new Map()));
    if (root === document.body || root === document.documentElement) docMem.clear();
    root.querySelectorAll('[data-cu]').forEach(el => {
      const s = st(el);
      s.own = null;
      if (s.anim) stop(el);
      queue(el);
    });
  }

  const mo = typeof MutationObserver === 'function'
    ? new MutationObserver(ingest) : null;
  if (mo) mo.observe(document.documentElement, { childList: true, subtree: true });

  // parse and format are here for test/countUp.test.js; the page never needs them.
  window.DSCount = { open: open, ms: ms, parse: parse, format: fmt };
})();
