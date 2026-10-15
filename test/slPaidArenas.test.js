'use strict';
// The paid sl directory (PAID-SL-DESIGN.md 1, 2, 7.2, 7.5, 11.1 slPaidArenas; task T4): real SlRooms with real money
// controllers on spy hooks, seated through the real slSockets and the paid door (test/slPaidFakes.js).
//   - rooms: lazy, labelled, fullest with space first, at most ROOMS_PER_RUNG, a crypto seed, the paid overrides
//   - rows: players = open accounts (live, gliding or parked, each once), parked = gliding accounts; closed under the
//     switch and listed only while an account is open; settling rooms summed; no rungs, no rows
//   - roomOf follows a resume (the seat scan), roomForKey finds a parked seat's key
//   - walletSeat: set at the open, cleared at every close, agrees with every bank (I9 across rooms)
//   - idle retire: the floor to the house once per source wallet with its exact micro and a unique sweepId, I1 holds, a
//     second sweep books nothing, a room with an account (or a gliding snake) is never retired
//   - an emergency close: the room leaves its rung, its sockets are let go; one whose settle left an account open stays
//     on settling (all(), rows, the dollars) until the sweep's retry pays it through the owed lane
//   - shutdownSettle: every room's money rows first (100% of the current balance), then its clock stops; the dollars
//   - maxSliceMs reads and resets; humanTotal counts accounts; the switch refuses to reopen while stopping
const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../shared/slWire.js');
const { paidRig, moneySpy, jidLike } = require('./slPaidFakes');
const { makeFixture } = require('./slLawsFixture');
const { SlRoom } = require('../server/sl/slRoom');
const { SlPaidArenas } = require('../server/slPaid/slPaidArenas');
const { checkWalletSeats } = require('../server/slPaid/slCheck');
const { ROOMS_PER_RUNG, FLOOR_SWEEP_MS } = require('../server/slPaid/slPaidConst');

const LAWS = makeFixture();
const PING = W.encodeInput([{ type: 'ping' }]); // any upstream packet keeps a hold alive (C_HOLD_SAFETY_MS)

function i1(room) {
  const b = room.money.bank;
  assert.equal(b.sums.acc + b.sums.floor + b.ledger.outCash + b.ledger.outRefund + b.ledger.outHouse, b.ledger.in, 'I1');
}

function frames(s) {
  return s.emitted.filter((e) => e.name === 'sl:f').length;
}

function keyOf(s) {
  const m = s.emitted.filter((e) => e.name === 'sl:x').flatMap((e) => e.data).filter((x) => x.t === 'seat' || x.t === 'back');
  return m[m.length - 1].k;
}

// Steps until every gliding snake of the paid rooms has died (C_DISCONNECT), at most k steps.
function untilGlidesEnd(r, k) {
  let n = 0;
  while (r.paid.rooms().some((room) => room.orphans.size > 0) && n++ < (k || 400)) r.step();
}

test('the directory needs the server\'s hooks when paid; none without', () => {
  const m = moneySpy();
  assert.doesNotThrow(() => new SlPaidArenas(LAWS, { paid: true, moneyHooks: m.hooks, shippableOnly: false }));
  for (const k of ['onCashout', 'onOwed', 'onFloor', 'onHouse', 'onBreach', 'onTransfer', 'journal']) {
    const h = Object.assign({}, m.hooks, { [k]: undefined });
    assert.throws(() => new SlPaidArenas(LAWS, { paid: true, moneyHooks: h, shippableOnly: false }), new RegExp(k));
  }
  assert.doesNotThrow(() => new SlPaidArenas(LAWS, { paid: false, shippableOnly: false }));
  assert.throws(() => new SlPaidArenas(LAWS, { paid: true, moneyHooks: m.hooks, seed: 0 }), /seed/);
});

