'use strict';
// Paper socket handlers (T8, design 5.6-5.7): the join order with a spy on the token consume,
// refunds bounded by what landed, respawn, the reconnect path, and hostile payloads.
const test = require('node:test');
const assert = require('node:assert');
const createPaperSockets = require('../server/paperSockets');
const { PaperArenas } = require('../server/paper/PaperArenas');
const { REASON, MP } = require('../server/paper/ArenaGame');
const { isStake } = require('../server/stakeRules');

function world({ paidEnabled = true, maintenance = false } = {}) {
  let t = 1000000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const io = { to: () => ({ emit() {}, volatile: { emit() {} } }) };
  const hooks = { onCashout() {}, onTransfer() {}, onRefund() {}, onSweep() {}, onBreach() {} };
  const arenas = new PaperArenas({ io, hooks, now: clock.now, paidEnabled, autoTick: false, warm: false });
  const tokens = new Map();
  const spy = { consume: [], storeConsume: [], refunds: [] };
  const take = (token, stake) => {
    stake = Number(stake);
    if (stake === 0) return { ok: true, worth: 0 };
    const tk = typeof token === 'string' && tokens.get(token);
    if (!tk || Math.abs(tk.stake - stake) > 1e-9) return { ok: false, worth: 0 };
    tokens.delete(token);
    return { ok: true, worth: tk.worth, paid: tk.paid, walletAddress: tk.walletAddress };
  };
  const entryStore = {
    consumeAtStake(token, stake) {
      const r = take(token, stake);
      spy.storeConsume.push([token, stake, r.ok]);
      return r;
    }
  };
  const deps = {
    arenas,
    ops: { get: () => ({ maintenance: world.maintenance !== undefined ? maintenance : maintenance }) },
    socketRL: () => true,
    sanitizeName: (n) => String(n == null ? '' : n).replace(/[<>]/g, '').trim().slice(0, 20) || 'Player',
    isStake,
    consumePaidEntryAtStake(token, stake) {
      const r = take(token, stake);
      spy.consume.push([token, stake, r.ok]);
      return r;
    },
    entryStore,
    payout: { refund: (x) => spy.refunds.push(x) },
    paidEnabled
  };
  const paper = createPaperSockets(deps);
  let tn = 0;
  const mint = (stake, worth = stake, paid = worth, wallet) => {
    const token = 'tok' + ++tn;
    tokens.set(token, { stake, worth, paid, walletAddress: wallet || 'WALLET' + tn });
    return token;
  };
  return { arenas, paper, spy, mint, clock, deps, tokens };
}

let sn = 0;
function sock(w) {
  const s = {
    id: 'sk' + ++sn,
    handlers: {},
    got: [],
    rooms: new Set(),
    on(ev, fn) { this.handlers[ev] = fn; },
    emit(ev, p) { this.got.push([ev, p]); },
    join(r) { this.rooms.add(r); },
    leave(r) { this.rooms.delete(r); },
    fire(ev, p) { this.handlers[ev](p); },
    last(ev) { const g = this.got.filter(x => x[0] === ev); return g.length ? g[g.length - 1][1] : null; }
  };
  w.paper.attach(s);
  return s;
}

function paidRoom(w) {
  return w.arenas.all().find(r => r.stake === 0.5);
}

test('bad stake, not-open, duplicate, maintenance and full are all decided before the token is consumed', () => {
  const w = world();
  // 0.1 is the retired rung (BACKLOG 2.1): refused like any other number off the ladder.
  for (const stake of ['abc', -1, 0.1, 0.25]) {
    const s = sock(w);
    s.fire('pp:join', { name: 'x', stake, entryToken: w.mint(0.5) });
    assert.strictEqual(s.last('pp:refused').why, 'bad-stake', String(stake));
  }
  const closed = world({ paidEnabled: false });
  const s0 = sock(closed);
  s0.fire('pp:join', { name: 'x', stake: 0.5, entryToken: closed.mint(0.5) });
  assert.strictEqual(s0.last('pp:refused').why, 'not-open');
  assert.strictEqual(closed.spy.consume.length, 0);
  // Duplicate: a seated socket sending pp:join again is dropped silently.
  const s1 = sock(w);
  s1.fire('pp:join', { name: 'a', stake: 0.5, entryToken: w.mint(0.5) });
  assert.ok(s1.last('pp:joined'));
  const consumed = w.spy.consume.length;
  s1.fire('pp:join', { name: 'a', stake: 0.5, entryToken: w.mint(0.5) });
  assert.strictEqual(w.spy.consume.length, consumed);
  assert.strictEqual(s1.got.filter(x => x[0] === 'pp:joined').length, 1);
  assert.strictEqual(w.spy.consume.filter(c => c[1] !== 0.5).length, 0);
  assert.strictEqual(w.spy.consume.length, 1, 'only the one real join consumed');
});

