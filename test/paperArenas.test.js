'use strict';
// The Paper arena directory (T7, design 6.1): seat search and overflow, sweeps, reconnect maps,
// and the lobby rows.
const test = require('node:test');
const assert = require('node:assert');
const { PaperArenas } = require('../server/paper/PaperArenas');
const { REASON, MP } = require('../server/paper/ArenaGame');

function directory({ paidEnabled = true } = {}) {
  let t = 1000000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const calls = { cashout: [] };
  const hooks = { onCashout: (o) => calls.cashout.push(o), onTransfer() {}, onRefund() {}, onSweep() {}, onBreach() {} };
  const io = { to: () => ({ emit() {}, volatile: { emit() {} } }) };
  const d = new PaperArenas({ region: 'na', io, hooks, now: clock.now, paidEnabled, autoTick: false, warm: false });
  return { d, clock, calls };
}

let n = 0;
function sock() {
  return { id: 'd' + ++n, join() {}, leave() {}, emit() {} };
}

function seatIn(d, stake, preferred) {
  const s = sock();
  const found = d.seatFor(stake, preferred);
  if (!found) return null;
  const seat = found.room.addHuman(s, { name: s.id, micro: stake ? Math.round(stake * 1e6) : 0, wallet: stake ? 'W' + s.id : null, spot: found.spot });
  found.room._confirm(seat); // its player got pp:joined (the unconfirmed-seat rules have their own tests)
  return { s, seat, room: found.room };
}

test('the 17th human opens an overflow arena', () => {
  const { d } = directory();
  const seats = [];
  for (let i = 0; i < 16; i++) seats.push(seatIn(d, 0.1));
  assert.ok(seats.every(x => x && x.room.index === 0));
  const next = seatIn(d, 0.1);
  assert.strictEqual(next.room.index, 1);
  assert.strictEqual(next.room.lobbyType, 'paper_na_s0_1#1');
  assert.strictEqual(d.all().filter(r => r.stake === 0.1).length, 2);
});

test('a room with no spawn spot is skipped; overflow with floor money is not swept and is picked first', () => {
  const { d, clock } = directory();
  const a = seatIn(d, 1);
  a.room.findSpawn = () => null;
  const b = seatIn(d, 1);
  assert.strictEqual(b.room.index, 1, 'skipped the room with no spot');
  delete a.room.findSpawn;
  // b's room gets floor money, then empties.
  b.room.game.kill(b.seat.unit, undefined, REASON.SELF_CROSS);
  assert.strictEqual(b.room.liveHumans, 0);
  assert.ok(b.room.bank.floorMicro() > 0);
  d.sweep(clock.now());
  clock.advance(MP.ARENA_SWEEP_MS + 1000);
  d.sweep(clock.now());
  assert.ok(d.all().includes(b.room) && !b.room.stopped, 'floor money keeps an overflow arena');
  a.room.completeCashout(a.seat.unit); // leaves with no coin behind
  const c = seatIn(d, 1);
  assert.ok(c.room === b.room, 'a tie goes to the arena holding floor money (got #' + c.room.index + ')');
});

test('an empty overflow arena is swept, re-created at its index, and pays its first cash-out', () => {
  const { d, clock, calls } = directory();
  for (let i = 0; i < 16; i++) seatIn(d, 0.1);
  const over = seatIn(d, 0.1);
  const old = over.room;
  const orderIds = new Set();
  // Cash it out, leave it empty, sweep it.
  old.completeCashout(over.seat.unit);
  orderIds.add(calls.cashout[0].cashoutId);
  d.sweep(clock.now());
  clock.advance(MP.ARENA_SWEEP_MS);
  d.sweep(clock.now());
  assert.ok(old.stopped);
  assert.ok(!d.all().includes(old));
  // A respawn that prefers the swept arena lands in a live one.
  const r = seatIn(d, 0.1, old);
  assert.ok(r && r.room !== old && !r.room.stopped);
  assert.strictEqual(r.room.index, 1, 'the index is reused');
  r.room.completeCashout(r.seat.unit);
  assert.strictEqual(calls.cashout.length, 2);
  assert.ok(!orderIds.has(calls.cashout[1].cashoutId), 'a fresh cashoutId');
});

