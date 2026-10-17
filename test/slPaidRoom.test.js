'use strict';
// The paid branches of SlRoom (PAID-SL-DESIGN.md 1, 3.3, 5, 6, 7.2, 7.4, 9 and 11.1 slPaidRoom; task T3): a room built
// with opts.money (the real controller, server/slPaid/slMoney.js, on spy hooks), the real sim, view and send queue,
// the FIXTURE table, on a fake clock.
//   - seatPaid opens the account LAST: a throw injected at each line of the build (the send queue, the seat view, its
//     join, the event push, the key message) or in money.open leaves no account, no snake, no seat and no key, so the
//     door refunds once; a throw after the open aborts the account (the door refunds once, the bank books the refund)
//   - the seat's messages: {t:'room'} kept and the own {t:'w'}; the resume sends both again; {t:'w'} once per wake to
//     the own seat (with its delta) and the seats holding the snake only, and with every add of a paid snake
//   - the cap: 22 (C_PAID_HUMAN_CAP, gliding snakes count), the 23rd refused, the border radius stays 2923; no bots
//   - no idle pause while an account is open
//   - a cash-out is money first: 500000 / 50000 / 450000 in {t:'cashed'} and one order; a death sends kept {t:'lost'}
//   - a step that throws closes the room at once: the step's facts applied (a kill death in it), every open
//     account refunded 100% of its GROWN balance (one ate gold first) through the owed lane, the floor swept to the house
//   - a throw in sim.remove right after a paid cash-out: exactly one payout order, owed rows for the other accounts only
//   - a seat whose own refund the bank refuses stays open: the door refunds nothing, the room ticks and taints, and
//     I4 pays it once through the owed lane (never both, never neither)
//   - cashOut throwing before the withdraw is alerted and the snake plays on; after it, alerted as unconfirmed with
//     its gross; a logger that throws on the order line still pays once; a throw in the cashed length is CRITICAL
//   - a fact the bank refuses (split, credit) in a live room: who is paid and what the checker reports
//   - a paid room needs its seed (no wall-clock fallback)
//   - stop() never settles (it alerts); halt() stops the clock only

const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../shared/slWire.js');
const slSnake = require('../server/sl/slSnake');
const slView = require('../server/sl/slView');
const { SlRoom } = require('../server/sl/slRoom');
const { createSlMoney } = require('../server/slPaid/slMoney');
const { makeFixture } = require('./slLawsFixture');
const { fakeTimers, bareSocket, fakeView } = require('./slNetFakes');

const LAWS = makeFixture();
const P = LAWS.L7.value;
const GRD = LAWS.L1.value;
const PI2 = 2 * Math.PI;
const LABEL = 'sl_na_s0_5';
const STAKE = 500000;
const OWED_KEY = /^agowed:[0-9a-f-]{36}$/; // db.js recordOwedOnce

const angle = (q) => W.encodeInput([{ type: 'angle', q }]);

function byteOf(a) {
  const w = ((a % PI2) + PI2) % PI2;
  return Math.round(w / PI2 * 251) % 251;
}

function jidOf(n) {
  return 'a0000000-0000-4000-8000-' + String(n).padStart(12, '0');
}

// Every hook recorded; the directory's walletSeat; a journal that remembers; flags to plant a throw.
function spy() {
  const calls = [];
  const walletSeat = new Map();
  const flags = {};
  const records = [];
  const hook = (name) => (...args) => {
    calls.push([name].concat(args));
    return undefined;
  };
  const hooks = {
    onCashout: hook('onCashout'),
    onOwed: hook('onOwed'),
    onFloor: hook('onFloor'),
    onHouse: hook('onHouse'),
    onBreach: hook('onBreach'),
    onTransfer: hook('onTransfer'),
    onAccountOpen(acct) {
      calls.push(['onAccountOpen', acct.jid]);
      if (flags.open) {
        flags.open = false;
        throw new Error('injected money.open');
      }
      if (walletSeat.has(acct.wallet)) throw new Error('wallet already seated');
      walletSeat.set(acct.wallet, { snakeId: acct.snakeId });
    },
    onAccountClosed(acct, outcome) {
      calls.push(['onAccountClosed', acct.jid, outcome]);
      const w = walletSeat.get(acct.wallet);
      if (w && w.snakeId === acct.snakeId) walletSeat.delete(acct.wallet);
    },
    journal: {
      open(acct, room) {
        records.push({ t: 'open', jid: acct.jid, room });
        return true;
      },
      close(acct, outcome, extra, room) {
        records.push(Object.assign({ t: 'close', jid: acct.jid, outcome, room }, extra));
        return true;
      },
    },
  };
  return { hooks, calls, of: (name) => calls.filter((c) => c[0] === name), walletSeat, flags, records };
}

function quiet() {
  const lines = [];
  const put = (lvl) => (...a) => lines.push(lvl + ' ' + a.map(String).join(' '));
  return { lines, log: put('log'), warn: put('warn'), error: put('error') };
}

// A seat-view factory that can throw at createSeatView or at the seat's join (the real slView otherwise).
function viewWith(flags) {
  return {
    createWorld: slView.createWorld,
    createSeatView(laws, o) {
      if (flags.createSeatView) {
        flags.createSeatView = false;
        throw new Error('injected createSeatView');
      }
      const v = slView.createSeatView(laws, o);
      if (flags.join) {
        flags.join = false;
        v.join = () => {
          throw new Error('injected view.join');
        };
      }
      return v;
    },
  };
}

