'use strict';
/* agar.io's menu card moves onto the lobby (Owen 2026-10-09 midday, BINDING; agario-reference OWNER-ANSWERS).

   Inside the lobby's agar frame (public/ag.html sets cfg.lobby when its frame element is #agar-frame) the page has
   no menu card: agLobby starts play under the lobby name (or watching, when the lobby's Spectate opened it), Esc
   does nothing in the free room, the Match Results panel ends with Play again and Lobby, and a dropped socket joins
   again as it was. The card's settings live on the lobby's agar.io screen (public/js/v2/agopts.js), which writes the
   same two storage keys the page reads, and a loaded page takes a change from the storage event. A direct visit to
   /ag and the parity harness keep the old menu exactly; a paid hand-off keeps its own flow. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { LIB, bootPage, spawn, makeDoc } = require('./agFakePage.js');

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

test('agScreens: the lobby card has no name entry, and its panel ends with Play again and Lobby', () => {
  const doc = makeDoc();
  const calls = [];
  const s = agScreens.createScreens({ doc, root: doc.body, lobby: true,
    onAgain: () => calls.push('again'), onLobby: () => calls.push('lobby'), onPlay: () => calls.push('play') });
  const all = ids(doc.body);
  for (const gone of ['ag-name', 'ag-nick', 'ag-play', 'ag-spectate', 'ag-sound', 'ag-settings', 'statsContinue']) {
    assert.ok(!all.includes(gone), gone + ' is not on the lobby card');
  }
  assert.ok(all.includes('statsAgain') && all.includes('statsLobby'), 'Play again and Lobby are');
  assert.ok(doc.getElementById('ag-screens-lobby-css'), 'their stylesheet is added');
  assert.strictEqual(doc.getElementById('statsAgain').textContent, 'Play again');
  assert.strictEqual(doc.getElementById('statsLobby').textContent, 'Lobby');
  s.showHome();
  assert.strictEqual(s.menu.hidden, true, 'HOME is the card closed: there is nothing to show');
  doc.getElementById('statsAgain').dispatch('click');
  assert.deepStrictEqual(calls, [], 'Play again does nothing unless the panel is up');
  s.showStats({ foodEaten: 1, highestMass: 30, timeAlive: 5000, leaderTime: 0, cellsEaten: 0, topPosition: 0 });
  assert.strictEqual(s.menu.hidden, false);
  doc.getElementById('statsAgain').dispatch('click');
  assert.deepStrictEqual(calls, ['again']);
  assert.strictEqual(s.menu.hidden, true, 'the panel closes on Play again');
  doc.getElementById('statsLobby').dispatch('click');
  assert.deepStrictEqual(calls, ['again', 'lobby']);
  s.setNick('x'); s.setSettings({ dark: true });   // no name box or settings block: both are no-ops
});

test('agScreens: the card everywhere else is built exactly as before (parity DOM, no lobby stylesheet)', () => {
  const doc = makeDoc();
  agScreens.createScreens({ doc, root: doc.body, soundButton: LIB.agSound.createSound({ storage: null }).createToggleButton(doc) });
  assert.deepStrictEqual(ids(doc.body), ['ag-menu', 'ag-card', 'ag-name', 'ag-nick', 'ag-play', 'ag-spectate', 'ag-sound',
    'ag-settings', 'ag-stats', 'statsGraph', 'statsContinue']);
  assert.strictEqual(doc.getElementById('ag-screens-lobby-css'), null);
  assert.ok(!agScreens.SCREENS_CSS.includes('statsAgain'), 'the parity stylesheet carries none of it');
});

// ---- agMain in the lobby frame ---------------------------------------------------------------------------------

test('agMain lobby: no card at boot, Esc does nothing, death shows Play again and Lobby, Play again respawns at once', async () => {
  const posted = [];
  const p = bootPage({ cfg: { lobby: true }, parent: { postMessage: (m, o) => posted.push([m, o]) } });
  const menu = p.doc.getElementById('ag-menu');
  assert.strictEqual(menu.hidden, true, 'no menu card at boot');
  assert.strictEqual(p.doc.getElementById('ag-nick'), null);
  await spawn(p, p.session.feed);                 // session.play('me'), as agLobby does with the lobby name
  assert.strictEqual(p.session.state().menuState, 'PLAY');
  p.key('keydown', 27);
  p.key('keyup', 27);
  await p.frames(2);
  assert.strictEqual(p.session.state().menuState, 'PLAY', 'Esc opens nothing');
  assert.strictEqual(menu.hidden, true);
  p.session.feed({ t: 'world', eats: [], cells: [], removed: [9] });
  await p.frames(3);
  assert.strictEqual(p.session.state().menuState, 'GAMEOVER');
  assert.strictEqual(menu.hidden, false, 'the Match Results panel');
  assert.strictEqual(p.doc.getElementById('ag-stats').hidden, false);
  const before = p.sent.filter((s) => s[0] === 'play').length;
  p.doc.getElementById('statsAgain').dispatch('click');
  const plays = p.sent.filter((s) => s[0] === 'play');
  assert.strictEqual(plays.length, before + 1, 'Play again sends play at once (the world is ready)');
  assert.deepStrictEqual(plays[plays.length - 1][1], { name: 'me' }, 'under the same name');
  assert.strictEqual(p.session.state().menuState, 'PLAY');
  assert.strictEqual(menu.hidden, true);
  // Death again, then Lobby: the framed page's way back.
  p.session.feed({ t: 'own', id: 11 });
  p.session.feed({ t: 'world', eats: [], cells: [{ id: 11, x: 0, y: 0, size: 200, virus: false, food: false, ejected: false,
    agitated: false, flag40: false, party: false, rgb: [255, 7, 100] }], removed: [] });
  await p.frames(3);
  p.session.feed({ t: 'world', eats: [], cells: [], removed: [11] });
  await p.frames(3);
  assert.strictEqual(p.session.state().menuState, 'GAMEOVER');
  p.doc.getElementById('statsLobby').dispatch('click');
  assert.deepStrictEqual(posted, [['game:done', '*']]);
  p.session.destroy();
});

test('agMain lobby: a free cash-out ends on the same panel (Cashed Out) with the same two buttons', async () => {
  const p = bootPage({ cfg: { lobby: true }, parent: { postMessage() {} } });
  await spawn(p, p.session.feed);
  p.session.sideEvent('ag:cashedout', { free: true });
  p.session.feed({ t: 'world', eats: [], cells: [], removed: [9] });
  await p.frames(3);
  const stats = p.doc.getElementById('ag-stats');
  assert.strictEqual(stats.hidden, false);
  assert.ok(p.doc.getElementById('statsAgain') && p.doc.getElementById('statsLobby'));
  const title = stats.children[0].children[0].textContent;
  assert.strictEqual(title, agScreens.CASHED_OUT_TITLE);
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
  assert.strictEqual(p.doc.getElementById('ag-menu').hidden, true, 'no menu after the drop');
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

test('agMain lobby: a settings write from the lobby reaches the loaded page at once and is not written back', async () => {
  const storage = countingStore();
  const p = bootPage({ cfg: { lobby: true, persistSettings: true, storage }, parent: { postMessage() {} } });
  await spawn(p, p.session.feed);
  const W0 = [p.canvas.width, p.canvas.height];
  storage.setItem('agSettings', JSON.stringify({ quality: 'Low', names: false, colors: true, showMass: true, dark: true }));
  const writes = storage.writes;
  p.win.fire('storage', { key: 'agSettings' });
  assert.deepStrictEqual(p.session.settings(), { quality: 'Low', names: false, colors: true, showMass: true, dark: true });
  assert.deepStrictEqual([p.canvas.width, p.canvas.height], [W0[0] * 0.75, W0[1] * 0.75], 'the quality sized the canvas');
  assert.strictEqual(storage.writes, writes, 'nothing written back');
  // Sound: the game's own key, from the event's new value.
  assert.strictEqual(p.mod.sound.isEnabled(), false);
  p.win.fire('storage', { key: 'agSoundOn', newValue: '1' });
  assert.strictEqual(p.mod.sound.isEnabled(), true);
  p.win.fire('storage', { key: 'agSoundOn', newValue: '0' });
  assert.strictEqual(p.mod.sound.isEnabled(), false);
  p.win.fire('storage', { key: 'somethingElse', newValue: '1' });
  assert.deepStrictEqual(p.session.settings().quality, 'Low');
  p.session.destroy();
});

test('agMain everywhere else: the card at boot, Esc opens it, Continue on the panel, no storage listener', async () => {
  const storage = memStore();
  const p = bootPage({ cfg: { persistSettings: true, storage } });
  assert.strictEqual(p.doc.getElementById('ag-menu').hidden, false, 'the name entry at boot');
  await spawn(p, p.session.feed);
  p.key('keydown', 27);
  await p.frames(2);
  assert.strictEqual(p.session.state().menuState, 'HOME', 'Esc opens the menu');
  p.key('keyup', 27);
  storage.setItem('agSettings', JSON.stringify({ quality: 'Low', names: true, colors: true, showMass: false, dark: true }));
  p.win.fire('storage', { key: 'agSettings' });
  assert.strictEqual(p.session.settings().dark, false, 'a direct visit does not follow the storage live');
  assert.ok(p.doc.getElementById('statsContinue'));
  assert.strictEqual(p.doc.getElementById('statsAgain'), null);
  p.session.destroy();
});

test('agMain lobby with a paid hand-off: its own flow, unchanged (no menu, Esc shows its hint, the paid card)', async () => {
  const tab = memStore({ stake: '0.1', entryToken: 'tok_abcdef0123456789', playerName: 'Owen' });
  const p = bootPage({ net: true, cfg: { lobby: true, handoff: true, tabStorage: tab }, parent: { postMessage() {} } });
  assert.ok(p.session.state().handoff, 'the paid flow runs');
  assert.strictEqual(p.session.state().paid, true);
  assert.strictEqual(p.doc.getElementById('ag-menu').hidden, true);
  p.sock.connected = true;
  p.sock.fire('connect');
  p.session.sideEvent('ag:joined', { stake: 0.1, micro: 100000 });
  const st = p.session.state().menuState;
  p.key('keydown', 27);
  p.key('keyup', 27);
  assert.strictEqual(p.session.state().menuState, st, 'Esc goes to the paid flow, never a menu');
  assert.strictEqual(p.doc.getElementById('ag-menu').hidden, true);
  p.session.sideEvent('ag:dead', { lostMicro: 100000, by: 'bob' });
  const card = p.doc.getElementById('ag-paid-end');
  assert.ok(card && !card.hidden, 'the paid end card, not the Match Results panel');
  assert.strictEqual(p.doc.getElementById('ag-stats').hidden, true);
  p.session.destroy();
});

// ---- agLobby: the start and the Lobby button -------------------------------------------------------------------

const LOBBY_SRC = read('public/js/ag/agLobby.js');
function lobbyPage({ lobby = true, paid = false, handoff = null, spectateOnly = false, framed = true, coarse = false } = {}) {
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
  const page = {
    config: { lobby }, onServer() {}, paidLocked: () => false,
    state: () => ({ paid, handoff }),
    play: (n) => calls.push(['play', n]), spectate: () => calls.push(['spectate'])
  };
  const session = memStore(Object.assign({ playerName: 'OwenTheTopBoss77' }, spectateOnly ? { spectateOnly: 'true' } : {}));
  const win = {
    document: { readyState: 'complete', head: node('head'), body: node('body'), getElementById: (id) => els[id] || null,
      createElement: (t) => node(t), addEventListener() {} },
    sessionStorage: session, localStorage: memStore(),
    matchMedia: () => ({ matches: coarse, addEventListener() {} }),
    MutationObserver: class { constructor(fn) { observers.push(fn); } observe() {} },
    addEventListener() {}, setTimeout, clearTimeout, duelAgar: page
  };
  win.parent = framed ? { postMessage() {} } : win;
  win.window = win;
  vm.createContext(win);
  vm.runInContext(LOBBY_SRC, win, { filename: 'agLobby.js' });
  return { calls, els, menu, notify: () => observers.forEach((fn) => fn()) };
}

test('agLobby: the lobby frame\'s free room starts at once under the lobby name, or watching from the lobby\'s Spectate', () => {
  assert.deepStrictEqual(lobbyPage().calls, [['play', 'OwenTheTopBoss7']], 'the lobby name, cut to the 15 the game takes');
  assert.deepStrictEqual(lobbyPage({ spectateOnly: true }).calls, [['spectate']]);
  assert.deepStrictEqual(lobbyPage({ lobby: false }).calls, [], 'a direct visit waits on its menu');
  assert.deepStrictEqual(lobbyPage({ paid: true, handoff: { state: 'joining' } }).calls, [], 'a paid hand-off runs its own flow');
  assert.deepStrictEqual(lobbyPage({ framed: false }).calls, [], 'never outside a frame');
});

test('agLobby: in the lobby frame\'s free room the Lobby button is always there, except over the panel\'s own Lobby', () => {
  for (const coarse of [false, true]) {
    const h = lobbyPage({ coarse });
    const btn = h.els['ag-lobby'];
    assert.ok(btn.classList.contains('on'), 'shown while playing (coarse ' + coarse + ')');
    h.menu.hidden = false;      // the Match Results panel
    h.notify();
    assert.ok(!btn.classList.contains('on'), 'hidden over the panel');
    h.menu.hidden = true;
    h.notify();
    assert.ok(btn.classList.contains('on'));
  }
  const direct = lobbyPage({ lobby: false });
  assert.ok(!direct.els['ag-lobby'].classList.contains('on'), 'elsewhere: only with the menu open or on a touch screen');
});

// ---- the lobby's agar.io screen --------------------------------------------------------------------------------

function optsPage(local) {
  const els = {};
  function node(tag) {
    const n = { tagName: tag.toUpperCase(), id: '', className: '', textContent: '', value: '', children: [], attrs: {}, l: {},
      setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') { this.id = String(v); els[this.id] = this; } },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
      appendChild(c) { this.children.push(c); if (c.id) els[c.id] = c; return c; },
      addEventListener(t, fn) { (this.l[t] = this.l[t] || []).push(fn); },
      fire(t) { (this.l[t] || []).forEach((fn) => fn({})); } };
    return new Proxy(n, { set(t, k, v) { t[k] = v; if (k === 'id' && v) els[v] = t; return true; } });
  }
  const box = node('div'); box.id = 'agtg';
  const winOn = {};
  const win = {
    localStorage: local,
    document: { readyState: 'complete', getElementById: (id) => els[id] || null, createElement: node,
      createTextNode: (t) => ({ textContent: t, children: [] }), addEventListener() {} },
    addEventListener(t, fn) { (winOn[t] = winOn[t] || []).push(fn); },
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(read('public/js/v2/agopts.js'), win, { filename: 'agopts.js' });
  const pills = () => box.children.filter((c) => c.getAttribute('data-opt'));
  return { win, box, els, pills, storage: (e) => (winOn.storage || []).forEach((fn) => fn(e)) };
}

test('lobby settings: the same options, labels, defaults and storage keys as the game\'s own card', () => {
  const o = JSON.parse(JSON.stringify(optsPage(memStore()).win.V2AgOpts));
  assert.deepStrictEqual(o.DEFAULTS, agScreens.SETTINGS_DEFAULTS);
  assert.deepStrictEqual(o.FLAGS, agScreens.SETTING_BOXES);
  assert.deepStrictEqual(o.QUALITY, agScreens.QUALITY_OPTIONS);
  assert.strictEqual(o.SETTINGS_KEY, LIB.agMain.SETTINGS_KEY);
  assert.strictEqual(o.SOUND_KEY, LIB.agSound.STORE_KEY);
  assert.deepStrictEqual([...LIB.agMain.SETTING_FLAGS], agScreens.SETTING_BOXES.map((b) => b[0]));
});

test('lobby settings: the pills show the defaults, a press writes the game\'s shape, and the game boots on it', () => {
  const local = memStore();
  const h = optsPage(local);
  const pills = h.pills();
  assert.deepStrictEqual(pills.map((b) => b.getAttribute('data-opt')), ['sound', 'names', 'colors', 'showMass', 'dark']);
  assert.deepStrictEqual(pills.map((b) => b.getAttribute('aria-pressed')), ['false', 'true', 'true', 'false', 'false'], 'defaults');
  assert.strictEqual(h.els.agqv.textContent, 'Retina');
  assert.strictEqual(local.getItem('agSettings'), null, 'nothing is written until something is pressed');
  pills[3].fire('click');       // Show mass on
  pills[4].fire('click');       // Dark theme on
  pills[0].fire('click');       // Sound on
  h.els.agq.value = 'VeryLow';
  h.els.agq.fire('change');
  assert.deepStrictEqual(JSON.parse(local.getItem('agSettings')),
    { quality: 'VeryLow', names: true, colors: true, showMass: true, dark: true }, 'agMain\'s storeSettings shape');
  assert.strictEqual(local.getItem('agSoundOn'), '1');
  assert.deepStrictEqual(h.pills().map((b) => b.getAttribute('aria-pressed')), ['true', 'true', 'true', 'true', 'true']);
  assert.strictEqual(h.els.agqv.textContent, 'Very low');
  // The game page boots on exactly these.
  const g = bootPage({ cfg: { lobby: true, persistSettings: true, storage: local } });
  assert.deepStrictEqual(g.session.settings(), { quality: 'VeryLow', names: true, colors: true, showMass: true, dark: true });
  assert.strictEqual(LIB.agSound.createSound({ storage: local, createAudioContext: () => null }).isEnabled(), true);
  g.session.destroy();
  // And follows a write made elsewhere (the game's own card on a direct visit).
  local.setItem('agSettings', JSON.stringify({ quality: 'High', names: false, colors: true, showMass: false, dark: false }));
  h.storage({ key: 'agSettings' });
  assert.deepStrictEqual(h.pills().map((b) => b.getAttribute('aria-pressed')), ['true', 'false', 'true', 'false', 'false']);
  assert.strictEqual(h.els.agqv.textContent, 'High');
  // A broken stored value is read as the defaults, the way agMain reads it.
  local.setItem('agSettings', '{not json');
  h.storage({ key: 'agSettings' });
  assert.strictEqual(h.els.agqv.textContent, 'Retina');
});

test('the lobby\'s agar.io screen: the settings block, Spectate on Free only beside Play, and the script', () => {
  const html = read('public/v2.html');
  assert.match(html, /<div class="gorow">\s*<button class="go" onclick="startFromDetail\(\)">Play<\/button>/, 'Play is the same button');
  assert.match(html, /<button type="button" class="spec" id="agspec" onclick="V2Play\.spectate\('agar'\)"/);
  assert.match(html, /<div class="agopts" role="group" aria-labelledby="agoptsl">\s*<div class="sl" id="agoptsl">Game settings<\/div>\s*<div class="agtg" id="agtg"><\/div>/);
  assert.match(html, /<script src="\/js\/v2\/play\.js"><\/script>\s*<script src="\/js\/v2\/agopts\.js"><\/script>/);
  assert.match(html, /det\.classList\.toggle\('agar',cur\.id==='agar'\);/, 'only the agar.io screen shows them');
  assert.match(html, /function drawStake\(\)\{\s*\/\*[^*]*\*\/\s*document\.getElementById\('detail'\)\.classList\.toggle\('agfree',STEPS\[si\]===0\);/,
    'Spectate follows the chosen rung');
  assert.match(html, /\.agopts\{display:none\}\s*#detail\.agar \.agopts\{display:block\}/);
  assert.match(html, /\.spec\{display:none;/);
  assert.match(html, /#detail\.agar\.agfree \.spec\{display:flex\}/);
  // The lobby's own pills: the buy-in row's surface, radius and selected colours.
  assert.match(html, /\.agt\{[^}]*background:var\(--s2\);border-radius:var\(--r2\);/);
  assert.match(html, /\.agt\[aria-pressed="true"\]\{background:var\(--bone\);color:var\(--ink\)\}/);
});

test('the lobby\'s Spectate opens /ag in the agar frame with the watch flag the page reads', () => {
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, style: { display: '' }, src: '', value: '', classList: { add() {}, remove() {} } });
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
