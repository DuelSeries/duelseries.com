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

// page: what root.duelAgar is (null for a page without one); framed: inside the lobby's frame; config: the fake
// page's boot config (agMain's session.config), where agLobby gates the paid end card's Back to lobby.
function fakePage({ framed = true, coarse = false, page, config } = {}) {
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
  const fake = { onServer(name, fn) { (hooks[name] = hooks[name] || []).push(fn); }, config: config || {} };
  // Virtual timers: advance(ms) runs what falls due.
  let clock = 0;
  let timers = [];
  let nextId = 1;
  const win = {
    setTimeout(fn, ms) { const id = nextId++; timers.push({ id, at: clock + (ms || 0), fn }); return id; },
    clearTimeout(id) { timers = timers.filter((t) => t.id !== id); },
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
  function advance(ms) {
    clock += ms;
    for (let guard = 0; guard < 100; guard++) {
      const due = timers.filter((t) => t.at <= clock);
      if (!due.length) return;
      timers = timers.filter((t) => t.at > clock);
      due.forEach((t) => t.fn());
    }
  }
  return {
    win, els, posted, menu, notify, unload, advance, pending: () => timers.length,
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

/* Review fixes (lobby-rungs review, BLOCKER): the lock follows the seat, not only the three closing events. A seat
   released before ag:ready (agMoney release, join-timeout and the rest) is refunded and closed, and the server says
   so with ag:refused { closed: true } (server/ag/agRoom.js _paidClosed); another tab taking the account over leaves
   this one with ag:replaced (agRoom resumePaid). A refusal that leaves the account open ('cash-out-to-leave', a
   refused second join) carries no closed flag and keeps the lock, and so does ag:refunded (reattach: the old account
   is still open, on this socket). */
test('a seat released before ready, or taken over by another tab, ends the lock; a refusal that leaves it open does not', () => {
  const p = fakePage();
  p.server('ag:joined', { stake: 0.1, micro: 100000, resumeKey: 'k1', confirmed: false });
  for (const r of [{ why: 'cash-out-to-leave' }, { why: 'seat-failed', text: 'x', refunded: true },
    { why: 'slow-down', retry: true }, { why: 'join-timeout', refunded: true }]) {
    p.server('ag:refused', r);
    assert.ok(!p.shown(p.btn()) && p.unload().asks, r.why + ' without closed: still locked');
  }
  p.server('ag:refunded', { why: 'reattach' });
  assert.ok(!p.shown(p.btn()), 'a reattach refund keeps the lock (the account is still open here)');
  p.server('ag:refused', { why: 'join-timeout', refunded: true, closed: true });
  assert.ok(p.shown(p.btn()) && !p.shown(p.hint()), 'released and refunded: the button is back, the hint gone');
  assert.strictEqual(p.unload().asks, false, 'and leaving asks nothing');
  p.btn().click();
  assert.deepStrictEqual(p.posted, [['game:done', '*']], 'a click goes back to the lobby');

  const q = fakePage({ coarse: true });
  q.server('ag:joined', { stake: 1 });
  assert.strictEqual(q.hint().textContent, 'Hold Cash out to leave');
  q.server('ag:replaced', {});
  assert.ok(q.shown(q.btn()) && !q.shown(q.hint()) && !q.unload().asks, 'replaced: this tab holds nothing now');
  q.server('ag:joined', { stake: 1, resumed: true });
  assert.ok(!q.shown(q.btn()), 'taking it back locks again');
});

/* A dropped socket: the seat is the server's dropped seat (5 s grace, then frozen; Owen Q5 auto cash-out, or a
   restart's refund, Owen Q6). The page lets go DROP_MS (DISCONNECT_GRACE_MS, 5000) after the drop unless it took the
   seat back (ag:joined with a stake), so a blip that resumes never shows the button and a crash never locks it. */
test('a dropped socket lets go after the server grace unless the page takes its seat back first', () => {
  const p = fakePage();
  p.server('disconnect', { reason: 'transport close' });
  assert.strictEqual(p.pending(), 0, 'no money in: a drop starts nothing');

  p.server('ag:joined', { stake: 0.1 });
  p.server('disconnect', { reason: 'transport close' });
  p.server('disconnect', { reason: 'transport close' });
  assert.strictEqual(p.pending(), 1, 'one wait per drop');
  p.advance(4999);
  assert.ok(!p.shown(p.btn()) && p.unload().asks, 'inside the grace: still locked');
  p.server('ag:joined', { stake: 0.1, resumed: true });
  assert.strictEqual(p.pending(), 0, 'the seat taken back cancels the wait');
  p.advance(60000);
  assert.ok(!p.shown(p.btn()) && p.unload().asks, 'and the page stays locked on its seat');

  p.server('disconnect', { reason: 'ping timeout' });
  p.advance(5000);
  assert.ok(p.shown(p.btn()) && !p.unload().asks, 'not taken back in 5 s: the page lets go');

  // The server said it closed during the wait (a planned restart's refund, ag:closed): at once, nothing left over.
  const r = fakePage();
  r.server('ag:joined', { stake: 1 });
  r.server('disconnect', {});
  r.server('ag:closed', { why: 'shutdown', refundedMicro: 1000000 });
  assert.ok(r.shown(r.btn()) && r.pending() === 0, 'closed: unlocked, no wait left');
  r.server('ag:joined', { stake: 1 });
  r.advance(60000);
  assert.ok(!r.shown(r.btn()), 'a stale wait never unlocks a later seat');
});

test('the paid end card\'s Back to lobby goes through the same gate, framed only', () => {
  const p = fakePage();
  const cfg = p.win.duelAgar.config;
  assert.strictEqual(typeof cfg.onLobby, 'function', 'framed: agLobby owns the card\'s way back');
  cfg.onLobby();
  assert.deepStrictEqual(p.posted, [['game:done', '*']], 'no money in: back to the lobby');
  p.server('ag:joined', { stake: 0.1 });
  cfg.onLobby();
  assert.strictEqual(p.posted.length, 1, 'money in: refused');
  p.server('ag:dead', { lostMicro: 100000 });
  cfg.onLobby();
  assert.strictEqual(p.posted.length, 2, 'after the death: allowed');

  // A handler the page already had (a hand-off's) is kept and gated.
  let own = 0;
  const h = fakePage({ config: { onLobby: () => { own++; } } });
  h.server('ag:joined', { stake: 1 });
  h.win.duelAgar.config.onLobby();
  assert.strictEqual(own, 0, 'gated while money is in');
  h.server('ag:cashedout', { grossMicro: 1, cutMicro: 0, netMicro: 1 });
  h.win.duelAgar.config.onLobby();
  assert.deepStrictEqual([own, h.posted.length], [1, 0], 'then the page\'s own handler runs, not a second post');

  const solo = fakePage({ framed: false });
  assert.strictEqual(solo.win.duelAgar.config.onLobby, undefined, 'unframed: agMain keeps its own close-the-card');
});

test('the real page: the last run\'s card goes on a new paid seat, its button is gated, and a socket drop reaches the hooks', async () => {
  const { bootPage } = require('./agFakePage.js');
  const real = bootPage({ net: true, parent: { postMessage() {} } });
  const p = fakePage({ page: real.session });
  real.sock.connected = true;
  real.sock.fire('connect');
  real.session.sideEvent('ag:joined', { stake: 0.1, micro: 100000 });
  real.session.sideEvent('ag:dead', { lostMicro: 100000, by: 'bob' });
  const card = real.doc.getElementById('ag-paid-end');
  assert.ok(card && !card.hidden, 'the death card is up');
  assert.ok(p.shown(p.btn()), 'and the lock is off');

  // Play again: a new paid seat on the same page. The old card goes, so its Back to lobby is not over the new run.
  real.session.sideEvent('ag:joined', { stake: 0.1, micro: 100000 });
  assert.ok(card.hidden, 'the last run\'s card is hidden on the new seat');
  assert.ok(!p.shown(p.btn()) && p.unload().asks, 'locked');
  real.doc.getElementById('ag-pe-lobby').dispatch('click');
  assert.deepStrictEqual(p.posted, [], 'the card\'s Back to lobby posts nothing while money is in');

  // The socket drops (agNet's disconnect, through agMain's onDisconnect): the hook hears it.
  real.sock.connected = false;
  real.sock.fire('disconnect', 'transport close');
  assert.strictEqual(p.pending(), 1, 'the drop reached agLobby');
  p.advance(5000);
  assert.ok(p.shown(p.btn()) && !p.unload().asks, 'and the page let go after the grace');
  real.doc.getElementById('ag-pe-lobby').dispatch('click');
  assert.deepStrictEqual(p.posted, [['game:done', '*']], 'the gate is open again');
  real.session.destroy();
});
