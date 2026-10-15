// DuelSeries layer on the frozen slither.io client: the results card (Owen Q11; SERVER-DESIGN 15.3 "Results card";
// task T17). Ours, not a parity area.
//
// Inert unless slxNet installed the production transport (15.2, finalize pass C20): no node, no listener, no style.
//
// When: their menu shows the first frame 1600 ms after dead_mtm (public/js/sl/slHud.js:210-216), relayed by slxMain as
// 'menuShow'. The card then follows their login layer: opacity 1 - login_fr on every 'menuFade' (their death fade
// in, slHud.js:217-233; their 500 ms start fade out, slHud.js:170-193), and it is taken away when the start fade ends
// (fr 1). So it appears with their menu and leaves when the next life starts.
//
// What it says:
//   a death              'Match Results' (agar's panel title, public/js/ag/agScreens.js:15-17)
//   a cash-out           'Cashed Out' (agar's free cash-out title, same place); sl:x {t: 'cashed'} came before `dead`
//   a close mid-life     'Connection lost', or 'Too slow' when the server itself disconnected the socket with no
//                        refusal (its stall and cap kicks, server/sl/slSendQueue.js kick)
//   then "Your final length was N" (Owen's words), N read from THEIR last-score line, which their gameOver writes on
//   the death and the close path alike (slHud.js:305-310, slApply.js:1252-1262, 1300-1320).
// Refusals never reach their menu (a refused socket closes before any life, so dead_mtm is never set,
// slApply.js:1252-1262): the card shows at once from the close, titled by the refusal's why
// (server/sl/slSockets.js REFUSALS).
//
// Buttons: Play again calls their Play (DuelSlither.play) under the name the first Play used (the lobby name, or the
// direct-visit box); their loop connects only once their fade ended (slLoop.js:612), so the button says "Starting"
// until the card goes. Lobby posts game:done to the lobby frame (slx.toLobby); a direct visit opens the lobby page.
// A click or tap on the card never reaches their boost or steering (slx.guard).
//
// The paid layer's hooks (PAID-SL-DESIGN 9; slxPaid.js, loaded before this file, sets them on a paid page and on a page
// that only shows a paid notice; a free page sets none, and the card is exactly as above). Each is read at the moment
// it is needed, and a throw in one is counted (slx.errors) and ignored:
//   slx.cardLines(kind) -> null, or { title, lines, again }: a title in place of the card's own, lines under it (each a
//     string, or { text, cls } with one more slx- class; text only, never markup), and Play again: false leaves it off
//     the card, a string is its label, { text, disabled } its label and state. Read when the card shows and on
//     refresh() (the cash-out status coming in).
//   slx.beforeAgain(go) -> true when the layer takes Play again over (a paid page buys a new entry first, then calls
//     go(), which starts the play as the button does and answers whether it did).
//   slx.beforeLobby() -> true when the layer keeps the page here (its exit trap: money is still in the room).
// slx.card.notice(kind) shows the card with no life behind it (the paid notices at boot), titled by cardLines(kind).
(function (root) {
  'use strict';
  var D = root.DuelSlither;
  if (!D || !D.slx || !D.slx.active) return;
  var slx = D.slx;
  var doc = root.document;
  var S = D.S;
  if (!doc || !S || typeof slx.on !== 'function' || typeof slx.guard !== 'function') return;

  // Titles (CHOSEN copy; Owen gave the length line and the two buttons).
  var TITLE = {
    dead: 'Match Results',
    cashed: 'Cashed Out',
    lost: 'Connection lost',
    slow: 'Too slow',
    full: 'Room full',
    maintenance: 'Maintenance',
    closed: 'Closed',
    'not-open': 'Closed',
    limit: 'Too many players on this network',
    flood: 'Connection lost'
  };
  var LENGTH_WORDS = 'Your final length was ';
  var BTN = { again: 'Play again', retry: 'Try again', starting: 'Starting', lobby: 'Lobby' };
  // socket.io's reason when the server called socket.disconnect() (socket.io-client: 'io server disconnect').
  var SERVER_DROP = 'io server disconnect';

  // Their card look: agar's Match Results panel (public/js/ag/agScreens.js:299-341): a white 10 px card, Arial, the
  // primary blue and the plain white button, 150 x 34 each. Placed over their last-score line (sl.html login layer:
  // 64 + 50 + 115 + 44 px down), above their login layer (z-index 20).
  var CSS = [
    '.slx-card{position:fixed;left:50%;top:230px;transform:translateX(-50%);z-index:30;display:none;' +
      'font-family:Arial,"Helvetica Neue",Helvetica,sans-serif;color:#343434;}',
    '.slx-card-box{width:306px;padding:10px 10px 15px;background:#fff;border-radius:10px;text-align:center;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.35);}',
    '.slx-card-title{margin:10px 0 8px;font-size:24px;line-height:28px;font-weight:bold;color:#343434;}',
    '.slx-card-line{margin:0 0 16px;font-size:15px;line-height:20px;color:#444;}',
    '.slx-card-line b{color:#000;}',
    // the paid layer's lines (cardLines above): a step smaller than the length line, between it and the buttons
    '.slx-card-notes{margin:-4px 0 14px;}',
    '.slx-card-note{margin:0 0 6px;font-size:14px;line-height:19px;color:#444;}',
    '.slx-card-btns{display:flex;justify-content:space-between;}',
    '.slx-card-btn{box-sizing:border-box;width:150px;height:34px;margin:0;padding:0;border:1px solid transparent;' +
      'border-radius:4px;font:bold 15px Arial,"Helvetica Neue",Helvetica,sans-serif;cursor:pointer;' +
      'touch-action:manipulation;-webkit-user-select:none;user-select:none;}',
    '.slx-card-again{color:#fff;background:#428bca;border-color:#357ebd;}',
    '.slx-card-again:hover{background:#3071a9;border-color:#285e8e;}',
    '.slx-card-lobby{color:#333;background:#fff;border-color:#ccc;}',
    '.slx-card-lobby:hover{background:#e6e6e6;border-color:#adadad;}',
    '.slx-card-btn:focus-visible{outline:2px solid #100e0b;outline-offset:2px;}',
    '.slx-card-btn:disabled{opacity:.65;cursor:default;}'
  ].join('\n');

  function el(tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  var style = el('style', null, CSS);
  (doc.head || doc.body).appendChild(style);

  var card = el('div', 'slx-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-live', 'polite');
  var box = el('div', 'slx-card-box');
  var title = el('h2', 'slx-card-title', '');
  var line = el('p', 'slx-card-line', '');
  var words = el('span', null, LENGTH_WORDS);
  var num = el('b', null, '');
  line.appendChild(words);
  line.appendChild(num);
  var btns = el('div', 'slx-card-btns');
  var again = el('button', 'slx-card-btn slx-card-again', BTN.again);
  again.type = 'button';
  var lobby = el('button', 'slx-card-btn slx-card-lobby', BTN.lobby);
  lobby.type = 'button';
  btns.appendChild(again);
  btns.appendChild(lobby);
  box.appendChild(title);
  box.appendChild(line);
  box.appendChild(btns);
  card.appendChild(box);
  var notes = null;                              // the hook's lines, made the first time it gives any
  var extra = null;                              // the hook's answer for the card on screen
  var againHidden = false;
  card.style.display = 'none';
  doc.body.appendChild(card);

  // ---- per socket: what the tap saw (slxNet fires 'open' for each socket that opened)
  var life = newLife();
  var lastReason = '';
  var connectWhy = '';                           // the why of a refused handshake (slSockets admit: {why: 'limit'})
  var shown = '';                                // '' or the kind on the card
  var lifeCard = false;                          // the card ends a life (Play again), else a refusal (Try again)
  var starting = false;

  function newLife() {
    return { cashed: false, dead: false, pending: '', noLength: false };
  }

  // The number in their last-score line: '<span ...>WORDS </span><b>N</b>' (slHud.js:305-310). null when absent.
  function lastscoreNumber() {
    var ls = S.lastscore;
    if (!ls) return null;
    var m = /<b>\s*([0-9]+)\s*<\/b>/i.exec(String(ls.innerHTML));
    return m ? Number(m[1]) : null;
  }

  // The name the last Play used: their Play keeps it (slMain.nick, public/js/sl/slMain.js:94-101), whether the lobby
  // hand-off (slxMain) or the direct-visit box (slxDirect) gave it.
  function nick() {
    var m = D.slMain;
    return m && typeof m.nick === 'string' ? m.nick : '';
  }

  function setStarting(on) {
    starting = on;
    againLook();
  }

  // Play again in the card's own words, or as the paid layer's answer says (left off, a label, a state).
  function againLook() {
    var a = extra ? extra.again : undefined;
    var hide = a === false && !starting;
    if (hide !== againHidden) {
      againHidden = hide;
      again.style.display = hide ? 'none' : '';
      btns.style.justifyContent = hide ? 'center' : '';
    }
    if (starting) {
      again.disabled = true;
      again.textContent = BTN.starting;
      return;
    }
    var o = a && typeof a === 'object' ? a : null;
    var label = typeof a === 'string' ? a : o && typeof o.text === 'string' ? o.text : '';
    again.disabled = !!(o && o.disabled === true);
    again.textContent = label || (lifeCard ? BTN.again : BTN.retry);
  }

  function hookLines(kind) {
    if (typeof slx.cardLines !== 'function') return null;
    try {
      var x = slx.cardLines(kind);
      return x && typeof x === 'object' ? x : null;
    } catch (e) {
      slx.errors++;
      return null;
    }
  }

  // The title, the hook's lines and Play again for the card on screen.
  function render() {
    var t = extra && typeof extra.title === 'string' ? extra.title : '';
    title.textContent = t || TITLE[shown] || TITLE.lost;
    var list = extra && Array.isArray(extra.lines) ? extra.lines : [];
    if (list.length && !notes) {
      notes = el('div', 'slx-card-notes');
      box.appendChild(notes);
      box.appendChild(btns);                     // the buttons stay last
    }
    if (notes) {
      notes.textContent = '';
      var n = 0;
      for (var i = 0; i < list.length; i++) {
        var item = list[i];
        var text = typeof item === 'string' ? item : item && typeof item.text === 'string' ? item.text : '';
        if (!text) continue;
        var cls = item && typeof item.cls === 'string' && /^slx-[a-z][\w-]*$/.test(item.cls) ? ' ' + item.cls : '';
        notes.appendChild(el('p', 'slx-card-note' + cls, text));
        n++;
      }
      notes.style.display = n ? '' : 'none';
    }
    againLook();
  }

  // The hook's lines on the card now, as text (tests and the console).
  function noteTexts() {
    var out = [];
    if (!notes || notes.style.display === 'none') return out;
    var list = notes.children || [];
    for (var i = 0; i < list.length; i++) out.push(list[i].textContent);
    return out;
  }

  // kind: a TITLE key. n: the length, or null for a card with no length line. ended: a life ended (else a refusal).
  function show(kind, n, opacity, ended) {
    shown = kind;
    lifeCard = !!ended;
    starting = false;
    extra = hookLines(kind);
    render();
    if (n === null || n === undefined) {
      line.style.display = 'none';
      num.textContent = '';
    } else {
      line.style.display = '';
      num.textContent = String(n);
    }
    card.style.opacity = String(opacity);
    card.style.display = 'block';
  }

  function hide() {
    shown = '';
    setStarting(false);
    card.style.display = 'none';
  }

  // The hook's answer again, for the card on screen (slxPaid: the cash-out status, a buy-in's progress).
  function refresh() {
    if (!shown) return;
    extra = hookLines(shown);
    render();
  }

  function start() {
    if (!shown || starting) return false;
    setStarting(true);
    D.play(nick());
    return true;
  }

  function playAgain() {
    if (!shown || starting) return;
    if (typeof slx.beforeAgain === 'function') {
      var took = false;
      try {
        took = slx.beforeAgain(start) === true;
      } catch (e) {
        slx.errors++;
        return;
      }
      if (took) return;
    }
    start();
  }

  function toLobby() {
    if (typeof slx.beforeLobby === 'function') {
      var kept = false;
      try {
        kept = slx.beforeLobby() === true;
      } catch (e) {
        slx.errors++;
      }
      if (kept) return;
    }
    if (typeof slx.toLobby === 'function' && slx.toLobby()) return;
    try {
      root.location.assign('/');
    } catch (e) { /* no location: nothing to do */ }
  }

  slx.guard(card, {});
  slx.guard(again, { activate: playAgain });
  slx.guard(lobby, { activate: toLobby });

  // ---- what the tap reports
  if (typeof slx.onSocket === 'function') {
    slx.onSocket('disconnect', function (reason) { lastReason = String(reason || ''); });
    slx.onSocket('connect_error', function (err) {
      lastReason = 'connect_error';
      var d = err && err.data;
      connectWhy = d && typeof d.why === 'string' ? d.why : '';
    });
  }
  slx.on('open', function () {
    life = newLife();
    lastReason = '';
    connectWhy = '';
  });
  slx.on('ownDead', function () { life.dead = true; });
  slx.on('x:cashed', function () { life.cashed = true; });

  slx.on('close', function (info) {
    var i = info || {};
    if (i.playing) {
      // Their applyClose runs next and their menu shows 1.6 s later; the kind waits for it.
      if (i.sawDead) return;
      if (!S.slither) life.noLength = true;            // their gameOver cannot write a length with no own snake
      life.pending = !i.refused && lastReason === SERVER_DROP ? 'slow' : 'lost';
      return;
    }
    // No life: their menu never shows (slApply.js:1252-1262), so the card shows now, at full opacity (their login
    // layer is fully shown when no life runs).
    var refused = typeof i.refused === 'string' ? i.refused : !i.opened ? connectWhy : '';
    show(refused && TITLE[refused] ? refused : 'lost', null, 1, false);
    connectWhy = '';
  });

  slx.on('menuShow', function () {
    var kind = life.cashed ? 'cashed' : life.dead ? 'dead' : life.pending || 'lost';
    show(kind, life.noLength ? null : lastscoreNumber(), 0, true);
  });

  slx.on('menuFade', function (fr) {
    if (!shown || typeof fr !== 'number') return;
    if (fr >= 1) {
      hide();                                    // their start fade ended: a life is running
      return;
    }
    card.style.opacity = String(1 - fr);
  });

  slx.card = {
    element: card,
    // For tests and the console: what the card shows now.
    state: function () {
      return {
        kind: shown,
        title: shown ? title.textContent : '',
        length: shown && line.style.display !== 'none' ? num.textContent : '',
        again: again.textContent,
        againShown: !againHidden,
        againDisabled: !!again.disabled,
        lines: shown ? noteTexts() : [],
        opacity: card.style.opacity
      };
    },
    playAgain: playAgain,
    toLobby: toLobby,
    hide: hide,
    refresh: refresh,
    notice: function (kind) { show(String(kind || ''), null, 1, false); }
  };
})(typeof window !== 'undefined' ? window : globalThis);