test('maintenance and full consume the token once through the refund path and pay what landed', () => {
  const m = world({ maintenance: true });
  const s = sock(m);
  s.fire('pp:join', { name: 'mia', stake: 0.5, entryToken: m.mint(0.5, 0.5, 0.495, 'WM') });
  assert.deepStrictEqual(s.last('pp:refused'), { why: 'maintenance', text: s.last('pp:refused').text, refunded: true });
  assert.strictEqual(m.spy.consume.length, 0, 'the main consume never ran');
  assert.strictEqual(m.spy.storeConsume.length, 1);
  assert.deepStrictEqual(m.spy.refunds, [{ wallet: 'WM', name: 'mia', micro: 500000, paid: 0.495, why: 'maintenance' }]);

  const f = world();
  f.arenas.seatFor = () => null; // every table full
  const s2 = sock(f);
  s2.fire('pp:join', { name: 'fay', stake: 1, entryToken: f.mint(1, 1, 1, 'WF') });
  assert.strictEqual(s2.last('pp:refused').why, 'full');
  assert.strictEqual(s2.last('pp:refused').refunded, true);
  assert.strictEqual(f.spy.consume.length, 0);
  assert.deepStrictEqual(f.spy.refunds.map(r => [r.wallet, r.micro, r.paid, r.why]), [['WF', 1000000, 1, 'full']]);
});

test('a bad token at 0.50 is refused visibly and never seated', () => {
  const w = world();
  const s = sock(w);
  s.fire('pp:join', { name: 'b', stake: 0.5, entryToken: 'forged' });
  assert.strictEqual(s.last('pp:refused').why, 'entry');
  assert.strictEqual(s.last('pp:refused').text, 'Entry fee not verified');
  assert.strictEqual(s.last('pp:joined'), null);
  assert.strictEqual(paidRoom(w).liveHumans, 0);
  assert.strictEqual(w.spy.refunds.length, 0);
});

test('a spent token re-sent after death is refused with no refund and no seat', () => {
  const w = world();
  const s = sock(w);
  const tok = w.mint(0.5);
  s.fire('pp:join', { name: 'c', stake: 0.5, entryToken: tok });
  s.fire('pp:in', MP.encodeInput(1, 0, false)); // the player got pp:joined and steered
  const room = paidRoom(w);
  const unit = room.seatOfSocket(s.id).unit;
  room.game.kill(unit, undefined, REASON.SELF_CROSS);
  for (const ev of ['pp:join', 'pp:respawn']) {
    const before = room.liveHumans;
    s.fire(ev, { name: 'c', stake: 0.5, entryToken: tok });
    assert.strictEqual(s.last('pp:refused').text, 'Entry fee not verified', ev);
    assert.strictEqual(room.liveHumans, before);
  }
  assert.deepStrictEqual(w.spy.consume.map(c => c[2]), [true, false, false]);
  assert.strictEqual(w.spy.refunds.length, 0);
});

