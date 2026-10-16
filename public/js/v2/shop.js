/* The Shop tab (Owen, 2026-10-15): skins for every game, priced, and nothing
   for sale yet. LOOK ONLY. Every Buy button is disabled and says Coming soon;
   there is no purchase flow, no request to the server and no change to which
   skins anybody can wear.

   The skins and their previews are public/js/v2/shopArt.js (window.V2Shop).
   Prices are shared/shopPrices.js, the one file Owen edits.

   One game at a time: game chips along the top, then that game's skins in a
   grid. Owen picked this one of the three mockup layouts (2026-10-15).

   Exposes window.V2ShopTab = {render()}; the lobby calls render() from
   fillScreen('shop'), before the screen is shown. */
(function (root) {
  'use strict';
  var S = root.V2Shop;
  var LOCK = root.DS_LOCKED;
  var gameId = S.games[0].id;

  function money(p) { return S.format(p); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function locked(g) { return !!(LOCK && LOCK.isLocked(g.id)); }

  function cv(g, k) {
    return '<canvas class="sh-cv" data-g="' + g.id + '" data-k="' + k.id + '"' +
      ' role="img" aria-label="' + esc(k.name + ', ' + g.name + ' skin') + '"></canvas>';
  }
  /* A card is the skin, its name and its price (Owen, 2026-10-15). The grey
     "Coming soon" button on every card and the rarity word, which only
     restated the price, went; one "Coming soon" under the heading says it
     for all of them. There is still no way to buy anything. */
  function card(g, k) {
    return '<div class="sh-card">' + cv(g, k) + '<div class="sh-meta">' +
      '<div class="sh-ln"><span class="sh-nm">' + esc(k.name) + '</span>' +
      '<span class="sh-price num">' + money(S.price(g.id, k.id)) + '</span></div>' +
      '</div></div>';
  }
  function chips() {
    // Plain toggle buttons (aria-pressed): tab roles promised a tab panel and arrow keys that never existed.
    return '<div class="sh-chips" role="group" aria-label="Game">' + S.games.map(function (g) {
      var on = g.id === gameId;
      /* No skin count: every game has the same eight, so the number on each
         chip said nothing (2026-10-15). */
      return '<button class="sh-chip' + (on ? ' on' : '') + '" type="button" aria-pressed="' + on + '" data-game="' + g.id + '">' +
        esc(g.name) + '</button>';
    }).join('') + '</div>';
  }
  function lockNote(g) {
    return locked(g) ? '<p class="sh-note">' + esc(g.name) + ' is not playable yet.</p>' : '';
  }
  function bodyA() {
    var g = S.game(gameId);
    return chips() + lockNote(g) + '<div class="sh-grid">' + g.skins.map(function (k) { return card(g, k); }).join('') + '</div>';
  }
  var host = null;
  function draw() {
    host = root.document.getElementById('shop');
    if (!host) return;
    /* The chip row keeps where it was scrolled to across a redraw, then
       brings the picked chip into view: rebuilding it put the row back at
       the start, so the chip just picked slid off the screen. */
    var old = host.querySelector('.sh-chips'), keep = old ? old.scrollLeft : 0;
    // One "Coming soon" for the whole Shop, instead of a dead button on every card.
    host.innerHTML = '<div class="head"><div><h2>Shop</h2><div class="sub">Coming soon</div></div></div>' + bodyA();
    host.onclick = onClick;
    var row = host.querySelector('.sh-chips');
    if (row) {
      row.scrollLeft = keep;
      var on = row.querySelector('.sh-chip.on');
      if (on && (on.offsetLeft < row.scrollLeft || on.offsetLeft + on.offsetWidth > row.scrollLeft + row.clientWidth))
        row.scrollLeft = on.offsetLeft - (row.clientWidth - on.offsetWidth) / 2;
    }
    collect();
  }
  function onClick(e) {
    var t = e.target.closest('button');
    if (!t || t.disabled) return;
    if (t.dataset.game) { gameId = t.dataset.game; draw(); }
  }

  /* ── painting ───────────────────────────────────────────────────────────
     Only while the Shop is on screen. The lobby shares its thread with the
     game iframe, and a preview left animating behind a game is what once cost
     the snake half its frame rate, so the loop stops itself the first frame
     the screen is not showing and render() is what starts it again. */
  var cvs = [], fresh = [], running = false, last = 0, sized = 0, FRESH_MS = 4;
  function collect() {
    cvs = Array.prototype.slice.call(host.querySelectorAll('canvas.sh-cv'));
    fresh = cvs.slice();
    sized = 0;
  }
  function showing() {
    var scr = root.document.getElementById('shop-screen');
    return !!(scr && scr.getClientRects().length && !root.document.hidden);
  }
  function fit(c) {
    var dpr = Math.min(2, root.devicePixelRatio || 1);
    var w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; return true; }
    return false;
  }
  var grace = 0;
  function frame(ts) {
    /* render() runs just before the screen is shown, so a few frames of grace
       before a hidden screen counts as gone. */
    if (!showing()) { if (grace-- <= 0) { running = false; return; } root.requestAnimationFrame(frame); return; }
    grace = 0;
    root.requestAnimationFrame(frame);
    var t = ts / 1000, vw = root.innerWidth, vh = root.innerHeight;
    var resize = ts - sized > 500;                       // a cheap re-measure twice a second
    if (resize) sized = ts;
    var tick = ts - last >= 33;                          // animated previews at ~30fps
    if (tick) last = ts;
    var t0 = root.performance.now(), newOnes = 0;
    for (var i = 0; i < cvs.length; i++) {
      var c = cvs[i];
      var at = fresh.indexOf(c), isNew = at >= 0;
      /* New previews get a few milliseconds a frame, and always at least
         one: on a slow phone the first frame of a swipe into the Shop used
         to paint every card at once (2026-10-16). The rest follow over
         the next frames, while the screen is still sliding in. */
      if (isNew && newOnes && root.performance.now() - t0 > FRESH_MS) continue;
      var grew = resize && fit(c);
      if (isNew) { newOnes++; fit(c); fresh.splice(at, 1); }
      var moves = S.animated(c.dataset.g);
      if (!(grew || isNew || (moves && tick))) continue;
      if (moves && !grew && !isNew) {
        var r = c.getBoundingClientRect();
        if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
      }
      S.paint(c, c.dataset.g, c.dataset.k, t, false);
    }
  }
  function render() {
    draw();
    grace = 10;
    if (!running) { running = true; root.requestAnimationFrame(frame); }
  }

  root.V2ShopTab = { render: render };
})(window);