let uuidN = 0;
function makePaid(o) {
  const opts = o || {};
  const s = spy();
  const log = quiet();
  const ft = fakeTimers(1000);
  const money = createSlMoney({ stake: 0.5, label: LABEL, hooks: s.hooks, now: ft.clock, log: opts.moneyLog || log,
    uuid: () => '00000000-0000-4000-8000-' + String(++uuidN).padStart(12, '0'), checkEvery: 1, laws: LAWS });
  const room = new SlRoom(opts.laws || LAWS, Object.assign({ money, lobbyType: LABEL, humanCap: 22, seed: opts.seed || 7,
    view: viewWith(s.flags), clock: ft.clock, timers: ft.timers, autoTick: false, shippableOnly: false, prey: false,
    now: () => 1.7e12, log }, opts.room));
  const refunds = [];
  // The door's part around seatPaid (design 3.2 steps 11 and 12): a refusal or a throw refunds the token once, and a
  // throw refunds only when no account holds the jid (seatPaid guarantees there is none, unless the bank refused the
  // account's own refund: then the owed lane pays it, never both). sock: a socket a case planted a fault on.
  function door(n, micro, sock0) {
    const sock = sock0 || bareSocket();
    const jid = jidOf(n);
    const m = micro === undefined ? STAKE : micro;
    let acct = null;
    let threw = null;
    try {
      acct = room.seatPaid(sock, { nick: 'p' + n, cv: n % 9 }, { jid, micro: m, wallet: 'W' + n, name: 'p' + n, paid: m / 1e6 });
    } catch (e) {
      threw = e;
    }
    if (!acct && !room.money.account(jid)) refunds.push({ jid, micro: m, why: threw ? 'seat-failed' : 'full' });
    return { sock, acct, threw, seat: room.seatOf(sock), jid };
  }
  function step(k) {
    for (let i = 0; i < (k || 1); i++) {
      ft.advance(P);
      room.wake();
    }
    ft.runImmediates();
  }
  return { s, ft, money, room, door, refunds, step, log };
}

function layer(sock) {
  const out = [];
  for (const e of sock.emitted) if (e.name === 'sl:x') for (const m of e.data) out.push(m);
  return out;
}

const paidMsgs = (sock) => layer(sock).filter((m) => ['room', 'w', 'lost', 'cashed', 'closed'].includes(m.t));

function i1(money) {
  const b = money.bank;
  assert.equal(b.sums.acc + b.sums.floor + b.ledger.outCash + b.ledger.outRefund + b.ledger.outHouse, b.ledger.in, 'I1');
}

function head(room, id) {
  const s = room.sim.snake(id);
  return [slSnake.headX(s), slSnake.headY(s)];
}

// Steers a seat's snake at (x, y).
function steerTo(room, seat, x, y) {
  const [hx, hy] = head(room, seat.snakeId);
  room.onInput(seat, angle(byteOf(Math.atan2(y - hy, x - hx))));
}

// The census the C1 cases compare: what a seat leaves behind.
function census(room) {
  return { snakes: room.sim.count(), seats: room.seats.size, bySnake: room.bySnake.size, keys: room.keys.size,
    humans: room.humans.size, names: room.names.size, open: room.money.openCount() };
}

// ------------------------------------------------------------------ construction

test('a paid room: the cap folds into R (22, or lower), one failing wake closes it, no bots, its own lobbyType', () => {
  const { room } = makePaid();
  assert.equal(room.R.humanCap, 22);
  assert.equal(room.R.emergencyFails, 1);
  assert.equal(room.lobbyType, LABEL);
  assert.equal(room.botsAllowed(), false);
  assert.equal(room.addBot(), null);
  assert.equal(room.sim.flux(), 2923, 'C_R_MIN: the 22-snake radius');
  assert.throws(() => room.seat(bareSocket(), { nick: 'free', cv: 0 }), /seatPaid/);
  assert.equal(makePaid({ room: { humanCap: 5 } }).room.R.humanCap, 5);
  assert.throws(() => makePaid({ room: { emergencyFails: 3 } }), /first failing wake/);
  assert.throws(() => makePaid({ room: { bots: { add() {} } } }), /no bots/);
  assert.throws(() => makePaid({ room: { lobbyType: 'sl_na_s1' } }), /labelled/);
  assert.throws(() => makePaid({ laws: makeFixture({ C_PAID_HUMAN_CAP: 23 }) }), /C_R_MIN/);
  // no wall-clock seed for a paid room (design 1, D2-m4): the directory must pass its crypto one
  for (const seed of [undefined, 0, -3, 1.5, '7', NaN, 2 ** 53]) {
    assert.throws(() => makePaid({ room: { seed } }), /needs its seed/, String(seed));
  }
  assert.equal(makePaid({ seed: 2147483646 }).room.sim.count(), 0);
  const s = spy();
  const half = createSlMoney({ stake: 0.5, label: LABEL, hooks: s.hooks });
  half.takeChanged = undefined;
  assert.throws(() => new SlRoom(LAWS, { money: half, autoTick: false, shippableOnly: false, prey: false }), /takeChanged/);
  // the free room is unchanged: no money, its own lobbyType, bots allowed, worth 0
  const free = new SlRoom(LAWS, { seed: 1, view: fakeView(), autoTick: false, shippableOnly: false, prey: false });
  assert.equal(free.money, null);
  assert.equal(free.lobbyType, 'sl_na_s0');
  assert.equal(free.botsAllowed(), true);
  assert.equal(free.R.emergencyFails, 3);
  assert.equal(free.liveStakeTotal(), 0);
  assert.throws(() => free.seatPaid(bareSocket(), {}, {}), /paid room/);
});

// ------------------------------------------------------------------ seatPaid (design 3.3)

test('the paid board ranks by worth: {t:lb} rows [name, micro] most first, each seat its own [rank, micro]', () => {
  const { room, door, step } = makePaid();
  const a = door(1);
  const b = door(2, 2 * STAKE);
  step(Math.ceil(3000 / P));
  const last = (sock) => layer(sock).filter((m) => m.t === 'lb').pop();
  assert.deepEqual(last(a.sock), { t: 'lb', rows: [['p2', 2 * STAKE], ['p1', STAKE]], me: [2, STAKE] });
  assert.deepEqual(last(b.sock).me, [1, 2 * STAKE]);
  const board = room._board();
  assert.deepEqual(board.order.map((r) => r.id), [b.seat.snakeId, a.seat.snakeId], 'the binary board in the same order');
});


