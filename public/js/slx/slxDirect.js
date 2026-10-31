// DuelSeries layer on the frozen slither.io client: the name box and Play for a direct visit (SERVER-DESIGN 3.2,
// 15.3 "Direct visit"; task T16). Ours, not a parity area. Agar keeps a menu for a direct visit too.
//
// Inert unless slxNet installed the production transport (15.2), and absent inside the lobby's frame, where
// slxMain plays at once under the lobby name.
//
// Their menu has no name box or Play button here (public/js/sl/slMain.js:91-101 is their Play "minus the menu"), so
// this adds one panel at the end of their login layer, under the logo and the last-score line. Being inside that
// layer, it fades and scales with their menu: out with their 500 ms start fade (slHud loginFade), back in with their
// death fade after 1.6 s (slHud.oefFades). The name box starts with the lobby name and keeps what was typed; its
// cap is their 24 characters (law L45 nameMax; their client cuts the same at the open, slNet.js openNick).
//
// Play calls their Play (DuelSlither.play). The button then says "Starting" until their menu shows again (a life
// ended, 'menuShow') or the socket closed before any life (a refusal or a failed connect: their client unlocks Play
// then, slApply.js:1252-1262, and never shows the menu). At that point the results card (slx.card,
// slxCard.js, T17) takes the menu over and this panel hides for good; on a page without the card it comes
// back as Play. Typing never reaches their key handlers, and a click or tap never reaches their boost (slx.guard).
(function (root) {
  'use strict';
  var D = root.DuelSlither;
  if (!D || !D.slx || !D.slx.active) return;
  var slx = D.slx;
  var doc = root.document;
  // A Spectate page (slxWatch) watches at once, from slxMain, wherever it opened: no name box or Play there.
  if (slx.inLobby || typeof slx.watchAuth === 'function' || !doc || typeof slx.guard !== 'function') return;
  var login = doc.getElementById('login');
  if (!login) return;

  var NAME_MAX = 24;                             // law L45 nameMax (spec/SERVER-LAWS.md)

  var panel = doc.createElement('div');
  panel.className = 'slx-direct';
  var name = doc.createElement('input');
  name.className = 'slx-direct-name';
  name.type = 'text';
  name.maxLength = NAME_MAX;
  name.placeholder = 'Nickname';
  name.autocomplete = 'off';
  name.spellcheck = false;
  name.setAttribute('aria-label', 'Nickname');
  name.value = slx.lobbyName().slice(0, NAME_MAX);
  var play = doc.createElement('button');
  play.className = 'slx-direct-play';
  play.type = 'button';
  play.textContent = 'Play';
  panel.appendChild(name);
  panel.appendChild(play);
  login.appendChild(panel);

  var busy = false;
  function go() {
    if (busy) return;
    busy = true;
    play.disabled = true;
    play.textContent = 'Starting';
    try {
      name.blur();
    } catch (e) { /* nothing focused */ }
    D.play(name.value);
  }
  function ready() {
    busy = false;
    play.disabled = false;
    play.textContent = 'Play';
  }
  // After a life or a refusal the results card (slxCard, T17: Play again, Try again, Lobby, under the same name) owns
  // the menu, so the panel steps aside for good when the page has one; without it the panel comes back as Play.
  function after() {
    if (slx.card) {
      panel.style.display = 'none';
      return;
    }
    ready();
  }

  slx.guard(name, { typing: true });
  slx.guard(play, { activate: go });
  name.addEventListener('keydown', function (e) {
    if (e.keyCode === 13 || e.key === 'Enter') {
      e.preventDefault();
      go();
    }
  });
  slx.on('menuShow', after);
  slx.on('close', function (info) {
    if (!info.playing) after();
  });

  // A computer gets the caret in the box at once; a phone would pop its keyboard over the menu, so it waits for a tap.
  if (!D.S.is_mobile) {
    try {
      name.focus();
    } catch (e) { /* the page has no focus yet */ }
  }

  slx.direct = { panel: panel, name: name, play: play, ready: ready };
})(typeof window !== 'undefined' ? window : globalThis);
