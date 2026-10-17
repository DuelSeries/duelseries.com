// DuelSeries shared in-game chat: ONE chat box for every game (Owen 2026-10-16: "update the chat, so it's T to type in
// the chat ... get the chat dialed in"). Each game keeps its own socket and only maps its messages in and out (a small
// adapter in the game's own files); this file owns the look, the keys and the phone button.
//
//   DSChat.mount(opts) -> the chat (one per page; a second mount returns the first). opts:
//     send(text)    -> true when the game sent it (the server cleans, filters and rate-limits; nothing here is trusted)
//     canSend()     -> false while T must not open the box (dead, spectating, a menu up). Default: always.
//     phone         true / false; default: a coarse pointer
//     zoom          a page-zoom fix (/sl's 0.7 viewport), as dsEnd's
//     pc            { left, bottom } px where the box sits on a computer (bottom left, above the game's own HUD)
//     phoneAt       { left, top } px where the chat button sits on a phone (top left: thumbs live at the bottom)
//     light         true on a game drawn on a light map (agar.io): the lines get a darker backing
//     guard(el, o)  /sl only: slx.guard, so their own key and touch handlers never see the box
//     z, root, maxLen, victimFallback ('a player')
//   chat.add(m)     one line. m: { name, color, text, me } a message; { kind: 'kill', killer, victim, killerColor,
//                   victimColor }; { kind: 'sys', text } a note only this player sees (a refused message)
//   chat.visible(on)  show or hide the whole box (the game shows it while its game shows)
//   chat.open(), chat.close(), chat.typing(), chat.lines(), chat.el, chat.input
//
// Typing never plays: while the box is open every key stops at the window before any game handler (Space, Q, P, the
// arrows, WASD), Enter sends and Esc closes. A key that was already held when the box opened still gets its key-up,
// so a held boost or a hold-Q cash-out ends the moment the key is let go, as it would without the box.
// Names and text only ever reach the page as text nodes. Colours are parsed into numbers before use.
(function (root) {
  'use strict';
  var doc = root.document;
  if (!doc || root.DSChat) return;

  var MAX_LEN = 120;                 // the servers' cap (server/chatGuard.js MAX_LEN)
  var KEEP = 60;                     // lines kept for scrolling back while the box is open
  var SHOW_PC = 7;                   // lines on screen while closed, computer
  var SHOW_PHONE = 4;                // and phone
  var LIFE_MS = 9000;                // a message stays this long, then fades
  var LIFE_SHORT_MS = 6000;          // kill lines and notes
  var COUNT_AT = 20;                 // "N left" shows from here down
  var HIDE_KEY = 'dsChatHidden';     // the "hide chat" choice, per browser

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var SKULL = String.fromCharCode(0xD83D, 0xDC80);   // the kill line's mark

  var CSS = [
    '.dsc{position:fixed;left:var(--dsc-l,10px);bottom:var(--dsc-b,12px);z-index:var(--dsc-z,30);width:340px;' +
      'max-width:46vw;display:flex;flex-direction:column;align-items:flex-start;gap:6px;pointer-events:none;' +
      'font:500 14px/1.36 "Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif;color:#f3f5f8;' +
      '-webkit-font-smoothing:antialiased;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}',
    '.dsc[hidden]{display:none}',
    '.dsc *{box-sizing:border-box}',
    '.dsc-phone{bottom:auto;top:calc(var(--dsc-t,10px) + env(safe-area-inset-top,0px));width:236px;max-width:60vw;' +
      'font-size:12.5px;gap:5px}',
    '.dsc-feed{order:1;display:flex;flex-direction:column;align-items:flex-start;gap:3px;width:100%;max-height:none;' +
      'overflow:hidden}',
    '.dsc-phone .dsc-feed{order:2}',
    '.dsc-open .dsc-feed{max-height:15.6em;overflow-y:auto;pointer-events:auto;overscroll-behavior:contain;' +
      'scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.25) transparent}',
    '.dsc-phone.dsc-open .dsc-feed{max-height:9.4em}',
    '.dsc-feed::-webkit-scrollbar{width:5px}',
    '.dsc-feed::-webkit-scrollbar-thumb{background:rgba(255,255,255,.22);border-radius:3px}',
    '.dsc-line{max-width:100%;overflow-wrap:anywhere;word-break:break-word;transition:opacity .7s ease}',
    '.dsc-line.dsc-old{opacity:0}',
    '.dsc-line.dsc-gone{display:none}',
    '.dsc-open .dsc-line.dsc-old{opacity:1;transition:none}',
    '.dsc-open .dsc-line.dsc-gone{display:block}',
    '.dsc-name{font-weight:700;color:var(--dsc-c,#cdd5df);margin-right:.38em}',
    '.dsc-kill{font-weight:600;color:#ffd0d0}',
    '.dsc-kill .dsc-name{margin:0}',
    '.dsc-kill .dsc-skull{margin-right:.35em}',
    '.dsc-sys{color:#c9d3de;font-style:italic;font-weight:500}',
    '.dsc-sys svg{width:.95em;height:.95em;vertical-align:-.12em;margin-right:.35em;fill:none;stroke:#f0b43c;stroke-width:2}',
    '.dsc-row{order:2;display:none;align-items:center;gap:6px;width:100%;pointer-events:auto}',
    '.dsc-phone .dsc-row{order:1;display:flex}',
    '.dsc-open .dsc-row{display:flex}',
    '.dsc-form{position:relative;flex:1;min-width:0;display:none;margin:0}',
    '.dsc-open .dsc-form{display:block}',
    '.dsc-in{display:block;width:100%;font:inherit;font-weight:500;color:#fff;caret-color:#f0b43c;border:0;outline:0;' +
      'margin:0;padding:7px 46px 7px 11px;-webkit-user-select:text;user-select:text;-webkit-appearance:none;appearance:none}',
    '.dsc-phone .dsc-in{font-size:16px;padding:7px 40px 7px 10px}',   // 16px: iOS zooms the page into a smaller box
    '.dsc-in::placeholder{color:rgba(255,255,255,.5)}',
    '.dsc-count{position:absolute;right:30px;top:50%;transform:translateY(-50%);font-size:11px;font-weight:600;' +
      'color:rgba(255,255,255,.55);font-variant-numeric:tabular-nums;pointer-events:none}',
    '.dsc-count.dsc-low{color:#f0b43c}',
    '.dsc-mute{position:absolute;right:4px;top:50%;transform:translateY(-50%);width:24px;height:24px;border:0;padding:3px;' +
      'margin:0;background:none;border-radius:6px;cursor:pointer;color:rgba(255,255,255,.6)}',
    '.dsc-mute:hover,.dsc-mute:focus-visible{color:#fff;background:rgba(255,255,255,.1);outline:0}',
    '.dsc-mute svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;' +
      'stroke-linejoin:round;display:block}',
    '.dsc-btn{display:none;flex:none;width:38px;height:38px;border:0;padding:0;margin:0;cursor:pointer;color:#fff;' +
      'pointer-events:auto;position:relative;touch-action:manipulation}',
    '.dsc-phone .dsc-btn{display:grid;place-items:center}',
    '.dsc-phone.dsc-nosend .dsc-btn{display:none}',
    '.dsc-btn svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:2;stroke-linejoin:round}',
    '.dsc-btn i{position:absolute;right:5px;top:5px;width:8px;height:8px;border-radius:50%;background:#f0b43c;' +
      'box-shadow:0 0 0 2px rgba(10,12,16,.9);display:none}',
    '.dsc-unread .dsc-btn i{display:block}',
    '.dsc-hint{order:3;display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:rgba(255,255,255,.72);' +
      'text-shadow:0 1px 2px rgba(0,0,0,.75)}',
    '.dsc-phone .dsc-hint,.dsc-open .dsc-hint{display:none}',
    '.dsc-hint kbd{font:700 11px/1 "Segoe UI",system-ui,sans-serif;color:#fff;min-width:18px;height:18px;display:inline-grid;' +
      'place-items:center;padding:0 4px;border-radius:5px;background:rgba(12,14,19,.72);' +
      'box-shadow:inset 0 0 0 1px rgba(255,255,255,.28),0 1px 0 rgba(0,0,0,.5)}',
    '.dsc-light .dsc-hint{color:rgba(20,24,32,.78);text-shadow:0 1px 0 rgba(255,255,255,.6)}',

    // Owen's pick (2026-10-16, look B "Pills" of three): each message a small dark pill led by a dot in the player's colour.
    '.dsc .dsc-line{display:block;background:rgba(14,16,22,.76);padding:4px 11px 5px 10px;border-radius:14px;' +
      'box-shadow:inset 0 0 0 1px rgba(255,255,255,.07),0 2px 8px rgba(0,0,0,.22)}',
    '.dsc .dsc-new{animation:dsc-in .18s ease-out}',
    '.dsc-light .dsc-line{background:rgba(14,16,22,.82)}',
    '.dsc .dsc-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;' +
      'vertical-align:.06em;background:var(--dsc-c,#cdd5df);box-shadow:0 0 0 2px rgba(0,0,0,.3)}',
    '.dsc .dsc-in{background:rgba(14,16,22,.88);border-radius:16px;box-shadow:inset 0 0 0 1.5px rgba(240,180,60,.8)}',
    '.dsc .dsc-btn{background:rgba(14,16,22,.7);border-radius:50%;box-shadow:inset 0 0 0 1px rgba(255,255,255,.12)}',

    '@keyframes dsc-in{from{opacity:0;transform:translateX(-8px)}to{opacity:1;transform:none}}',
    '@media (prefers-reduced-motion: reduce){.dsc .dsc-line{transition:none}.dsc .dsc-new{animation:none}}'
  ].join('\n');

  function el(tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function svg(paths, vb) {
    var s = doc.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', vb || '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < paths.length; i++) {
      var p = doc.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', paths[i]);
      s.appendChild(p);
    }
    return s;
  }
  var ICON_BUBBLE = ['M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V17.5H4A1.5 1.5 0 0 1 2.5 16V7A1.5 1.5 0 0 1 4 5.5z'];
  var ICON_SHIELD = ['M12 3l7 3v5.5c0 4.2-2.9 7.8-7 9-4.1-1.2-7-4.8-7-9V6z'];
  var ICON_EYE = ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', 'M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z'];
  var ICON_EYE_OFF = ['M3 3l18 18', 'M10.6 5.6c.5-.1.9-.1 1.4-.1 6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.7',
    'M6.4 6.9C3.9 8.6 2.5 12 2.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.2-1.1'];

  // ---------------------------------------------------------------- colours

  // A player's colour as an [r, g, b] of integers, or null. Accepts #rgb, #rrggbb, rgb(r, g, b) and [r, g, b].
  function parseColour(c) {
    var r, g, b, m;
    if (Array.isArray(c) && c.length >= 3) {
      r = +c[0]; g = +c[1]; b = +c[2];
    } else if (typeof c === 'string') {
      var s = c.trim();
      if ((m = /^#([0-9a-f]{3})$/i.exec(s))) {
        r = parseInt(m[1][0] + m[1][0], 16); g = parseInt(m[1][1] + m[1][1], 16); b = parseInt(m[1][2] + m[1][2], 16);
      } else if ((m = /^#([0-9a-f]{6})$/i.exec(s))) {
        r = parseInt(m[1].slice(0, 2), 16); g = parseInt(m[1].slice(2, 4), 16); b = parseInt(m[1].slice(4, 6), 16);
      } else if ((m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i.exec(s))) {
        r = +m[1]; g = +m[2]; b = +m[3];
      } else return null;
    } else return null;
    if (![r, g, b].every(function (v) { return isFinite(v) && v >= 0 && v <= 255; })) return null;
    return [Math.round(r), Math.round(g), Math.round(b)];
  }

  // The colour a name is printed in: the player's own hue, lifted until it reads on the dark pill
  // (a navy snake's name would vanish otherwise). Returns 'rgb(r,g,b)' or '' (the default name colour).
  function nameColour(c) {
    var rgb = parseColour(c);
    if (!rgb) return '';
    var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    // perceived brightness: lift dark colours, and the blues a little more (they read darker at the same lightness)
    var lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    var minL = 0.66 + (b > r && b > g ? 0.06 : 0);
    if (lum < 0.5 && l < minL) l = minL;
    if (s > 0.9) s = 0.9;
    function hue(p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    var R, G, B;
    if (s === 0) R = G = B = l;
    else {
      var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      var p = 2 * l - q;
      R = hue(p, q, h + 1 / 3); G = hue(p, q, h); B = hue(p, q, h - 1 / 3);
    }
    return 'rgb(' + Math.round(R * 255) + ',' + Math.round(G * 255) + ',' + Math.round(B * 255) + ')';
  }

  // ---------------------------------------------------------------- the chat

  var styleOn = false;
  var chat = null;
  var keys = null;                     // the mounted chat's key handlers

  // Installed when this file loads, before any game's own key handlers (pages load it ahead of the game), so a key
  // typed into the box is stopped at the window before anything else hears it.
  root.addEventListener('keydown', function (e) { if (keys) keys.down(e); }, true);
  root.addEventListener('keyup', function (e) { if (keys) keys.up(e); }, true);
  root.addEventListener('keypress', function (e) { if (keys) keys.press(e); }, true);
  root.addEventListener('blur', function () { if (keys) keys.blur(); });

  function str(v, max) {
    var s = typeof v === 'string' ? v : '';
    return s.length > max ? s.slice(0, max) : s;
  }

  function hiddenPref() {
    try {
      return root.localStorage && root.localStorage.getItem(HIDE_KEY) === '1';
    } catch (e) { return false; }
  }
  function saveHidden(on) {
    try {
      if (root.localStorage) root.localStorage.setItem(HIDE_KEY, on ? '1' : '0');
    } catch (e) { /* private window: the choice lasts this page */ }
  }

  // Another text box on the page has the caret (a name box, a search): T is a letter there, not the chat.
  function otherField(t, mine) {
    if (!t || t === mine || !t.tagName) return false;
    var tag = t.tagName;
    var field = tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable ||
      (tag === 'INPUT' && !/^(button|checkbox|radio|range|submit|reset|color|file|image)$/i.test(t.type || ''));
    if (!field) return false;
    // slither keeps its own hidden nickname box focused all game: a box nobody can see does not count
    return t.offsetWidth > 0 && t.offsetHeight > 0 && t.getClientRects().length > 0;
  }

  function mount(opts) {
    if (chat) return chat;
    var o = opts || {};
    var send = typeof o.send === 'function' ? o.send : function () { return false; };
    var canSend = typeof o.canSend === 'function' ? o.canSend : function () { return true; };
    var phone = typeof o.phone === 'boolean' ? o.phone
      : !!(root.matchMedia && root.matchMedia('(pointer: coarse)').matches);
    var maxLen = Number.isInteger(o.maxLen) && o.maxLen > 0 ? Math.min(o.maxLen, MAX_LEN) : MAX_LEN;

    if (!styleOn) {
      var st = el('style', null, CSS);
      st.setAttribute('data-ds', 'chat');
      (doc.head || doc.body).appendChild(st);
      styleOn = true;
    }

    var box = el('div', 'dsc' + (phone ? ' dsc-phone' : '') + (o.light ? ' dsc-light' : ''));
    box.hidden = true;
    if (o.z != null) box.style.setProperty('--dsc-z', String(o.z | 0));
    var pc = o.pc || {};
    var ph = o.phoneAt || {};
    var left = phone ? ph.left : pc.left;
    if (typeof left === 'number' && isFinite(left)) box.style.setProperty('--dsc-l', left + 'px');
    if (typeof pc.bottom === 'number' && isFinite(pc.bottom)) box.style.setProperty('--dsc-b', pc.bottom + 'px');
    if (typeof ph.top === 'number' && isFinite(ph.top)) box.style.setProperty('--dsc-t', ph.top + 'px');
    if (o.zoom && o.zoom !== 1) box.style.zoom = String(o.zoom);

    var feed = el('div', 'dsc-feed');
    feed.setAttribute('role', 'log');
    feed.setAttribute('aria-live', 'polite');
    feed.setAttribute('aria-label', 'Chat');

    var row = el('div', 'dsc-row');
    var btn = el('button', 'dsc-btn');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Chat');
    btn.appendChild(svg(ICON_BUBBLE));
    btn.appendChild(el('i'));
    var form = el('form', 'dsc-form');
    form.setAttribute('autocomplete', 'off');
    form.noValidate = true;
    var input = el('input', 'dsc-in');
    input.type = 'text';
    input.maxLength = maxLen;
    input.placeholder = phone ? 'Message' : 'Say something, Enter to send';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'sentences');
    input.setAttribute('enterkeyhint', 'send');
    input.setAttribute('aria-label', 'Chat message');
    var count = el('span', 'dsc-count');
    var mute = el('button', 'dsc-mute');
    mute.type = 'button';
    form.appendChild(input);
    form.appendChild(count);
    form.appendChild(mute);
    row.appendChild(btn);
    row.appendChild(form);

    var hint = el('div', 'dsc-hint');
    hint.appendChild(el('kbd', null, 'T'));
    var hintText = el('span', null, 'Chat');
    hint.appendChild(hintText);

    box.appendChild(feed);
    box.appendChild(row);
    box.appendChild(hint);
    (o.root || doc.body).appendChild(box);

    var typing = false;
    var shown = false;
    var hidden = hiddenPref();
    var draft = '';
    var held = Object.create(null);    // keys down when the box opened: their key-ups still reach the game
    var lines = [];                     // { el, born, life, label }

    function setMuteIcon() {
      while (mute.firstChild) mute.removeChild(mute.firstChild);
      mute.appendChild(svg(hidden ? ICON_EYE_OFF : ICON_EYE));
      var label = hidden ? 'Show chat' : 'Hide chat';
      mute.setAttribute('aria-label', label);
      mute.title = label;
      hintText.textContent = hidden ? 'Chat (hidden)' : 'Chat';
    }
    setMuteIcon();

    function showFrom() {
      return Math.max(0, lines.length - (phone ? SHOW_PHONE : SHOW_PC));
    }

    // Which lines show while closed: the newest few, until they fade.
    function restyle(now) {
      var from = showFrom();
      var live = 0;
      for (var i = 0; i < lines.length; i++) {
        var L = lines[i];
        var gone = i < from;
        var old = gone || now - L.born > L.life;
        L.el.classList.toggle('dsc-gone', gone);
        L.el.classList.toggle('dsc-old', old);
        if (!old) live++;
      }
      if (live === 0) box.classList.remove('dsc-unread');
    }

    var timer = 0;
    function tick() {
      timer = 0;
      var now = Date.now();
      restyle(now);
      var next = Infinity;
      for (var i = showFrom(); i < lines.length; i++) {
        var due = lines[i].born + lines[i].life - now;
        if (due > 0 && due < next) next = due;
      }
      if (next < Infinity) timer = root.setTimeout(tick, next + 30);
    }
    function schedule() {
      if (timer) root.clearTimeout(timer);
      timer = 0;
      tick();
    }

    function atBottom() {
      return feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 6;
    }

    function push(line, life, quiet, label) {
      var stick = !typing || atBottom();
      line.classList.add('dsc-new');
      feed.appendChild(line);
      lines.push({ el: line, born: Date.now(), life: life, label: label });
      while (lines.length > KEEP) feed.removeChild(lines.shift().el);
      root.setTimeout(function () { line.classList.remove('dsc-new'); }, 260);
      schedule();
      sendable();
      if (stick) feed.scrollTop = feed.scrollHeight;
      if (phone && !typing && !quiet) box.classList.add('dsc-unread');
    }

    function nameSpan(name, colour, fallback) {
      var span = el('b', 'dsc-name', str(name, 40) || fallback);
      var c = nameColour(colour);
      if (c) span.style.setProperty('--dsc-c', c);
      return span;
    }

    function add(m) {
      if (!m || typeof m !== 'object') return;
      var kind = m.kind === 'kill' || m.kind === 'sys' ? m.kind : 'msg';
      var line;
      if (kind === 'sys') {
        var t = str(m.text, 200);
        if (!t) return;
        line = el('div', 'dsc-line dsc-sys');
        line.appendChild(svg(ICON_SHIELD));
        line.appendChild(el('span', null, t));
        push(line, LIFE_SHORT_MS, true, t);
        return;
      }
      if (hidden && !m.me) return;
      if (kind === 'kill') {
        line = el('div', 'dsc-line dsc-kill');
        line.appendChild(el('span', 'dsc-skull', SKULL));
        var victim = nameSpan(m.victim, m.victimColor, o.victimFallback || 'a player');
        var said;
        if (m.killer) {
          var killer = nameSpan(m.killer, m.killerColor, 'Player');
          line.appendChild(killer);
          line.appendChild(el('span', null, ' killed '));
          line.appendChild(victim);
          said = killer.textContent + ' killed ' + victim.textContent;
        } else {
          line.appendChild(victim);
          line.appendChild(el('span', null, ' died'));
          said = victim.textContent + ' died';
        }
        var kc = nameColour(m.killer ? m.killerColor : m.victimColor);
        if (kc) line.style.setProperty('--dsc-c', kc);
        push(line, LIFE_SHORT_MS, true, SKULL + ' ' + said);
        return;
      }
      var text = str(m.text, 300);
      if (!text) return;
      line = el('div', 'dsc-line' + (m.me ? ' dsc-me' : ''));
      var c = nameColour(m.color);
      if (c) line.style.setProperty('--dsc-c', c);
      line.appendChild(el('i', 'dsc-dot'));
      var who = nameSpan(m.name, m.color, 'Player');
      line.appendChild(who);
      line.appendChild(el('span', 'dsc-text', text));
      push(line, LIFE_MS, !!m.me, who.textContent + ': ' + text);
    }

    function updateCount() {
      var left = maxLen - input.value.length;
      count.textContent = left <= COUNT_AT ? String(left) : '';
      count.classList.toggle('dsc-low', left <= 5);
    }

    function open() {
      if (typing || !shown || !canSend()) return false;
      typing = true;
      box.classList.add('dsc-open');
      box.classList.remove('dsc-unread');
      input.value = draft;
      updateCount();
      restyle(Date.now());
      feed.scrollTop = feed.scrollHeight;
      try {
        input.focus({ preventScroll: true });   // in the same tap on a phone, or its keyboard never comes up
      } catch (e) { /* the page has no focus */ }
      if (typeof o.onOpen === 'function') o.onOpen();
      return true;
    }

    function close(keepDraft) {
      if (!typing) return;
      typing = false;
      draft = keepDraft ? input.value : '';
      box.classList.remove('dsc-open');
      if (doc.activeElement === input) {
        try {
          input.blur();
        } catch (e) { /* already blurred */ }
      }
      schedule();
      if (typeof o.onClose === 'function') o.onClose();
    }

    function submit() {
      var t = String(input.value).replace(/\s+/g, ' ').trim();
      if (t) {
        if (t.length > maxLen) t = t.slice(0, maxLen);
        send(t);
      }
      input.value = '';
      draft = '';
      close(false);
    }

    function isT(e) {
      return e.key === 't' || e.key === 'T' || e.keyCode === 84;
    }

    // Window, capture phase: runs before any game's key handler on the window, the document or the canvas.
    function onKeyDown(e) {
      var k = e.code || e.key || e.keyCode;
      if (!typing) {
        held[k] = true;
        if (!shown || e.repeat || e.ctrlKey || e.metaKey || e.altKey || !isT(e)) return;
        if (otherField(e.target, input) || otherField(doc.activeElement, input)) return;
        if (!canSend()) return;
        delete held[k];                 // its own key-up is the box's
        e.preventDefault();             // the T is not typed into the box
        e.stopImmediatePropagation();
        open();
        return;
      }
      e.stopImmediatePropagation();     // nothing reaches the game while typing
      if (e.key === 'Enter' || e.keyCode === 13) {
        if (e.isComposing) return;
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape' || e.keyCode === 27) {
        e.preventDefault();
        close(false);
      } else if (doc.activeElement !== input && !e.ctrlKey && !e.metaKey) {
        try {
          input.focus({ preventScroll: true });
        } catch (err) { /* nothing to do */ }
      }
    }
    function onKeyUp(e) {
      var k = e.code || e.key || e.keyCode;
      var was = held[k];
      delete held[k];
      if (typing && !was) e.stopImmediatePropagation();
    }
    function onKeyPress(e) {
      if (typing) e.stopImmediatePropagation();
    }
    keys = { down: onKeyDown, up: onKeyUp, press: onKeyPress, blur: function () { held = Object.create(null); } };

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      submit();
    });
    input.addEventListener('input', updateCount);
    input.addEventListener('blur', function () {
      // a tap on the hide button keeps the box open
      root.setTimeout(function () {
        if (typing && doc.activeElement !== input && doc.activeElement !== mute) close(true);
      }, 0);
    });

    function toggleHidden() {
      hidden = !hidden;
      saveHidden(hidden);
      setMuteIcon();
      add({ kind: 'sys', text: hidden ? 'Chat hidden. Only your own messages show.' : 'Chat is showing again.' });
      try {
        input.focus({ preventScroll: true });
      } catch (e) { /* nothing to do */ }
    }

    // Presses on the box never reach the game (a click would boost, a tap would steer). Releases do: a boost let go
    // over the box must still end.
    var STOP = ['pointerdown', 'mousedown', 'click', 'dblclick', 'contextmenu', 'touchstart', 'touchmove', 'touchend',
      'touchcancel', 'wheel'];
    function stopper(e) {
      e.stopPropagation();
    }
    function guardEl(node) {
      for (var i = 0; i < STOP.length; i++) node.addEventListener(STOP[i], stopper, { passive: true });
    }
    // The box and its lines stop presses only (a page guard would stop key-ups too, and a key held before the box
    // opened must still be let go in the game); the buttons take a page's own guard where it has one (/sl: slx.guard
    // turns a tap into a press there).
    guardEl(row);
    guardEl(feed);
    if (typeof o.guard === 'function') {
      o.guard(btn, { activate: function () { if (typing) close(true); else open(); } });
      o.guard(mute, { activate: toggleHidden });
    } else {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        if (typing) close(true);
        else open();
      });
      mute.addEventListener('click', function (e) {
        e.preventDefault();
        toggleHidden();
      });
    }
    // the hide button must not take the caret away on a computer
    mute.addEventListener('mousedown', function (e) { e.preventDefault(); });

    // A phone's button shows only to someone who can talk (a watcher reads the lines but has no button).
    function sendable() {
      box.classList.toggle('dsc-nosend', !canSend());
    }

    function visible(on) {
      on = !!on;
      if (on) sendable();
      if (on === shown) return;
      shown = on;
      box.hidden = !on;
      if (!on) close(true);
    }

    chat = {
      el: box,
      input: input,
      add: add,
      visible: visible,
      open: open,
      close: function () { close(false); },
      typing: function () { return typing; },
      // For tests and the console: each kept line in words ("Ann: hi", a skull and "Bob killed Ann", a note).
      lines: function () {
        return lines.map(function (L) { return L.label; });
      }
    };
    return chat;
  }

  root.DSChat = {
    mount: mount,
    get: function () { return chat; },
    nameColour: nameColour,
    MAX_LEN: MAX_LEN
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.DSChat;
})(typeof window !== 'undefined' ? window : globalThis);