test('rooms: lazy, labelled, fullest with space first, at most ROOMS_PER_RUNG; a crypto seed; the paid overrides', () => {
  const m = moneySpy();
  const made = [];
  const A = new SlPaidArenas(LAWS, { paid: true, moneyHooks: m.hooks, shippableOnly: false, autoTick: false, prey: false,
    log: { log() {}, warn() {}, error() {} },
    makeRoom: (l, ro) => { made.push(ro); return new SlRoom(l, ro); } });
  assert.deepEqual(A.rooms(), [], 'no room before a join');
  assert.deepEqual([A.hasSpace(0.5), A.hasSpace(1), A.hasSpace(2)], [true, true, false]);
  const r0 = A.seatFor(0.5);
  assert.equal(A.seatFor(0.5), r0, 'an empty room with space is reused, not a second one');
  assert.equal(r0.lobbyType, 'sl_na_s0_5');
  assert.equal(A.seatFor(1).lobbyType, 'sl_na_s1');
  assert.equal(A.seatFor(0.5, r0).lobbyType, 'sl_na_s0_5#1');
  assert.equal(A.labelOf(0.5, 3), 'sl_na_s0_5#3');
  for (const ro of made) {
    assert.ok(Number.isSafeInteger(ro.seed) && ro.seed >= 1 && ro.seed < 2 ** 31 - 1, 'crypto seed ' + ro.seed);
    assert.equal(ro.humanCap, 22);
    assert.equal(ro.emergencyFails, 1);
    assert.equal(ro.bots, undefined, 'no bots');
    assert.equal(ro.money.label, ro.lobbyType);
  }
  assert.notEqual(made[0].seed, made[1].seed);
  assert.equal(r0.R.humanCap, 22);
  assert.equal(r0.botsAllowed(), false);
  // fullest first, through the door: 4 rooms of 2 (the cap patched), filled in index order
  const r = paidRig({ rig: { patch: { C_PAID_HUMAN_CAP: 2 } } });
  const socks = [];
  for (let i = 0; i < 2 * ROOMS_PER_RUNG; i++) socks.push(r.join(r.mint({})));
  assert.deepEqual(socks.map((s) => r.paid.roomOf(s.id).lobbyType),
    ['sl_na_s0_5', 'sl_na_s0_5', 'sl_na_s0_5#1', 'sl_na_s0_5#1', 'sl_na_s0_5#2', 'sl_na_s0_5#2', 'sl_na_s0_5#3', 'sl_na_s0_5#3']);
  assert.equal(r.paid.hasSpace(0.5), false);
  assert.equal(r.paid.seatFor(0.5), null);
  // a seat leaves room #1 (its snake glides, then dies): the fullest room WITH space is #1 itself; with #2 also
  // short of one, the lower index wins
  socks[2].fire('sl:leave');
  socks[2].disconnect();
  untilGlidesEnd(r);
  assert.equal(r.paid.seatFor(0.5).lobbyType, 'sl_na_s0_5#1');
});

test('rows: players = open accounts (gliding and parked once each), parked = gliding; the switch; settling summed', () => {
  const r = paidRig();
  assert.deepEqual(r.paid.boardRows().map((x) => [x.id, x.players, x.state, x.capacity]),
    [['sl:na:s0.5', 0, 'open', 0], ['sl:na:s1', 0, 'open', 0]]);
  const a = r.join(r.mint({}));
  const b = r.join(r.mint({}));
  r.join(r.mint({ stake: 1, worth: 1, paid: 1 }), { auth: { stake: 1 } });
  r.step(2);
  // b drops (parked, its snake glides): still one player, and parked 1
  b.disconnected = true;
  b.fire('disconnect', 'transport close');
  const rows = r.paid.boardRows();
  assert.deepEqual(rows[0], { id: 'sl:na:s0.5', game: 'snake', region: 'na', stake: 0.5, players: 2, parked: 1, bots: 0,
    capacity: 22, state: 'open' });
  assert.deepEqual([rows[1].players, rows[1].parked], [1, 0]);
  assert.equal(r.paid.humanTotal(), 3);
  // the switch: rows say closed, and a rung with nobody in it is not listed
  r.paid.setPaidOpen(false);
  assert.deepEqual(r.paid.boardRows().map((x) => [x.id, x.state, x.players]), [['sl:na:s0.5', 'closed', 2], ['sl:na:s1', 'closed', 1]]);
  untilGlidesEnd(r);
  a.fire('sl:leave');
  a.disconnect();
  untilGlidesEnd(r);
  assert.deepEqual(r.paid.boardRows().map((x) => [x.id, x.state, x.players]), [['sl:na:s1', 'closed', 1]]);
  r.paid.setPaidOpen(true);
  assert.equal(r.paid.boardRows().length, 2);
  // no rungs: no rows
  assert.deepEqual(paidRig({ paid: false }).paid.boardRows(), []);
});