test('a paid room watcher sees the same $ board: {t:lb} rows most first, me null; it opens no account', () => {
  const { room, money, door, step } = makePaid();
  const a = door(1);
  door(2, 2 * STAKE);
  step(2);
  const opens = money.accounts ? money.accounts.size : 0;
  const ws = bareSocket();
  assert.ok(room.seatWatch(ws, {}), 'a watcher');
  step(Math.ceil(3000 / P));
  const last = (sock) => layer(sock).filter((m) => m.t === 'lb').pop();
  assert.deepEqual(last(ws), { t: 'lb', rows: [['p2', 2 * STAKE], ['p1', STAKE]], me: null });
  assert.deepEqual(last(a.sock).me, [2, STAKE], 'a player keeps its own row');
  assert.equal(money.accounts ? money.accounts.size : 0, opens, 'no account opened');
});

test('seatPaid: the account opens last; the seat gets {t:room} kept and its own {t:w}; the console reads dollars', () => {
  const { room, money, s, door } = makePaid();
  const a = door(1);
  assert.ok(a.acct && !a.threw);
  assert.equal(a.acct.snakeId, a.seat.snakeId);
  assert.equal(money.worthOf(a.seat.snakeId), STAKE);
  assert.deepEqual(s.of('onAccountOpen').map((c) => c[1]), [jidOf(1)]);
  assert.deepEqual(s.records.map((r) => [r.t, r.jid, r.room]), [['open', jidOf(1), LABEL]]);
  const msgs = paidMsgs(a.sock);
  assert.deepEqual(msgs, [{ t: 'room', stake: 0.5, cut: 10 }, { t: 'w', id: a.seat.snakeId, v: STAKE }]);
  assert.ok(layer(a.sock).some((m) => m.t === 'seat' && typeof m.k === 'string'), 'the key message too');
  assert.ok(a.sock.emitted.some((e) => e.name === 'sl:f'), 'flushed at the commit');
  assert.equal(room.ticking, true);
  // the console contract answers in dollars (design 7.5)
  assert.equal(room.liveStakeTotal(), 0.5);
  assert.equal(room.floorWorth, 0);
  assert.deepEqual(Array.from(room.snakes.values()), [{ alive: true, isBot: false, worth: 0.5 }]);
  // one seat per socket: a second seatPaid on it throws (the door refunds that token; no second account)
  assert.throws(() => room.seatPaid(a.sock, {}, { jid: jidOf(2), micro: STAKE, wallet: 'W2' }), /already holds a seat/);
  assert.equal(money.openCount(), 1);
  i1(money);
});

test('C1: a throw at each line of the build, or in money.open, leaves no account, no snake, no seat, no key; the door refunds once', () => {
  const cases = [
    ['createSendQueue', (ctx, sock) => { sock.emit = null; }],
    ['createSeatView', (ctx) => { ctx.s.flags.createSeatView = true; }],
    ['view.join', (ctx) => { ctx.s.flags.join = true; }],
    ['_pushEvents', (ctx) => {
      const push = ctx.room._pushEvents;
      ctx.room._pushEvents = () => {
        ctx.room._pushEvents = push;
        throw new Error('injected _pushEvents');
      };
    }],
    ['the key message', (ctx) => {
      const msg = ctx.room._keyMsg;
      ctx.room._keyMsg = () => {
        ctx.room._keyMsg = msg;
        throw new Error('injected key message');
      };
    }],
    ['money.open', (ctx) => { ctx.s.flags.open = true; }],
  ];
  for (const [name, plant] of cases) {
    const ctx = makePaid();
    const { room, money, s, refunds } = ctx;
    const first = ctx.door(1);
    ctx.step(3);
    const before = census(room);
    const bank0 = JSON.stringify(money.bank.ledger);
    const sock = bareSocket();
    plant(ctx, sock);
    const jid = jidOf(2);
    // through the door's rule (refund iff no account holds the jid), so the count below is the door's, not the test's
    const r = ctx.door(2, STAKE, sock);
    assert.match(r.threw && r.threw.message, /injected|socket with emit/, name);
    assert.equal(r.acct, null, name);
    assert.equal(money.account(jid), null, name + ': no account');
    assert.deepEqual(census(room), before, name + ': nothing of the seat is left');
    assert.equal(room.seatOf(sock), null, name);
    assert.deepEqual(refunds, [{ jid, micro: STAKE, why: 'seat-failed' }], name + ': exactly one refund, the door\'s');
    assert.equal(s.of('onOwed').length, 0, name + ': the money refunds nothing itself');
    assert.equal(s.walletSeat.has('W2'), false, name);
    if (name === 'money.open') {
      // the deposit went in and out again (the rollback), booked as a refund in the bank; the door's token refund is
      // the only money that leaves
      const l = money.bank.ledger;
      assert.deepEqual([l.in, l.outRefund], [2 * STAKE, STAKE], name);
    } else {
      assert.equal(JSON.stringify(money.bank.ledger), bank0, name + ': the bank never moved');
    }
    assert.ok(!s.records.some((r) => r.jid === jid && r.t === 'close'), name + ': the door writes that close, not the money');
    i1(money);
    // the room still seats and steps
    const next = ctx.door(3);
    assert.ok(next.acct, name + ': the next seat opens');
    assert.equal(refunds.length, 1, name + ': and refunds nothing');
    ctx.step(5);
    assert.ok(room.sim.snake(first.seat.snakeId) && room.sim.snake(next.seat.snakeId), name);
    assert.deepEqual(money.lastViolations, [], name);
  }
});

test('C1: a throw after the account opened aborts it (refund booked, seat forgotten) and the door refunds once', () => {
  const ctx = makePaid();
  const { room, money, s, refunds } = ctx;
  ctx.door(1);
  const before = census(room);
  const worth = money.worthOf;
  money.worthOf = () => {
    money.worthOf = worth;
    throw new Error('injected after open');
  };
  const jid = jidOf(2);
  const r = ctx.door(2);
  assert.match(r.threw && r.threw.message, /after open/);
  assert.equal(r.acct, null);
  assert.equal(money.account(jid), null);
  assert.deepEqual(refunds, [{ jid, micro: STAKE, why: 'seat-failed' }], 'exactly one refund, the door\'s');
  const sock = r.sock;
  assert.deepEqual(census(room), before);
  assert.deepEqual(s.of('onAccountClosed').map((c) => [c[1], c[2]]), [[jid, 'aborted']]);
  assert.equal(s.walletSeat.has('W2'), false);
  assert.deepEqual([money.bank.ledger.in, money.bank.ledger.outRefund], [2 * STAKE, STAKE]);
  assert.equal(s.of('onOwed').length, 0);
  assert.equal(sock.emitted.length, 0, 'nothing was sent to the aborted seat');
  assert.ok(ctx.log.lines.some((l) => /SEAT threw after the account opened/.test(l)));
  i1(money);
});

