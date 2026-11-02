/* The lobby's "Players have cashed out $X" strip, its top-10 board and sheet.

   Everything here reads /api/earnings (server/earnings), which answers
   {on:false} until real players have cashed out, or when Owen hides it (the
   owner console's earnings:off, or SHOW in server/earnings/config.js). This
   file only draws what that answer says: it holds no numbers or names of its
   own. ?earnings=preview on the lobby URL asks for the preview, which lets
   the owner's own cash-outs in so the look can be judged before real players
   have any; only that viewer sees it.

   Self-contained on purpose: its own styles, its own DOM, inserted at the top
   of the home screen. Deleting this file and its <script> tag removes it. */
(function () {
  'use strict';
  var PERIOD_MS = 60000;
  var PREVIEW = /(^|[?&])earnings=preview(&|$)/.test(location.search);
  var URL_ = '/api/earnings' + (PREVIEW ? '?preview=1' : '');
  var TABS = [['today', 'Today'], ['week', 'This week'], ['all', 'All time']];
  var PERIOD_WORD = { today: 'today', week: 'this week', all: 'so far' };

  var data = null;       // last {on:true,...} answer, or null
  var strip = null, board = null, sheet = null, cols = null;
  var boardTab = null, sheetTab = null;

  /* Site redo stage 3: drawn from the kit's tokens (ds-tokens.css): a quiet panel row with the figure in gold (money),
     the board and the sheet as the kit's panel and sheet, the period tabs as its segmented control. */
  var css = '' +
    '.earn-strip{display:flex;align-items:center;gap:10px;width:100%;margin:0 0 var(--ds-sp4,16px);min-height:48px;padding:0 16px;' +
      'border:0;border-radius:var(--ds-r2,10px);cursor:pointer;text-align:left;background:var(--ds-s1,#0d0b08);' +
      'box-shadow:var(--ds-edge);color:var(--ds-tx2,#b3a792);font:inherit;font-size:15px;' +
      'transition:background-color var(--ds-dur-1,.14s),box-shadow var(--ds-dur-1,.14s)}' +
    '.earn-strip:hover{background:var(--ds-s2,#1a1611);box-shadow:var(--ds-edge2)}' +
    '.earn-strip:focus-visible{outline:2px solid var(--ds-bone,#f4f1ea);outline-offset:2px}' +
    '.earn-strip .earn-big{color:var(--ds-gold,#f0a830);font-weight:800;font-stretch:var(--ds-wide,118%);font-size:18px}' +
    '.earn-strip .earn-r{margin-left:auto;color:var(--ds-tx2,#b3a792);font-size:13px;white-space:nowrap;display:flex;align-items:center;gap:8px}' +
    '.earn-strip .earn-r b{color:var(--ds-bone,#f4f1ea);font-weight:700}' +
    '.earn-chev{font-size:20px;line-height:1;color:var(--ds-tx3,#988b78)}' +
    '.earn-cols{display:block}' +
    '.earn-board{display:none}' +
    '@media(min-width:1100px){' +
      '.earn-cols.on{display:grid;grid-template-columns:minmax(0,1fr) 320px;column-gap:28px;align-items:start}' +
      '.earn-cols.on .earn-board{display:block;margin-top:56px}' +
    '}' +
    '.earn-card{background:var(--ds-s1,#0d0b08);box-shadow:var(--ds-edge);border-radius:var(--ds-r3,18px);padding:var(--ds-sp5,24px);color:var(--ds-bone,#f4f1ea)}' +
    '.earn-card h3{font-size:var(--ds-fs-4,18px);font-weight:700;display:flex;align-items:center;gap:8px;margin:0}' +
    '.earn-tag{display:inline-flex;align-items:center;height:24px;padding:0 8px;border-radius:var(--ds-r1,6px);font-size:12px;font-weight:650;' +
      'color:var(--ds-gold,#f0a830);background:var(--ds-gold-t)}' +
    '.earn-tabs{display:flex;gap:2px;margin:14px 0 12px;background:var(--ds-ink,#000);box-shadow:var(--ds-edge);border-radius:var(--ds-r2,10px);padding:4px}' +
    '.earn-tabs button{flex:1;min-height:36px;border:0;background:none;color:var(--ds-tx2,#b3a792);font:inherit;font-size:13px;font-weight:650;' +
      'border-radius:var(--ds-r1,6px);cursor:pointer}' +
    '.earn-tabs button:hover{color:var(--ds-bone,#f4f1ea)}' +
    '.earn-tabs button[aria-selected=true]{background:var(--ds-s3,#272018);color:var(--ds-bone,#f4f1ea);box-shadow:var(--ds-edge2)}' +
    '.earn-ptot{font-size:13px;color:var(--ds-tx2,#b3a792);margin:2px 0 8px}' +
    '.earn-ptot b{color:var(--ds-gold,#f0a830);font-size:17px;font-weight:800;font-stretch:var(--ds-wide,118%)}' +
    '.earn-row{display:flex;align-items:center;gap:10px;padding:10px 0;box-shadow:0 -1px 0 var(--ds-line,#36291a);font-size:15px}' +
    '.earn-row .rk{width:18px;flex:none;color:var(--ds-tx2,#b3a792);font-size:13px;font-weight:650}' +
    '.earn-row .nm{font-weight:650;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.earn-row .gm{display:block;font-size:13px;color:var(--ds-tx2,#b3a792);font-weight:400;margin-top:1px}' +
    '.earn-row .am{margin-left:auto;color:var(--ds-gold,#f0a830);font-weight:700;flex:none}' +
    '.earn-empty{color:var(--ds-tx2,#b3a792);font-size:13px;text-align:center;padding:16px 0;box-shadow:0 -1px 0 var(--ds-line,#36291a)}' +
    '.earn-note{font-size:12px;color:var(--ds-tx2,#b3a792);margin-top:12px;line-height:1.45}' +
    '.earn-ov{position:fixed;inset:0;z-index:var(--ds-z-sheet,200);background:var(--ds-scrim,rgba(0,0,0,.78));' +
      '-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;' +
      'opacity:0;transition:opacity .18s}' +
    '.earn-ov.in{opacity:1}' +
    '.earn-sheet{width:min(420px,calc(100vw - 32px));max-height:80vh;overflow:auto;box-shadow:var(--ds-sh-pop);' +
      'transform:translateY(14px) scale(.98);transition:transform var(--ds-dur-2,.24s) var(--ds-ease,ease-out)}' +
    '.earn-ov.in .earn-sheet{transform:none}' +
    '.earn-x{margin-left:auto;border:0;background:transparent;color:var(--ds-tx2,#b3a792);width:44px;height:44px;margin-right:-10px;' +
      'border-radius:var(--ds-r2,10px);font-size:22px;line-height:1;cursor:pointer}' +
    '.earn-x:hover{background:var(--ds-s2,#1a1611);color:var(--ds-bone,#f4f1ea)}' +
    '.earn-grab{display:none}' +
    '@media(max-width:760px){' +
      '.earn-strip{min-height:44px;padding:0 12px;font-size:13px;gap:7px}' +
      '.earn-strip .earn-big{font-size:16px}' +
      '.earn-strip .earn-r .earn-best{display:none}' +
      '.earn-ov{align-items:flex-end}' +
      '.earn-sheet{width:100%;max-height:78vh;border-radius:var(--ds-r3,18px) var(--ds-r3,18px) 0 0;padding:8px 16px calc(20px + env(safe-area-inset-bottom));' +
        'transform:translateY(48px)}' +
      '.earn-grab{display:block;width:40px;height:4px;border-radius:999px;background:var(--ds-line2,#5a4630);margin:0 auto 12px}' +
    '}' +
    '@media(prefers-reduced-motion:reduce){.earn-ov,.earn-sheet{transition:none}}';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(v) { return '$' + Number(v || 0).toFixed(2); }

  function injectCss() {
    if (document.getElementById('earn-css')) return;
    var st = document.createElement('style');
    st.id = 'earn-css';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function firstTab(d) {
    if (d.periods.today.top.length) return 'today';
    if (d.periods.week.top.length) return 'week';
    return 'all';
  }

  /* The board's inside, shared by the PC panel and the sheet. */
  function boardHtml(d, tab, withClose) {
    var p = d.periods[tab];
    var rows = p.top.map(function (r, i) {
      return '<div class="earn-row"><span class="rk num">' + (i + 1) + '</span>' +
        '<span class="nm">' + esc(r.name) + '<span class="gm">' + esc(r.game) +
        (r.n > 1 ? ', ' + r.n + ' cash-outs' : '') + '</span></span>' +
        '<span class="am num">' + money(r.amount) + '</span></div>';
    }).join('');
    return '<span class="earn-grab"></span>' +
      '<h3>Top cash-outs' + (d.preview ? ' <span class="earn-tag">Preview</span>' : '') +
      (withClose ? '<button type="button" class="earn-x" aria-label="Close">&times;</button>' : '') + '</h3>' +
      '<div class="earn-tabs" role="tablist">' + TABS.map(function (t) {
        return '<button type="button" role="tab" data-t="' + t[0] + '" aria-selected="' + (t[0] === tab) + '">' +
          t[1] + '</button>';
      }).join('') + '</div>' +
      (p.top.length
        ? '<div class="earn-ptot"><b class="num">' + money(p.total) + '</b> cashed out by players ' +
            PERIOD_WORD[tab] + '</div>' + rows
        : '<div class="earn-empty">No cash-outs ' + (tab === 'today' ? 'yet today' : tab === 'week' ? 'yet this week' : 'yet') +
            '</div>') +
      '<div class="earn-note">What landed in players\' wallets after the 10% cut.' +
      (d.preview ? ' Preview: includes your own test cash-outs, which the real strip never counts.' : '') + '</div>';
  }

  function wireTabs(el, set) {
    el.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('.earn-tabs button');
      if (b) set(b.getAttribute('data-t'));
    });
  }

  function drawBoard() {
    if (!board || !data) return;
    if (!boardTab || !data.periods[boardTab]) boardTab = firstTab(data);
    board.innerHTML = boardHtml(data, boardTab, false);
  }

  function drawSheet() {
    if (!sheet || !data) return;
    var card = sheet.querySelector('.earn-sheet');
    card.innerHTML = boardHtml(data, sheetTab, true);
  }

  function openSheet() {
    if (!data || sheet) return;
    sheetTab = firstTab(data);
    sheet = document.createElement('div');
    sheet.className = 'earn-ov';
    sheet.innerHTML = '<div class="earn-sheet earn-card" role="dialog" aria-modal="true" aria-label="Top cash-outs"></div>';
    document.body.appendChild(sheet);
    drawSheet();
    wireTabs(sheet, function (t) { sheetTab = t; drawSheet(); var x = sheet.querySelector('.earn-x'); if (x) x.focus(); });
    sheet.addEventListener('click', function (e) {
      if (e.target === sheet || (e.target.closest && e.target.closest('.earn-x'))) closeSheet();
    });
    // Swipe down on a phone closes it.
    var y0 = null, card = sheet.querySelector('.earn-sheet');
    card.addEventListener('touchstart', function (e) { y0 = card.scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
    card.addEventListener('touchend', function (e) {
      if (y0 != null && e.changedTouches[0].clientY - y0 > 70) closeSheet();
      y0 = null;
    }, { passive: true });
    document.addEventListener('keydown', onKey);
    requestAnimationFrame(function () { if (sheet) sheet.classList.add('in'); });
    var x = sheet.querySelector('.earn-x');
    if (x) x.focus();
  }
  function closeSheet() {
    if (!sheet) return;
    document.removeEventListener('keydown', onKey);
    sheet.remove();
    sheet = null;
    if (strip) strip.focus();
  }
  function onKey(e) { if (e.key === 'Escape') closeSheet(); }

  function drawStrip() {
    var home = document.getElementById('home');
    if (!home) return;
    if (!strip) {
      strip = document.createElement('button');
      strip.type = 'button';
      strip.className = 'earn-strip';
      strip.addEventListener('click', openSheet);
      home.insertBefore(strip, home.firstElementChild);
    }
    var b = data.bestToday;
    strip.setAttribute('aria-label', 'Players have cashed out ' + money(data.total) + '. Show top cash-outs');
    /* Static (Owen, 2026-10-16): only the podium, the leaderboards and the
       wallet balances count up (countUp.js), so the strip shows its total as is. */
    strip.innerHTML = '<span>Players have cashed out</span><span class="earn-big num">' +
      money(data.total) + '</span>' +
      '<span class="earn-r">' + (b
        ? '<span class="earn-best">Biggest today <b class="num">' + money(b.amount) + '</b> on ' + esc(b.game) + '</span>'
        : '<span class="earn-best">See top cash-outs</span>') +
      '<span class="earn-chev" aria-hidden="true">&rsaquo;</span></span>';
  }

  /* PC: the board sits beside Open lobbies. That heading and the list are moved
     into a two-column wrapper once; on narrower screens the wrapper is a plain
     block and the board is hidden (the strip opens the sheet instead). */
  function placeBoard() {
    var lob = document.getElementById('lob');
    if (!lob) return;
    if (!cols) {
      var head = lob.previousElementSibling;
      if (!head || !head.classList.contains('head')) return;
      cols = document.createElement('div');
      cols.className = 'earn-cols';
      var left = document.createElement('div');
      left.style.minWidth = '0';
      lob.parentNode.insertBefore(cols, head);
      left.appendChild(head);
      left.appendChild(lob);
      board = document.createElement('aside');
      board.className = 'earn-board earn-card';
      board.setAttribute('aria-label', 'Top cash-outs');
      wireTabs(board, function (t) { boardTab = t; drawBoard(); });
      cols.appendChild(left);
      cols.appendChild(board);
    }
    cols.classList.add('on');
    drawBoard();
  }

  function hide() {
    data = null;
    if (window.V2Side) window.V2Side.paint();
    document.body.classList.remove('earn-on');
    if (strip) { strip.remove(); strip = null; }
    if (cols) cols.classList.remove('on');
    if (board) board.innerHTML = '';
    closeSheet();
  }

  function apply(d) {
    if (!d || d.on !== true || !d.periods || !(d.total > 0)) { hide(); return; }
    data = d;
    injectCss();
    document.body.classList.add('earn-on');
    drawStrip();
    placeBoard();
    if (sheet) drawSheet();
    if (window.V2Side) window.V2Side.paint();
  }

  var busy = false;
  function pull() {
    if (busy) return;
    busy = true;
    fetch(URL_, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) apply(d); })
      .catch(function () { /* keep what is showing */ })
      .then(function () { busy = false; });
  }

  function start() {
    pull();
    setInterval(function () {
      if (document.hidden || document.body.classList.contains('ingame')) return;
      pull();
    }, PERIOD_MS);
    document.addEventListener('visibilitychange', function () { if (!document.hidden && data) pull(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  /* data: the last answer while the feed is on, else null (the PC sidebar's "paid today"). */
  window.V2Earnings = { pull: pull, apply: apply, open: openSheet, get data() { return data; } };
})();