test('roomOf follows a resume; roomForKey finds a parked seat; nothing routes to a stopped room', () => {
  const r = paidRig();
  const s = r.join(r.mint({}));
  const room = r.paid.roomOf(s.id);
  r.step(3);
  const k = keyOf(s);
  assert.equal(r.paid.roomForKey(k), room);
  s.disconnected = true;
  s.fire('disconnect', 'transport close');
  assert.equal(r.paid.roomOf(s.id), null, 'parked: no socket holds the seat');
  assert.equal(r.paid.roomForKey(k), room, 'the key still names it');
  const t = r.paidSock(undefined, { auth: { entryToken: undefined } });
  const back = room.resume(t, k, frames(s), 0);
  assert.ok(back && back.seat, 'resumed');
  assert.equal(r.paid.roomOf(t.id), room, 'the seat scan follows the new socket id');
  assert.equal(r.paid.roomForKey('no-such-key'), null);
  room.halt();
  assert.equal(r.paid.roomOf(t.id), null);
  assert.equal(r.paid.roomForKey(keyOf(t)), null);
  assert.equal(r.paid.input(t.id, Buffer.from([1])), false);
});

test('walletSeat: set at the open, cleared at every close (cash-out, death), agrees with every bank', () => {
  const r = paidRig();
  const a = r.join(r.mint({ walletAddress: 'WA' }));
  const b = r.join(r.mint({ walletAddress: 'WB' }));
  const room = r.paid.roomOf(a.id);
  assert.deepEqual(Array.from(r.paid.walletSeat.keys()).sort(), ['WA', 'WB']);
  assert.equal(r.paid.walletSeatOf('WA').room, room);
  assert.deepEqual(checkWalletSeats(r.paid.all(), r.paid.walletSeat), []);
  // A cashes out (holds Q to the end), B leaves and dies
  a.fire('sl:hold', { on: 1 });
  let k = 0;
  while (room.seatOf(a.id) && room.sim.snake(room.seatOf(a.id).snakeId) && k++ < 200) {
    r.wall.t += 60;
    a.fire('sl:i', PING);
    r.step();
  }
  assert.equal(r.money.of('onCashout').length, 1);
  assert.equal(r.paid.walletSeatOf('WA'), null, 'cleared at the cash-out');
  b.fire('sl:leave');
  b.disconnect();
  untilGlidesEnd(r);
  assert.equal(r.paid.walletSeat.size, 0, 'cleared at the death');
  assert.deepEqual(checkWalletSeats(r.paid.all(), r.paid.walletSeat), []);
  i1(room);
});

test('idle retire: the floor to the house once per source wallet, I1 holds, never with an account, never twice', () => {
  const r = paidRig();
  const a = r.join(r.mint({ walletAddress: 'WA' }));
  const b = r.join(r.mint({ walletAddress: 'WB', stake: 1, worth: 1, paid: 1 }), { auth: { stake: 1 } });
  const c = r.join(r.mint({ walletAddress: 'WC' }));
  const room = r.paid.roomOf(a.id);
  r.step(2);
  // A and C leave: their snakes glide, die, and drop their whole worth as gold
  for (const s of [a, c]) {
    s.fire('sl:leave');
    s.disconnect();
  }
  // a gliding snake keeps the room busy
  assert.deepEqual(r.paid.sweep(r.wall.t + 10 * FLOOR_SWEEP_MS), { retired: 0, settled: 0 });
  untilGlidesEnd(r);
  assert.equal(room.money.openCount(), 0);
  assert.equal(room.money.bank.floorMicro(), 1000000, 'both stakes are gold on the floor');
  const t0 = r.wall.t;
  assert.equal(r.paid.sweep(t0).retired, 0, 'first seen empty');
  assert.equal(r.paid.sweep(t0 + FLOOR_SWEEP_MS - 1).retired, 0, 'not yet');
  const bRoom = r.paid.roomOf(b.id);
  assert.equal(r.paid.sweep(t0 + FLOOR_SWEEP_MS).retired, 1, 'the empty $0.50 room retires; the $1 room has B');
  const floors = r.money.of('onFloor');
  assert.deepEqual(floors.map((f) => [f.srcWallet, f.micro, f.pid, f.label]).sort(),
    [['WA', 500000, 'idle', 'sl_na_s0_5'], ['WC', 500000, 'idle', 'sl_na_s0_5']]);
  assert.equal(new Set(floors.map((f) => f.sweepId)).size, 2, 'unique sweep ids');
  for (const f of floors) assert.match(f.sweepId, jidLike);
  assert.equal(room.money.bank.floorMicro(), 0);
  assert.equal(room.stopped, true);
  i1(room);
  assert.ok(!r.paid.rooms().includes(room) && !r.paid.all().includes(room), 'gone from the directory');
  assert.equal(r.paid.sweep(t0 + 2 * FLOOR_SWEEP_MS).retired, 0);
  assert.equal(r.money.of('onFloor').length, 2, 'a second sweep books nothing');
  assert.equal(r.paid.roomOf(b.id), bRoom, 'a room with an account is never retired');
  assert.equal(bRoom.stopped, false);
  // the next $0.50 join opens a fresh room under the first label
  const d = r.join(r.mint({ walletAddress: 'WD' }));
  assert.equal(r.paid.roomOf(d.id).lobbyType, 'sl_na_s0_5');
  assert.notEqual(r.paid.roomOf(d.id), room);
});

