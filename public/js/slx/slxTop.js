// DuelSeries layer on the frozen slither.io client: the biggest cash-out box (Owen Q13 and 14:45; SERVER-DESIGN 15.4;
// task T17). Ours, not a parity area.
//
// Inert unless slxNet installed the production transport (15.2, finalize pass C20).
//
// Their "Today's longest" box is the vcm element (public/sl.html:25). Their client writes it only on packet `m`
// (public/js/sl/slHud.js:299-301), which our server never sends, and their resetGame keeps its text across lives. So
// this file writes the biggest all-time cash-out into that same element and everything else stays theirs: its place,
// its font, its show at the game start and its fades (slHud.js:136-160, 206-237).
//
// The server pushes sl:x {t: 'top', name, amount} at join and on change (server/sl/slTopCashout.js): amount is the
// take-home in dollars at cent precision, name the winner's name; {name: null, amount: null} is the empty state
// ("No cash-outs yet"). Before any push the box stays empty (the server has no reading yet, or no database).
//
// The lines copy the shape of their longest box (public/js/sl/slApply.js:847-868): italic lines, the label at opacity
// .5, the figure at .75 and the name at .65, bold. Text goes in as text nodes only (a name is never parsed as HTML).
(function (root) {
  'use strict';
  var D = root.DuelSlither;
  if (!D || !D.slx || !D.slx.active) return;
  var slx = D.slx;
  var doc = root.document;
  var S = D.S;
  if (!doc || !S || !S.vcm || typeof slx.on !== 'function') return;

  var WORDS = { head: 'Biggest cash-out', none: 'No cash-outs yet', by: ' by ' };
  // A name longer than their 24-character cap (law L45 nameMax) is not one our server sent.
  var NAME_MAX = 24;

  var lastKey = null;

  // Dollars with thousands commas and two decimals, from the cents (the amount is at cent precision already).
  function money(amount) {
    var cents = Math.round(amount * 100);
    var whole = String(Math.floor(cents / 100));
    var frac = String(cents % 100);
    if (frac.length < 2) frac = '0' + frac;
    var out = '';
    while (whole.length > 3) {
      out = ',' + whole.slice(-3) + out;
      whole = whole.slice(0, -3);
    }
    return '$' + whole + out + '.' + frac;
  }

  function span(opacity, text, bold) {
    var s = doc.createElement('span');
    s.style.opacity = opacity;
    if (bold) {
      var b = doc.createElement('b');
      b.textContent = text;
      s.appendChild(b);
    } else {
      s.textContent = text;
    }
    return s;
  }

  function italic(parts) {
    var i = doc.createElement('i');
    for (var k = 0; k < parts.length; k++) i.appendChild(parts[k]);
    return i;
  }

  // The message, checked; null when it is not one the box can show.
  function read(m) {
    if (!m || typeof m !== 'object') return null;
    if (m.name === null && m.amount === null) return { empty: true, name: '', amount: 0 };
    var a = m.amount;
    if (typeof a !== 'number' || !isFinite(a) || a < 0) return null;
    var n = m.name == null ? '' : m.name;
    if (typeof n !== 'string' || n.length > NAME_MAX) return null;
    return { empty: false, name: n, amount: a };
  }

  function render(m) {
    var v = read(m);
    if (!v) return;
    var key = v.empty ? 'empty' : money(v.amount) + '\n' + v.name;
    if (key === lastKey) return;
    lastKey = key;
    var box = S.vcm;
    while (box.firstChild) box.removeChild(box.firstChild);
    box.appendChild(italic([span('.5', WORDS.head)]));
    box.appendChild(doc.createElement('br'));
    if (v.empty) {
      box.appendChild(italic([span('.5', WORDS.none)]));
      return;
    }
    var parts = [span('.75', money(v.amount), true)];
    if (v.name) {
      parts.push(span('.5', WORDS.by));
      parts.push(span('.65', v.name, true));
    }
    box.appendChild(italic(parts));
  }

  slx.on('x:top', render);

  slx.top = {
    money: money,
    // For tests and the console: the text the box shows now.
    text: function () {
      return lastKey === null ? '' : lastKey;
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
