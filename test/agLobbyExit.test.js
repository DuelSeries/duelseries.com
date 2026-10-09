'use strict';
/* The exit trap (PAID-AGAR-DESIGN.md 4 step 7 and 6; gameplay-ops review BLOCKER "exit trap").

   public/js/ag/agLobby.js puts a Lobby button on the agar.io page inside the lobby's frame. It posts
   'game:done', the lobby blanks the frame (public/js/v2/play.js), and the socket goes with it. With a
   paid account open that walks the player out with money in the room: the account sits frozen and
   edible for 3 minutes before its automatic cash-out (Owen Q5). So from the server's ag:joined with a
   stake until it says the account closed (ag:cashedout, ag:dead, ag:closed), the button is hidden and
   refuses a click, the menu shows how to leave instead, and closing the tab asks first. The free room
   never sends ag:joined with a stake, so it never locks.

   A small fake page (the shape of test/agarSwap.test.js's, which keeps its own copy), plus one run
   against the real page session from public/js/ag/agMain.js (test/agFakePage.js), so the hooks are the
   ones agMain actually calls. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const LOBBY_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ag/agLobby.js'), 'utf8');

// page: what root.duelAgar is (null for a page without one); framed: inside the lobby's frame.
function fakePage({ framed = true, coarse = false, page } = {}) {
  const els = {};
  const posted = [];
  function node(tag) {
    return {
      tagName: tag.toUpperCase(), id: '', type: '', value: '', hidden: false, textContent: '', innerHTML: '',
      children: [], attrs: {}, listeners: {},
      classList: {
        set: new Set(),
        toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); },
        contains(c) { return this.set.has(c); },
        add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); },
      },
      setAttribute(k, v) { this.attrs[k] = v; },
      appendChild(c) { this.children.push(c); if (c.id) els[c.id] = c; return c; },
      addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
      click() { (this.listeners.click || []).forEach((fn) => fn({ preventDefault() {} })); },
    };
  }
  const menu = node('div'); menu.id = 'ag-menu'; els['ag-menu'] = menu;
  const box = node('input'); box.id = 'ag-nick'; els['ag-nick'] = box;
  const observers = [];
  const winOn = {};
  const doc = {
    readyState: 'complete',
    head: node('head'), body: node('body'),
    getElementById: (id) => els[id] || null,
    createElement: (t) => node(t),
    addEventListener() {},
  };
  const store = { getItem: () => null };
  const hooks = {};
  const fake = { onServer(name, fn) { (hooks[name] = hooks[name] || []).push(fn); } };
  const win = {
    document: doc,
    sessionStorage: store, localStorage: store,
    matchMedia: () => ({ matches: coarse, addEventListener() {} }),
    MutationObserver: class { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} },
    addEventListener(t, fn) { (winOn[t] = winOn[t] || []).push(fn); },
  };
  if (page !== null) win.duelAgar = page || fake;
  win.parent = framed ? { postMessage: (m, o) => posted.push([m, o]) } : win;
  win.window = win;
  vm.createContext(win);
  vm.runInContext(LOBBY_SRC, win, { filename: 'agLobby.js' });
  const notify = () => observers.forEach((o) => o.fn());
  // The browser's beforeunload: what a handler did to the event decides whether it asks.
  function unload() {
    const ev = { prevented: false, preventDefault() { this.prevented = true; } };
    const rets = (winOn.beforeunload || []).map((fn) => fn(ev));
    return { asks: ev.prevented || ev.returnValue !== undefined || rets.some((r) => r !== undefined), ev };
  }
  return {
    win, els, posted, menu, notify, unload,
    server: (name, p) => (hooks[name] || []).forEach((fn) => fn(p)),
    btn: () => els['ag-lobby'],
    hint: () => els['ag-lobby-hint'],
    shown: (el) => !!el && el.classList.contains('on'),
  };
}

test('with money in the room the Lobby button is gone, a click does nothing, and closing the tab asks first', () => {
  const p = fakePage();
  assert.ok(p.shown(p.btn()), 'the Lobby button is up on the menu before anything is staked');
  assert.strictEqual(p.unload().asks, false, 'and leaving asks nothing');

  // ag:joined with no stake (or 0) is not money: nothing changes.
  p.server('ag:joined', { tickMs: 40 });
  p.server('ag:joined', { stake: 0 });
  assert.ok(p.shown(p.btn()), 'a joined with no stake changes nothing');

  // The paid door seated this page: a paid account is open.
  p.server('ag:joined', { stake: 0.1, micro: 100000, resumeKey: 'k1' });
  assert.ok(!p.shown(p.btn()), 'the button is hidden on the menu');
  assert.ok(p.shown(p.hint()), 'and the hint is in its place');
  assert.strictEqual(p.hint().textContent, 'Hold Q to cash out', 'saying how to leave');
  p.btn().click();
  assert.deepStrictEqual(p.posted, [], 'a click on the hidden button posts nothing');
  const u = p.unload();
  assert.ok(u.asks, 'closing or reloading the tab asks first');
  assert.ok(u.ev.prevented && u.ev.returnValue === '', 'by the standard beforeunload contract');

  // Playing (menu shut): neither the button nor the hint.
  p.menu.hidden = true; p.notify();
  assert.ok(!p.shown(p.btn()) && !p.shown(p.hint()), 'nothing over the running game');
  p.menu.hidden = false; p.notify();

  // A free result never closes a paid account.
  p.server('ag:cashedout', { free: true });
  assert.ok(!p.shown(p.btn()), 'still hidden after a stray free result');

  // The server closed the account (the hold-Q cash-out): the way back is open again.
  p.server('ag:cashedout', { grossMicro: 200000, cutMicro: 20000, netMicro: 180000 });
  assert.ok(p.shown(p.btn()) && !p.shown(p.hint()), 'the button is back, the hint gone');
  assert.strictEqual(p.unload().asks, false, 'leaving asks nothing');
  p.btn().click();
  assert.deepStrictEqual(p.posted, [['game:done', '*']], 'and a click goes back to the lobby');
});

test('death, a closed room and a resumed receipt each end the lock; a touch screen gets its own hint', () => {
  for (const [ev, payload] of [['ag:dead', { lostMicro: 100000, by: 'bob' }], ['ag:closed', { why: 'shutdown' }],
    ['ag:cashedout', { grossMicro: 1, cutMicro: 0, netMicro: 1, resumed: true }]]) {
    const p = fakePage();
    p.server('ag:joined', { stake: 1 });
    assert.ok(!p.shown(p.btn()), ev + ': locked while open');
    p.server(ev, payload);
    assert.ok(p.shown(p.btn()), ev + ': the button is back');
    assert.strictEqual(p.unload().asks, false, ev + ': leaving asks nothing');
  }

  // A phone shows the button all the time (no Esc key), so the lock matters there most.
  const t = fakePage({ coarse: true });
  t.menu.hidden = true; t.notify();
  assert.ok(t.shown(t.btn()), 'touch, free: the button stays up during play');
  t.server('ag:joined', { stake: 0.1 });
  assert.ok(!t.shown(t.btn()), 'touch, paid: gone during play');
  assert.ok(!t.shown(t.hint()), 'and no hint over the game (the pad has the Cash out button)');
  t.menu.hidden = false; t.notify();
  assert.strictEqual(t.hint().textContent, 'Hold Cash out to leave', 'the menu names the phone\'s own control');
});

test('opened on its own the page has no button, but leaving with money in the room still asks; no page, no lock', () => {
  const p = fakePage({ framed: false });
  assert.strictEqual(p.btn(), undefined, 'there is no lobby to go back to');
  p.server('ag:joined', { stake: 0.1 });
  assert.ok(p.unload().asks, 'closing the tab asks first');
  p.server('ag:dead', {});
  assert.strictEqual(p.unload().asks, false);

  // A page with no agar session (agMain not booted) keeps the plain button and installs nothing.
  const bare = fakePage({ page: null });
  assert.ok(bare.shown(bare.btn()));
  assert.strictEqual(bare.unload().asks, false);
});

test('the real page session drives the lock: agMain\'s onServer hooks run after its own handling', async () => {
  const { bootPage } = require('./agFakePage.js');
  const real = bootPage({ parent: { postMessage() {} } });
  const p = fakePage({ page: real.session });
  assert.ok(p.shown(p.btn()));
  real.session.sideEvent('ag:joined', { stake: 0.1, micro: 100000 });
  assert.strictEqual(real.session.state().paid, true, 'agMain took the seat as paid');
  assert.ok(!p.shown(p.btn()) && p.unload().asks, 'and the lobby hook locked the way out');
  real.session.sideEvent('ag:cashedout', { grossMicro: 100000, cutMicro: 10000, netMicro: 90000 });
  assert.strictEqual(real.session.state().paidEnd, 'cashed', 'agMain showed the receipt');
  assert.ok(p.shown(p.btn()) && !p.unload().asks, 'and the lock is off');
  real.session.destroy();
});

test('the free page never locks: its own events leave the button and the tab alone', () => {
  const p = fakePage();
  for (const [ev, payload] of [['ag:holding', { on: 1, need: 75 }], ['ag:holding', { on: 0 }],
    ['ag:cashedout', { free: true }], ['ag:joined', { tickMs: 40, holdTicks: 75 }]]) {
    p.server(ev, payload);
    assert.ok(p.shown(p.btn()), ev + ' leaves the button');
    assert.strictEqual(p.unload().asks, false, ev + ' leaves the tab');
  }
});
