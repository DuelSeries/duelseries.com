'use strict';
// Hostile paid sl sockets (PAID-SL-DESIGN.md 3.1, 3.2, 11.1 slPaidHostile; task T4), through the real slSockets, door,
// paid directory, SlRoom and slMoney, with a REAL entry store.
//   - bad handshake auth: every bad stake is 'bad-stake', every bad token 'entry', and neither touches a token; a
//     spent token, one of the other rung and a Paper or agar dev token are refused 'entry' and stay as they were
//   - money fields inside sl:join are refused by their presence, the handshake token untouched
//   - a 300-char emoji name seats an asciized name and no wake fails (D1-M1: no raw name reaches the wire)
//   - another seat's key: a free socket cannot resume a paid seat, a paid socket cannot resume a free one
//   - a hold flood presses once and pays once
//   - auth.paid other than the number 1 is a free socket; a free socket with the helper reads only auth.paid, cv and watch (the free room's Spectate)
const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../shared/slWire.js');
const { paidRig } = require('./slPaidFakes');
const { layerMsgs } = require('./slSockFakes');

const PING = W.encodeInput([{ type: 'ping' }]);

function refusal(s) {
  return layerMsgs(s).find((x) => x.t === 'refused') || null;
}

function keyOf(s) {
  const m = layerMsgs(s).filter((x) => x.t === 'seat' || x.t === 'back');
  return m.length ? m[m.length - 1].k : null;
}

function frames(s) {
  return s.emitted.filter((e) => e.name === 'sl:f').length;
}

test('bad auth: bad stakes and bad tokens are refused before any token is read', () => {
  const r = paidRig();
  const good = r.mint({});
  const stakes = [{ toString: 1 }, NaN, '0.5x', -1, 0, 0.1, 2, '', null, [0.5], Infinity];
  for (const stake of stakes) {
    const s = r.join(good, { auth: { stake } });
    assert.deepEqual(refusal(s), { t: 'refused', why: 'bad-stake', refunded: 0 }, JSON.stringify(stake) || typeof stake);
  }
  for (const entryToken of ['x'.repeat(65), 7, '', null, { length: 3 }, ['t']]) {
    const s = r.join(good, { auth: { entryToken } });
    assert.deepEqual(refusal(s), { t: 'refused', why: 'entry', refunded: 0 }, JSON.stringify(entryToken));
  }
  assert.deepEqual(r.consumed, [], 'no token offered to the store');
  // a getter on the token is never called (only own data properties are read)
  let called = false;
  const auth = { paid: 1, stake: 0.5, cv: 1 };
  Object.defineProperty(auth, 'entryToken', { enumerable: true, get() { called = true; return good; } });
  const g = r.sock({ auth });
  g.fire('sl:join', { nick: 'g' });
  assert.equal(called, false);
  assert.equal(refusal(g).why, 'entry');
  assert.equal(r.store.consumeAtStake(good, 0.5, 'slither').ok, true, 'the good token was never spent');
});

test('a spent token, a token of the other rung, a Paper or agar dev token: entry, and each stays as it was', () => {
  const r = paidRig();
  const spent = r.mint({});
  assert.ok(r.paid.roomOf(r.join(spent).id));
  const again = r.join(spent);
  assert.deepEqual(refusal(again), { t: 'refused', why: 'entry', refunded: 0 });
  const dollar = r.mint({ stake: 1, worth: 1, paid: 1 });
  assert.equal(refusal(r.join(dollar)).why, 'entry', 'a $1 token at the $0.50 door');
  for (const game of ['paper', 'agar']) {
    const t = r.mint({ onlyGame: game });
    assert.equal(refusal(r.join(t)).why, 'entry', game + ' dev token');
    assert.equal(r.store.consumeAtStake(t, 0.5, game).ok, true, game + ': still spendable at its own door');
  }
  assert.equal(r.store.consumeAtStake(dollar, 1, 'slither').ok, true, 'the $1 token is untouched');
  assert.deepEqual(r.payout.refunds, []);
  assert.equal(r.paid.humanTotal(), 1);
});

test('money fields inside sl:join are refused by their presence; the handshake token is not spent', () => {
  const r = paidRig();
  for (const k of ['stake', 'entryToken', 'resumeKey']) {
    const token = r.mint({});
    r.wall.t += 1000;
    const s = r.paidSock(token);
    s.fire('sl:join', { nick: 'x', [k]: k === 'stake' ? 100 : 'evil' });
    assert.deepEqual(refusal(s), { t: 'refused', why: 'not-open' }, k);
    assert.equal(r.store.consumeAtStake(token, 0.5, 'slither').ok, true, k + ': token untouched');
  }
  assert.equal(r.paid.rooms().length, 0);
});

test('a 300-char emoji name seats an asciized name and no wake fails', () => {
  const r = paidRig();
  const nameMax = r.laws.L45.value.nameMax;
  const s = r.join(r.mint({}), { nick: '\u{1F40D}'.repeat(150) + 'Owen' });
  const room = r.paid.roomOf(s.id);
  assert.ok(room, 'seated');
  const nick = room.seatOf(s.id).nick;
  assert.ok(nick.length <= nameMax, 'cleaned to at most ' + nameMax);
  assert.ok(/^[\x20-\x7e]*$/.test(nick), 'ascii only: ' + JSON.stringify(nick));
  const t = r.join(r.mint({}), { nick: 'a'.repeat(300) });
  assert.ok(r.paid.roomOf(t.id).seatOf(t.id).nick.length <= nameMax);
  r.step(200);
  assert.equal(room.stats.failedWakes, 0);
  assert.equal(room.closed, false);
  assert.deepEqual(room.money.lastViolations, []);
});