test('an emergency close: the room leaves its rung; a settle that left an account stays on settling until paid', () => {
  const r = paidRig();
  const a = r.join(r.mint({ walletAddress: 'WA' }));
  const b = r.join(r.mint({ walletAddress: 'WB' }));
  const room = r.paid.roomOf(a.id);
  r.step(2);
  // the bank refuses every withdraw: the emergency settle leaves both accounts open
  const bank = room.money.bank;
  const withdraw = bank.withdraw.bind(bank);
  bank.withdraw = () => { throw new Error('injected refusal'); };
  room.emergencyClose();
  assert.deepEqual(room.settled.left.length, 2);
  assert.equal(a.disconnected && b.disconnected, true, 'its sockets are let go');
  assert.equal(r.paid.rooms().includes(room), false, 'off its rung: the next join opens a fresh room');
  assert.deepEqual(r.paid.settling, [room]);
  assert.ok(r.paid.all().includes(room), 'all() keeps it for the drain and the solvency sum');
  assert.equal(r.paid.boardRows()[0].players, 2, 'its accounts still count on the row (rule 4b)');
  assert.equal(room.liveStakeTotal(), 1, 'in dollars');
  assert.deepEqual(r.money.of('onOwed'), []);
  assert.equal(r.paid.walletSeat.size, 2, 'the stuck accounts keep their wallets seated (one account per wallet)');
  const c = r.join(r.mint({ walletAddress: 'WA' }));
  assert.equal(c.emitted.flatMap((e) => (e.name === 'sl:x' ? e.data : [])).find((m) => m.t === 'refused').why, 'one-seat');
  // the sweep retries; still refused, it stays
  assert.equal(r.paid.sweep(r.wall.t).settled, 0);
  assert.deepEqual(r.paid.settling, [room]);
  bank.withdraw = withdraw;
  assert.equal(r.paid.sweep(r.wall.t + 1).settled, 1);
  assert.deepEqual(r.paid.settling, []);
  const owed = r.money.of('onOwed');
  assert.deepEqual(owed.map((o) => [o.wallet, o.micro]).sort(), [['WA', 500000], ['WB', 500000]]);
  for (const o of owed) assert.match(o.reason, /^refund slither emergency sl_na_s0_5 agowed:/);
  assert.equal(r.paid.walletSeat.size, 0);
  i1(room);
  // a clean emergency close never goes on settling
  const d = r.join(r.mint({ walletAddress: 'WD' }));
  const room2 = r.paid.roomOf(d.id);
  room2.emergencyClose();
  assert.deepEqual(r.paid.settling, []);
  assert.equal(r.paid.all().includes(room2), false);
  // a room that closed while its close hook was lost is let go by the next sweep
  const e = r.join(r.mint({ walletAddress: 'WE' }));
  const room3 = r.paid.roomOf(e.id);
  room3.onClosed = null;
  room3.emergencyClose();
  assert.ok(r.paid.rooms().includes(room3), 'still listed');
  r.paid.sweep(r.wall.t + 2);
  assert.equal(r.paid.rooms().includes(room3), false);
  assert.deepEqual(r.paid.settling, []);
  assert.equal(r.money.of('onOwed').filter((o) => o.wallet === 'WE').length, 1, 'its owed row was written by its own close');
});

