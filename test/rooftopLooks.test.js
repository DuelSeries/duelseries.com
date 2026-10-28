'use strict';
/* ROOFTOP SNIPERS' FREE LOOKS (Owen 2026-10-28): three of the game's own snipers, picked in the lobby's Customize
   the way Pac-Man's free colours were, and worn every round instead of the round's random sniper.
     · the list (shared/rtLooks.js) names snipers the game actually draws (public/js/rooftop/rtArt.js CAST)
     · the server keeps only a listed id, never anything else a page sends, and carries it per seat in players[]
       to both players and every watcher; the bot and a seat without one stay random
     · the lobby's chooser shows exactly that list after Random, and its previews draw from the game's own art
     · the page sends the stored id in rt:queue
   And the sound switch: one mute for the music and the effects, remembered on the device. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const rtLooks = require('../shared/rtLooks');
const { RooftopLobby } = require('../server/RooftopLobby');
const { RooftopRoom } = require('../server/RooftopRoom');
const { FREE_WAIT_MS } = require('../server/duelQueue');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const io = { to: () => ({ emit: () => {}, volatile: { emit: () => {} } }) };
/* A socket as index.js leaves it after rt:queue: socket._rtLook = rtLooks.pick(look). */
function sock(id, look) {
  return { id, _rtLook: rtLooks.pick(look), join() {}, leave() {}, emit() {} };
}
const seatLooks = (players) => {
  const out = [null, null];
  for (const p of players) out[p.side] = p.look;
  return out;
};

test('three looks, each one of the snipers the game draws, under the lobby key', () => {
  assert.deepStrictEqual(rtLooks.LOOKS.map((l) => l.id), ['builder', 'chef', 'astronaut']);
  assert.deepStrictEqual(rtLooks.LOOKS.map((l) => l.name), ['Builder', 'Chef', 'Astronaut']);
  assert.strictEqual(rtLooks.KEY, 'duel.rooftop.look');
  const cast = [...read('public/js/rooftop/rtArt.js').matchAll(/\{ name: '(\w+)'/g)].map((m) => m[1]);
  assert.strictEqual(cast.length, 8, 'the eight snipers');
  for (const l of rtLooks.LOOKS) assert.ok(cast.includes(l.id), l.id + ' is a sniper rtArt draws');
  assert.ok(Object.isFrozen(rtLooks.LOOKS) && rtLooks.LOOKS.every(Object.isFrozen), 'nobody can add to the list at run time');
});

test('only a listed id is kept; anything else a page sends is the random look', () => {
  for (const id of ['builder', 'chef', 'astronaut']) assert.strictEqual(rtLooks.pick(id), id);
  for (const junk of ['robot', 'farmer', 'Builder', ' chef', '__proto__', 'constructor', 'toString', '', '<b>', 7, null,
    undefined, {}, ['chef'], { toString: () => 'chef' }]) {
    assert.strictEqual(rtLooks.pick(junk), null, JSON.stringify(String(junk)));
  }
  // index.js keeps exactly that on the socket, before a seat is taken or a wait resumed
  const src = read('server/index.js');
  const at = src.indexOf("on('rt:queue'");
  const body = src.slice(at, src.indexOf("on('rt:unqueue'", at));
  assert.match(body, /\{[^}]*\blook\b[^}]*\} = \{\}\) =>/, 'the handler reads look');
  assert.match(body, /socket\._rtLook = rtLooks\.pick\(look\);/, 'and keeps only a listed id');
  assert.ok(body.indexOf('socket._rtLook') < body.indexOf('rooftopLobby.resume('), 'before a resumed wait takes its seat');
});

test('the room carries each seat\'s look in players[] to both screens and to watchers', () => {
  const lob = new RooftopLobby(io);
  lob.enqueue(sock('A', 'chef'), 'Ann', null, 0, 0, 0);
  lob.enqueue(sock('B', 'nope'), 'Bob', null, 0, 0, 0);
  const room = lob.roomOf('A');
  assert.ok(room && room === lob.roomOf('B'), 'matched');
  const ps = room.publicState(0);
  const a = ps.players.find((p) => p.name === 'Ann'), b = ps.players.find((p) => p.name === 'Bob');
  assert.strictEqual(a.look, 'chef');
  assert.strictEqual(b.look, null, 'an unlisted id is never worn');
  const ws = room.watchState(ps);
  assert.deepStrictEqual(seatLooks(ws.players), seatLooks(ps.players), 'watchers are told the same');
  assert.deepStrictEqual(room.forWatchers('rt:start', ps).players.map((p) => p.look), ws.players.map((p) => p.look));
});