test('C1: a seat whose refund the bank refuses (abort or open\'s rollback) stays open: the door refunds nothing, the room ticks, I4 pays it once', () => {
  for (const path of ['abort', 'rollback']) {
    // the first seat of an auto-ticking room: its clock starts only at the commit (C), which never came
    const ctx = makePaid({ room: { autoTick: true } });
    const { room, money, s, refunds } = ctx;
    if (path === 'abort') {
      const worth = money.worthOf;
      money.worthOf = () => {
        money.worthOf = worth;
        throw new Error('injected after open');
      };
    } else {
      s.flags.open = true;
    }
    const withdraw = money.bank.withdraw.bind(money.bank);
    money.bank.withdraw = (id, kind) => {
      money.bank.withdraw = withdraw;
      throw new Error('injected refusal of ' + kind);
    };
    const r = ctx.door(1);
    assert.match(r.threw && r.threw.message, /injected/, path);
    assert.equal(money.bank.withdraw, withdraw, path + ': the refund was refused');
    assert.ok(money.account(r.jid), path + ': the account stays open');
    assert.equal(room.sim.count(), 0, path + ': the seat is undone');
    assert.deepEqual(refunds, [], path + ': the door refunds nothing (an account holds the jid)');
    assert.equal(room.ticking, true, path + ': the clock runs so I4 can pay it');
    assert.equal(money.tainted, true, path + ': no new seat in this room');
    assert.ok(s.of('onBreach').some((c) => c[1].kind === 'seat-refund-refused' && c[1].jid === r.jid &&
      c[1].micro === STAKE && c[1].why === path), path);
    assert.equal(ctx.door(2).acct, null, path + ': tainted, the next seat is refused');
    assert.deepEqual(refunds, [{ jid: jidOf(2), micro: STAKE, why: 'full' }], path);
    ctx.ft.run(5 * P);
    // the orphan check refunds it through the owed lane, once: never both refunds, never neither
    const key = 'agowed:' + r.jid;
    assert.deepEqual(s.of('onOwed').map((c) => [c[1].key, c[1].micro]), [[key, STAKE]], path);
    assert.ok(s.of('onOwed')[0][1].reason.startsWith('refund slither orphan ' + LABEL), path);
    assert.deepEqual(s.records.filter((x) => x.t === 'close').map((x) => [x.jid, x.outcome, x.why, x.key]),
      [[r.jid, 'refunded', 'orphan', key]], path);
    assert.equal(money.openCount(), 0, path);
    assert.deepEqual([money.bank.ledger.in, money.bank.ledger.outRefund], [STAKE, STAKE], path);
    i1(money);
    room.halt();
  }
});

// ------------------------------------------------------------------ cap, bots, pause

test('cap 22: the 23rd is refused (a gliding snake still counts), the border radius stays 2923, I10 never fires', () => {
  const ctx = makePaid();
  const { room, money } = ctx;
  const seated = [];
  for (let n = 1; n <= 22; n++) seated.push(ctx.door(n));
  assert.ok(seated.every((x) => x.acct));
  const extra = ctx.door(23);
  assert.equal(extra.acct, null);
  assert.equal(room.refusal(), 'full');
  assert.deepEqual(ctx.refunds, [{ jid: jidOf(23), micro: STAKE, why: 'full' }]);
  // one leaves: its snake glides and still counts until the glide ends
  room.unseat(seated[0].sock, 'leave');
  assert.equal(ctx.door(24).acct, null, 'the gliding snake still holds its place');
  for (let k = 0; k < 400; k++) {
    ctx.step();
    assert.equal(room.sim.flux(), 2923, 'step ' + k);
    assert.ok(room.sim.count() <= 22);
    assert.deepEqual(money.lastViolations, [], 'step ' + k);
  }
  assert.equal(room.orphans.size, 0, 'the glide ended');
  assert.ok(ctx.door(25).acct, 'a place is free again');
  i1(money);
});

test('idle pause: never while an account is open; once the last one closed it pauses as the free room does', () => {
  const ft = fakeTimers(1000);
  const s = spy();
  const money = createSlMoney({ stake: 0.5, label: LABEL, hooks: s.hooks, now: ft.clock, log: quiet(), checkEvery: 1 });
  const room = new SlRoom(LAWS, { money, seed: 3, view: fakeView(), clock: ft.clock, timers: ft.timers,
    shippableOnly: false, prey: false, now: () => 1.7e12, log: quiet() });
  const sock = bareSocket();
  const acct = room.seatPaid(sock, { nick: 'a', cv: 1 }, { jid: jidOf(1), micro: STAKE, wallet: 'W1', name: 'a' });
  assert.ok(acct);
  // the seat is gone from every list the free rule reads, but its money is still open
  const open = money.openCount;
  money.openCount = () => 1;
  room.seats.clear();
  ft.run(70000);
  assert.equal(room.paused, false, 'no pause with an account open');
  assert.ok(room.stats.steps > 1500);
  money.openCount = open;
  if (money.openCount() > 0) money.emergencySettle('test');
  ft.run(61000 + 2 * P);
  assert.equal(room.paused, true, 'paused once no account is open');
  room.stop();
});

// ------------------------------------------------------------------ messages, cash-out, death

