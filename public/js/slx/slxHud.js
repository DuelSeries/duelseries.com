// DuelSeries layer on the frozen slither.io client: Owen's HUD layout (2026-10-16). Ours, and a deliberate departure
// from slither.io parity that Owen asked for, made at runtime on their HUD elements (their files stay frozen). Loaded
// after slxStats.js (server/sl/slBoot.js SLX_FILES).
//
// Inert unless slxNet installed the production transport (15.2, finalize pass C20).
//
// 1. Their "Your length / Your rank" box (lbf, slHud.js updateLengthBox) is hidden on every screen, by visibility:
//    their client writes its display and opacity (slHud.js onInit and the fades) but never its visibility.
// 2. The leaderboard is the one every DuelSeries game shows (public/js/shared/dsEnd.js board; Owen 2026-10-16: one
//    leaderboard for all the games, fully clear, text only): their four boxes (sl.html:20-23: header lbh, scores lbs,
//    names lbn, places lbp) are hidden the same way, and ours is filled from what their leaderboard handler writes
//    there (slApply.js onLeaderboard -> slHud.setLeaderboard, three innerHTML writes): each frame looks whether the
//    boxes were written again (an innerHTML write replaces every child node, so their first nodes change) and then
//    reads the rows back as text: the names, the lengths, and the own row (theirs is the bold one, place == myPos).
//    Their module is never touched. The own row is pinned under the list when it is outside it: from their own
//    length box, which their HUD rewrites at every leaderboard with the own length by their formula, their rank and
//    the snake count, in that order whatever the language (slHud.js updateLengthBox, 275-288). Ours follows their
//    board's fade (lb_fr on the boxes' opacity), so it shows and goes when theirs would. Top PHONE_ROWS on a phone,
//    else dsEnd's rows (10 on a computer, 5 on a window as narrow as a phone).
//    A phone is their is_mobile (a user agent that says Mobile, slMain.js:59) or a window whose short side is at
//    most PHONE_SIDE. Their page is laid out at 0.7 on a phone (sl.html:4, initial-scale 0.7, where is_mobile holds),
//    so the board is drawn back up by 1/0.7 there to the size it has in every other game. A frame ignores the
//    viewport line, so in a frame it is drawn up only when the lobby drew the frame at 0.7 (slx.hud.zoom() says).
// 3. (The ping and FPS line is no longer placed here: it is the readout every game shares, in the bottom right corner
//    under their minimap, public/js/shared/dsPerfHud.js, Owen 2026-10-27.)
// 4. slx.hud.topSlot(w): the top, in px, where a block w px wide centred at the top of the screen covers neither the
//    leaderboard nor the text of their top left box (vcm): beside them when there is room, else just under the board.
//    The battle royale's block (slxBr.js) sits there.
//
// Adds to DuelSlither.slx: hud { phone(), zoom(), topSlot(w), board(), rows() }.
(function (root) {
  'use strict';
  var D = root.DuelSlither;
  if (!D || !D.slx || !D.slx.active) return;
  var slx = D.slx;
  var doc = root.document;
  var S = D.S;
  var E = root.DSEnd;
  if (!doc || !S || !E) return;
  var lbh = S.lbh;
  var lbs = S.lbs;
  var lbn = S.lbn;
  var lbp = S.lbp;
  var lbf = S.lbf;
  var vcm = S.vcm;
  if (!lbh || !lbs || !lbn || !lbp || !lbh.style || !lbs.style || !lbn.style || !lbp.style) return;

  var PHONE_SIDE = 520;            // CHOSEN: a computer window this small counts as a phone too
  var PHONE_ROWS = 5;              // Owen 2026-10-16: the top 5 on a phone
  var GAP = 8;                     // CHOSEN: the clear space kept around a top block
  var NO_RANK = 999999999;         // their rank before any leaderboard (slApply.js:146)

  // 1. the length box and their board, hidden on every screen
  if (lbf && lbf.style) lbf.style.visibility = 'hidden';
  var theirs = [lbh, lbs, lbn, lbp];
  for (var t = 0; t < theirs.length; t++) theirs[t].style.visibility = 'hidden';

  // ---- 2. the board
  var phone = null;                // unknown until the first frame
  var vw = -1;
  var vh = -1;
  // Drawn back up from their 0.7 page only where the page really is at 0.7 (slxMain's layoutZoom(): a phone's page of
  // its own, or the lobby's frame, which the lobby draws at 0.7 on a phone; a frame alone ignores the viewport line).
  var ZOOM = typeof slx.layoutZoom === 'function' ? slx.layoutZoom() : S.is_mobile && slx.framed !== true ? 1 / 0.7 : 1;
  // A paid room ranks by money (Owen 2026-10-17): the server's {t:'lb'} rows (name, worth in micro, its own order) and
  // the seat's own [rank, worth] replace their names and lengths, shown as $ (dsEnd usd). Display only. A watcher of a
  // paid rung (slxWatch) is no paid page, so the first {t:'lb'} (only a paid room sends one) turns it on there too.
  var PAID = !!(slx.paid && slx.paid.on);
  var ours = E.board({ zoom: ZOOM, z: 10, money: PAID });
  ours.hide();
  var rows = [];                   // what ours shows: { name, value, me }
  var me = null;

  function px(n) {
    return Math.round(n * 100) / 100 + 'px';
  }

  function texts(box) {
    var out = [];
    var kids = box.children || [];
    for (var i = 0; i < kids.length; i++) if (String(kids[i].tagName).toUpperCase() === 'SPAN') out.push(kids[i]);
    return out;
  }

  // The name the last Play used (slMain.nick, public/js/sl/slMain.js:94-101): theirs on the own row too.
  function nick() {
    var m = D.slMain;
    return m && typeof m.nick === 'string' ? m.nick : '';
  }

  // The own length and rank from their length box: its text is "<words>: LENGTH<words>: RANK <words> COUNT" in every
  // language (slHud.js updateLengthBox and lengthWords, none with a digit). null before their first write.
  function ownBox() {
    var m = lbf ? /(\d+)\D+(\d+)\D+(\d+)\D*$/.exec(String(lbf.textContent || '')) : null;
    if (!m || !(Number(m[2]) > 0) || Number(m[2]) >= NO_RANK) return null;
    return { rank: Number(m[2]), value: E.int(Number(m[1])) };
  }

  // What ours shows: the top PHONE_ROWS on a phone (the cut leaves the own row out: dsEnd pins it), else every row.
  function push() {
    ours.set(phone ? rows.slice(0, PHONE_ROWS) : rows, me);
  }

  // The paid board from the last {t:'lb'}: others' names through their filter (slApply gdnm), the own row with the
  // name the last Play used. Shown only once their board has been written (their fades then say when it shows).
  var worths = null;
  var seen = false;
  function micro(v) {
    return typeof v === 'number' && v >= 0 && isFinite(v) ? v : 0;
  }
  function fromWorths() {
    var m = worths;
    if (!m || !seen) return;
    var gd = D.slApply && typeof D.slApply.gdnm === 'function' ? D.slApply.gdnm : null;
    var mine = m.me ? m.me[0] : 0;
    var out = [];
    for (var i = 0; i < m.rows.length; i++) {
      var r = m.rows[i];
      var own = i + 1 === mine;
      var name = own && nick() ? nick() : String(r[0] == null ? '' : r[0]);
      if (!own && gd && !gd(name)) name = '';
      out.push({ name: name, value: E.usd(micro(r[1])), me: own });
    }
    rows = out;
    me = m.me ? { rank: m.me[0], name: nick(), value: E.usd(micro(m.me[1])) } : null;
    push();
  }
  if (typeof slx.on === 'function') {
    slx.on('x:lb', function (m) {
      if (!m || !Array.isArray(m.rows)) return;
      if (!PAID) {
        PAID = true;
        if (ours.el) ours.el.className = String(ours.el.className) + ' money';
        seen = texts(lbn).length > 0;
      }
      var meOk = Array.isArray(m.me) && typeof m.me[0] === 'number' && m.me[0] >= 1;
      worths = { rows: m.rows.filter(Array.isArray), me: meOk ? m.me : null };
      try {
        fromWorths();
      } catch (e) {
        slx.errors++;
      }
    });
  }

  // Their rows, read back after their handler wrote them: names (the own one bold) and lengths, in place order.
  function readTheirs() {
    if (PAID) {
      seen = seen || texts(lbn).length > 0;
      fromWorths();
      return;
    }
    var names = texts(lbn);
    var scores = texts(lbs);
    var out = [];
    var at = -1;
    for (var i = 0; i < names.length; i++) {
      var n = names[i];
      var bold = !!(n.style && /bold|[6-9]00/.test(String(n.style.fontWeight)));
      if (bold && at < 0) at = i;
      var sc = scores[i] ? String(scores[i].textContent).replace(/[^0-9]/g, '') : '';
      out.push({ name: String(n.textContent || ''), value: sc ? E.int(Number(sc)) : '', me: bold });
    }
    rows = out;
    // The own row: theirs when their board lists it (place = row), else their length box's while playing.
    var box = at < 0 && S.playing ? ownBox() : null;
    me = at >= 0 ? { rank: at + 1, name: out[at].name, value: out[at].value }
      : box ? { rank: box.rank, name: nick(), value: box.value } : null;
    push();
  }

  // Their boxes' first nodes at the last read: an innerHTML write replaces every child, so a new first node (or none
  // where there was one) means their handler or their length box wrote again.
  var firsts = [null, null, null];
  function written() {
    var cur = [lbn.firstChild || null, lbs.firstChild || null, lbf && lbf.firstChild || null];
    if (cur[0] === firsts[0] && cur[1] === firsts[1] && cur[2] === firsts[2]) return false;
    firsts = cur;
    return true;
  }

  // Ours shows while theirs would: their fades write the boxes' opacity (lb_fr), their onInit their display.
  var shownKey = '';
  function follow() {
    var op = parseFloat(lbs.style.opacity);
    var on = lbs.style.display !== 'none' && !(op === 0) && rows.length > 0;
    var key = on ? 'on|' + (op >= 0 ? op : 1) : 'off';
    if (key === shownKey) return;
    shownKey = key;
    if (!on) {
      ours.hide();
      return;
    }
    ours.show();
    ours.el.style.opacity = String(op >= 0 ? Math.min(1, op) : 1);
  }

  // The board's box on screen: { left, bottom, width }.
  function board() {
    var r = ours.el && typeof ours.el.getBoundingClientRect === 'function' ? ours.el.getBoundingClientRect() : null;
    if (!r || !(r.width > 0)) {
      var w = root.innerWidth || 0;
      return { left: w, bottom: 0, width: 0 };
    }
    return { left: r.left, bottom: r.bottom, width: r.width };
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
      phone = !!S.is_mobile || Math.min(w, h) <= PHONE_SIDE;
      if (rows.length) push();               // the row count follows the window
      vcmKey = null;
    }
    if (written()) {
      try {
        readTheirs();
      } catch (e) {
        slx.errors++;
      }
    }
    follow();
    var t = vcm ? vcm.textContent : '';
    if (t !== vcmKey) {
      vcmKey = t;
      measureVcm();
    }
  }
  if (typeof root.requestAnimationFrame === 'function') root.requestAnimationFrame(frame);

  slx.hud = {
    phone: function () { return phone === true; },
    zoom: function () { return ZOOM; },
    topSlot: topSlot,
    board: board,
    rows: function () { return { rows: rows.slice(), me: me }; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
