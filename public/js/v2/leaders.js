'use strict';
/* ─── Social: Top earners, live ───────────────────────────────────────────────
   The top 10 on the Social tab with a LIVE mark beside the heading (Owen,
   2026-10-15; the top 3 plus a "View full leaderboard" sheet until
   2026-10-26, when he wanted all ten right on the board).

   Real data only: GET /api/earnings/board, the gold strip's own read and rule
   (server/earnings): take-home from paid cash-outs that LANDED, never the
   owner, revenue or test wallets, and bots have no wallet to count. The
   server reads the database once a minute at most, so this asks once a minute
   while the Social tab is on screen, which is what "live" means here.

   The sample players (socialPreview.js: everyone while config.js
   SAMPLE_BOARD is on, else ?leaderboard=preview in one browser) take its
   place, tagged "Sample" with a one-line note, and never marked LIVE, except
   in a browser that opened ?leaderboard=preview itself (liveLook below).

   Its own styles, like earnings.js: one file to read, one to delete. */
(function () {
  const PERIOD_MS = 60000;
  const P = () => window.V2SocialPreview && window.V2SocialPreview.on ? window.V2SocialPreview : null;
  /* Owen asked to see the sample board as LIVE (2026-10-26). Made-up players
     marked LIVE on a real-money site would mislead real visitors, so that look
     is only for the browser that opened ?leaderboard=preview (liveLook);
     everyone else keeps the Sample tag and note. */
  const SAMPLE = () => !!P() && !P().liveLook;

  let money = n => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let open = () => {};
  let data = null;            // last good { ok, top, preview? }
  let failed = false;
  let timer = null;

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const $ = id => document.getElementById(id);

  const css = '' +
    /* The mark: the Global player winnings panel's own LIVE (v2.html .win-live)
       beside the heading, the lobby's beating dot (lpulse) and the word. */
    '.lb-live{display:inline-flex;align-items:center;gap:6px;margin-left:12px;vertical-align:middle;' +
      'position:relative;top:-4px;color:var(--live);font:700 11px/1 var(--f);letter-spacing:.08em}' +
    '.lb-live i{width:7px;height:7px;border-radius:50%;background:var(--live);animation:lpulse 1.6s ease-in-out infinite}' +
    '.lb-live.off{color:var(--tx3)}' +
    '.lb-live.off i{background:var(--tx3);animation:none!important;box-shadow:none}' +
    '.lb-tag{display:inline-block;margin-left:8px;vertical-align:middle;position:relative;top:-3px;' +
      'font:600 12px/1 var(--f);color:var(--ink);background:var(--money);border-radius:var(--rf);padding:4px 8px;letter-spacing:0}' +
    /* The top 10: one card, ten rows, the amount where the eye ends. */
    '.lb-card{background:var(--s1);border-radius:var(--r3);padding:6px}' +
    '.lbrow{display:grid;grid-template-columns:30px minmax(0,1fr) auto;gap:12px;align-items:center;width:100%;' +
      'text-align:left;padding:13px 12px;border-radius:12px;transition:background .13s}' +
    '.lbrow+.lbrow{box-shadow:0 -1px 0 var(--s2)}' +
    '.lbrow:hover{background:var(--s2)}' +
    '.lbrow:hover+.lbrow{box-shadow:none}' +
    '.lbrow:focus-visible{outline:2px solid var(--money);outline-offset:-2px}' +
    '.lbrow .rk{font-family:var(--fm);font-size:13px;color:var(--tx3);text-align:center}' +
    '.lbrow .nm{min-width:0;font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.lbrow .gm{display:block;font-size:12px;font-weight:400;color:var(--tx3);margin-top:2px}' +
    '.lbrow .am{font-family:var(--fm);font-size:15px;font-weight:600;color:var(--money)}' +
    '.lb-first .lbrow:first-child .rk{color:var(--money)}' +
    '.lb-none{font-size:13.5px;color:var(--tx3);padding:22px 12px;line-height:1.5}' +
    '.lb-note{font-size:12px;color:var(--tx3);margin-top:10px;line-height:1.45}' +
    '#soc-top{margin-bottom:22px}' +
    /* The dot beats for everyone, like the lobby's other live dots (Owen,
       2026-10-10: "Pulse for everyone"; his own Windows has animation effects
       off), so the blanket reduce rule is overridden for it alone. */
    '@media(prefers-reduced-motion:reduce){.lb-live i{animation-duration:1.6s!important;' +
      'animation-iteration-count:infinite!important}}';

  function injectCss() {
    if ($('lb-css')) return;
    const st = document.createElement('style');
    st.id = 'lb-css';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function rowHTML(r) {
    const sub = [r.game, r.n > 1 ? r.n + ' cash-outs' : r.n === 1 ? '1 cash-out' : ''].filter(Boolean).join(', ');
    return '<button type="button" class="lbrow" data-name="' + esc(r.name) + '">' +
      '<span class="rk">' + r.rank + '</span>' +
      '<span class="nm">' + esc(r.name) + (sub ? '<span class="gm">' + esc(sub) + '</span>' : '') + '</span>' +
      '<span class="am" data-cu="lb-' + esc(r.name) + '">' + money(r.amount) + '</span></button>';
  }

  // The heading's marks: LIVE (grey while the last read failed), or Sample instead of it.
  function drawMarks() {
    const live = $('soc-live');
    if (live) {
      live.hidden = SAMPLE();
      live.classList.toggle('off', failed && !P());
      live.title = failed && !P() ? 'Not updating: the last read failed' : 'Updates every minute';
    }
    const h = live && live.parentNode;
    if (h && SAMPLE() && !h.querySelector('.lb-tag')) h.insertAdjacentHTML('beforeend', '<span class="lb-tag">' + P().tag + '</span>');
  }

  function draw() {
    const box = $('soc-top');
    if (!box) return;
    drawMarks();
    if (!data) {
      box.innerHTML = '<div class="lb-card"><div class="lb-none">' +
        (failed ? 'Could not load the board. Try again in a moment.' : 'Loading…') + '</div></div>';
      return;
    }
    const top = data.top || [];
    if (!top.length) {
      box.innerHTML = '<div class="lb-card"><div class="lb-none">Nobody has cashed out yet. ' +
        'Win a paid game and cash out to be first here.</div></div>';
      return;
    }
    box.innerHTML = '<div class="lb-card lb-first">' + top.slice(0, 10).map(rowHTML).join('') + '</div>' +
      (SAMPLE() ? '<div class="lb-note">' + P().note + '</div>' : '');
  }

  async function refresh() {
    const p = P();
    if (p) { data = p.board(10); failed = false; draw(); return; }
    try {
      const r = await fetch('/api/earnings/board', { cache: 'no-store' });
      if (r.ok === false) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (!j || j.ok !== true || !Array.isArray(j.top)) throw new Error('bad answer');
      data = j; failed = false;
    } catch (_) {
      failed = true;          // the last good board stays up; the mark turns grey
    }
    draw();
  }

  const onSocial = () => { const s = $('social-screen'); return !!s && getComputedStyle(s).display !== 'none'; };
  function tick() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (document.visibilityState === 'visible' && onSocial()) refresh().then(tick, tick);
      else tick();
    }, PERIOD_MS);
  }

  /* Called by social.js each time the Social tab opens: draws at once from
     the last answer, then asks again. */
  function load(opts) {
    if (opts && typeof opts.money === 'function') money = opts.money;
    if (opts && typeof opts.open === 'function') open = opts.open;
    injectCss();
    const box = $('soc-top');
    if (box && !box._wired) {
      box._wired = true;
      box.addEventListener('click', e => {
        const row = e.target.closest && e.target.closest('.lbrow');
        if (row) open(row.getAttribute('data-name'));
      });
    }
    draw();
    return refresh().then(tick);
  }

  function rankOf(name) {
    const r = data && (data.top || []).find(x => x.name === name);
    return r ? r.rank : null;
  }
  function amountOf(name) {
    const r = data && (data.top || []).find(x => x.name === name);
    return r ? r.amount : null;
  }

  injectCss();   // now, so the LIVE mark in the heading is never seen unstyled
  window.V2Leaders = { load: load, rankOf: rankOf, amountOf: amountOf };
})();
