'use strict';
/* agar.io's menu card moves onto the lobby (Owen 2026-10-09 midday, BINDING; agario-reference OWNER-ANSWERS).

   Inside the lobby's agar frame (public/ag.html sets cfg.lobby when its frame element is #agar-frame) the page has
   no menu card: agLobby starts play under the lobby name (or watching, when the lobby's Spectate opened it), Esc
   does nothing in the free room, the end card (the shared DSEnd card, Owen 2026-10-16) ends with Play again, Spectate
   and Lobby, and a dropped socket joins again as it was. There are no agar.io settings anywhere since 2026-10-15 (Owen: "just get rid of all the
   settings"): not on the lobby, not on the card, nothing stored; sound is always on and the drawing values are the
   reference defaults. A direct visit to /ag and the parity harness keep the old menu otherwise; a paid hand-off keeps
   its own flow. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { LIB, bootPage, spawn, makeDoc } = require('./agFakePage.js');
const { readCard, clickCard } = require('./agEndProbe.js');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const agScreens = LIB.agScreens;

function memStore(init) {
  const m = new Map(Object.entries(init || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k), map: m, writes: 0 };
}
function countingStore(init) {
  const s = memStore(init);
  const set = s.setItem;
  s.setItem = (k, v) => { s.writes++; set(k, v); };
  return s;
}
const ids = (el, out = []) => { if (el.id) out.push(el.id); el.children.forEach((c) => ids(c, out)); return out; };

// ---- agScreens -------------------------------------------------------------------------------------------------

test('agScreens: the menu card is the name entry only (name, Play, Spectate); no Sound, settings or lobby variant', () => {
  const doc = makeDoc();
  agScreens.createScreens({ doc, root: doc.body, lobby: true });
  assert.deepStrictEqual(ids(doc.body), ['ag-menu', 'ag-card', 'ag-name', 'ag-nick', 'ag-play', 'ag-spectate']);
  assert.strictEqual(doc.getElementById('ag-screens-lobby-css'), null);
  assert.strictEqual(agScreens.LOBBY_CSS, undefined);
});

// ---- agMain in the lobby frame ---------------------------------------------------------------------------------

const own11 = { id: 11, x: 0, y: 0, size: 200, virus: false, food: false, ejected: false, agitated: false, flag40: false,
  party: false, rgb: [255, 7, 100] };
async function liveAgain(p) {
  p.session.feed({ t: 'own', id: 11 });
  p.session.feed({ t: 'world', eats: [], cells: [own11], removed: [] });
  await p.frames(3);
}

test('agMain lobby: no card at boot, Esc does nothing, death shows Play again, Spectate and Lobby, Play again respawns at once', async () => {
  const posted = [];
  const p = bootPage({ cfg: { lobby: true }, parent: { postMessage: (m, o) => posted.push([m, o]) } });
  assert.strictEqual(p.doc.getElementById('ag-menu'), null, 'no menu card in the lobby frame');
  assert.strictEqual(p.doc.getElementById('ag-nick'), null);
  assert.strictEqual(p.mod.screens, null);
  await spawn(p, p.session.feed);                 // session.play('me'), as agLobby does with the lobby name
  assert.strictEqual(p.session.state().menuState, 'PLAY');
  p.key('keydown', 27);
  p.key('keyup', 27);
  await p.frames(2);
  assert.strictEqual(p.session.state().menuState, 'PLAY', 'Esc opens nothing');
  assert.strictEqual(readCard(p.doc), null);
  // bob (cell 10) eats the own cell: the card names him
  p.session.feed({ t: 'world', eats: [[10, 9]], cells: [], removed: [9] });
  await p.frames(3);
  assert.strictEqual(p.session.state().menuState, 'GAMEOVER');
  const card = readCard(p.doc);
  assert.deepStrictEqual([card.verdict, card.hero, card.unit], ['Eaten by bob', 'Free', '']);   // a free game says Free (Owen 2026-10-16)
  assert.deepStrictEqual(card.facts, [['Mass', '400'], ['Time', '0:00'], ['Top rank', '2nd'], ['Cells eaten', '0']]);   // its score is the first tray row
  assert.deepStrictEqual(card.buttons.map((b) => [b.id, b.text, b.primary, b.disabled]),
    [['lobby', 'Lobby', false, false], ['watch', 'Spectate', false, false], ['again', 'Play again', true, false]],
    'every end card: Lobby, Spectate, Play again (Owen 2026-10-16)');
  assert.strictEqual(p.session.state().board.visible, false, 'the board steps aside for the card');
  const before = p.sent.filter((s) => s[0] === 'play').length;
  clickCard(p.doc, 'again');
  const plays = p.sent.filter((s) => s[0] === 'play');
  assert.strictEqual(plays.length, before + 1, 'Play again sends play at once (the world is ready)');
  assert.deepStrictEqual(plays[plays.length - 1][1], { name: 'me' }, 'under the same name');
  assert.strictEqual(p.session.state().menuState, 'PLAY');
  assert.strictEqual(readCard(p.doc), null, 'the card goes');
  // Death again, then Spectate: the room, watched.
  await liveAgain(p);
  p.session.feed({ t: 'world', eats: [], cells: [], removed: [11] });
  await p.frames(3);
  assert.strictEqual(readCard(p.doc).verdict, 'Eaten', 'no eater seen');
  clickCard(p.doc, 'watch');
  assert.strictEqual(p.session.state().menuState, 'SPECTATE');
  assert.deepStrictEqual(p.sent[p.sent.length - 1].slice(0, 2), ['spectate', undefined]);
  assert.strictEqual(readCard(p.doc), null);
  // A new life, a death, then Lobby: the framed page's way back.
  p.session.play('me');
  await liveAgain(p);
  p.session.feed({ t: 'world', eats: [], cells: [], removed: [11] });
  await p.frames(3);
  assert.strictEqual(p.session.state().menuState, 'GAMEOVER');
  clickCard(p.doc, 'lobby');
  assert.deepStrictEqual(posted, [['game:done', '*']]);
  p.session.destroy();
});

test('agMain lobby: a free cash-out ends on the same card ("Cashed out") with the same buttons', async () => {
  const p = bootPage({ cfg: { lobby: true }, parent: { postMessage() {} } });
  await spawn(p, p.session.feed);
  p.session.sideEvent('ag:cashedout', { free: true });
  p.session.feed({ t: 'world', eats: [], cells: [], removed: [9] });
  await p.frames(3);
  const card = readCard(p.doc);
  assert.deepStrictEqual([card.tone, card.verdict, card.hero, card.facts[0]], ['plain', 'Cashed out', 'Free', ['Mass', '400']]);
  assert.deepStrictEqual(card.buttons.map((b) => [b.id, b.text]), [['lobby', 'Lobby'], ['watch', 'Spectate'], ['again', 'Play again']]);
  assert.strictEqual(p.session.state().paidEnd, '', 'no money on it');
  clickCard(p.doc, 'watch');
  assert.deepStrictEqual([p.session.state().menuState, p.sent[p.sent.length - 1][0], readCard(p.doc)], ['SPECTATE', 'spectate', null],
    'Spectate from a free cash-out watches the room');
  p.session.destroy();
});

test('agMain lobby: a dropped socket joins again as it was (play under the same name, or watching), no menu', async () => {
  const p = bootPage({ net: true, cfg: { lobby: true }, parent: { postMessage() {} } });
  p.sock.connected = true;
  p.sock.fire('connect');
  const W = LIB.agWire || require('../shared/agWire.js');
  const feed = (rec) => p.sock.fire('ag:f', W.encodeBundle([rec]));
  await spawn(p, feed);
  const plays0 = p.sent.filter((s) => s[0] === 'play').length;
  p.sock.connected = false;
  p.sock.fire('disconnect', 'transport close');
  assert.strictEqual(p.doc.getElementById('ag-menu'), null, 'no menu after the drop');
  assert.strictEqual(readCard(p.doc), null, 'no card either');
  assert.strictEqual(p.session.state().menuState, 'PLAY');
  p.sock.connected = true;
  p.sock.fire('connect');
  feed({ t: 'hello' });
  feed({ t: 'border', minX: -7071, minY: -7071, maxX: 7071, maxY: 7071, mode: 0 });
  feed({ t: 'world', eats: [], cells: [], removed: [] });
  await p.frames(2);
  const plays = p.sent.filter((s) => s[0] === 'play');
  assert.strictEqual(plays.length, plays0 + 1, 'joined again once the new world was ready');
  assert.deepStrictEqual(plays[plays.length - 1][1], { name: 'me' });
  p.session.destroy();

  const w = bootPage({ net: true, cfg: { lobby: true }, parent: { postMessage() {} } });
  w.sock.connected = true;
  w.sock.fire('connect');
  const wf = (rec) => w.sock.fire('ag:f', W.encodeBundle([rec]));
  wf({ t: 'hello' });
  wf({ t: 'border', minX: -7071, minY: -7071, maxX: 7071, maxY: 7071, mode: 0 });
  w.session.spectate();
  wf({ t: 'world', eats: [], cells: [], removed: [] });
  await w.frames(2);
  const specs0 = w.sent.filter((s) => s[0] === 'spectate').length;
  w.sock.connected = false;
  w.sock.fire('disconnect', 'transport close');
  w.sock.connected = true;
  w.sock.fire('connect');
  wf({ t: 'hello' });
  wf({ t: 'border', minX: -7071, minY: -7071, maxX: 7071, maxY: 7071, mode: 0 });
  wf({ t: 'world', eats: [], cells: [], removed: [] });
  await w.frames(2);
  assert.strictEqual(w.sent.filter((s) => s[0] === 'spectate').length, specs0 + 1, 'the watcher watches again');
  assert.strictEqual(w.session.state().menuState, 'SPECTATE');
  w.session.destroy();
});

test('agMain lobby: the old settings keys change nothing, before boot or after it, and nothing is written', async () => {
  const storage = countingStore({ agSettings: JSON.stringify({ quality: 'Low', names: false, colors: false, showMass: true, dark: true }),
    agSoundOn: '0' });
  const p = bootPage({ cfg: { lobby: true, persistSettings: true, storage }, parent: { postMessage() {} } });
  await spawn(p, p.session.feed);
  const fixed = { quality: 'Retina', names: true, colors: true, showMass: false, dark: false };
  assert.deepStrictEqual(p.session.settings(), fixed, 'hard-wired: names and colours on, mass and dark off, Retina');
  assert.strictEqual(p.mod.sound.isEnabled(), true, 'sound always on');
  const W0 = [p.canvas.width, p.canvas.height];
  p.win.fire('storage', { key: 'agSettings' });
  p.win.fire('storage', { key: 'agSoundOn', newValue: '0' });
  assert.deepStrictEqual(p.session.settings(), fixed);
  assert.deepStrictEqual([p.canvas.width, p.canvas.height], W0, 'the canvas is not resized');
  assert.strictEqual(p.mod.sound.isEnabled(), true);
  assert.strictEqual(storage.writes, 0, 'nothing written');
  p.session.destroy();
});

test('agMain everywhere else: the card at boot, Esc opens it, Menu on the end card, no storage listener', async () => {
  const storage = memStore();
  const p = bootPage({ cfg: { storage } });
  const menu = p.doc.getElementById('ag-menu');
  assert.strictEqual(menu.hidden, false, 'the name entry at boot');
  await spawn(p, p.session.feed);
  p.key('keydown', 27);
  await p.frames(2);
  assert.strictEqual(p.session.state().menuState, 'HOME', 'Esc opens the menu');
  p.key('keyup', 27);
  storage.setItem('agSettings', JSON.stringify({ quality: 'Low', names: true, colors: true, showMass: false, dark: true }));
  p.win.fire('storage', { key: 'agSettings' });
  assert.strictEqual(p.session.settings().dark, false, 'a direct visit does not follow the storage either');
  // Play from the name entry, a death: the end card, with Menu (the old Continue) in place of Lobby
  p.doc.getElementById('ag-play').dispatch('click');
  await liveAgain(p);
  p.session.feed({ t: 'world', eats: [], cells: [], removed: [9, 11] });   // the Esc menu left cell 9 playing
  await p.frames(3);
  assert.deepStrictEqual(readCard(p.doc).buttons.map((b) => b.id), ['menu', 'watch', 'again'], 'Menu in place of Lobby (no lobby here)');
  assert.strictEqual(menu.hidden, true);
  // Esc over the card: the name entry replaces it
  p.key('keydown', 27);
  p.key('keyup', 27);
  await p.frames(2);
  assert.deepStrictEqual([p.session.state().menuState, menu.hidden, readCard(p.doc)], ['HOME', false, null]);
  // and Menu does the same from the card
  p.doc.getElementById('ag-play').dispatch('click');
  await liveAgain(p);
  p.session.feed({ t: 'world', eats: [], cells: [], removed: [11] });
  await p.frames(3);
  clickCard(p.doc, 'menu');
  assert.deepStrictEqual([p.session.state().menuState, menu.hidden, readCard(p.doc)], ['HOME', false, null]);
  p.session.destroy();
});

test('agMain lobby with a paid hand-off: its own flow, unchanged (no menu, Esc shows its hint, the paid card)', async () => {
  const tab = memStore({ stake: '0.1', entryToken: 'tok_abcdef0123456789', playerName: 'Owen' });
  const p = bootPage({ net: true, cfg: { lobby: true, handoff: true, tabStorage: tab }, parent: { postMessage() {} } });
  assert.ok(p.session.state().handoff, 'the paid flow runs');
  assert.strictEqual(p.session.state().paid, true);
  assert.strictEqual(p.doc.getElementById('ag-menu'), null);
  p.sock.connected = true;
  p.sock.fire('connect');
  p.session.sideEvent('ag:joined', { stake: 0.1, micro: 100000 });
  const st = p.session.state().menuState;
  p.key('keydown', 27);
  p.key('keyup', 27);
  assert.strictEqual(p.session.state().menuState, st, 'Esc goes to the paid flow, never a menu');
  assert.strictEqual(p.doc.getElementById('ag-menu'), null);
  p.session.sideEvent('ag:dead', { lostMicro: 100000, by: 'bob' });
  const card = readCard(p.doc);
  assert.deepStrictEqual([card.tone, card.verdict, card.hero], ['loss', 'Eaten by bob', '−$0.10'], 'the paid death, not the free card');
  assert.deepStrictEqual(card.buttons.map((b) => [b.id, b.text]), [['lobby', 'Lobby'], ['watch', 'Spectate'], ['again', 'Play again $0.10']]);
  p.session.destroy();
});

// ---- agLobby: the start and the Lobby button -------------------------------------------------------------------

const LOBBY_SRC = read('public/js/ag/agLobby.js');
function lobbyPage({ lobby = true, paid = false, handoff = null, spectateOnly = false, framed = true, coarse = false,
  st = {} } = {}) {
  let cardUp = false;   // the shared end card (window.DSEnd.shown())
  const els = {};
  function node(tag) {
    return { tagName: tag, id: '', hidden: false, textContent: '', innerHTML: '', children: [],
      classList: { set: new Set(), toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); }, contains(c) { return this.set.has(c); } },
      setAttribute() {}, addEventListener(t, fn) { (this.l = this.l || {})[t] = fn; },
      appendChild(c) { this.children.push(c); if (c.id) els[c.id] = c; return c; } };
  }
  const menu = node('div'); menu.id = 'ag-menu'; menu.hidden = true; els['ag-menu'] = menu;
  const observers = [];
  const calls = [];
  const hooks = {};
  // st: the page state the test moves (menuState, connected); play and spectate move it as agMain does.
  const page = {
    config: { lobby }, paidLocked: () => false,
    onServer(name, fn) { (hooks[name] = hooks[name] || []).push(fn); },
    state: () => Object.assign({ paid, handoff, menuState: 'HOME', connected: true }, st),
    play: (n) => { calls.push(['play', n]); st.menuState = 'PLAY'; },
    spectate: () => { calls.push(['spectate']); st.menuState = 'SPECTATE'; }
  };
  const session = memStore(Object.assign({ playerName: 'OwenTheTopBoss77' }, spectateOnly ? { spectateOnly: 'true' } : {}));
  const win = {
    document: { readyState: 'complete', head: node('head'), body: node('body'), getElementById: (id) => els[id] || null,
      createElement: (t) => node(t), addEventListener() {} },
    sessionStorage: session, localStorage: memStore(),
    matchMedia: () => ({ matches: coarse, addEventListener() {} }),
    MutationObserver: class { constructor(fn) { observers.push(fn); } observe() {} },
    addEventListener() {}, setTimeout, clearTimeout, duelAgar: page,
    DSEnd: { shown: () => cardUp }
  };
  win.parent = framed ? { postMessage() {} } : win;
  win.window = win;
  vm.createContext(win);
  vm.runInContext(LOBBY_SRC, win, { filename: 'agLobby.js' });
  const notify = () => observers.forEach((fn) => fn());
  return { calls, els, menu, st, notify, card: (on) => { cardUp = on; notify(); },
    fire: (name, p) => (hooks[name] || []).forEach((fn) => fn(p)) };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('agLobby: the lobby frame\'s free room starts at once under the lobby name, or watching from the lobby\'s Spectate', () => {
  assert.deepStrictEqual(lobbyPage().calls, [['play', 'OwenTheTopBoss7']], 'the lobby name, cut to the 15 the game takes');
  assert.deepStrictEqual(lobbyPage({ spectateOnly: true }).calls, [['spectate']]);
  assert.deepStrictEqual(lobbyPage({ lobby: false }).calls, [], 'a direct visit waits on its menu');
  assert.deepStrictEqual(lobbyPage({ paid: true, handoff: { state: 'joining' } }).calls, [], 'a paid hand-off runs its own flow');
  assert.deepStrictEqual(lobbyPage({ framed: false }).calls, [], 'never outside a frame');
});

test('agLobby: in the lobby frame\'s free room the Lobby button keeps the old player rule, and shows for a watcher and a drop', async () => {
  // A mouse player: hidden while playing (hold Q, then the end card's Lobby), as before the menu moved.
  const mouse = lobbyPage();
  const btn = mouse.els['ag-lobby'];
  assert.deepStrictEqual(mouse.calls, [['play', 'OwenTheTopBoss7']]);
  assert.ok(!btn.classList.contains('on'), 'not over a mouse player\'s game');
  mouse.card(true);             // the end card, which has its own Lobby
  assert.ok(!btn.classList.contains('on'), 'hidden over the card');
  mouse.card(false);            // Play again
  assert.ok(!btn.classList.contains('on'));
  // The socket drops: shown until it is back (agMain rejoins), so a server that never answers is not a dead end.
  mouse.st.connected = false;
  mouse.fire('disconnect', { reason: 'transport close' });
  assert.ok(btn.classList.contains('on'), 'shown while the socket is down');
  await wait(250);
  assert.ok(btn.classList.contains('on'), 'still down');
  mouse.st.connected = true;
  await wait(250);
  assert.ok(!btn.classList.contains('on'), 'gone again once the page is back in');
  // A touch screen: shown while playing, as before; never over the card.
  const touch = lobbyPage({ coarse: true });
  assert.ok(touch.els['ag-lobby'].classList.contains('on'), 'shown on a touch screen');
  touch.card(true);
  assert.ok(!touch.els['ag-lobby'].classList.contains('on'), 'hidden over the card');
  touch.card(false);
  assert.ok(touch.els['ag-lobby'].classList.contains('on'), 'back once it goes');
  // A watcher (the lobby's Spectate, or the card's): shown, with a mouse too, since Esc opens nothing now.
  const watcher = lobbyPage({ spectateOnly: true });
  assert.ok(watcher.els['ag-lobby'].classList.contains('on'), 'shown for a watcher');
  // A paid page on a touch screen: never over a paid card either (its own Lobby, or none while leaving is shut).
  const paidTouch = lobbyPage({ paid: true, handoff: { phase: 'end' }, coarse: true });
  assert.ok(paidTouch.els['ag-lobby'].classList.contains('on'));
  paidTouch.card(true);
  assert.ok(!paidTouch.els['ag-lobby'].classList.contains('on'));
  const direct = lobbyPage({ lobby: false });
  assert.ok(!direct.els['ag-lobby'].classList.contains('on'), 'elsewhere: only with the menu open or on a touch screen');
});

// ---- the lobby's agar.io screen --------------------------------------------------------------------------------

test('the lobby\'s agar.io screen: no settings anywhere, Spectate beside Play on every rung', () => {
  const html = read('public/v2.html');
  assert.match(html, /<div class="gorow">\s*<button type="button" class="go" id="gobtn" onclick="startFromDetail\(\)">/, 'Play is the same button');
  assert.match(html, /<button type="button" class="spec" id="specbtn" onclick="spectateFromDetail\(\)"/);
  // Owen 2026-10-15: "just get rid of all the settings, I don't need any of them". Not in the play column, not in
  // Customize, no script, no stored keys.
  assert.ok(!fs.existsSync(path.join(ROOT, 'public/js/v2/agopts.js')), 'agopts.js is gone');
  for (const gone of ['agopts', 'id="agtg"', 'agset', 'hasSettings', 'Game settings', 'agSettings', 'agSoundOn', '.agt{']) {
    assert.ok(!html.includes(gone), gone + ' is not in the lobby');
  }
  // Every game's screen has it now (Owen 2026-10-15), on every rung (paid too, the same night), shut on a game that
  // is not open.
  assert.match(html, /function drawStake\(\)\{\s*\/\*[^*]*\*\/\s*document\.getElementById\('detail'\)\.classList\.toggle\('freerung',STEPS\[si\]===0\);/,
    'Spectate follows the chosen rung');
  assert.match(html, /\.spec\{display:flex;/);
  assert.match(html, /specBtn\.disabled=locked;/);
  // No other page offers them either: the /ag card and the game's own code read and write nothing.
  for (const f of ['public/js/ag/agMain.js', 'public/js/ag/agSound.js', 'public/js/ag/agScreens.js', 'public/ag.html']) {
    assert.ok(!/agSettings|agSoundOn|ag-settings|ag-sound\b|createToggleButton/.test(read(f)), f + ' has no settings');
  }
});

test('the lobby\'s Spectate opens /ag in the agar frame with the watch flag the page reads', () => {
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, style: { display: '' }, src: '', value: '', classList: { add() {}, remove() {}, toggle() {} } });
  const session = memStore();
  const win = { localStorage: memStore(), sessionStorage: session, console,
    document: { getElementById: el, addEventListener() {}, body: { classList: { add() {}, remove() {} } } },
    addEventListener() {}, MutationObserver: class { observe() {} } };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(read('public/js/v2/play.js'), win, { filename: 'play.js' });
  win.V2Play.spectate('agar');
  assert.strictEqual(els['agar-frame'].src, '/ag');
  assert.strictEqual(session.getItem('spectateOnly'), 'true');
  assert.strictEqual(session.getItem('stake'), null, 'and no stake: the page is never a paid hand-off');
});