test('{t:w}: once per wake to the own seat (with its delta) and the seats holding the snake only; with every add of a paid snake', () => {
  const ctx = makePaid({ seed: 11 });
  const { room, money } = ctx;
  const a = ctx.door(1);
  const b = ctx.door(2);
  const c = ctx.door(3);
  ctx.step(2);
  const A = a.seat.snakeId;
  // a change of A's worth this wake: B's client holds A, C's does not
  b.seat.queue.holdsSnake = (id) => id === A;
  c.seat.queue.holdsSnake = () => false;
  const take = money.takeChanged.bind(money);
  let once = [{ id: A, v: 500123, d: 123 }];
  money.takeChanged = () => {
    const out = once;
    once = [];
    take();
    return out;
  };
  const n0 = [a, b, c].map((x) => paidMsgs(x.sock).length);
  ctx.step();
  const got = [a, b, c].map((x, i) => paidMsgs(x.sock).slice(n0[i]));
  assert.deepEqual(got[0], [{ t: 'w', id: A, v: 500123, d: 123 }]);
  assert.deepEqual(got[1], [{ t: 'w', id: A, v: 500123 }]);
  assert.deepEqual(got[2], []);
  ctx.step(3);
  assert.deepEqual([a, b, c].map((x, i) => paidMsgs(x.sock).length - n0[i]), [1, 1, 0], 'once per change, not per wake');
  // a seat that picks a paid snake up gets its worth with the add (the join bundle here), its own with the commit
  money.takeChanged = take;
  const d = ctx.door(4);
  const adds = [];
  for (const e of d.sock.emitted) if (e.name === 'sl:f') for (const ev of W.decodeBundle(e.data)) if (ev.type === 'snake_add') adds.push(ev.id);
  const ws = paidMsgs(d.sock).filter((m) => m.t === 'w').map((m) => m.id);
  const others = adds.filter((id) => id !== d.seat.snakeId);
  assert.ok(others.length > 0, 'the new seat sees another paid snake');
  assert.deepEqual(ws.sort(), others.concat([d.seat.snakeId]).sort());
});

test('resume: the first sl:x after sl:back carries back, room and the own w again', () => {
  const ctx = makePaid();
  const { room } = ctx;
  const a = ctx.door(1);
  ctx.step(3);
  const key = a.seat.key;
  const n = a.seat.queue.sentSeq;
  room.unseat(a.sock, 'disconnect');
  ctx.step(2);
  const sock = bareSocket();
  const res = room.resume(sock, key, n, 0);
  assert.ok(res && res.seat === a.seat);
  const firstX = sock.emitted.find((e) => e.name === 'sl:x').data;
  assert.deepEqual(firstX.slice(0, 3).map((m) => m.t), ['back', 'room', 'w']);
  assert.deepEqual(firstX[1], { t: 'room', stake: 0.5, cut: 10 });
  assert.deepEqual(firstX[2], { t: 'w', id: a.seat.snakeId, v: STAKE });
});

test('cash-out, money first: one order and {t:cashed} with 500000 / 50000 / 450000; a death sends kept {t:lost}', () => {
  const ctx = makePaid();
  const { room, money, s } = ctx;
  const a = ctx.door(1);
  const b = ctx.door(2);
  const A = a.seat.snakeId;
  const B = b.seat.snakeId;
  // A holds Q to the end (heard every wake), steering locked; B dives at the border
  room.onHold(a.seat, true);
  let k = 0;
  while (room.sim.snake(A) && k++ < 200) {
    room.onHold(a.seat, true);
    if (room.sim.snake(B)) steerTo(room, b.seat, GRD + 50000 * Math.cos(1), GRD + 50000 * Math.sin(1));
    ctx.step();
  }
  assert.equal(room.sim.snake(A), null, 'A cashed out');
  const orders = s.of('onCashout').map((c) => c[1]);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].grossMicro, STAKE);
  assert.equal(orders[0].wallet, 'W1');
  assert.equal(orders[0].socketId, a.sock.id);
  const cashed = paidMsgs(a.sock).filter((m) => m.t === 'cashed');
  assert.equal(cashed.length, 1);
  assert.deepEqual([cashed[0].gross, cashed[0].cut, cashed[0].net, cashed[0].cid], [500000, 50000, 450000, orders[0].cashoutId]);
  assert.ok(cashed[0].len > 0);
  assert.equal(money.account(A), null);
  // B: the border death splits its worth over its drops (C_PAID_BORDER_DROPS) and its seat hears lost
  while (room.sim.snake(B) && k++ < 2000) {
    steerTo(room, b.seat, GRD + 50000 * Math.cos(1), GRD + 50000 * Math.sin(1));
    ctx.step();
  }
  assert.equal(room.sim.snake(B), null, 'B died');
  assert.deepEqual(paidMsgs(b.sock).filter((m) => m.t === 'lost'), [{ t: 'lost', v: STAKE }]);
  assert.equal(money.bank.floorMicro(), STAKE, 'B\'s whole worth is gold on the floor');
  assert.deepEqual(money.lastViolations, []);
  i1(money);
});

// ------------------------------------------------------------------ a step that throws (design 5, 7.4)

