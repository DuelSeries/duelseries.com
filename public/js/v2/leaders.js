'use strict';
/* ─── Social: Top earners, live ───────────────────────────────────────────────
   The top 3 on the Social tab, a LIVE mark beside the heading, and "View full
   leaderboard", which opens the top 10 in a sheet (Owen, 2026-10-15).

   Real data only: GET /api/earnings/board, the gold strip's own read and rule
   (server/earnings): take-home from paid cash-outs that LANDED, never the
   owner, revenue or test wallets, and bots have no wallet to count. The
   server reads the database once a minute at most, so this asks once a minute
   while the Social tab is on screen, which is what "live" means here.

   ?leaderboard=preview swaps in the sample players made in this browser by
   socialPreview.js, tagged "Preview" wherever they show.

   Its own styles, like earnings.js: one file to read, one to delete. */
(function () {
  const PERIOD_MS = 60000;
  const P = () => window.V2SocialPreview && window.V2SocialPreview.on ? window.V2SocialPreview : null;

  let money = n => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let open = () => {};
  let data = null;            // last good { ok, top, preview? }
  let failed = false;
  let timer = null, sheet = null, opener = null;

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
      'font:600 11px/1 var(--f);color:var(--ink);background:var(--money);border-radius:var(--rf);padding:4px 8px;letter-spacing:0}' +
    /* The top 3: one card, three rows, the amount where the eye ends. */
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
    '.lb-all{width:100%;margin-top:10px;padding:12px;border-radius:var(--r2);background:var(--s2);' +
      'color:var(--tx);font-size:13.5px;font-weight:600;transition:background .15s,color .15s}' +
    '.lb-all:hover{background:var(--bone);color:var(--ink)}' +
    '.lb-all:focus-visible{outline:2px solid var(--money);outline-offset:2px}' +
    '#soc-top{margin-bottom:22px}' +
    /* The full board: the gold strip's sheet (earnings.js), a card on a
       computer and a bottom sheet on a phone. The list scrolls inside it. */
    '.lb-ov{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.55);display:flex;align-items:center;' +
      'justify-content:center;opacity:0;transition:opacity .18s}' +
    '.lb-ov.in{opacity:1}' +
    '.lb-sheet{width:min(440px,calc(100vw - 32px));max-height:80vh;display:flex;flex-direction:column;' +
      'background:var(--s1);border:1px solid var(--s3);border-radius:var(--r3);padding:16px 10px 12px;' +
      'transform:translateY(12px);transition:transform .2s}' +
    '.lb-ov.in .lb-sheet{transform:none}' +
    '.lb-sh{display:flex;align-items:center;padding:0 6px 10px}' +
    '.lb-sh h3{font-size:18px;font-weight:700;letter-spacing:-.02em}' +
    '.lb-sh .lb-live,.lb-sh .lb-tag{top:0}' +
    '.lb-x{margin-left:auto;background:var(--s2);color:var(--tx2);width:32px;height:32px;border-radius:8px;' +
      'font-size:18px;line-height:1;flex:none}' +
    '.lb-x:hover{color:var(--tx)}' +
    '.lb-list{overflow:auto;overscroll-behavior:contain;min-height:0}' +
    '.lb-sheet .lb-note{padding:0 8px}' +
    '.lb-grab{display:none}' +
    '@media(max-width:760px){' +
      '.lb-ov{align-items:flex-end}' +
      '.lb-sheet{width:100%;max-height:82vh;border-radius:20px 20px 0 0;border-bottom:0;' +
        'padding-bottom:calc(14px + env(safe-area-inset-bottom));transform:translateY(40px)}' +
      '.lb-grab{display:block;width:38px;height:4px;border-radius:2px;background:var(--s3);margin:0 auto 12px;flex:none}' +
      '.lb-live{margin-left:10px;top:-2px}' +
    '}' +
    /* The dot beats for everyone, like the lobby's other live dots (Owen,
       2026-10-10: "Pulse for everyone"; his own Windows has animation effects
       off), so the blanket reduce rule is overridden for it alone. */
    '@media(prefers-reduced-motion:reduce){.lb-live i{animation-duration:1.6s!important;' +
      'animation-iteration-count:infinite!important}.lb-ov,.lb-sheet{transition:none}}';

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

  // The heading's marks: LIVE (grey while the last read failed) and Preview.
  function drawMarks() {
    const live = $('soc-live');
    if (live) {
      live.classList.toggle('off', failed && !P());
      live.title = failed && !P() ? 'Not updating: the last read failed' : 'Updates every minute';
    }
    const h = live && live.parentNode;
    if (h && P() && !h.querySelector('.lb-tag')) h.insertAdjacentHTML('beforeend', '<span class="lb-tag">Preview</span>');
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
    box.innerHTML = '<div class="lb-card lb-first">' + top.slice(0, 3).map(rowHTML).join('') + '</div>' +
      (top.length > 3 ? '<button type="button" class="lb-all" aria-haspopup="dialog">View full leaderboard</button>' : '') +
      (P() ? '<div class="lb-note">Preview: sample players made in this browser only. ' +
             'Nobody else sees them, and the real board shows only real cash-outs.</div>' : '');
  }

  async function refresh() {
    const p = P();
    if (p) { data = p.board(10); failed = false; draw(); drawSheet(); return; }
    try {
      const r = await fetch('/api/earnings/board', { cache: 'no-store' });
      if (r.ok === false) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (!j || j.ok !== true || !Array.isArray(j.top)) throw new Error('bad answer');
      data = j; failed = false;
    } catch (_) {
      failed = true;          // the last good board stays up; the mark turns grey
    }
    draw(); drawSheet();
  }

  const onSocial = () => { const s = $('social-screen'); return !!s && getComputedStyle(s).display !== 'none'; };
  function tick() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (document.visibilityState === 'visible' && onSocial()) refresh().then(tick, tick);
      else tick();
    }, PERIOD_MS);
  }

  /* ─── The full board ───────────────────────────────────────────────────── */
  function sheetHTML() {
    const top = (data && data.top) || [];
    return '<span class="lb-grab"></span>' +
      '<div class="lb-sh"><h3>Top earners</h3>' +
        '<span class="lb-live' + (failed && !P() ? ' off' : '') + '"><i></i>LIVE</span>' +
        (P() ? '<span class="lb-tag">Preview</span>' : '') +
        '<button type="button" class="lb-x" aria-label="Close">&times;</button></div>' +
      '<div class="lb-list">' + top.slice(0, 10).map(rowHTML).join('') + '</div>' +
      '<div class="lb-note">' + (P()
        ? 'Preview: sample players made in this browser only.'
        : 'What players took home from paid cash-outs, after the 10% cut. Updates every minute.') + '</div>';
  }
  function drawSheet() {
    if (!sheet) return;
    const list = sheet.querySelector('.lb-list');
    const y = list ? list.scrollTop : 0;
    sheet.querySelector('.lb-sheet').innerHTML = sheetHTML();
    const l2 = sheet.querySelector('.lb-list');
    if (l2) l2.scrollTop = y;
  }
  function openSheet(from) {
    if (sheet || !data) return;
    opener = from || null;
    sheet = document.createElement('div');
    sheet.className = 'lb-ov' + (P() ? ' ph-no-capture' : '');
    sheet.innerHTML = '<div class="lb-sheet" role="dialog" aria-modal="true" aria-label="Top earners"></div>';
    document.body.appendChild(sheet);
    drawSheet();
    if (window.DSCount) window.DSCount.open(sheet);    // its figures count up as it opens
    sheet.addEventListener('click', e => {
      const row = e.target.closest && e.target.closest('.lbrow');
      if (row) { const n = row.getAttribute('data-name'); closeSheet(true); open(n); return; }
      if (e.target === sheet || (e.target.closest && e.target.closest('.lb-x'))) closeSheet();
    });
    // Swipe down on a phone closes it, from the top of the list only.
    const card = sheet.querySelector('.lb-sheet');
    let y0 = null;
    card.addEventListener('touchstart', e => {
      const l = card.querySelector('.lb-list');
      y0 = !l || l.scrollTop <= 0 || !l.contains(e.target) ? e.touches[0].clientY : null;
    }, { passive: true });
    card.addEventListener('touchend', e => {
      if (y0 != null && e.changedTouches[0].clientY - y0 > 70) closeSheet();
      y0 = null;
    }, { passive: true });
    document.addEventListener('keydown', onKey);
    requestAnimationFrame(() => { if (sheet) sheet.classList.add('in'); });
    const x = sheet.querySelector('.lb-x');
    if (x) x.focus();
  }
  function closeSheet(leaving) {
    if (!sheet) return;
    document.removeEventListener('keydown', onKey);
    sheet.remove();
    sheet = null;
    if (!leaving && opener && opener.isConnected) opener.focus();
  }
  function onKey(e) { if (e.key === 'Escape') closeSheet(); }

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
        if (row) { open(row.getAttribute('data-name')); return; }
        const all = e.target.closest && e.target.closest('.lb-all');
        if (all) openSheet(all);
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
  window.V2Leaders = { load: load, rankOf: rankOf, amountOf: amountOf, openSheet: openSheet, closeSheet: closeSheet };
})();
