'use strict';
// Pac-Man (Chomp) in the lobby's frame, its link lost mid-game (bug sweep 2026-10-31): the free chomper goes with its
// socket, and the page used to fall back to its title card, which has only Play and no way back to the lobby (the lobby
// never shows that card), so a phone player whose connection dropped, or who was playing through a server restart,
// was stuck there. The page now shows the end card with Lobby and Play again. A direct visit keeps its title card.
// Runs public/js/chomp/chompMain.js in a vm with a fake page and a fake socket.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '../public/js/chomp/chompMain.js'), 'utf8');

function element(id) {
  const listeners = {};
  return {
    id, hidden: false, value: '', style: {}, textContent: '',
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    querySelector() { return null; },
    setAttribute() {}, appendChild() {},
    getContext() { return new Proxy({}, { get: () => () => {} }); },
    classList: { add() {}, remove() {}, toggle() {} },
    fire(t, e) { (listeners[t] || []).forEach((fn) => fn(e || {})); },
  };
}

function boot({ inLobby }) {
  const els = { cv: element('cv'), title: element('title'), name: element('name'), play: element('play'), toast: element('toast') };
  const handlers = {};
  const emitted = [];
  const socket = {
    connected: true,
    on(ev, fn) { handlers[ev] = fn; },
    emit(ev, p) { emitted.push([ev, p]); },
  };
  const shown = [];
  const posted = [];
  const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  const win = {
    ChompRules: { TICK_HZ: 60, LIVES: 1 },
    ChompMaze: {}, ChompMove: {}, ChompWire: { AWAY: 5, F: {} }, ChompDraw: function () {}, ChompSound: { play() {}, eat() {} },
    DSEnd: { show(o) { shown.push(o); return { button() { return null; } }; }, hide() {}, board() { return { set() {} }; } },
    frameElement: inLobby ? { id: 'game-frame' } : null,
    io: () => socket,
    innerWidth: 400, innerHeight: 800, devicePixelRatio: 1,
    matchMedia: () => ({ matches: true }),
    localStorage: store(), sessionStorage: store(),
    addEventListener() {},
    location: { search: '', origin: 'http://x', href: 'http://x/chomp' },
  };
  win.parent = inLobby ? { postMessage: (m) => posted.push(m) } : win;
  const document = {
    title: '', documentElement: { classList: { remove() {} } },
    getElementById: (id) => els[id] || element(id),
    createElement: (t) => element(t), body: element('body'),
  };
  const ctx = vm.createContext(Object.assign(win, {
    window: win, document, URLSearchParams, performance: { now: () => 0 }, console,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, requestAnimationFrame() {},
  }));
  vm.runInContext(SRC, ctx);
  return { els, handlers, emitted, shown, posted, state: () => win.ChompPage.state() };
}

test('in the lobby frame a lost link mid-game shows the end card with Lobby and Play again, not the title card', () => {
  const p = boot({ inLobby: true });
  p.els.title.hidden = true;
  p.handlers['c:you']({ id: 7, metas: [] });
  assert.strictEqual(p.state().phase, 'play');
  p.handlers.disconnect('transport close');
  assert.strictEqual(p.els.title.hidden, true, 'the title card (Play only) stays hidden');
  assert.strictEqual(p.state().phase, 'over');
  assert.strictEqual(p.shown.length, 1);
  const card = p.shown[0];
  assert.strictEqual(card.verdict, 'Disconnected');
  assert.strictEqual(JSON.stringify(card.buttons.map((b) => b.id)), '["lobby","again"]');
  // Lobby goes back to the lobby
  card.buttons[0].onClick();
  assert.deepStrictEqual(p.posted, ['game:done']);
  // Play again asks the free arena for a new seat (socket.io holds it until the link is back)
  card.buttons[1].onClick();
  assert.strictEqual(p.emitted.filter((e) => e[0] === 'c:join').length, 1);
  // the reconnect's c:init does not put the title card back
  p.handlers['c:you']({ id: 8, metas: [] });
  assert.strictEqual(p.state().phase, 'play');
});

test('a direct visit keeps its title card (its menu) after a lost link', () => {
  const p = boot({ inLobby: false });
  p.els.title.hidden = true;
  p.handlers['c:you']({ id: 7, metas: [] });
  p.handlers.disconnect('transport close');
  assert.strictEqual(p.els.title.hidden, false);
  assert.strictEqual(p.state().phase, 'title');
  assert.strictEqual(p.shown.length, 0);
});

test('a lost link while not playing changes nothing', () => {
  const p = boot({ inLobby: true });
  p.handlers.disconnect('transport close');
  assert.strictEqual(p.shown.length, 0);
});