test('a throwing step with a kill death in it: the facts applied, the room closed, 100% owed rows of the GROWN balances, the floor to the house', () => {
  const ctx = makePaid({ seed: 5 });
  const { room, money, s } = ctx;
  const seats = [1, 2, 3, 4].map((n) => ctx.door(n));
  const [a, b, c, d] = seats;
  const A = a.seat.snakeId;
  const B = b.seat.snakeId;
  const C = c.seat.snakeId;
  const homes = new Map([[B, [GRD + 900, GRD]], [C, [GRD - 900, GRD]]]);
  const safe = () => {
    for (const x of [b, c]) if (room.seats.has(x.sock.id) && room.sim.snake(x.seat.snakeId)) steerTo(room, x.seat, ...homes.get(x.seat.snakeId));
  };
  // D leaves: it glides 3 s and dies (a kill death), its 500000 becomes gold
  room.unseat(d.sock, 'leave');
  let k = 0;
  while (money.openCount() === 4 && k++ < 300) {
    safe();
    steerTo(room, a.seat, GRD, GRD);
    ctx.step();
  }
  assert.equal(money.openCount(), 3, 'D died');
  assert.ok(money.bank.floorMicro() === STAKE);
  // A eats D's gold until it has grown
  while (money.worthOf(A) === STAKE && k++ < 3000) {
    safe();
    let best = null;
    let bd = Infinity;
    const [hx, hy] = head(room, A);
    for (const f of money.bank.floor.keys()) {
      const dd = Math.hypot(f.x - hx, f.y - hy);
      if (dd < bd) {
        bd = dd;
        best = f;
      }
    }
    if (best) steerTo(room, a.seat, best.x, best.y);
    ctx.step();
  }
  assert.ok(money.worthOf(A) > STAKE, 'A grew: ' + money.worthOf(A));
  assert.equal(money.openCount(), 3);
  // B leaves; on the step its glide's kill is due, the next step throws in its food pass (after Phase A)
  room.unseat(b.sock, 'leave');
  while (!(room.orphans.get(B) && room.orphans.get(B).killed) && k++ < 400) {
    safe();
    steerTo(room, a.seat, GRD, GRD);
    ctx.step();
  }
  assert.ok(room.orphans.get(B).killed, 'B\'s kill is due at the next step');
  const grown = money.worthOf(A);
  const pass = room.sim.food.step;
  room.sim.food.step = () => {
    room.sim.food.step = pass;
    throw new Error('injected step');
  };
  let closedWith = null;
  room.onClosed = (r, sockets) => {
    closedWith = sockets;
  };
  ctx.ft.advance(P);
  assert.throws(() => room.wake(), /injected step/);
  assert.equal(room.closed, true);
  assert.equal(room.stopped, true);
  // the facts of the step that threw: B's kill death split over its drops (its journal close is died), then
  const died = s.records.filter((r) => r.t === 'close' && r.outcome === 'died').map((r) => r.jid);
  assert.deepEqual(died, [jidOf(4), jidOf(2)]);
  // every open account through the owed lane at 100% of its balance: A grown, C its deposit, none for B or D
  const owed = s.of('onOwed').map((x) => x[1]);
  assert.deepEqual(owed.map((r) => [r.key, r.micro]).sort(), [['agowed:' + jidOf(1), grown], ['agowed:' + jidOf(3), STAKE]].sort());
  for (const r of owed) {
    assert.match(r.key, OWED_KEY);
    assert.ok(r.reason.startsWith('refund slither emergency ' + LABEL + ' agowed:'));
  }
  assert.ok(grown > STAKE);
  // the journal closes carry the keys (the replay net, design 7.4)
  for (const n of [1, 3]) {
    const cl = s.records.filter((r) => r.t === 'close' && r.jid === jidOf(n));
    assert.deepEqual(cl.map((r) => [r.outcome, r.why, r.key]), [['refunded', 'emergency', 'agowed:' + jidOf(n)]]);
  }
  // the floor (what is left of D's gold and all of B's) to the house, one sweep per source wallet
  const sweeps = s.of('onFloor').map((x) => x[1]);
  assert.deepEqual(sweeps.map((x) => x.srcWallet).sort(), ['W2', 'W4']);
  const l = money.bank.ledger;
  assert.equal(money.bank.house.swept, sweeps.reduce((t, x) => t + x.micro, 0));
  assert.equal(l.in, 4 * STAKE);
  assert.equal(l.outRefund, grown + STAKE);
  assert.equal(l.outHouse + l.outRefund, 4 * STAKE, 'every micro is refunded or the house\'s');
  assert.equal(money.bank.sums.acc + money.bank.sums.floor, 0);
  assert.deepEqual(room.settled.left, []);
  i1(money);
  // the seats hear closed, flushed at once; the room hands its sockets on
  assert.deepEqual(paidMsgs(a.sock).filter((m) => m.t === 'closed'), [{ t: 'closed', why: 'emergency', refunded: grown }]);
  assert.deepEqual(paidMsgs(c.sock).filter((m) => m.t === 'closed'), [{ t: 'closed', why: 'emergency', refunded: STAKE }]);
  assert.deepEqual(closedWith, [a.sock, c.sock]);
  assert.equal(s.of('onCashout').length, 0);
});

test('C-6: a throw in sim.remove right after a paid cash-out: exactly one payout order, owed rows for the other accounts only', () => {
  const ctx = makePaid();
  const { room, money, s } = ctx;
  const a = ctx.door(1);
  const b = ctx.door(2);
  const A = a.seat.snakeId;
  const remove = room.sim.remove;
  room.sim.remove = (id) => {
    if (id === A) throw new Error('injected remove');
    return remove(id);
  };
  room.onHold(a.seat, true);
  let threw = null;
  for (let k = 0; k < 200 && !threw; k++) {
    room.onHold(a.seat, true);
    steerTo(room, b.seat, GRD, GRD);
    ctx.ft.advance(P);
    try {
      room.wake();
    } catch (e) {
      threw = e;
    }
  }
  assert.match(threw && threw.message, /injected remove/);
  assert.equal(room.closed, true);
  const orders = s.of('onCashout').map((x) => x[1]);
  assert.equal(orders.length, 1, 'exactly one payout order');
  assert.equal(orders[0].grossMicro, STAKE);
  assert.equal(orders[0].wallet, 'W1');
  assert.deepEqual(s.of('onOwed').map((x) => [x[1].key, x[1].micro]), [['agowed:' + jidOf(2), STAKE]]);
  assert.deepEqual(s.records.filter((r) => r.t === 'close' && r.jid === jidOf(1)).map((r) => r.outcome), ['cashedout']);
  assert.deepEqual([money.bank.ledger.outCash, money.bank.ledger.outRefund], [STAKE, STAKE]);
  assert.ok(ctx.log.lines.some((l) => /CASHOUT CRITICAL snake .* paid .* but its removal threw/.test(l)));
  assert.ok(s.of('onBreach').some((x) => x[1].kind === 'cashout-removal'));
  i1(money);
});

test('a refused cash-out keeps the snake playing: its hold ends, no order, the account untouched', () => {
  const ctx = makePaid();
  const { room, money, s } = ctx;
  const a = ctx.door(1);
  const A = a.seat.snakeId;
  const cash = money.cashOut.bind(money);
  money.cashOut = () => {
    money.cashOut = cash;
    throw new Error('injected refusal before the withdraw');
  };
  room.onHold(a.seat, true);
  for (let k = 0; k < 200 && money.cashOut !== cash; k++) {
    room.onHold(a.seat, true);
    ctx.step();
  }
  assert.equal(money.cashOut, cash, 'the refusal happened');
  assert.ok(room.sim.snake(A), 'it keeps playing');
  assert.equal(room.holds.holding(A), false);
  assert.equal(money.worthOf(A), STAKE);
  assert.equal(s.of('onCashout').length, 0);
  assert.ok(layer(a.sock).some((m) => m.t === 'hold' && m.id === A && m.on === 0), 'the ring ended');
  assert.ok(!paidMsgs(a.sock).some((m) => m.t === 'cashed'));
  ctx.step(5);
  assert.deepEqual(money.lastViolations, []);
});

