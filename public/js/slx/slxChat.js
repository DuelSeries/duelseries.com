// DuelSeries layer on the frozen slither.io client: in-game chat and kill lines (Owen Q14 "keep all"; SERVER-DESIGN
// 15.3 "Old extras kept"; task T17). Ours, not a parity area.
//
// Inert unless slxNet installed the production transport (15.2, finalize pass C20).
//
// Drawn by the shared chat every game uses (public/js/shared/dsChat.js, Owen's pick "Pills", 2026-10-16), which the
// composed /sl page loads before the slx tail as it does dsEnd.js (server/sl/slBoot.js). This file only maps the wire
// in and out: T opens the box, Enter sends, Esc closes, the newest lines fade after a few seconds, names print in the
// snake's own colour. On a phone (coarse pointer) a small chat button sits top left.
//
// Wire: sl:chat {text} out (slx.send; the server runs the chat guard, server/chatGuard.js, then C_CHAT, and slSockets'
// C_RATE chat gap); sl:x {t: 'chat', name, text, id, cv}, {t: 'kill', killer, victim, kid, vid} and {t: 'chatnote',
// text} (a refused line, only to its sender) in (slRoom onChat and _onDeath, C_KILLFEED).
//
// Typing never steers: dsChat stops every key at the window while the box is open, before their document.onkeydown
// (public/js/sl/slInput.js:173-197, 208) sees Space, the arrows, Q or P; a key already held when it opened still gets
// its key-up. A press on the box never reaches their window.onmousedown boost (slx.guard, slInput.js:148, 205).
// Shown while their game shows (S.playing), like their HUD. A watcher never sends (slxWatch swallows T first, and the
// server takes no line from a watcher) but sees the lines.
(function (root) {
  'use strict';
  var D = root.DuelSlither;
  if (!D || !D.slx || !D.slx.active) return;
  var slx = D.slx;
  var S = D.S;
  var C = root.DSChat;
  if (!S || !C || typeof C.mount !== 'function' || typeof slx.on !== 'function' || typeof slx.guard !== 'function') return;

  var NAME_FALLBACK = 'Player';                  // game.js:315
  var VICTIM_FALLBACK = 'a snake';               // game.js:279

  // Drawn back up from their 0.7 page only where the page really is at 0.7 (slxMain's layoutZoom, as slxHud).
  var ZOOM = typeof slx.layoutZoom === 'function' ? slx.layoutZoom() : 1;

  var pending = [];                              // own lines waiting for their echo: styling only
  var PENDING_MAX = 8;                           // CHOSEN: lines in flight at once (the old box's PENDING_MAX)

  var chat = C.mount({
    send: function (text) {
      if (!slx.send('sl:chat', { text: text })) return false;
      // as the server will print it, near enough: no tags or angle brackets, one space (server/chatGuard.js clean)
      pending.push(text.replace(/<[^>]*>/g, ' ').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().toLowerCase());
      if (pending.length > PENDING_MAX) pending.shift();
      return true;
    },
    canSend: function () { return !!S.playing; },
    phone: !!S.is_mobile,
    zoom: ZOOM,
    pc: { left: 10, bottom: 50 },                // above their length box (sl.html lbf, 37 px high at bottom 4)
    phoneAt: { left: 10, top: 10 },
    guard: slx.guard,
    victimFallback: VICTIM_FALLBACK,
    z: 11
  });

  // slxTouch leaves any touch inside an slx- element alone (its isControl), so the chat button and box get theirs.
  chat.el.className += ' slx-chat';

  // A snake's colour: the live snake's own (custom and striped skins too), else its plain skin colour from their
  // table (every skin outside 0..8 draws from it by cv % 9, public/js/sl/slSprites.js setSkin).
  function colourOf(id, cv) {
    var o = S.os && Number.isInteger(id) ? S.os['s' + id] : null;
    if (o && typeof o.cs === 'string') return o.cs;
    if (!Number.isInteger(cv) || cv < 0 || !S.rrs || !S.ggs || !S.bbs) return '';
    var i = cv % 9;
    return [S.rrs[i], S.ggs[i], S.bbs[i]];
  }

  function str(v) {
    return typeof v === 'string' ? v : '';
  }

  // The server sends the same line to every seat with no "self" mark: an own line is the next echo of a text this
  // page sent, letter for letter except where the server masked a word (a star).
  function same(sent, echo) {
    if (sent.length !== echo.length) return false;
    for (var i = 0; i < echo.length; i++) if (echo.charAt(i) !== '*' && echo.charAt(i) !== sent.charAt(i)) return false;
    return true;
  }
  function ownLine(text) {
    var low = text.toLowerCase();
    for (var i = 0; i < pending.length; i++) {
      if (same(pending[i], low)) {
        pending.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  slx.on('x:chat', function (m) {
    var text = str(m.text);
    if (!text) return;
    chat.add({ name: str(m.name) || NAME_FALLBACK, color: colourOf(m.id, m.cv), text: text, me: ownLine(text) });
  });
  slx.on('x:kill', function (m) {
    chat.add({ kind: 'kill', killer: str(m.killer), victim: str(m.victim), killerColor: colourOf(m.kid, -1),
      victimColor: colourOf(m.vid, -1) });
  });
  slx.on('x:chatnote', function (m) {
    var text = str(m.text);
    if (text) chat.add({ kind: 'sys', text: text });
  });

  // Shown while their game shows.
  var visible = false;
  function frame() {
    var on = !!S.playing;
    if (on !== visible) {
      visible = on;
      chat.visible(on);
    }
    root.requestAnimationFrame(frame);
  }
  root.requestAnimationFrame(frame);

  slx.chat = {
    element: chat.el,
    input: chat.input,
    open: chat.open,
    close: chat.close,
    typing: chat.typing,
    lines: chat.lines
  };
})(typeof window !== 'undefined' ? window : globalThis);
