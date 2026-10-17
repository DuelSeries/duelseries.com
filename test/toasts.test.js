'use strict';
// The lobby's toasts (public/js/v2/toasts.js), run for real in a small fake page: what each card says, the
// stack limit, what waits while a game is open, and how a balance rise is named (a game's payout or money
// added). Read-only by design: it must never call anything that moves money.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '../public/js/v2/toasts.js'), 'utf8');

function node(tag) {
  const n = {
    tag, children: [], childNodes: [], className: '', attrs: {}, listeners: {}, removed: false, style: {},
    _text: '',
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); },
    set textContent(v) { this._text = String(v); this.children = []; this.childNodes = []; },
    appendChild(c) { this.children.push(c); this.childNodes.push(c); c.parent = this; return c; },
    get firstChild() { return this.children[0] || null; },
    insertBefore(c, ref) {
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i < 0) return this.appendChild(c);
      this.children.splice(i, 0, c); this.childNodes.splice(i, 0, c); c.parent = this; return c;
    },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    remove() { this.removed = true; if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); },
  };
  n.classList = {
    set: () => new Set(n.className.split(/\s+/).filter(Boolean)),
    add(c) { const s = this.set(); s.add(c); n.className = [...s].join(' '); },
    remove(c) { const s = this.set(); s.delete(c); n.className = [...s].join(' '); },
    toggle(c, on) { if (on) this.add(c); else this.remove(c); },
    contains(c) { return this.set().has(c); },
  };
  return n;
}