test('the room checks the id again itself, and a look changes nothing about the match or its money', () => {
  const room = new RooftopRoom(io);
  room.addPlayer({ id: 'X', _rtLook: '<script>', join() {}, emit() {} }, 'X', 'WX', 0.5, 0.5);
  room.addPlayer({ id: 'Y', _rtLook: 'astronaut', join() {}, emit() {} }, 'Y', 'WY', 0.5, 0.5);
  assert.deepStrictEqual(seatLooks(room.publicState(0).players), [null, 'astronaut']);
  const plain = new RooftopRoom(io);
  plain.addPlayer({ id: 'X', join() {}, emit() {} }, 'X', 'WX', 0.5, 0.5);
  plain.addPlayer({ id: 'Y', join() {}, emit() {} }, 'Y', 'WY', 0.5, 0.5);
  assert.strictEqual(room.pot(), plain.pot(), 'the same pot');
  assert.deepStrictEqual([...room.worth.values()], [...plain.worth.values()], 'the same worth per seat');
  assert.deepStrictEqual(JSON.stringify(room.match), JSON.stringify(plain.match), 'the same roof, bodies and hitboxes');
  // no money or rule code reads it
  for (const f of ['server/KnockoutRoom.js', 'server/KnockoutLobby.js', 'shared/rtSim.js', 'server/rtBot.js']) {
    assert.ok(!/_rtLook|\.look\b|rtLooks/.test(read(f)), f + ' never reads the look');
  }
});

test('the bot stays random; a person rescued from a bot match keeps their look', () => {
  const lob = new RooftopLobby(io);
  const t0 = 3e6;
  lob.enqueue(sock('A', 'builder'), 'Ann', null, 0, 0, t0);
  lob.tick(t0 + FREE_WAIT_MS + 1);
  const botRoom = lob.roomOf('A');
  assert.ok(botRoom && botRoom.bot, 'a bot match');
  assert.deepStrictEqual(botRoom.publicState(t0).players.map((p) => p.look).sort(), ['builder', null].sort());
  lob.enqueue(sock('B', 'astronaut'), 'Bob', null, 0, 0, t0 + FREE_WAIT_MS + 2);
  const room = lob.roomOf('A');
  assert.ok(room && room !== botRoom && room === lob.roomOf('B') && !room.bot, 'paired with the person instead');
  const ps = room.publicState(t0);
  assert.strictEqual(ps.players.find((p) => p.name === 'Ann').look, 'builder');
  assert.strictEqual(ps.players.find((p) => p.name === 'Bob').look, 'astronaut');
});

/* lookList run for real, the way test/customizeBar.test.js runs it, with the scripts the lobby loads. */
function lookListFor(id) {
  globalThis.DS_SHOP_PRICES = require('../shared/shopPrices.js');
  globalThis.DS_AG_SKINS = require('../shared/agSkins.js');
  globalThis.DS_SHOP_SKINS = require('../shared/shopSkins.js');
  globalThis.DS_RT_LOOKS = rtLooks;
  require('../public/js/v2/shopArt.js');
  const html = read('public/v2.html');
  const src = html.slice(html.indexOf('const AGS=window.DS_AG_SKINS;'), html.indexOf('let LK=[];'));
  const fn = new Function('window', 'localStorage', 'LOOKS', 'V2Shop', 'skin', 'storeSkin',
    src.replace(/^const /gm, 'var ') + '\nreturn [lookList, SAVED];');
  const store = new Map();
  const ls = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const [lookList, SAVED] = fn(globalThis, ls, [], globalThis.V2Shop, () => null, () => {});
  return { list: lookList({ id, look: 0 }), SAVED, store };
}

test('the lobby\'s chooser lists Random, then exactly the three looks, and Save stores the id the page sends', () => {
  const { list, SAVED, store } = lookListFor('rooftop');
  assert.deepStrictEqual(list.map((s) => s.id), ['default', 'rt:builder', 'rt:chef', 'rt:astronaut']);
  assert.deepStrictEqual(list.map((s) => s.name), ['Random', 'Builder', 'Chef', 'Astronaut']);
  assert.ok(list.every((s) => !s.locked && !s.price), 'all free, nothing locked or priced');
  SAVED.rooftop.put(list[2]);
  assert.strictEqual(store.get('duel.rooftop.look'), 'chef');
  assert.strictEqual(SAVED.rooftop.worn().id, 'rt:chef');
  SAVED.rooftop.put(null);
  assert.ok(!store.has('duel.rooftop.look'), 'Random stores nothing');
  assert.strictEqual(SAVED.rooftop.worn(), null);

  const html = read('public/v2.html');
  const tag = (s) => html.indexOf('<script src="' + s + '"></script>');
  assert.ok(tag('/shared/rtLooks.js') > 0 && tag('/js/rooftop/rtArt.js') > 0, 'the lobby loads the list and the painter');
  assert.ok(tag('/shared/rtLooks.js') < tag('/js/v2/shopArt.js') && tag('/js/rooftop/rtArt.js') < tag('/js/v2/shopArt.js'));
  assert.match(html, /const hasLook=[^\n]*g\.id==='rooftop'&&RT_LOOKS\.length/, 'Customize opens for Rooftop');
});

