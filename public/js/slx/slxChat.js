// DuelSeries layer on the frozen slither.io client: in-game chat and kill lines (Owen Q14 "keep all"; SERVER-DESIGN
// 15.3 "Old extras kept"; task T17). Ours, not a parity area.
//
// Inert unless slxNet installed the production transport (15.2, finalize pass C20).
//
// A port of the old game's box (public/js/game.js:239-318, public/game.html:275-279, public/css/game.css:54-164):
// T opens the input, Enter sends, Esc or a blur closes, 120 characters (law C_CHAT maxLen), the last 50 lines kept,
// the view sticks to the newest line unless the player scrolled up, kill lines in red ("killer killed victim"). On a
// phone (coarse pointer) it is the old small feed: four lines, no box, no input, no touch taken.
//
// Wire: sl:chat {text} out (slx.send; the server strips < and >, trims and cuts, server/sl/slRoom.js cleanChat, and
// rate-limits, C_RATE chat); sl:x {t: 'chat', name, text} and {t: 'kill', killer, victim} in (slRoom onChat and
// _onDeath, C_KILLFEED). Names and text only ever reach the page as text nodes.
//
// Typing never steers: the input's key events stop at the input (slx.guard typing), so their document.onkeydown
// (public/js/sl/slInput.js:173-197, 208) never sees Space or the arrows; a click on the box never reaches their
// window.onmousedown boost (slInput.js:148, 205). Shown while their game shows (S.playing), like their HUD.
(function (root) {
  'use strict';
  var D = root.DuelSlither;
  if (!D || !D.slx || !D.slx.active) return;
  var slx = D.slx;
  var doc = root.document;
  var S = D.S;
  if (!doc || !S || typeof slx.on !== 'function' || typeof slx.guard !== 'function') return;

  var MAX_LEN = 120;                             // law C_CHAT maxLen (spec/SERVER-LAWS.md section N)
  var STRIP = '<>';                              // law C_CHAT strip
  var KEEP_LINES = 50;                           // the old box (public/js/game.js:270)
  var STICK_PX = 6;                              // the old "at the bottom" slack (game.js:263)
  var PENDING_MAX = 8;                           // own lines waiting for their echo (CHOSEN; styling only)
  var NAME_FALLBACK = 'Player';                  // game.js:315
  var VICTIM_FALLBACK = 'a snake';               // game.js:279
  var SKULL = '💀 ';                   // the old kill line's mark (game.js:277)

  // The old look (public/css/game.css:54-164), placed bottom left above their length box (sl.html lbf, 37 px high at
  // bottom 4): one shaded box, 144 px of lines.
  var CSS = [
    '.slx-chat{position:fixed;left:8px;bottom:48px;width:280px;max-width:44vw;z-index:11;pointer-events:none;' +
      'font-family:system-ui,"Segoe UI",Arial,sans-serif;background:rgba(0,0,0,.42);' +
      'border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:8px 10px;box-sizing:content-box;' +
      'backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);display:none;}',
    '.slx-chat-msgs{display:flex;flex-direction:column;align-items:flex-start;gap:1px;height:144px;overflow-y:auto;' +
      'overflow-x:hidden;margin-bottom:6px;pointer-events:auto;scrollbar-width:thin;' +
      'scrollbar-color:rgba(255,255,255,.25) transparent;}',
    '.slx-chat-msgs::-webkit-scrollbar{width:5px;}',
    '.slx-chat-msgs::-webkit-scrollbar-thumb{background:rgba(255,255,255,.22);border-radius:3px;}',
    '.slx-chat-msgs::-webkit-scrollbar-track{background:transparent;}',
    '.slx-chat-msgs > :first-child{margin-top:auto;}',
    '.slx-chat-msg{font-size:12.5px;line-height:1.35;color:#e8e8e8;max-width:100%;word-break:break-word;' +
      'text-shadow:0 1px 2px rgba(0,0,0,.6);}',
    '.slx-chat-name{color:#14F195;font-weight:700;margin-right:4px;}',
    '.slx-chat-me .slx-chat-name{color:#ffcc00;}',
    '.slx-chat-kill{color:#ff7b7b;font-weight:600;text-shadow:0 1px 2px rgba(0,0,0,.7),0 0 7px rgba(255,50,50,.3);}',
    '.slx-chat-killer{color:#ff2e2e;font-weight:800;}',
    '.slx-chat-victim{color:#ffb0b0;font-weight:700;}',
    '.slx-chat-input{display:none;width:100%;box-sizing:border-box;background:rgba(0,0,0,.5);' +
      'border:1px solid rgba(20,241,149,.55);border-radius:6px;padding:6px 9px;color:#fff;font-size:13px;' +
      'outline:none;pointer-events:auto;}',
    '.slx-chat-input.slx-chat-open{display:block;margin-bottom:5px;}',
    '.slx-chat-hint{font-size:10.5px;color:rgba(255,255,255,.5);text-align:left;}',
    '.slx-chat-hint b{color:rgba(255,255,255,.72);text-transform:uppercase;}',
    '@media (pointer: coarse){' +
      '.slx-chat{left:10px;bottom:calc(46px + env(safe-area-inset-bottom));width:190px;max-width:52vw;padding:0;' +
        'background:none;border:none;backdrop-filter:none;-webkit-backdrop-filter:none;}' +
      '.slx-chat-msgs{height:58px;margin-bottom:0;overflow-y:hidden;pointer-events:none;gap:0;}' +
      '.slx-chat-msg{font-size:10.5px;line-height:1.28;opacity:.72;text-shadow:0 1px 3px rgba(0,0,0,.9);}' +
      '.slx-chat-input,.slx-chat-input.slx-chat-open,.slx-chat-hint{display:none !important;}' +
    '}'
  ].join('\n');

  function el(tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  var style = el('style', null, CSS);
  (doc.head || doc.body).appendChild(style);

  var box = el('div', 'slx-chat');
  var msgs = el('div', 'slx-chat-msgs');
  var input = el('input', 'slx-chat-input');
  input.type = 'text';
  input.maxLength = MAX_LEN;
  input.placeholder = 'Say something… (Enter to send)';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Chat message');
  var hint = el('div', 'slx-chat-hint');
  hint.appendChild(el('span', null, 'press '));
  hint.appendChild(el('b', null, 't'));
  hint.appendChild(el('span', null, ' to type in chat'));
  box.appendChild(msgs);
  box.appendChild(input);
  box.appendChild(hint);
  doc.body.appendChild(box);

  slx.guard(box, {});
  slx.guard(input, { typing: true });

  var typing = false;
  var visible = false;
  var pending = [];                              // cleaned own lines, oldest first

  // The server's cleanChat (server/sl/slRoom.js): strip, trim, cut.
  function clean(text) {
    var s = String(text);
    for (var i = 0; i < STRIP.length; i++) s = s.split(STRIP.charAt(i)).join('');
    s = s.trim();
    return s.length > MAX_LEN ? s.slice(0, MAX_LEN) : s;
  }

  function openChat() {
    typing = true;
    input.className = 'slx-chat-input slx-chat-open';
    hint.style.display = 'none';
    input.value = '';
    root.setTimeout(function () {
      try {
        input.focus();
      } catch (e) { /* the page lost focus */ }
    }, 0);
  }

  function closeChat() {
    if (!typing) return;
    typing = false;
    input.className = 'slx-chat-input';
    hint.style.display = '';
    if (doc.activeElement === input) {
      try {
        input.blur();
      } catch (e) { /* already blurred */ }
    }
  }

  function atBottom() {
    return msgs.scrollTop + msgs.clientHeight >= msgs.scrollHeight - STICK_PX;
  }

  function addLine(line) {
    var stick = atBottom();
    msgs.appendChild(line);
    while (msgs.children && msgs.children.length > KEEP_LINES) msgs.removeChild(msgs.firstChild);
    if (stick) msgs.scrollTop = msgs.scrollHeight;
  }

  function addMessage(name, text, isMe) {
    var line = el('div', 'slx-chat-msg' + (isMe ? ' slx-chat-me' : ''));
    line.appendChild(el('span', 'slx-chat-name', name + ':'));
    line.appendChild(el('span', null, ' ' + text));
    addLine(line);
  }

  // "killer killed victim", or "victim died" with no killer (game.js:272-292).
  function addKill(killer, victim) {
    var line = el('div', 'slx-chat-msg slx-chat-kill');
    line.appendChild(el('span', null, SKULL));
    var v = el('span', 'slx-chat-victim', victim || VICTIM_FALLBACK);
    if (killer) {
      line.appendChild(el('span', 'slx-chat-killer', killer));
      line.appendChild(el('span', null, ' killed '));
      line.appendChild(v);
    } else {
      line.appendChild(v);
      line.appendChild(el('span', null, ' died'));
    }
    addLine(line);
  }

  function send() {
    var raw = String(input.value).trim();
    var c = clean(raw);
    if (raw && c && slx.send('sl:chat', { text: raw })) {
      pending.push(c);
      if (pending.length > PENDING_MAX) pending.shift();
    }
    closeChat();
  }

  function str(v) {
    return typeof v === 'string' ? v : '';
  }

  // The server sends the same line to every seat with no "self" mark: an own line is the next echo of a text this
  // page sent (styling only).
  function ownLine(text) {
    var at = pending.indexOf(text);
    if (at < 0) return false;
    pending.splice(at, 1);
    return true;
  }

  slx.on('x:chat', function (m) {
    var text = str(m.text);
    if (!text) return;
    addMessage(str(m.name) || NAME_FALLBACK, text, ownLine(text));
  });
  slx.on('x:kill', function (m) {
    addKill(str(m.killer), str(m.victim));
  });

  // T opens the input (game.js:294-300): not while typing, nor while any text box has the focus (the direct-visit
  // name box, slxDirect), nor on a phone (no input there).
  root.addEventListener('keydown', function (e) {
    if (typing || !visible || S.is_mobile) return;
    var a = doc.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return;
    if (e.key === 't' || e.key === 'T' || e.keyCode === 84) {
      e.preventDefault();
      openChat();
    }
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.keyCode === 13) {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape' || e.keyCode === 27) {
      closeChat();
    }
  });
  input.addEventListener('blur', closeChat);

  // Shown while their game shows.
  function frame() {
    var on = !!S.playing;
    if (on !== visible) {
      visible = on;
      box.style.display = on ? 'block' : 'none';
      if (!on) closeChat();
    }
    root.requestAnimationFrame(frame);
  }
  root.requestAnimationFrame(frame);

  slx.chat = {
    element: box,
    input: input,
    open: openChat,
    close: closeChat,
    typing: function () { return typing; },
    // For tests and the console: the text of each kept line.
    lines: function () {
      var out = [];
      var list = msgs.children || [];
      for (var i = 0; i < list.length; i++) out.push(list[i].textContent);
      return out;
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
