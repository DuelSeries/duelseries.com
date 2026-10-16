// DuelSeries layer on the frozen slither.io client: Owen's HUD layout (2026-10-16). Ours, and a deliberate departure
// from slither.io parity that Owen asked for, made at runtime on the inline styles of their HUD elements (their files
// stay frozen). Loaded after slxStats.js (server/sl/slBoot.js SLX_FILES).
//
// Inert unless slxNet installed the production transport (15.2, finalize pass C20).
//
// 1. Their "Your length / Your rank" box (lbf, slHud.js updateLengthBox) is hidden on every screen, by visibility:
//    their client writes its display and opacity (slHud.js onInit and the fades) but never its visibility.
// 2. On a phone (their is_mobile, a user agent that says Mobile, slMain.js:59; or a window whose short side is at most
//    PHONE_SIDE) their leaderboard is smaller and shows the top PHONE_ROWS rows. Their page is laid out at 0.7 on a
//    phone (sl.html:4, initial-scale 0.7), so a 375 px phone is 536 px wide here and the window's size alone cannot
//    tell a phone from a small computer window. Their four boxes (sl.html:20-23: header lbh, scores lbs, names lbn, places lbp) are scaled about
//    the board's top right corner by a transform (the header to HEAD_K, the rows to ROW_K, the rows lifted to sit under
//    the smaller header), the names box is cut to PHONE_NAMES_W with an ellipsis and the places column moved in by the
//    width it lost, and the three row boxes are cut to PHONE_ROWS rows of their 12 px at line-height 150%. Their
//    resizeHud rewrites only `right` on these boxes (slHud.js resizeHud), and their client never writes transform,
//    transform-origin, width, height or text-overflow on them, so all of it holds across resizes. A computer keeps
//    their board as it is (the inline values sl.html gave, restored when a window grows past PHONE_SIDE).
// 3. The ping and FPS line (slxStats) sits under their minimap's disc, centred on it: their holder (loch) is the disc
//    plus a 12 px margin on every side (slHud.js setMinimapSize, fitMapCanvas), placed by its inline right, bottom and
//    width, so the line follows a new minimap size.
// 4. slx.hud.topSlot(w): the top, in px, where a block w px wide centred at the top of the screen covers neither their
//    leaderboard nor the text of their top left box (vcm): beside them when there is room, else just under the board.
//    The battle royale's block (slxBr.js) sits there.
//
// Adds to DuelSlither.slx: hud { phone(), topSlot(w), board() }.
(function (root) {
  'use strict';
  var D = root.DuelSlither;
  if (!D || !D.slx || !D.slx.active) return;
  var slx = D.slx;
  var doc = root.document;
  var S = D.S;
  if (!doc || !S) return;
  var lbh = S.lbh;
  var lbs = S.lbs;
  var lbn = S.lbn;
  var lbp = S.lbp;
  var lbf = S.lbf;
  var loch = S.loch;
  var vcm = S.vcm;
  if (!lbh || !lbs || !lbn || !lbp || !lbh.style || !lbs.style || !lbn.style || !lbp.style) return;

  var PHONE_SIDE = 520;            // CHOSEN: a computer window this small gets the phone board too
  var PHONE_ROWS = 5;              // Owen 2026-10-16: the top 5 on a phone
  var HEAD_K = 0.6;                // CHOSEN: their 21 px header at about 13 px, near the rows' size
  var ROW_K = 0.9;                 // CHOSEN: their 12 px rows at about 11 px (7.6 px on the phone's glass at 0.7)
  var PHONE_NAMES_W = 140;         // CHOSEN: about 20 characters at 12 px before the ellipsis
  // Their board (sl.html:20-23; slHud.js resizeHud, LB_W 180): right edge 4 px from the window's, header 28 px tall
  // from top 4, rows from top 32 in 12 px at line-height 150%; scores box 50 px at right 4, names 180 px at right 64,
  // places 30 px at right 260 (right-aligned, so the board's left edge is 290 px from the window's right edge).
  var EDGE = 4;
  var ROWS_TOP = 32;
  var ROW_PX = 18;
  var PC_ROWS = 10;                // their server's board has ten rows at most
  var NAMES_RIGHT = 64;
  var NAMES_W = 180;
  var PLACES_RIGHT = 260;
  var PLACES_W = 30;
  var SCORES_W = 50;
  var HEAD_W = 285;
  var BOARD_W = PLACES_RIGHT + PLACES_W - EDGE;   // 286
  var GAP = 8;                     // CHOSEN: the clear space kept around a top block

  // Their inline values, as sl.html gave them, put back on a computer.
  function keep(el, keys) {
    var o = {};
    for (var i = 0; i < keys.length; i++) o[keys[i]] = el.style[keys[i]] || '';
    return o;
  }
  var KEYS = ['transform', 'transformOrigin', 'height', 'width', 'textOverflow'];
  var orig = [[lbh, keep(lbh, KEYS)], [lbs, keep(lbs, KEYS)], [lbn, keep(lbn, KEYS)], [lbp, keep(lbp, KEYS)]];

  // 1. the length box, hidden on every screen
  if (lbf && lbf.style) lbf.style.visibility = 'hidden';

  // ---- 2. the phone board
  var phone = null;                // unknown until the first frame
  var vw = -1;
  var vh = -1;

  function px(n) {
    return Math.round(n * 100) / 100 + 'px';
  }

  function set(el, k, v) {
    if (el.style[k] !== v) el.style[k] = v;
  }

  function phoneBoard() {
    var cut = NAMES_W - PHONE_NAMES_W;                     // the width the names box lost
    var rowsLift = ROWS_TOP - EDGE;                        // 28: rows top above the board's top edge
    var ty = rowsLift * (HEAD_K - ROW_K);                  // rows lifted to sit under the smaller header
    var span = BOARD_W - cut;                              // the rows' width before the scale
    var headDx = (HEAD_W / 2) * HEAD_K - (span / 2) * ROW_K; // the header centred over the rows
    var rowsH = px(PHONE_ROWS * ROW_PX);
    set(lbh, 'transformOrigin', px(HEAD_W) + ' 0px');
    set(lbh, 'transform', 'translateZ(0) translate(' + px(headDx) + ', 0px) scale(' + HEAD_K + ')');
    set(lbs, 'transformOrigin', px(SCORES_W) + ' ' + px(-rowsLift));
    set(lbs, 'transform', 'translateZ(0) translate(0px, ' + px(ty) + ') scale(' + ROW_K + ')');
    set(lbs, 'height', rowsH);
    set(lbn, 'width', px(PHONE_NAMES_W));
    set(lbn, 'textOverflow', 'ellipsis');
    set(lbn, 'transformOrigin', px(PHONE_NAMES_W + NAMES_RIGHT - EDGE) + ' ' + px(-rowsLift));
    set(lbn, 'transform', 'translateZ(0) translate(0px, ' + px(ty) + ') scale(' + ROW_K + ')');
    set(lbn, 'height', rowsH);
    set(lbp, 'transformOrigin', px(PLACES_W + PLACES_RIGHT - EDGE) + ' ' + px(-rowsLift));
    set(lbp, 'transform', 'translateZ(0) translate(' + px(cut * ROW_K) + ', ' + px(ty) + ') scale(' + ROW_K + ')');
    set(lbp, 'height', rowsH);
  }

  function pcBoard() {
    for (var i = 0; i < orig.length; i++) {
      var el = orig[i][0];
      var o = orig[i][1];
      for (var k = 0; k < KEYS.length; k++) set(el, KEYS[k], o[KEYS[k]]);
    }
  }

  // The board's box on screen: { left, bottom, width } (the window's right edge is EDGE px from its right).
  function board() {
    var w = root.innerWidth || 0;
    if (phone) {
      var bw = (BOARD_W - (NAMES_W - PHONE_NAMES_W)) * ROW_K;
      return { left: w - EDGE - bw, bottom: EDGE + (ROWS_TOP - EDGE) * HEAD_K + PHONE_ROWS * ROW_PX * ROW_K, width: bw };
    }
    return { left: w - EDGE - BOARD_W, bottom: ROWS_TOP + PC_ROWS * ROW_PX, width: BOARD_W };
  }

  // ---- 3. the ping and FPS line under the minimap
  var stats = slx.stats && slx.stats.element;
  var MAP_MARGIN = 12;             // the holder's margin round the disc (slHud.js fitMapCanvas at 12)
  var LINE_PX = 14;                // the line's height (slxStats CSS)
  var LINE_GAP = 2;                // CHOSEN: between the disc and the line
  var LINE_MIN_W = 120;            // CHOSEN: wide enough for "999 ms  FPS: 120" under a small map
  var LINE_EDGE = 6;               // CHOSEN: the least gap to the window's right edge
  var lochKey = '';

  function placeStats() {
    if (!stats || !loch || !loch.style) return;
    var key = loch.style.right + '|' + loch.style.bottom + '|' + loch.style.width;
    if (key === lochKey) return;
    lochKey = key;
    var r = parseFloat(loch.style.right);
    var b = parseFloat(loch.style.bottom);
    var w = parseFloat(loch.style.width);
    if (!(r >= 0) || !(b >= 0) || !(w > 2 * MAP_MARGIN)) return;
    var disc = w - 2 * MAP_MARGIN;
    var lw = Math.max(disc, LINE_MIN_W);
    stats.style.right = px(Math.max(LINE_EDGE, r + MAP_MARGIN + disc / 2 - lw / 2)); // a small map: kept on screen
    stats.style.width = px(lw);
    stats.style.bottom = px(Math.max(2, b + MAP_MARGIN - LINE_GAP - LINE_PX));
  }

  // ---- 4. the top slot
  var vcmKey = null;
  var vcmRight = 0;
  var vcmBottom = 0;

  // The right and bottom edges of the text in their top left box (its box is 300 px wide whatever it says).
  function measureVcm() {
    vcmRight = 0;
    vcmBottom = 0;
    var kids = vcm && vcm.children;
    if (!kids) return;
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (typeof k.getBoundingClientRect !== 'function') continue;
      var r = k.getBoundingClientRect();
      if (!(r.width > 0)) continue;
      if (r.right > vcmRight) vcmRight = r.right;
      if (r.bottom > vcmBottom) vcmBottom = r.bottom;
    }
  }

  function topSlot(w) {
    var bw = root.innerWidth || 0;
    var half = (w > 0 ? w : 0) / 2 + GAP;
    var b = board();
    var cx = bw / 2;
    if (cx - half >= vcmRight && cx + half <= b.left) return GAP;
    return Math.round(Math.max(b.bottom, vcmBottom) + GAP);
  }

  function frame() {
    root.requestAnimationFrame(frame);
    var w = root.innerWidth;
    var h = root.innerHeight;
    if (w !== vw || h !== vh) {
      vw = w;
      vh = h;
      var p = !!S.is_mobile || Math.min(w, h) <= PHONE_SIDE;
      if (p !== phone) {
        phone = p;
        if (p) phoneBoard();
        else pcBoard();
      }
      vcmKey = null;
    }
    placeStats();
    var t = vcm ? vcm.textContent : '';
    if (t !== vcmKey) {
      vcmKey = t;
      measureVcm();
    }
  }
  if (typeof root.requestAnimationFrame === 'function') root.requestAnimationFrame(frame);

  slx.hud = {
    phone: function () { return phone === true; },
    topSlot: topSlot,
    board: board
  };
})(typeof window !== 'undefined' ? window : globalThis);