test('a stopped preferred room is skipped', () => {
  const { d } = directory();
  const a = seatIn(d, 0.1);
  a.room.stop();
  const b = seatIn(d, 0.1, a.room);
  assert.ok(b && b.room !== a.room);
});

test('seatByKey finds a seat in grace and forgets it once freed', () => {
  const { d } = directory();
  const a = seatIn(d, 0.1);
  seatIn(d, 0.1);
  assert.ok(d.seatOfSocket(a.s.id) === a.seat);
  a.room.beginGrace(a.seat);
  assert.ok(d.seatByKey(a.seat.resumeKey) === a.seat);
  assert.ok(d.seatOfSocket(a.s.id) === null, 'the closed socket no longer maps');
  const s2 = sock();
  a.room.resume(s2, a.seat);
  assert.ok(d.seatOfSocket(s2.id) === a.seat);
  a.room.removeHuman(a.seat.unit.id, REASON.LEAVE);
  assert.ok(d.seatByKey(a.seat.resumeKey) === null);
  assert.ok(d.seatOfSocket(s2.id) === null);
});

test('the 60 s sweep runs the hour sweep on a frozen room', () => {
  const { d, clock } = directory();
  const a = seatIn(d, 0.1);
  const b = seatIn(d, 0.1);
  a.room.game.kill(a.seat.unit, undefined, REASON.SELF_CROSS);
  b.room.removeHuman(b.seat.unit.id, REASON.LEAVE);
  assert.strictEqual(a.room.timer, null);
  assert.strictEqual(a.room.bank.pickups().length, 2);
  clock.advance(MP.PICKUP_SWEEP_MS + 1);
  d.sweep(clock.now());
  assert.strictEqual(a.room.bank.pickups().length, 0);
  assert.strictEqual(a.room.bank.totalMicro(), 0);
});

test('rows: free always, the paid rungs only with PAPER_PAID', () => {
  const off = directory({ paidEnabled: false }).d.boardRows();
  assert.deepStrictEqual(off.map(r => r.stake), [0]);
  assert.deepStrictEqual(off[0], { id: 'paper:na:s0', game: 'paper', region: 'na', stake: 0, players: 0, bots: 15, capacity: 16, state: 'open' });
  const { d } = directory({ paidEnabled: true });
  seatIn(d, 1);
  const on = d.boardRows();
  assert.deepStrictEqual(on.map(r => r.stake), [0, 0.1, 1]);
  assert.strictEqual(on[2].players, 1);
  assert.strictEqual(on[2].bots, 0);
});

test('humanTotal: every seated human on every rung, never a bot (the lobby card count)', () => {
  const { d } = directory({ paidEnabled: true });
  assert.strictEqual(d.humanTotal(), 0);
  seatIn(d, 0);
  seatIn(d, 0);
  seatIn(d, 0.1);
  const last = seatIn(d, 1);
  assert.strictEqual(d.humanTotal(), 4);
  const free = d.all().find(r => r.stake === 0);
  // A random spawn can miss a spot now and then, so try until two are in.
  for (let i = 0; i < 40 && free.botCount < 2; i++) free.addBot();
  assert.ok(free.botCount >= 2, 'the free arena really has bots in it');
  assert.strictEqual(d.humanTotal(), 4, 'and they are not counted');
  assert.strictEqual(d.humanTotal(), d.all().reduce((n, r) => n + r.liveHumans, 0));
  last.room.removeHuman(last.seat.unit.id, REASON.LEAVE);
  assert.strictEqual(d.humanTotal(), 3);
});

test('neither the room nor the directory requires money, db or Wallet', () => {
  const fs = require('fs');
  const path = require('path');
  for (const f of ['PaperRoom.js', 'PaperArenas.js']) {
    const src = fs.readFileSync(path.join(__dirname, '../server/paper', f), 'utf8');
    const reqs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
    assert.ok(!reqs.some(r => /(^|\/)(money|db|Wallet|Usdc)(\.js)?$/.test(r)), f + ' requires ' + reqs.join(', '));
  }
});