function page(opts) {
  const o = opts || {};
  const ids = { toasts: node('div'), 'game-frame': node('iframe'), 'agar-frame': node('iframe') };
  ids['game-frame'].style.display = 'none';
  ids['agar-frame'].style.display = 'none';
  const listeners = {};
  const store = {};
  let observer = null;
  const timers = [];
  let now = 1000000;
  const win = {
    innerWidth: o.w || 1440, innerHeight: o.h || 900,
    location: { origin: 'https://duelseries.com' },
    sessionStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    dispatchEvent(e) { (listeners[e.type] || []).forEach(fn => fn(e)); },
    requestAnimationFrame: fn => fn(),
    setTimeout: (fn, ms) => { timers.push({ fn, at: now + ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    MutationObserver: function (cb) { observer = cb; this.observe = () => {}; },
    duelWallet: null, refreshes: 0,
  };
  win.duelWalletRefresh = () => { win.refreshes++; };
  win.window = win;
  win.document = {
    readyState: 'complete',
    getElementById: id => ids[id] || null,
    createElement: node,
    createTextNode: t => ({ textContent: t }),
  };
  win.Date = { now: () => now };
  vm.runInNewContext(SRC, Object.assign(win, { Object, Math, Number, String, Infinity, isFinite, Array }));
  const cards = () => ids.toasts.children.filter(c => !c.className.includes('out'));
  const say = c => {
    const tt = c.children[1].children.find(x => x.className === 't-title');
    const td = c.children[1].children.find(x => x.className === 't-line');
    return { kind: c.className.replace(/\b(toast|on|out)\b/g, '').trim(), title: tt ? tt.textContent : '', line: td ? td.textContent : '' };
  };
  return {
    win, ids, store, cards, said: () => cards().map(say),
    tick(ms) { now += ms; timers.filter(t => t.fn && t.at <= now).forEach(t => { const f = t.fn; t.fn = null; f(); }); },
    open(id) { ids[id || 'game-frame'].style.display = 'block'; observer && observer(); },
    close(id) { ids[id || 'game-frame'].style.display = 'none'; observer && observer(); },
    wallet(balance, address) {
      win.duelWallet = { authenticated: true, address: address || 'AAAAbbbbccccddddeeeeffffgggghhhhiiiijjjjZZZZ', balance, unit: 'USDC' };
      win.dispatchEvent({ type: 'duelwallet:change' });
    },
    play(detail) { win.dispatchEvent({ type: 'duel:play', detail }); },
  };
}

test('a card has the outcome as its class, a title, and one line: amount, words, address', () => {
  const p = page();
  p.win.DSToast.show({ kind: 'ok', title: 'Address copied', code: '7xKp…f3Qa' });
  p.win.DSToast.show({ kind: 'money', title: 'Funds added', amount: '+$5.00 USDC', detail: 'is in your wallet' });
  assert.deepStrictEqual(p.said(), [
    { kind: 'ok', title: 'Address copied', line: '7xKp…f3Qa' },
    { kind: 'money', title: 'Funds added', line: '+$5.00 USDC is in your wallet' },
  ]);
  assert.strictEqual(p.ids.toasts.children[0].children[0].attrs['aria-hidden'], 'true', 'the icon is not read out');
});

test('three at most on a PC, two on a short phone; the same message twice is one card', () => {
  const p = page();
  for (const t of ['one', 'two', 'three', 'four']) p.win.DSToast.show({ title: t });
  assert.deepStrictEqual(p.said().map(s => s.title), ['two', 'three', 'four']);
  p.win.DSToast.show({ title: 'four' });
  assert.strictEqual(p.cards().length, 3);
  const phone = page({ w: 375, h: 667 });
  for (const t of ['one', 'two', 'three']) phone.win.DSToast.show({ title: t });
  assert.deepStrictEqual(phone.said().map(s => s.title), ['two', 'three']);
});

test('goes after about 3 to 4 s (an error a little longer); a click puts it away sooner', () => {
  const p = page();
  p.win.DSToast.show({ kind: 'ok', title: 'Name saved' });
  p.win.DSToast.show({ kind: 'err', title: 'Withdraw failed' });
  p.tick(3500);
  assert.deepStrictEqual(p.said().map(s => s.title), ['Withdraw failed']);
  p.ids.toasts.children.find(c => !c.className.includes('out')).listeners.click[0]();
  assert.strictEqual(p.cards().length, 0);
});

test('a running send stays until it is answered, then says the answer in place', () => {
  const p = page();
  const c = p.win.DSToast.show({ kind: 'info', title: 'Sending your withdraw', amount: '$5.00 USDC', detail: 'to', code: 'AbCd…WxYz', sticky: true });
  p.tick(30000);
  assert.deepStrictEqual(p.said(), [{ kind: 'info', title: 'Sending your withdraw', line: '$5.00 USDC to AbCd…WxYz' }]);
  c.update({ kind: 'ok', title: 'Withdraw confirmed' });
  assert.deepStrictEqual(p.said(), [{ kind: 'ok', title: 'Withdraw confirmed', line: '$5.00 USDC to AbCd…WxYz' }]);
  p.tick(4000);
  assert.strictEqual(p.cards().length, 0, 'an answered card times out like any other');
});

test('while a game is open only what belongs over it shows (at the top); the rest waits for the lobby', () => {
  const p = page();
  p.win.DSToast.show({ title: 'Address copied' });
  p.open();
  assert.strictEqual(p.cards().length, 0, 'a lobby card does not follow the player into the game');
  p.win.DSToast.show({ title: 'Skin saved' });
  assert.strictEqual(p.cards().length, 0, 'not over the game');
  p.win.DSToast.show({ kind: 'money', title: 'Payout received', game: true });
  assert.deepStrictEqual(p.said().map(s => s.title), ['Payout received']);
  assert.ok(p.ids.toasts.className.split(' ').includes('top'), 'top centre over a game');
  p.close();
  assert.ok(!p.ids.toasts.className.split(' ').includes('top'));
  assert.ok(p.said().some(s => s.title === 'Skin saved'), 'shown once back in the lobby');
});

test('the balance going up: Funds added, never on sign-in, a failed read, or a fall', () => {
  const p = page();
  p.wallet(null);
  p.wallet(10);
  p.wallet(null);                       // a failed read
  p.wallet(10);
  p.wallet(7.5);                        // a stake or a withdraw: its own card already
  assert.strictEqual(p.cards().length, 0);
  p.wallet(12.5);
  assert.deepStrictEqual(p.said(), [{ kind: 'money', title: 'Funds added', line: '+$5.00 USDC is in your wallet' }]);
  p.wallet(12.5, 'ZZZZyyyyxxxxwwwwvvvvuuuuttttssssrrrrqqqqAAAA');   // another wallet signed in
  p.wallet(20, 'ZZZZyyyyxxxxwwwwvvvvuuuuttttssssrrrrqqqqAAAA');
  assert.strictEqual(p.said().filter(s => s.title === 'Funds added').length, 2);
});

test('a Convert to USDC rise has its own card: Funds added stays quiet for it, and only for it', () => {
  const p = page();
  p.wallet(10);
  p.wallet(10);
  p.win.DSToast.expectRise(4.38);
  p.wallet(14.38);                      // the conversion landing
  assert.strictEqual(p.cards().length, 0);
  p.wallet(19.38);                      // money that really was added afterwards
  assert.deepStrictEqual(p.said(), [{ kind: 'money', title: 'Funds added', line: '+$5.00 USDC is in your wallet' }]);
  // A conversion that failed takes its expectation back.
  const q = page();
  q.wallet(10); q.wallet(10);
  const cancel = q.win.DSToast.expectRise(4);
  cancel();
  q.wallet(14);
  assert.strictEqual(q.said().filter(s => s.title === 'Funds added').length, 1);
  // And it lapses after a minute.
  const r = page();
  r.wallet(10); r.wallet(10);
  r.win.DSToast.expectRise(4);
  r.tick(61000);
  r.wallet(14);
  assert.strictEqual(r.said().filter(s => s.title === 'Funds added').length, 1);
});

test('a paid seat: Entry paid at the top as it opens, then a rise is the game paying out, for 15 minutes after', () => {
  const p = page();
  p.wallet(10);
  p.store.entryToken = 'OLD-TOKEN';     // left over from an earlier seat
  p.play({ game: 'snake', stake: 1 });
  p.store.entryToken = 'NEW-TOKEN'; p.store.stake = '1'; p.store.entrySol = '1';   // the widget's hand-off
  p.open();
  assert.deepStrictEqual(p.said(), [{ kind: 'money', title: 'Entry paid', line: '$1.00 USDC' }]);
  p.wallet(9);
  p.wallet(10.8);
  assert.deepStrictEqual(p.said().pop(), { kind: 'money', title: 'Payout received', line: '+$1.80 USDC from your game' });
  p.close();
  p.tick(14 * 60 * 1000);
  p.wallet(11.7);
  assert.strictEqual(p.said().pop().title, 'Payout received');
  p.tick(2 * 60 * 1000);
  p.wallet(16.7);
  assert.strictEqual(p.said().pop().title, 'Funds added', 'long after the game, money is money added');
});

test('no Entry paid for a free seat, a stale token, or a paid ask that never opened a game', () => {
  const p = page();
  p.store.entryToken = 'OLD-TOKEN'; p.store.stake = '1';
  p.play({ game: 'snake', stake: 1 });  // the stake failed: the widget wrote nothing new
  p.open();
  p.close();
  p.play({ game: 'snake', stake: 0 });
  p.open();
  assert.strictEqual(p.said().filter(s => s.title === 'Entry paid').length, 0);
});

test('an in-game Play again reads the balance first, so a payout is not hidden by the new stake', () => {
  const p = page();
  const game = {};
  p.ids['game-frame'].contentWindow = game;
  p.win.dispatchEvent({ type: 'message', origin: 'https://duelseries.com', source: game, data: { type: 'duel:restake', game: 'snake' } });
  p.win.dispatchEvent({ type: 'message', origin: 'https://evil.example', source: game, data: { type: 'duel:restake' } });
  p.win.dispatchEvent({ type: 'message', origin: 'https://duelseries.com', source: {}, data: { type: 'duel:restake' } });
  assert.strictEqual(p.win.refreshes, 1, 'only our own game frame, on our own origin');
});

test('read-only: the module never touches anything that sends or stakes', () => {
  assert.ok(!/duelWalletSend|duelWalletFund|duelWalletBuy|submit-stake|signTransaction|\.setItem\(/.test(SRC));
});

test('the owner\'s announcement shows over a running game, as text, once; its socket only listens', () => {
  const p = page();
  const heard = {};
  let made = 0;
  p.win.io = () => { made++; return { on(ev, fn) { heard[ev] = fn; } }; };
  p.tick(1500);                                   // the socket is opened once the page is up
  assert.strictEqual(made, 1);
  assert.strictEqual(typeof heard.announce, 'function');
  p.open();
  heard.announce({ text: 'Back in <b>5</b>\nminutes', at: 1 });
  assert.deepStrictEqual(p.said(), [{ kind: 'info ann', title: 'DuelSeries', line: 'Back in <b>5</b> minutes' }],
    'over the game, at the top, written as text (the markup is shown, never run)');
  heard.announce({ text: 'Back in <b>5</b>\nminutes', at: 1 });
  assert.strictEqual(p.cards().length, 1, 'a reconnect sending it again is one card');
  heard.announce({ text: '' });
  heard.announce(null);
  assert.strictEqual(p.cards().length, 1);
  assert.ok(!/\.emit\(/.test(SRC), 'it sends nothing: no lobby:join, nobody counted');
});

test('announcements stack over a game, newest on top, at most 4, each on its own word timer (Owen 2026-10-17)', () => {
  const p = page();
  const heard = {};
  p.win.io = () => ({ on(ev, fn) { heard[ev] = fn; } });
  p.tick(1500);
  p.open();
  heard.announce({ text: 'one two three', at: 1 });                           // 3 s + 3 x 0.35 s = 4.05 s
  heard.announce({ text: Array(20).fill('w').join(' '), at: 2 });            // 3 s + 20 x 0.35 s = 10 s
  assert.deepStrictEqual(p.said().map(c => c.line), [Array(20).fill('w').join(' '), 'one two three'], 'both, newest on top');
  p.tick(4100);
  assert.deepStrictEqual(p.said().map(c => c.line), [Array(20).fill('w').join(' ')], 'the short one left on its own timer');
  p.tick(6000);
  assert.strictEqual(p.cards().length, 0, 'the long one after about 10 s');
  for (let i = 1; i <= 5; i++) heard.announce({ text: 'line ' + i, at: 10 + i });
  assert.deepStrictEqual(p.said().map(c => c.line), ['line 5', 'line 4', 'line 3', 'line 2'], 'four at most, the oldest left early');
  heard.announce({ text: Array(200).fill('w').join(' '), at: 99 });
  p.tick(19900);
  assert.ok(p.said().some(c => c.line.startsWith('w w')), 'a very long one is still up just under 20 s');
  p.tick(200);
  assert.ok(!p.said().some(c => c.line.startsWith('w w')), 'and gone at the 20 s cap');
});