test('client wallet, worth and micro fields change nothing about the deposit', () => {
  const w = world();
  const s = sock(w);
  s.fire('pp:join', { name: 'd', stake: 0.5, entryToken: w.mint(0.5, 0.5, 0.5, 'TOKENWALLET'), wallet: 'EVIL', worth: 500, micro: 9e9, paid: 99 });
  const room = paidRoom(w);
  const seat = room.seatOfSocket(s.id);
  assert.strictEqual(room.bank.balance(seat.unit.id), 500000);
  assert.strictEqual(room.bank.accounts.get(seat.unit.id).wallet, 'TOKENWALLET');
  room.game.kill(seat.unit, undefined, REASON.SELF_CROSS);
  s.fire('pp:respawn', { entryToken: w.mint(0.5, 0.5, 0.5, 'W2'), stake: 1, worth: 1000, micro: 1e9 });
  const again = room.seatOfSocket(s.id) || w.arenas.seatOfSocket(s.id);
  assert.ok(again, 'respawned');
  assert.strictEqual(again.room.stake, 0.5, 'respawn uses the socket stake, not the message');
  assert.strictEqual(again.room.bank.balance(again.unit.id), 500000);
});

test('a respawn with a stale room consumes once and seats in a listed arena, leaving the old io room', () => {
  const w = world();
  const s = sock(w);
  s.fire('pp:join', { name: 'e', stake: 0.5, entryToken: w.mint(0.5) });
  const old = paidRoom(w);
  old.game.kill(old.seatOfSocket(s.id).unit, undefined, REASON.SELF_CROSS);
  old.stop();
  w.arenas.arenas['0.50'].splice(w.arenas.arenas['0.50'].indexOf(old), 1); // swept
  const n = w.spy.consume.length;
  s.fire('pp:respawn', { entryToken: w.mint(0.5) });
  assert.strictEqual(w.spy.consume.length, n + 1);
  assert.ok(s._ppRoom && s._ppRoom !== old && !s._ppRoom.stopped);
  assert.ok(w.arenas.all().includes(s._ppRoom));
  assert.ok(!s.rooms.has(old.ioRoom));
  assert.ok(s.rooms.has(s._ppRoom.ioRoom));
});

test('a seat failure refunds exactly once, bounded by paid', (t) => {
  t.mock.method(console, 'error', () => {});
  const w = world();
  const room = paidRoom(w) || w.arenas.seatFor(0.5).room;
  const units = room.game.units.length;
  const add = room.addHuman.bind(room);
  room.addHuman = (socket, spec) => {
    room.addHuman = add;
    const seat = add(socket, spec);
    throw new Error('late failure after seating');
  };
  const s = sock(w);
  s.fire('pp:join', { name: 'f', stake: 0.5, entryToken: w.mint(0.5, 0.5, 0.4975, 'WSF') });
  assert.strictEqual(s.last('pp:refused').why, 'seat-failed');
  assert.deepStrictEqual(w.spy.refunds.map(r => [r.wallet, r.micro, r.paid, r.why]), [['WSF', 500000, 0.4975, 'seat-failed']]);
  void units;
});

test('addHuman throwing inside the room never leaves a unit or an open account', (t) => {
  t.mock.method(console, 'error', () => {});
  const w = world();
  const found = w.arenas.seatFor(0.5);
  const room = found.room;
  const units = room.game.units.length;
  const inBefore = room.bank.ledger.inMicro;
  room.joinedPayload = () => { throw new Error('payload broke'); };
  const s = sock(w);
  s.fire('pp:join', { name: 'g', stake: 0.5, entryToken: w.mint(0.5, 0.5, 0.5, 'WG') });
  assert.strictEqual(s.last('pp:refused').why, 'seat-failed');
  assert.strictEqual(w.spy.refunds.length, 1);
  assert.strictEqual(room.game.units.length, units);
  assert.strictEqual(room.bank.totalMicro(), 0);
  assert.strictEqual(room.bank.ledger.inMicro - room.bank.ledger.outMicro, 0);
  assert.ok(room.bank.ledger.inMicro > inBefore, 'the deposit was closed out, not left open');
  assert.strictEqual(room.liveHumans, 0);
});

