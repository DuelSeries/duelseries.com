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
  var counted = false;
  var boardTab = null, sheetTab = null;

  var css = '' +
    '.earn-strip{display:flex;align-items:center;gap:10px;width:100%;margin:28px 0 0;height:44px;padding:0 16px;' +
      'border:1px solid rgba(240,168,48,.28);border-radius:var(--r2,10px);cursor:pointer;text-align:left;' +
      'background:linear-gradient(90deg,rgba(240,168,48,.16),rgba(240,168,48,.05));color:var(--tx2);' +
      'font:inherit;font-size:14.5px}' +
    '.earn-strip:hover{border-color:rgba(240,168,48,.45)}' +
    '.earn-strip:focus-visible{outline:2px solid var(--money);outline-offset:2px}' +
    '.earn-strip .earn-big{color:var(--money);font-weight:600;font-size:17px}' +
    '.earn-strip .earn-r{margin-left:auto;color:var(--tx3);font-size:13.5px;white-space:nowrap;display:flex;align-items:center;gap:8px}' +
    '.earn-strip .earn-r b{color:var(--tx);font-weight:600}' +
    '.earn-chev{font-size:18px;line-height:1;color:var(--tx3)}' +
    '#home>.earn-strip+.head{margin-top:32px}' +
    '.earn-cols{display:block}' +
    '.earn-board{display:none}' +
    '@media(min-width:1100px){' +
      '.earn-cols.on{display:grid;grid-template-columns:minmax(0,1fr) 320px;column-gap:28px;align-items:start}' +
      '.earn-cols.on .earn-board{display:block;margin-top:56px}' +
    '}' +
    '.earn-card{background:var(--s1);border:1px solid var(--s3);border-radius:14px;padding:16px}' +
    '.earn-card h3{font-size:16px;font-weight:700;letter-spacing:-.01em;display:flex;align-items:center;gap:8px}' +
    '.earn-tag{font-size:11px;font-weight:600;color:var(--bg);background:var(--money);border-radius:999px;padding:2px 7px}' +
    '.earn-tabs{display:flex;gap:4px;margin:12px 0 10px;background:var(--bg);border-radius:9px;padding:3px}' +
    '.earn-tabs button{flex:1;border:0;background:none;color:var(--tx3);font:inherit;font-size:12.5px;font-weight:600;' +
      'padding:7px 0;border-radius:7px;cursor:pointer}' +
    '.earn-tabs button[aria-selected=true]{background:var(--s3);color:var(--tx)}' +
    '.earn-ptot{font-size:12.5px;color:var(--tx3);margin:2px 0 8px}' +
    '.earn-ptot b{color:var(--money);font-size:15px;font-weight:600}' +
    '.earn-row{display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid var(--s2);font-size:13.5px}' +
    '.earn-row .rk{width:18px;flex:none;color:var(--tx3);font-size:12px}' +
    '.earn-row .nm{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.earn-row .gm{display:block;font-size:11.5px;color:var(--tx3);font-weight:400;margin-top:1px}' +
    '.earn-row .am{margin-left:auto;color:var(--money);font-weight:600;flex:none}' +
    '.earn-empty{color:var(--tx3);font-size:12.5px;text-align:center;padding:14px 0;border-top:1px solid var(--s2)}' +
    '.earn-note{font-size:11.5px;color:var(--tx3);margin-top:10px;line-height:1.4}' +
    '.earn-ov{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;' +
      'opacity:0;transition:opacity .18s}' +
    '.earn-ov.in{opacity:1}' +
    '.earn-sheet{width:min(420px,calc(100vw - 32px));max-height:80vh;overflow:auto;transform:translateY(12px);transition:transform .2s}' +
    '.earn-ov.in .earn-sheet{transform:none}' +
    '.earn-x{margin-left:auto;border:0;background:var(--s2);color:var(--tx2);width:30px;height:30px;border-radius:8px;' +
      'font-size:17px;line-height:1;cursor:pointer}' +
    '.earn-grab{display:none}' +
    '@media(max-width:760px){' +
      '.earn-strip{margin:8px 0 0;height:34px;padding:0 12px;font-size:13px;gap:7px}' +
      '.earn-strip .earn-big{font-size:15px}' +
      '.earn-strip .earn-r .earn-best{display:none}' +
      '#home>.earn-strip+.head{margin-top:18px}' +
      'body.earn-on .tickerwrap{margin-top:8px}' +
      'body.earn-on .tki{padding-top:6px;padding-bottom:6px}' +
      '.earn-ov{align-items:flex-end}' +
      '.earn-sheet{width:100%;max-height:78vh;border-radius:20px 20px 0 0;border-bottom:0;' +
        'padding-bottom:calc(20px + env(safe-area-inset-bottom));transform:translateY(40px)}' +
      '.earn-grab{display:block;width:38px;height:4px;border-radius:2px;background:var(--s3);margin:0 auto 12px}' +
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

  function countUp(el, to) {
    if (counted || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = money(to); counted = true; return; }
    counted = true;
    var t0 = performance.now(), D = 1300;
    (function f(t) {
      var k = Math.min(1, (t - t0) / D), e = 1 - Math.pow(1 - k, 3);
      el.textContent = money(to * e);
      if (k < 1) requestAnimationFrame(f);
    })(t0);
  }

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
    strip.innerHTML = '<span>Players have cashed out</span><span class="earn-big num">' +
      (counted ? money(data.total) : '$0.00') + '</span>' +
      '<span class="earn-r">' + (b
        ? '<span class="earn-best">Biggest today <b class="num">' + money(b.amount) + '</b> on ' + esc(b.game) + '</span>'
        : '<span class="earn-best">See top cash-outs</span>') +
      '<span class="earn-chev" aria-hidden="true">&rsaquo;</span></span>';
    countUp(strip.querySelector('.earn-big'), data.total);
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

  window.V2Earnings = { pull: pull, apply: apply, open: openSheet };
})();