test('the previews draw every look, and Random, from the game\'s own sniper art', () => {
  const ctxCalls = [];
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...a) => { ctxCalls.push(k); }), set: (t, k, v) => { t[k] = v; return true; } });
  const canvas = (w, h) => ({ width: w || 0, height: h || 0, getContext: () => ctx });
  const box = { console, Math, JSON, document: { createElement: () => canvas() } };
  box.window = box; box.globalThis = box;
  vm.createContext(box);
  for (const f of ['shared/shopPrices.js', 'shared/shopSkins.js', 'public/js/battleshipArt.js', 'public/js/rooftop/rtArt.js', 'public/js/v2/shopArt.js']) {
    vm.runInContext(read(f), box, { filename: f });
  }
  assert.deepStrictEqual(Array.from(box.RTArt.NAMES).length, 8);
  for (const l of rtLooks.LOOKS) {
    const img = box.RTArt.pose(l.id, 0);
    assert.ok(img && img.width === 60 && img.height === 150, l.id + ' poses');
    assert.strictEqual(box.RTArt.pose(l.id, 0), img, 'cached');
  }
  assert.strictEqual(box.RTArt.pose('nobody', 0), null);
  for (const look of ['builder', 'chef', 'astronaut', '']) {
    ctxCalls.length = 0;
    box.V2Shop.paintWith(canvas(300, 112), 'rooftop', { look }, 2.5, false, true);
    box.V2Shop.paintWith(canvas(420, 208), 'rooftop', { look }, 2.5, false, true);
    assert.ok(ctxCalls.includes('drawImage'), (look || 'Random') + ' is drawn');
  }
});

test('the page sends the stored look in rt:queue and draws each seat\'s look from players[]', () => {
  const js = read('public/js/rooftop.js');
  assert.match(js, /L\.byId\(id\)\) return \{ look: id \}/, 'only an id on the list');
  assert.match(js, /socket\.emit\('rt:queue', Object\.assign\(\{[\s\S]{0,200}\}, shopFields\(\), lookField\(\)\)\)/);
  assert.match(js, /art\.setLooks\(looks\)/, 'every screen draws the seat\'s look');
  const html = read('public/rooftop.html');
  assert.ok(html.indexOf('<script src="/shared/rtLooks.js"></script>') > 0 &&
    html.indexOf('<script src="/shared/rtLooks.js"></script>') < html.indexOf('<script src="/js/rooftop.js"></script>'));
});

test('one switch mutes the music and the effects, remembered on this device', () => {
  const store = new Map();
  let level = null;
  const box = {
    console, Math, JSON, performance: { now: () => 0 }, setTimeout: () => 0,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    DSSfx: { setLevel: (fn) => { level = fn; }, define() {}, play() { return true; }, rng: () => () => 0.5, context: () => null, output: () => null },
  };
  box.window = box;
  vm.createContext(box);
  vm.runInContext(read('public/js/rooftopSound.js'), box);
  const S = box.RooftopSound;
  assert.strictEqual(S.muted(), false);
  assert.strictEqual(level(), 1);
  assert.strictEqual(S.toggle(), true);
  assert.strictEqual(level(), 0, 'the effects go quiet');
  assert.strictEqual(store.get('duel.rooftop.muted'), '1');
  S.music(true); S.music(false);                  // no audio context here: asking for music never throws
  // a new page on the same device starts muted
  vm.runInContext(read('public/js/rooftopSound.js'), box);
  assert.strictEqual(box.RooftopSound.muted(), true);
  const js = read('public/js/rooftop.js');
  assert.match(js, /e\.code === 'KeyM'[^\n]*toggleSound\(\)/, 'M toggles it');
  assert.match(js, /onSound\(e\.clientX, e\.clientY\)\) \{ e\.preventDefault\(\); toggleSound\(\)/, 'and so does the corner button');
});