test('reconnect: in time, too late, after a death in the grace, two sockets on one seat, a wrong key', () => {
  const w = world();
  const a = sock(w);
  a.fire('pp:join', { name: 'r', stake: 0.5, entryToken: w.mint(0.5) });
  a.fire('pp:in', MP.encodeInput(1, 0, false)); // the player got pp:joined and steered
  const key = a.last('pp:joined').resumeKey;
  const room = paidRoom(w);
  const unit = room.seatOfSocket(a.id).unit;
  const consumed = w.spy.consume.length;
  w.paper.drop(a.id);
  const b = sock(w);
  b.fire('pp:join', { name: 'r', stake: 0.5, resumeKey: key });
  const rj = b.last('pp:joined');
  assert.strictEqual(rj.resumed, true);
  assert.strictEqual(rj.you, unit.id);
  assert.strictEqual(room.bank.balance(unit.id), 500000);
  assert.strictEqual(w.spy.consume.length, consumed, 'no token on the reconnect path');
  // A second socket with the same key: the newer wins, the older is told and leaves.
  const c = sock(w);
  w.arenas.io = null;
  room._socketById = (id) => (id === b.id ? b : null);
  c.fire('pp:join', { name: 'r', stake: 0.5, resumeKey: key });
  assert.ok(c.last('pp:joined').resumed);
  assert.ok(b.last('pp:replaced'));
  assert.ok(!b.rooms.has(room.ioRoom));
  // Wrong key.
  const d = sock(w);
  d.fire('pp:join', { name: 'r', stake: 0.5, resumeKey: 'not-a-key' });
  assert.strictEqual(d.last('pp:refused').why, 'expired');
  // Too late.
  w.paper.drop(c.id);
  w.clock.advance(MP.DISCONNECT_GRACE_MS + 50);
  room.tickOnce();
  const e = sock(w);
  e.fire('pp:join', { name: 'r', stake: 0.5, resumeKey: key });
  assert.strictEqual(e.last('pp:refused').why, 'expired');
  // Die during the grace, then reconnect.
  const f = sock(w);
  f.fire('pp:join', { name: 'q', stake: 0.5, entryToken: w.mint(0.5) });
  f.fire('pp:in', MP.encodeInput(1, 0, false));
  const key2 = f.last('pp:joined').resumeKey;
  w.paper.drop(f.id);
  const fr = f._ppRoom;
  fr.game.kill(fr.seats.values().next().value.unit, undefined, REASON.SELF_CROSS);
  const g = sock(w);
  g.fire('pp:join', { name: 'q', stake: 0.5, resumeKey: key2 });
  assert.strictEqual(g.last('pp:refused').why, 'expired');
  assert.strictEqual(w.spy.consume.length, consumed + 1, 'only f\'s real join consumed anything');
});

test('null, a number or a string as the payload is ignored without a throw and consumes nothing', (t) => {
  const errors = [];
  t.mock.method(console, 'error', (...a) => errors.push(a.join(' ')));
  const w = world();
  const s = sock(w);
  for (const bad of [null, 7, 'x', undefined, [1, 2]]) {
    for (const ev of ['pp:join', 'pp:respawn', 'pp:need', 'pp:leave', 'pp:ping']) s.fire(ev, bad);
    s.fire('pp:in', bad);
  }
  s.fire('pp:in', 1.5);
  s.fire('pp:in', 2 ** 40);
  assert.strictEqual(w.spy.consume.length, 0);
  assert.strictEqual(w.spy.storeConsume.length, 0);
  assert.deepStrictEqual(errors, [], 'no handler threw');
  assert.ok(s.got.every(x => x[0] !== 'pp:joined'));
});

test('a free join seats with no token and no money, and pp:need answers from the live room', () => {
  const w = world();
  const s = sock(w);
  s.fire('pp:join', { name: 'free', stake: 0 });
  const j = s.last('pp:joined');
  assert.ok(j && j.stake === 0);
  assert.strictEqual(w.spy.refunds.length, 0);
  s.fire('pp:need', { id: j.you });
  const geo = s.last('pp:geo');
  assert.ok(geo && geo.ev.some(e => e[0] === 'b' && e[1] === j.you));
  s.fire('pp:ping', { t: 123 });
  assert.strictEqual(s.last('pp:pong').t, 123);
  s.fire('pp:leave');
  assert.strictEqual(s._ppRoom, null);
});
