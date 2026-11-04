// The one set of Spectate controls every game uses (Owen 2026-10-16: "I want the same controls for every single game,
// so there should be next buttons that instantly swap to the next person, there should be the Lobby button every
// time"). His pick from the picker (look B, "Split", with his changes): a Lobby chip top left, and at the bottom
// centre a big round previous button, a plate with just the watched player's name, and a big round next button. No
// dot and no "3 of 12" on the plate. PC: Left arrow is previous, Right arrow and Space are next. Phones (2026-11-04,
// like slither.io's): small, together at the very bottom left, out of the middle and off the owner controls. An empty table (nobody to follow) shows the whole map behind it
// (public/js/shared/dsEmptyArena.js, bare) and says so on the plate, with the arrows off. A game with no map to show
// (Knockout, Battleship, Crossy Road: emptyArt) shows its own card art instead, zoomed, blurred and darkened the way the
// lobby's game screen does (public/v2.html .gbg), so an empty Watch never looks like a dead page (Owen 2026-10-28).
//
// Used by slither.io and its battle royale (public/js/slx/slxWatch.js, slxBr.js), agar.io (public/js/ag/agMain.js),
// Paper.io (public/js/paper/mp/paperArenaMain.js), Knockout and Battleship. Each game says who it is following and
// does the switching itself; this file never talks to a server, reads money or seats anyone.
//
// DSWatchBar.open({ game, stake, onPrev, onNext, onLobby, phoneLift, phoneSize, phoneRight, emptyArt })  shows the bar (again: updates the
//           handlers); 'Finding a player' on the plate until watching(name)
//           .watching(name)   the name on the plate, arrows on, the empty map (or card art) hidden
//           .empty()          the empty table: the whole map (or with emptyArt the game's card art) behind, "Nobody is
//                             playing yet", arrows off
//           .busy(on)         arrows off while a switch is on its way (a second press waits for it)
//           .close()          everything hidden (the page is going back to the lobby, or playing)
//           .shown(), .state()
(function (root) {
  'use strict';
  var doc = root.document;
  if (!doc) return;

  var Z = 2147480100; // above the empty map (dsEmptyArena 2147480000), under the clip recorder's card
  var ART_Z = Z - 200; // the card art behind an empty table: over the game's own page, under the bar
  var ART_V = 1; // public/v2.html ART_V: the card pictures' version, so a new painting is fetched fresh
  // the site kit's font link and stack (site redo 2026-11-02): Archivo with its width axis
  var FONT_HREF = 'https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&family=IBM+Plex+Mono:wght@500&display=swap';
  var SANS = '"Archivo","Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif';
  var WORDS = {
    lobby: 'Lobby',
    prev: 'Previous player',
    next: 'Next player',
    empty: 'Nobody is playing yet',
    finding: 'Finding a player',
    unnamed: 'Unnamed'
  };
  // The kit's in-game glass (layout 1 "Sidebar", game-ui mockup): black glass with the kit's one line, bone text,
  // 10 px radii on the Lobby control, round arrows, an 18 px plate. Colours read --ds-* tokens when a page loads them.
  var CSS = [
    '.dsw-lobby,.dsw-switch{position:fixed;z-index:' + Z + ';font-family:' + SANS + ';-webkit-tap-highlight-color:transparent;',
    'user-select:none;-webkit-user-select:none;touch-action:manipulation;-webkit-font-smoothing:antialiased;}',
    '.dsw-lobby,.dsw-switch{display:none;}',
    '.dsw-on .dsw-lobby{display:inline-flex;}',
    '.dsw-on .dsw-switch{display:flex;}',
    '.dsw-btn{display:inline-flex;align-items:center;justify-content:center;margin:0;border:0;cursor:pointer;padding:0;',
    'font:650 15px ' + SANS + ';color:var(--ds-bone,#f4f1ea);background:none;transition:background-color .14s,box-shadow .14s,transform .08s;}',
    '.dsw-btn:focus-visible{outline:2px solid var(--ds-bone,#f4f1ea);outline-offset:2px;}',
    '.dsw-btn:disabled{color:var(--ds-tx3,#988b78);cursor:default;}',
    '.dsw-lobby{left:calc(16px + env(safe-area-inset-left,0px));top:calc(16px + env(safe-area-inset-top,0px));gap:8px;height:44px;',
    'padding:0 16px 0 12px;border-radius:10px;background:rgba(0,0,0,.74);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);',
    'box-shadow:inset 0 0 0 1px var(--ds-line,#36291a);}',
    '.dsw-lobby:hover{background:rgba(26,22,17,.94);box-shadow:inset 0 0 0 1px var(--ds-line2,#5a4630);}',
    '.dsw-lobby:active{transform:translateY(1px) scale(.985);}',
    '.dsw-lobby svg{width:18px;height:18px;flex:none;}',
    '.dsw-switch{left:50%;bottom:calc(24px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);align-items:center;',
    'gap:12px;}',
    '.dsw-round{width:56px;height:56px;flex:none;border-radius:50%;background:rgba(0,0,0,.74);',
    '-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);box-shadow:inset 0 0 0 1px var(--ds-line,#36291a),0 6px 18px rgba(0,0,0,.3);}',
    '.dsw-round:hover:not(:disabled){background:rgba(26,22,17,.94);box-shadow:inset 0 0 0 1px var(--ds-line2,#5a4630),0 6px 18px rgba(0,0,0,.3);}',
    '.dsw-round:active:not(:disabled){transform:scale(.94);}',
    '.dsw-round svg{width:24px;height:24px;}',
    '.dsw-plate{display:flex;align-items:center;justify-content:center;box-sizing:border-box;min-width:260px;max-width:460px;',
    'height:56px;padding:0 24px;border-radius:18px;background:rgba(0,0,0,.84);color:var(--ds-bone,#f4f1ea);',
    '-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);box-shadow:inset 0 0 0 1px var(--ds-line,#36291a),0 6px 18px rgba(0,0,0,.3);}',
    '.dsw-name{font-weight:700;font-size:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.dsw-empty .dsw-name,.dsw-wait .dsw-name{font-weight:600;font-size:15px;color:var(--ds-tx2,#b3a792);}',
    // Phones, either way up (Owen 2026-11-04: "make it like slither.io's: out of the way, off to the side, small"): the
    // arrows and the name sit together at the very bottom left, as small as a thumb allows (46 px), the name only as
    // wide as it needs, so the middle of the screen, the bottom right (minimaps, the ping readout) and every owner
    // control stay clear. The Lobby chip is smaller too. Upright, the cluster stops 134 px short of the right edge
    // (Paper's minimap and the ping readout); sideways the name is at most 180 px, clear of a bottom-centre scoreboard.
    '@media (max-width:600px),(pointer:coarse) and (max-height:600px){',
    '.dsw-switch{left:calc(var(--dsw-left,10px) + env(safe-area-inset-left,0px));right:auto;transform:none;',
    'bottom:calc(10px + env(safe-area-inset-bottom,0px));justify-content:flex-start;gap:6px;}',
    '.dsw-round{width:46px;height:46px;box-shadow:inset 0 0 0 1px var(--ds-line,#36291a),0 4px 12px rgba(0,0,0,.28);}',
    '.dsw-round svg{width:20px;height:20px;}',
    '.dsw-plate{min-width:88px;max-width:max(88px,calc(100vw - 248px));flex:none;height:46px;padding:0 12px;border-radius:14px;',
    'box-shadow:inset 0 0 0 1px var(--ds-line,#36291a),0 4px 12px rgba(0,0,0,.28);}',
    '.dsw-name{font-size:14px;}',
    '.dsw-empty .dsw-name,.dsw-wait .dsw-name{font-size:13px;}',
    // nobody to follow: the arrows do nothing, so on a phone the plate alone says so, in full
    '.dsw-empty .dsw-round{display:none;}',
    '.dsw-empty .dsw-plate{max-width:max(88px,calc(100vw - 150px));}',
    '.dsw-lobby{left:calc(10px + env(safe-area-inset-left,0px));top:calc(10px + env(safe-area-inset-top,0px));height:36px;',
    'padding:0 12px 0 8px;gap:6px;border-radius:9px;font-size:13px;}',
    '.dsw-lobby svg{width:16px;height:16px;}}',
    '@media (pointer:coarse) and (max-height:600px) and (min-width:601px){.dsw-plate{max-width:180px;}.dsw-empty .dsw-plate{max-width:260px;}}',
    // A page that measured its own corner (slither.io and its battle royale, drawn at 0.7 in the lobby: phoneRight)
    // keeps the bar it placed: along the bottom, stopping that far from the right edge, at its own size.
    '@media (max-width:600px),(pointer:coarse) and (max-height:600px){',
    '.dsw-fit .dsw-switch{left:12px;right:var(--dsw-right,12px);bottom:calc(var(--dsw-lift,12px) + env(safe-area-inset-bottom,0px));',
    'justify-content:space-between;gap:8px;}',
    '.dsw-fit .dsw-round{width:var(--dsw-size,64px);height:var(--dsw-size,64px);',
    'box-shadow:inset 0 0 0 1px var(--ds-line,#36291a),0 6px 18px rgba(0,0,0,.3);}',
    '.dsw-fit .dsw-round svg{width:24px;height:24px;}',
    '.dsw-fit .dsw-plate{min-width:0;max-width:none;flex:1;height:var(--dsw-size,64px);padding:0 14px;border-radius:18px;',
    'box-shadow:inset 0 0 0 1px var(--ds-line,#36291a),0 6px 18px rgba(0,0,0,.3);}',
    '.dsw-fit .dsw-name{font-size:16px;}',
    '.dsw-fit .dsw-empty .dsw-name,.dsw-fit .dsw-wait .dsw-name{font-size:15px;}',
    '.dsw-fit .dsw-empty .dsw-round{display:inline-flex;}',
    '.dsw-fit .dsw-empty .dsw-plate{max-width:none;}',
    '.dsw-fit .dsw-lobby{left:calc(16px + env(safe-area-inset-left,0px));top:calc(16px + env(safe-area-inset-top,0px));',
    'height:max(44px,calc(var(--dsw-size,64px) * .66));padding:0 14px 0 10px;gap:8px;border-radius:10px;font-size:15px;}',
    '.dsw-fit .dsw-lobby svg{width:18px;height:18px;}}',
    '@media (prefers-reduced-motion:reduce){.dsw-round:active:not(:disabled){transform:none;}}',
    // the empty table's card art (emptyArt): the lobby's game screen, zoomed, blurred and dark on true black
    '.dsw-art{position:fixed;inset:0;z-index:' + ART_Z + ';overflow:hidden;pointer-events:none;background:#000;display:none;}',
    '.dsw-art.dsw-art-on{display:block;}',
    '.dsw-art i{position:absolute;inset:-40px;background-size:cover;background-position:center;',
    'filter:blur(6px) brightness(.4) saturate(1.05);}',
    '@media (orientation:portrait){.dsw-art i{background-size:auto 150%;background-position:50% 28%;}}',
    ".dsw-art::after{content:'';position:absolute;inset:0;",
    'background:radial-gradient(120% 80% at 50% 48%,rgba(0,0,0,.66),rgba(0,0,0,.36) 66%,rgba(0,0,0,.62)),',
    'linear-gradient(180deg,rgba(0,0,0,.5),transparent 30%,rgba(0,0,0,.55));}'
  ].join('');
  // A game whose own control sits in the bottom left corner on a phone: the small bar starts right of it (px).
  // Air Hockey draws its music button there (public/js/airhockey.js MUSIC, x 26 r 17).
  var PHONE_LEFT = { airhockey: 52 };
  var ICON = {
    back: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" ' +
      'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" ' +
      'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };

  var built = false;
  var lobbyBtn = null;
  var sw = null;
  var prevBtn = null;
  var nextBtn = null;
  var plate = null;
  var nameEl = null;
  var art = null;
  var opts = {};
  var on = false;
  var isEmpty = false;
  var isBusy = false;
  var name = null; // null until the game says who it follows: 'Finding a player'
  var presses = 0;

  function el(tag, cls, html) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (html) e.innerHTML = html;
    return e;
  }

  function call(fn) {
    if (typeof fn !== 'function') return;
    try { fn(); } catch (err) { /* a game's handler never breaks the bar */ }
  }

  function step(d) {
    if (!on || isEmpty || isBusy) return;
    presses++;
    call(d < 0 ? opts.onPrev : opts.onNext);
  }

  function build() {
    if (built) return true;
    if (!doc.body) return false;
    built = true;
    try {
      if (!doc.querySelector('link[data-dsw-font]')) {
        var link = el('link');
        link.rel = 'stylesheet';
        link.href = FONT_HREF;
        link.setAttribute('data-dsw-font', '1');
        (doc.head || doc.body).appendChild(link);
      }
    } catch (e) { /* the system font is fine */ }
    var st = el('style');
    st.textContent = CSS;
    (doc.head || doc.body).appendChild(st);
    lobbyBtn = el('button', 'dsw-btn dsw-lobby', ICON.back + '<span>' + WORDS.lobby + '</span>');
    lobbyBtn.type = 'button';
    sw = el('div', 'dsw-switch');
    prevBtn = el('button', 'dsw-btn dsw-round', ICON.prev);
    prevBtn.type = 'button';
    prevBtn.setAttribute('aria-label', WORDS.prev);
    nextBtn = el('button', 'dsw-btn dsw-round', ICON.next);
    nextBtn.type = 'button';
    nextBtn.setAttribute('aria-label', WORDS.next);
    plate = el('div', 'dsw-plate');
    plate.setAttribute('aria-live', 'polite');
    nameEl = el('span', 'dsw-name');
    plate.appendChild(nameEl);
    sw.appendChild(prevBtn);
    sw.appendChild(plate);
    sw.appendChild(nextBtn);
    doc.body.appendChild(lobbyBtn);
    doc.body.appendChild(sw);
    // The game under the bar never hears a press meant for it (games steer from window-level handlers).
    var stop = function (e) { e.stopPropagation(); };
    var kinds = ['mousedown', 'mouseup', 'touchstart', 'touchend', 'pointerdown', 'pointerup', 'wheel'];
    for (var i = 0; i < kinds.length; i++) {
      lobbyBtn.addEventListener(kinds[i], stop, { passive: true });
      sw.addEventListener(kinds[i], stop, { passive: true });
    }
    lobbyBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (on) call(opts.onLobby);
    });
    prevBtn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); step(-1); });
    nextBtn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); step(1); });
    // PC keys, before the game's own (Space boosts and the arrows steer in some games; a watcher steers nothing).
    root.addEventListener('keydown', function (e) {
      if (!on) return;
      var t = e.target;
      var tag = t && t.tagName ? String(t.tagName).toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || (t && t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      var k = e.key;
      var d = k === 'ArrowLeft' ? -1 : k === 'ArrowRight' || k === ' ' || k === 'Spacebar' ? 1 : 0;
      if (!d) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) step(d);
    }, true);
    return true;
  }

  function paint() {
    if (!built) return;
    var body = doc.body;
    if (body && body.classList) {
      body.classList.toggle('dsw-on', on);
      body.classList.toggle('dsw-fit', on && opts.phoneRight > 0);   // the page placed the bar itself (slither.io)
    }
    sw.classList.toggle('dsw-empty', isEmpty);
    sw.classList.toggle('dsw-wait', !isEmpty && name === null);
    var text = isEmpty ? WORDS.empty : name === null ? WORDS.finding : (name || WORDS.unnamed);
    if (nameEl.textContent !== text) nameEl.textContent = text;
    var off = isEmpty || isBusy;
    prevBtn.disabled = off;
    nextBtn.disabled = off;
  }

  function emptyMap(show) {
    emptyArt(show && opts.emptyArt === true);
    var E = root.DSEmptyArena;
    if (!E) return;
    if (show) E.show({ game: opts.game, stake: opts.stake, bare: true });
    else E.hide();
  }

  // The card art behind an empty table, for the games with no map of their own to show. Made on first use only.
  function emptyArt(show) {
    var id = String(opts.game || '');
    if (show && /^[a-z0-9]+$/.test(id)) {
      if (!art) {
        art = el('div', 'dsw-art');
        art.setAttribute('aria-hidden', 'true');
        art.appendChild(el('i'));
        doc.body.appendChild(art);
      }
      var url = 'url("/img/games/' + id + '-card.webp?v=' + ART_V + '")';
      if (art.firstChild.style.backgroundImage !== url) art.firstChild.style.backgroundImage = url;
      art.classList.add('dsw-art-on');
    } else if (art) {
      art.classList.remove('dsw-art-on');
    }
  }

  root.DSWatchBar = {
    // o.phoneRight (px, optional): a page that measured its own corner (the lobby shows /sl at 0.7) has the bar along
    // the bottom, o.phoneLift up and stopping this far from the right edge, its buttons o.phoneSize, clear of its own
    // minimap. Without it a phone gets the small bar at the bottom left (phoneLift alone is no longer used there).
    open: function (o) {
      opts = o || {};
      if (!build()) return false;
      var rs = doc.documentElement && doc.documentElement.style;
      if (rs && typeof rs.setProperty === 'function') {
        if (opts.phoneLift > 0) rs.setProperty('--dsw-lift', Math.round(opts.phoneLift) + 'px');
        if (opts.phoneSize > 0) rs.setProperty('--dsw-size', Math.round(opts.phoneSize) + 'px');
        if (opts.phoneRight > 0) rs.setProperty('--dsw-right', Math.round(opts.phoneRight) + 'px');
        var pl = PHONE_LEFT[String(opts.game || '')];
        if (pl > 0) rs.setProperty('--dsw-left', pl + 'px');
      }
      if (!on) name = null;
      on = true;
      paint();
      return true;
    },
    watching: function (n) {
      name = typeof n === 'string' ? n.trim().slice(0, 32) : '';
      isEmpty = false;
      isBusy = false;
      emptyMap(false);
      paint();
    },
    empty: function () {
      isEmpty = true;
      isBusy = false;
      if (on) emptyMap(true);
      paint();
    },
    busy: function (b) {
      isBusy = b === true;
      paint();
    },
    close: function () {
      on = false;
      name = null;
      isEmpty = false;
      isBusy = false;
      emptyMap(false);
      paint();
    },
    shown: function () { return on; },
    // For headless checks: what the bar shows now.
    state: function () {
      return { on: on, empty: isEmpty, busy: isBusy, name: name, presses: presses,
        text: nameEl ? nameEl.textContent : '', art: !!(art && art.classList.contains('dsw-art-on')) };
    },
    WORDS: WORDS
  };
})(typeof window !== 'undefined' ? window : globalThis);