// Holds seat a's snake until cashOut has run (or the wake threw); -> the wake's throw, if any.
function holdToCashOut(ctx, a, done) {
  ctx.room.onHold(a.seat, true);
  for (let k = 0; k < 200 && !done(); k++) {
    ctx.room.onHold(a.seat, true);
    ctx.ft.advance(P);
    try {
      ctx.room.wake();
    } catch (e) {
      return e;
    }
    ctx.ft.runImmediates();
  }
  return null;
}

test('cash-out: a throw before the withdraw (the cashout id) is CRITICAL and alerted, the snake plays on; a logger that throws on the order line still pays', () => {
  const ctx = makePaid();
  const { room, money, s } = ctx;
  const a = ctx.door(1);
  const A = a.seat.snakeId;
  const uuid = money.uuid;
  money.uuid = () => {
    money.uuid = uuid;
    throw new Error('injected uuid');
  };
  assert.equal(holdToCashOut(ctx, a, () => money.uuid === uuid), null);
  assert.equal(money.uuid, uuid, 'cashOut ran');
  assert.ok(room.sim.snake(A) && money.worthOf(A) === STAKE, 'it keeps playing, the account untouched');
  assert.equal(s.of('onCashout').length, 0);
  assert.ok(s.of('onBreach').some((c) => c[1].kind === 'cashout-refused' && c[1].snakeId === A));
  assert.ok(ctx.log.lines.some((l) => /CASHOUT CRITICAL refused for snake .* it keeps playing: injected uuid/.test(l)));
  // the money's logger throws on every line it writes with log(): the withdrawn account is still paid, once
  const ctx2 = makePaid({ moneyLog: { log() { throw new Error('stdout gone'); }, warn() {}, error() {} } });
  const b = ctx2.door(1);
  assert.equal(holdToCashOut(ctx2, b, () => ctx2.money.openCount() === 0), null);
  const orders = ctx2.s.of('onCashout').map((c) => c[1]);
  assert.deepEqual(orders.map((o) => [o.grossMicro, o.wallet]), [[STAKE, 'W1']], 'exactly one payout order');
  assert.deepEqual(paidMsgs(b.sock).filter((m) => m.t === 'cashed'),
    [{ t: 'cashed', len: paidMsgs(b.sock).find((m) => m.t === 'cashed').len, gross: STAKE, cut: 50000, net: 450000,
      cid: orders[0].cashoutId }]);
  assert.equal(ctx2.room.sim.snake(b.seat.snakeId), null);
  i1(ctx2.money);
});

test('cash-out: cashOut throwing after the withdraw is alerted as unconfirmed with its gross (the snake leaves); a throw in the length is CRITICAL', () => {
  // cashOut withdrew, closed and dispatched, then threw: the room cannot know the order went out, so it alerts
  const ctx = makePaid();
  const { room, money, s } = ctx;
  const a = ctx.door(1);
  const A = a.seat.snakeId;
  const cash = money.cashOut.bind(money);
  money.cashOut = (...args) => {
    money.cashOut = cash;
    cash(...args);
    throw new Error('injected after the withdraw');
  };
  assert.equal(holdToCashOut(ctx, a, () => money.cashOut === cash), null);
  assert.equal(money.account(A), null);
  assert.equal(room.sim.snake(A), null, 'it leaves like any cash-out');
  assert.deepEqual(paidMsgs(a.sock).filter((m) => m.t === 'cashed').map((m) => Object.keys(m).sort()), [['len', 't']]);
  assert.ok(ctx.log.lines.some((l) => new RegExp('CASHOUT CRITICAL snake ' + A + ' withdrawn \\(500000 micro\\) but ' +
    'cashOut threw, its order is unconfirmed').test(l)));
  assert.deepEqual(s.of('onBreach').map((c) => c[1]).filter((b) => b.kind === 'cashout-unconfirmed'),
    [{ snakeId: A, micro: STAKE, kind: 'cashout-unconfirmed', lobbyType: LABEL }]);
  assert.equal(s.of('onCashout').length, 1);
  i1(money);
  // the length of the cashed message throws after the withdraw: CRITICAL with the order's id, alerted, the room closes
  const ctx2 = makePaid();
  const b = ctx2.door(1);
  ctx2.door(2);
  const len = ctx2.room._lenOf;
  ctx2.room._lenOf = () => {
    ctx2.room._lenOf = len;
    throw new Error('injected length');
  };
  const threw = holdToCashOut(ctx2, b, () => false);
  assert.match(threw && threw.message, /injected length/);
  assert.equal(ctx2.room.closed, true);
  const orders = ctx2.s.of('onCashout').map((c) => c[1]);
  assert.equal(orders.length, 1, 'exactly one payout order');
  assert.ok(ctx2.log.lines.some((l) => l.includes('CASHOUT CRITICAL snake ' + b.seat.snakeId + ' paid (' +
    orders[0].cashoutId + ') but its removal threw')));
  assert.ok(ctx2.s.of('onBreach').some((c) => c[1].kind === 'cashout-removal'));
  assert.deepEqual(ctx2.s.of('onOwed').map((c) => [c[1].key, c[1].micro]), [['agowed:' + jidOf(2), STAKE]]);
  i1(ctx2.money);
});

// ------------------------------------------------------------------ a fact the bank refuses (design 5)

// Steers seat's snake straight out from the centre.
function dive(room, seat) {
  const [hx, hy] = head(room, seat.snakeId);
  room.onInput(seat, angle(byteOf(Math.atan2(hy - GRD, hx - GRD))));
}