test('another seat\'s key: a free socket cannot resume a paid seat, a paid socket cannot resume a free one', () => {
  const r = paidRig();
  const p = r.join(r.mint({}));
  const f = r.sock();
  f.fire('sl:join', { nick: 'free' });
  r.step(3);
  const proom = r.paid.roomOf(p.id);
  const pk = keyOf(p);
  const fk = keyOf(f);
  for (const s of [p, f]) {
    s.disconnected = true;
    s.fire('disconnect', 'transport close');
  }
  // a free socket presenting the paid seat's key
  const x = r.sock();
  x.fire('sl:back', { k: pk, n: frames(p), p: 0 });
  assert.equal(refusal(x).why, 'gone');
  assert.equal(proom.parked.size, 1, 'the paid seat still waits for its owner');
  // a paid socket presenting the free seat's key, and a made-up one
  const y = r.paidSock(undefined, { auth: { entryToken: undefined } });
  y.fire('sl:back', { k: fk, n: frames(f), p: 0 });
  assert.equal(refusal(y).why, 'gone');
  const z = r.paidSock(undefined, { auth: { entryToken: undefined } });
  z.fire('sl:back', { k: '00000000-0000-4000-8000-000000000000', n: 0, p: 0 });
  assert.equal(refusal(z).why, 'gone');
  // the owner comes back with its key
  const w = r.paidSock(undefined, { auth: { entryToken: undefined } });
  w.fire('sl:back', { k: pk, n: frames(p), p: 0 });
  assert.equal(refusal(w), null);
  assert.equal(r.paid.roomOf(w.id), proom);
});

test('a hold flood presses once and pays once', () => {
  const r = paidRig();
  const s = r.join(r.mint({ walletAddress: 'WH' }));
  const room = r.paid.roomOf(s.id);
  const id = room.seatOf(s.id).snakeId;
  r.step(2);
  r.wall.t += 1000;
  let presses = 0;
  const press = room.holds.press.bind(room.holds);
  room.holds.press = (...a) => {
    presses++;
    return press(...a);
  };
  for (let i = 0; i < 500; i++) s.fire('sl:hold', { on: 1 });
  assert.equal(presses, 1, 'one press through the rate limit');
  for (let i = 0; i < 500; i++) s.fire('sl:hold', { on: 0 });
  s.fire('sl:hold', { on: 1 });
  r.wall.t += 1000;
  s.fire('sl:hold', { on: 1 });
  let k = 0;
  while (room.sim.snake(id) && k++ < 200) {
    r.wall.t += 1;
    s.fire('sl:i', PING);
    for (let i = 0; i < 20; i++) s.fire('sl:hold', { on: 1 });
    r.step();
  }
  assert.equal(room.sim.snake(id), null, 'cashed out');
  assert.equal(r.money.of('onCashout').length, 1, 'paid once');
  assert.equal(r.money.of('onCashout')[0].wallet, 'WH');
  for (let i = 0; i < 50; i++) s.fire('sl:hold', { on: 1 });
  r.step(5);
  assert.equal(r.money.of('onCashout').length, 1, 'still once');
  assert.equal(room.money.bank.ledger.outCash, 500000);
});

test('auth.paid other than the number 1 is a free socket; a free socket reads only auth.paid, auth.cv and auth.watch', () => {
  const r = paidRig();
  for (const paidV of ['1', true, 2, [1], { valueOf: () => 1 }]) {
    const token = r.mint({});
    r.wall.t += 1000;
    const s = r.sock({ auth: { paid: paidV, stake: 0.5, entryToken: token, cv: 1 } });
    s.fire('sl:join', { nick: 'f' });
    assert.ok(r.room().seatOf(s.id), JSON.stringify(paidV) + ': a free seat');
    assert.equal(r.paid.roomOf(s.id), null);
    assert.equal(r.store.consumeAtStake(token, 0.5, 'slither').ok, true, 'its token never read');
  }
  const touched = new Set();
  const auth = new Proxy({ cv: 2, entryToken: 't', stake: 0.5, wallet: 'W' }, {
    get(t, k) { touched.add(String(k)); return t[k]; },
    getOwnPropertyDescriptor(t, k) { touched.add(String(k)); return Object.getOwnPropertyDescriptor(t, k); },
    has(t, k) { touched.add(String(k)); return k in t; },
    ownKeys(t) { touched.add('*keys'); return Reflect.ownKeys(t); },
  });
  const f = r.sock({ auth });
  f.fire('sl:join', { nick: 'f' });
  f.fire('sl:hold', { on: 1 });
  f.fire('sl:leave');
  // shop and skinPass: a bought skin's id and the lobby's skin pass (docs/skin-purchases.md), cosmetic, never money
  assert.deepEqual(Array.from(touched).sort(), ['cv', 'paid', 'shop', 'skinPass', 'watch']);
  // without the helper nothing but cv is read (slNoMoney's own test pins the rest)
  const plain = require('./slSockFakes').rig();
  const t2 = new Set();
  const a2 = new Proxy({ cv: 2, paid: 1, entryToken: 't' }, {
    getOwnPropertyDescriptor(t, k) { t2.add(String(k)); return Object.getOwnPropertyDescriptor(t, k); },
    get(t, k) { t2.add(String(k)); return t[k]; },
  });
  const q = plain.sock({ auth: a2 });
  q.fire('sl:join', { nick: 'q' });
  assert.ok(plain.room().seatOf(q.id), 'no helper: a paid page is a free seat (its token unspent, it expires into a refund)');
  assert.deepEqual(Array.from(t2).sort(), ['cv', 'shop', 'skinPass', 'watch'], 'the skin (free and bought), and whether it only watches');
});