test('shutdownSettle: every room\'s money rows first, then its clock; 100% of the current balance; the dollars', () => {
  const r = paidRig();
  const a = r.join(r.mint({ walletAddress: 'WA' }));
  r.join(r.mint({ walletAddress: 'WB', stake: 1, worth: 1, paid: 1 }), { auth: { stake: 1 } });
  r.step(2);
  const rooms = r.paid.all();
  assert.equal(rooms.length, 2);
  // the dollars the drain and the solvency sum read
  let dollars = 0;
  for (const room of rooms) {
    dollars += room.liveStakeTotal();
    for (const v of room.snakes.values()) assert.equal(v.isBot, false);
    assert.equal(room.floorWorth, 0);
  }
  assert.equal(dollars, 1.5);
  assert.deepEqual(Array.from(rooms[0].snakes.values()).map((v) => v.worth), [0.5]);
  const order = [];
  for (const room of rooms) {
    const settle = room.money.shutdownSettle.bind(room.money);
    room.money.shutdownSettle = (why) => {
      order.push(['money', room.lobbyType, room.stopped]);
      return settle(why);
    };
    const halt = room.halt.bind(room);
    room.halt = () => {
      order.push(['halt', room.lobbyType, room.stopped]);
      return halt();
    };
  }
  const rows = r.paid.shutdownSettle('shutdown');
  assert.deepEqual(order, [['money', 'sl_na_s0_5', false], ['halt', 'sl_na_s0_5', false],
    ['money', 'sl_na_s1', false], ['halt', 'sl_na_s1', false]]);
  assert.deepEqual(rows.map((x) => [x.wallet, x.micro]), [['WA', 500000], ['WB', 1000000]]);
  for (const x of rows) {
    assert.match(x.key, /^agowed:[0-9a-f-]{36}$/);
    assert.match(x.reason, /^refund slither shutdown sl_na_s/);
  }
  assert.equal(r.paid.stopping, true);
  assert.equal(r.paid.paidOpen, false);
  for (const room of rooms) {
    assert.equal(room.stopped, true);
    assert.equal(room.money.openCount(), 0);
    i1(room);
  }
  assert.deepEqual(r.money.of('onOwed'), [], 'rows only: no money hook in the exit window');
  assert.ok(a.emitted.some((e) => e.name === 'sl:x' && e.data.some((m) => m.t === 'closed' && m.refunded === 500000)));
  assert.deepEqual(r.paid.setPaidOpen(true), { ok: false, why: 'stopping', open: false });
  assert.deepEqual(r.paid.sweep(r.wall.t + 10 * FLOOR_SWEEP_MS), { retired: 0, settled: 0 }, 'nothing moves while stopping');
  assert.deepEqual(r.paid.boardRows(), [], 'closed and empty');
  // a settle that throws in one room never stops the next
  const r2 = paidRig();
  r2.join(r2.mint({ walletAddress: 'WX' }));
  r2.join(r2.mint({ walletAddress: 'WY', stake: 1, worth: 1, paid: 1 }), { auth: { stake: 1 } });
  r2.paid.rooms()[0].money.shutdownSettle = () => { throw new Error('injected'); };
  assert.deepEqual(r2.paid.shutdownSettle('crash').map((x) => [x.wallet, x.reason.split(' ')[2]]), [['WY', 'crash']]);
  assert.equal(r2.paid.rooms()[0].stopped, true, 'halted anyway');
});

test('maxSliceMs reads and resets; humanTotal counts open accounts of live rooms', () => {
  const r = paidRig();
  r.join(r.mint({}));
  r.join(r.mint({ stake: 1, worth: 1, paid: 1 }), { auth: { stake: 1 } });
  const [x, y] = r.paid.rooms();
  x.stats.maxSliceMs = 3.5;
  y.stats.maxSliceMs = 7.25;
  assert.equal(r.paid.maxSliceMs(), 7.25);
  assert.equal(r.paid.maxSliceMs(), 0, 'reset: the slice since the last read');
  assert.equal(r.paid.humanTotal(), 2);
  y.halt();
  assert.equal(r.paid.humanTotal(), 1);
  assert.equal(r.paid.stats().walletSeats, 2);
});