test('a fact the bank refuses in a live room: a failed split is paid back 100% as an orphan (I6 for its cashless gold), a failed credit strands one pellet (I8 that step, I5 from then on)', () => {
  // the split of B's border death throws: B's account outlives its snake, I4 refunds it through the owed lane the same
  // step (so I8 never sees it), nobody else gains, and B's drops are gold foods with no pellet behind them (I6)
  {
    const ctx = makePaid({ seed: 5 });
    const { room, money, s } = ctx;
    const a = ctx.door(1);
    const b = ctx.door(2);
    const split = money.bank.split;
    money.bank.split = () => {
      money.bank.split = split;
      throw new Error('injected split');
    };
    const kinds = new Map();
    const tally = () => {
      for (const v of money.lastViolations) kinds.set(v.kind, (kinds.get(v.kind) || 0) + 1);
      i1(money);
    };
    let k = 0;
    while (money.account(b.jid) && k++ < 3000) {
      dive(room, b.seat);
      steerTo(room, a.seat, GRD, GRD);
      ctx.step();
      tally();
    }
    assert.equal(money.bank.split, split, 'the split threw');
    assert.equal(room.sim.snake(b.seat.snakeId), null, 'B died');
    for (let j = 0; j < 30; j++) {
      steerTo(room, a.seat, GRD, GRD);
      ctx.step();
      tally();
    }
    assert.deepEqual(Array.from(kinds.keys()), ['I6'], JSON.stringify(Array.from(kinds)));
    const key = 'agowed:' + b.jid;
    assert.deepEqual(s.of('onOwed').map((c) => [c[1].key, c[1].micro]), [[key, STAKE]], 'exactly one owed row, B\'s');
    assert.ok(s.of('onOwed')[0][1].reason.startsWith('refund slither orphan ' + LABEL));
    assert.deepEqual(s.records.filter((x) => x.t === 'close').map((x) => [x.jid, x.outcome, x.why]), [[b.jid, 'refunded', 'orphan']]);
    const alerts = s.of('onBreach').map((c) => c[1].kind);
    assert.equal(alerts.filter((x) => x === 'fact').length, 1);
    assert.equal(alerts.filter((x) => x === 'I4').length, 1);
    assert.deepEqual([money.worthOf(a.seat.snakeId), money.bank.floorMicro()], [STAKE, 0], 'A gained nothing, no cash on the floor');
    assert.equal(money.tainted, false);
  }
  // the first credit of B's gold throws: the sim ate the food, the bank kept the pellet; I8 that step, and I5 every
  // step for the stranded pellet (its micro waits on the floor for the sweep), and every other eat still credits
  {
    const ctx = makePaid({ seed: 5 });
    const { room, money, s } = ctx;
    const a = ctx.door(1);
    const b = ctx.door(2);
    let k = 0;
    while (money.account(b.jid) && k++ < 3000) {
      dive(room, b.seat);
      steerTo(room, a.seat, GRD, GRD);
      ctx.step();
    }
    assert.equal(money.bank.floorMicro(), STAKE, 'B died, its 500000 is gold');
    const credit = money.bank.credit;
    money.bank.credit = function (f, id) {
      if (!this.floor.has(f)) return credit.call(this, f, id);
      money.bank.credit = credit;
      throw new Error('injected credit');
    };
    const kinds = [];
    let after = -1;
    for (let j = 0; j < 3000 && (after < 0 || j - after < 30); j++) {
      let best = null;
      let bd = Infinity;
      const [hx, hy] = head(room, a.seat.snakeId);
      for (const f of money.bank.floor.keys()) {
        if (room.sim.food.get(f.id) !== f) continue;
        const dd = Math.hypot(f.x - hx, f.y - hy);
        if (dd < bd) {
          bd = dd;
          best = f;
        }
      }
      if (best) steerTo(room, a.seat, best.x, best.y);
      else steerTo(room, a.seat, GRD, GRD);
      ctx.step();
      if (after < 0 && money.bank.credit === credit) after = j;
      if (after >= 0) kinds.push(money.lastViolations.map((v) => v.kind));
      i1(money);
    }
    assert.ok(after >= 0, 'the credit threw');
    assert.deepEqual(kinds[0].slice().sort(), ['I5', 'I8'], 'the step of the failed eat');
    for (const ks of kinds.slice(1)) assert.deepEqual(ks, ['I5'], 'the stranded pellet, every step after');
    const stranded = Array.from(money.bank.floor).filter(([f]) => room.sim.food.get(f.id) !== f);
    assert.equal(stranded.length, 1, 'one pellet whose food is gone');
    assert.ok(stranded[0][1].micro > 0);
    assert.equal(money.worthOf(a.seat.snakeId) + money.bank.floorMicro(), 2 * STAKE, 'nothing left the room');
    assert.ok(money.worthOf(a.seat.snakeId) > STAKE, 'the other eats still credit');
    assert.equal(s.of('onBreach').filter((c) => c[1].kind === 'fact').length, 1);
    assert.equal(s.of('onOwed').length, 0);
    assert.equal(money.tainted, false);
  }
});

// ------------------------------------------------------------------ stop, halt

test('stop() never settles: the account stays open, CRITICAL and an alert; halt() stops the clock only', () => {
  const ctx = makePaid();
  const { room, money, s } = ctx;
  const a = ctx.door(1);
  ctx.step(2);
  room.unseat(ctx.door(2).sock, 'disconnect');
  const ledger = JSON.stringify(money.bank.ledger);
  room.halt();
  assert.equal(room.stopped, true);
  assert.equal(room.timer, null);
  assert.equal(room.parked.size, 1, 'halt leaves the seats as they are');
  assert.equal(room.orphans.size, 1);
  assert.equal(room.wake(), 0);
  assert.equal(money.openCount(), 2);
  const other = makePaid();
  other.door(1);
  other.room.stop();
  assert.equal(other.money.openCount(), 1, 'stop settled nothing');
  assert.equal(other.money.bank.ledger.outRefund, 0);
  assert.ok(other.log.lines.some((l) => /STOP CRITICAL sl_na_s0_5 stopped with 1 open account\(s\) and 500000 micro/.test(l)));
  assert.ok(other.s.of('onBreach').some((x) => x[1].kind === 'stop-with-money'));
  assert.equal(other.s.of('onOwed').length + other.s.of('onCashout').length, 0);
  assert.equal(JSON.stringify(money.bank.ledger), ledger);
  assert.ok(a.acct);
  assert.equal(s.of('onOwed').length, 0);
});
