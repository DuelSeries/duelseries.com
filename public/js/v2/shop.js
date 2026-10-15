/* The Shop tab (Owen, 2026-10-15): skins for every game, priced, and nothing
   for sale yet. LOOK ONLY. Every Buy button is disabled and says Coming soon;
   there is no purchase flow, no request to the server and no change to which
   skins anybody can wear.

   The skins and their previews are public/js/v2/shopArt.js (window.V2Shop).
   Prices are shared/shopPrices.js, the one file Owen edits.

   Owen asked for all three layouts from the mockups so he can pick one in the
   real lobby. The switch at the top of the screen is that choice, remembered
   on this device; once he has picked, the other two and the switch go.
     A  one game at a time: game chips, then that game's skins in a grid
     B  every game on one page: a sideways shelf per game
     C  showcase: one big live preview of the tapped skin, tiles under it

   Exposes window.V2ShopTab = {render()}; the lobby calls render() from
   fillScreen('shop'), before the screen is shown. */
(function (root) {
  'use strict';
  var S = root.V2Shop;
  var LOCK = root.DS_LOCKED;
  var KEY = 'shop:layout';
  var LAYOUTS = [['a', 'One game'], ['b', 'All games'], ['c', 'Showcase']];

  function read(k) { try { return root.localStorage.getItem(k); } catch (e) { return null; } }
  function write(k, v) { try { root.localStorage.setItem(k, v); } catch (e) { /* private mode */ } }

  var layout = read(KEY);
  if (!LAYOUTS.some(function (l) { return l[0] === layout; })) layout = 'a';
  var gameId = S.games[0].id;
  var pickId = null;

  /* Whole dollars show as $1, anything with cents as $1.50, so a price Owen
     sets with cents still reads right. */
  function money(p) {
    if (p == null) return '';
    return '$' + (Math.round(p * 100) % 100 === 0 ? String(Math.round(p)) : p.toFixed(2));
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function locked(g) { return !!(LOCK && LOCK.isLocked(g.id)); }

  function rarity(g, k) {
    var t = S.tier(S.price(g.id, k.id));
    if (t == null) return '';
    var pips = '';
    for (var i = 0; i < S.tiers.length; i++) pips += '<i' + (i <= t ? ' class="on"' : '') + '></i>';
    return '<span class="sh-rar"><span class="sh-pips" aria-hidden="true">' + pips + '</span>' + esc(S.tiers[t].name) + '</span>';
  }
  /* A real disabled button: it cannot be pressed, focused or submitted, and
     it has no handler. Buying is a later job. */
  var BUY = '<button class="sh-buy" type="button" disabled>Coming soon</button>';

  function cv(g, k, big) {
    return '<canvas class="sh-cv" data-g="' + g.id + '" data-k="' + k.id + '"' + (big ? ' data-big="1"' : '') +
      ' role="img" aria-label="' + esc(k.name + ', ' + g.name + ' skin') + '"></canvas>';
  }
  function card(g, k) {
    return '<div class="sh-card">' + cv(g, k) + '<div class="sh-meta">' +
      '<div class="sh-nm">' + esc(k.name) + '</div>' +
      '<div class="sh-ln">' + rarity(g, k) + '<span class="sh-price num">' + money(S.price(g.id, k.id)) + '</span></div>' +
      BUY + '</div></div>';
  }
  function chips() {
    return '<div class="sh-chips" role="tablist" aria-label="Game">' + S.games.map(function (g) {
      var on = g.id === gameId;
      return '<button class="sh-chip' + (on ? ' on' : '') + '" role="tab" aria-selected="' + on + '" data-game="' + g.id + '">' +
        esc(g.name) + '<span class="sh-n num">' + g.skins.length + '</span></button>';
    }).join('') + '</div>';
  }
  function lockNote(g) {
    return locked(g) ? '<p class="sh-note">' + esc(g.name) + ' is not playable yet. Its skins are here for when it is.</p>' : '';
  }
  function switcher() {
    return '<div class="sh-lay" role="radiogroup" aria-label="Shop layout">' + LAYOUTS.map(function (l) {
      var on = l[0] === layout;
      return '<button class="' + (on ? 'on' : '') + '" role="radio" aria-checked="' + on + '" data-layout="' + l[0] + '">' + l[1] + '</button>';
    }).join('') + '</div>';
  }

  function bodyA() {
    var g = S.game(gameId);
    return chips() + lockNote(g) + '<div class="sh-grid">' + g.skins.map(function (k) { return card(g, k); }).join('') + '</div>';
  }
  function bodyB() {
    return S.games.map(function (g) {
      return '<section class="sh-shelf"><div class="sh-sh"><h3>' + esc(g.name) + '</h3>' +
        '<span class="num">' + (locked(g) ? 'Not playable yet' : g.skins.length + ' skins') + '</span></div>' +
        '<div class="sh-rail">' + g.skins.map(function (k) { return card(g, k); }).join('') + '</div></section>';
    }).join('');
  }
  function bodyC() {
    var g = S.game(gameId);
    var k = g.by[pickId] || g.skins[0];
    var show = '<div class="sh-show">' + cv(g, k, true) + '<div class="sh-meta">' +
      '<div class="sh-ln"><span class="sh-nm">' + esc(k.name) + '</span><span class="sh-price num">' + money(S.price(g.id, k.id)) + '</span></div>' +
      '<div class="sh-ln">' + rarity(g, k) + '<span class="sh-for">' + esc(g.name) + '</span></div>' + BUY + '</div></div>';
    var tiles = '<div class="sh-tiles">' + g.skins.map(function (s) {
      var on = s.id === k.id;
      return '<button class="sh-tile' + (on ? ' on' : '') + '" aria-pressed="' + on + '" data-skin="' + s.id + '">' + cv(g, s) +
        '<span class="sh-tp num">' + money(S.price(g.id, s.id)) + '</span><span class="sh-tn">' + esc(s.name) + '</span></button>';
    }).join('') + '</div>';
    return chips() + lockNote(g) + '<div class="sh-cwrap">' + show + tiles + '</div>';
  }

  var host = null;
  function draw() {
    host = root.document.getElementById('shop');
    if (!host) return;
    host.className = 'sh-' + layout;
    host.innerHTML =
      '<div class="head"><div><h2>Shop</h2><div class="sub">Skins for every game. Nothing is for sale yet.</div></div>' +
      '<span class="sp"></span>' + switcher() + '</div>' +
      (layout === 'b' ? bodyB() : layout === 'c' ? bodyC() : bodyA());
    host.onclick = onClick;
    collect();
  }
  function onClick(e) {
    var t = e.target.closest('button');
    if (!t || t.disabled) return;
    if (t.dataset.layout) { layout = t.dataset.layout; write(KEY, layout); draw(); }
    else if (t.dataset.game) { gameId = t.dataset.game; pickId = null; draw(); }
    else if (t.dataset.skin) { pickId = t.dataset.skin; draw(); }
  }

  /* ── painting ───────────────────────────────────────────────────────────
     Only while the Shop is on screen. The lobby shares its thread with the
     game iframe, and a preview left animating behind a game is what once cost
     the snake half its frame rate, so the loop stops itself the first frame
     the screen is not showing and render() is what starts it again. */
  var cvs = [], fresh = [], running = false, last = 0, sized = 0;
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
    for (var i = 0; i < cvs.length; i++) {
      var c = cvs[i];
      var grew = resize && fit(c);
      var isNew = fresh.indexOf(c) >= 0;
      if (isNew) { fit(c); fresh.splice(fresh.indexOf(c), 1); }
      var moves = S.animated(c.dataset.g);
      if (!(grew || isNew || (moves && tick))) continue;
      if (moves && !grew && !isNew) {
        var r = c.getBoundingClientRect();
        if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
      }
      S.paint(c, c.dataset.g, c.dataset.k, t, !!c.dataset.big);
    }
  }
  function render() {
    draw();
    grace = 10;
    if (!running) { running = true; root.requestAnimationFrame(frame); }
  }

  root.V2ShopTab = { render: render };
})(window);
