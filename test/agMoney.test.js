'use strict';
// The paid agar.io room and its money controller (PAID-AGAR-DESIGN.md 3.4, 5.2; checklist steps 5 and 6), with
// Owen's binding answers of 2026-10-08: hold-Q 3 s cash-out (75 ticks, movement lock, split and eject refused,
// edible, death wins a tie), disconnect grace 5 s then frozen and edible 3 min then auto cash-out 90/10, a crash
// refunds 100%, share-at-eat money on split cells, no bots in a paid room. Real AgRoom on the FIXTURE law table,
// fake sockets, recorded hooks, a hand-driven wall clock.
const test = require('node:test');
const assert = require('node:assert');
const { AgRoom } = require('../server/ag/agRoom');
const { AG_MONEY } = require('../server/ag/agMoney');
const { FIXTURE } = require('./agLawsFixture');

const quiet = { error() {}, warn() {}, log() {} };
const HOLD = AG_MONEY.HOLD_TICKS.value;

function recorder() {
  const calls = { cashout: [], refund: [], transfer: [], feed: [], breach: [], stake: [], house: [], open: [],
    closed: [], confirmed: [] };
  const hooks = {
    onCashout: (o) => calls.cashout.push(o),
    onRefund: (o) => calls.refund.push(o),
    onTransfer: (t) => calls.transfer.push(t),
    onFeed: (f) => calls.feed.push(f),
    onBreach: (b) => calls.breach.push(b),
    onStake: (s) => calls.stake.push(s),
    onHouse: (h) => calls.house.push(h),
    onAccountOpen: (a) => calls.open.push(a.pid),
    onAccountConfirmed: (a) => calls.confirmed.push(a.pid),
    onAccountClosed: (a, outcome, extra) => calls.closed.push({ pid: a.pid, wallet: a.wallet, outcome, extra }),
  };
  return { calls, hooks };
}

function world(opts) {
  const clock = { t: 1000000 };
  const rec = recorder();
  const seatless = [];
  const r = new AgRoom(Object.assign({ laws: FIXTURE, shippableOnly: false, seed: 7, autoTick: false, log: quiet,
    stake: 0.1, moneyHooks: rec.hooks, now: () => clock.t,
    onSeatless: (socket, room, outcome) => seatless.push([socket.id, outcome]) }, opts));
  return { r, clock, calls: rec.calls, seatless };
}

let sn = 0;
function sock(id) {
  return {
    id: id || 'ps' + ++sn,
    conn: { writeBuffer: [] },
    events: [],
    emit(ev, p) { this.events.push([ev, p]); },
    of(ev) { return this.events.filter((e) => e[0] === ev).map((e) => e[1]); },
  };
}

// A seated paid player; ready: true also ticks once and readies it.
function join(w, name, opts) {
  const o = Object.assign({ micro: 100000, ready: true }, opts);
  const s = sock(name);
  const acct = w.r.addPaidHuman(s, { name, micro: o.micro, wallet: 'W-' + name, paid: o.micro / 1e6, ip: o.ip || '' });
  assert.ok(acct && typeof acct === 'object', 'seated: ' + acct);
  if (o.ready) {
    w.r.tickOnce();
    assert.strictEqual(w.r.ready(s.id), true, name + ' readies');
  }
  return { s, pid: acct.pid, acct };
}

function cellsOf(r, pid) {
  const info = r.sim.playerInfo(pid);
  return info ? info.cells.map((id) => r.sim.getCell(id)) : [];
}

// Puts a cell of `eater` big enough to eat on top of `victim`'s first cell, with both steering at that point.
function smother(r, eater, victim, size) {
  const v = cellsOf(r, victim)[0];
  const e = cellsOf(r, eater)[0];
  e.x = v.x;
  e.y = v.y;
  e.size = size || 300;
  r.sim.setInput(eater, { x: v.x, y: v.y });
  r.sim.setInput(victim, { x: v.x, y: v.y });
}

function conserved(r) {
  const b = r.money.bank;
  return b.totalMicro() === b.ledger.inMicro - b.ledger.outMicro;
}

test('a paid room: no bots ever, counts are open accounts, no watchers, no Play and no spectate', () => {
  const w = world();
  const { r } = w;
  assert.strictEqual(r.botsAllowed(), false);
  assert.strictEqual(r.addBot(), null);
  r.fillBots();
  assert.strictEqual(r.botCount, 0);
  assert.strictEqual(r.hasWatchSpace(), false);
  assert.strictEqual(r.addSocket(sock(), {}), null, 'no free seat in a paid room');
  const a = join(w, 'a');
  assert.strictEqual(r.liveHumans, 1);
  assert.strictEqual(r.join(a.s.id, 'x'), 'paid');
  assert.strictEqual(r.spectate(a.s.id), false);
  r.removeSocket(a.s.id);                 // grace: still an open account, still counted
  assert.strictEqual(r.liveHumans, 1);
  assert.strictEqual(r.playerCount, 1);
  assert.strictEqual(r.sim.counts().bots, 0);
});

test('open: unconfirmed seats are shielded and still; inputs before ag:ready are ignored; ready writes the buy-in row once', () => {
  const w = world();
  const { r, calls } = w;
  const a = join(w, 'a', { ready: false });
  assert.strictEqual(a.acct.state, 'unconfirmed');
  assert.ok(r.shielded.has(a.pid) && r.still.has(a.pid));
  assert.strictEqual(r.ready(a.s.id), false, 'no cell yet: ready refused');
  assert.strictEqual(r.target(a.s.id, 100, 100), false, 'target ignored before ready');
  assert.strictEqual(r.split(a.s.id), false);
  r.tickOnce();
  assert.strictEqual(cellsOf(r, a.pid).length, 1);
  const x0 = cellsOf(r, a.pid)[0].x;
  r.tickOnce();
  assert.strictEqual(cellsOf(r, a.pid)[0].x, x0, 'still while unconfirmed');
  assert.strictEqual(r.ready('someone-else'), false);
  assert.strictEqual(r.ready(a.s.id), true);
  assert.strictEqual(r.ready(a.s.id), false, 'once');
  assert.strictEqual(a.acct.state, 'live');
  assert.ok(!r.shielded.has(a.pid) && !r.still.has(a.pid));
  assert.deepStrictEqual(calls.stake, [{ wallet: 'W-a', worth: 0.1, label: r.lobbyType }]);
  assert.strictEqual(r.target(a.s.id, 100, 100), true);
});

test('hold-Q: completes at 75 held ticks, not 74; 90/10 order with the socket; the seat goes', () => {
  const w = world();
  const { r, calls } = w;
  const a = join(w, 'a');
  const b = join(w, 'b');
  r.target(a.s.id, 3000, 3000);
  r.tickOnce();
  assert.ok(r.hold(a.s.id, true));
  for (let i = 0; i < HOLD - 1; i++) r.tickOnce();
  assert.strictEqual(a.acct.holdTicks, HOLD - 1);
  assert.ok(r.money.account(a.pid), 'open after 74 held ticks');
  assert.deepStrictEqual(a.s.of('ag:holding')[0], { on: 1, need: HOLD });
  r.tickOnce();
  assert.strictEqual(r.money.account(a.pid), null, 'cashed out on the 75th');
  assert.strictEqual(calls.cashout.length, 1);
  const o = calls.cashout[0];
  assert.deepStrictEqual([o.socketId, o.wallet, o.grossMicro, o.stake, o.label], [a.s.id, 'W-a', 100000, 0.1, r.lobbyType]);
  assert.match(o.cashoutId, /^[0-9a-f-]{36}$/);
  assert.strictEqual(r.seatOf(a.s.id), null, 'the socket is seatless');
  assert.deepStrictEqual(w.seatless.pop(), [a.s.id, 'cashedout']);
  r.tickOnce();
  assert.strictEqual(r.sim.hasPlayer(a.pid), false, 'its cells left at the next step');
  assert.ok(r.money.account(b.pid), 'the other player plays on');
  assert.ok(conserved(r));
  // a second cash-out of the same account is impossible
  assert.strictEqual(r.money.completeCashout(a.pid, 'cashedout'), null);
  assert.strictEqual(calls.cashout.length, 1);
});

test('hold-Q locks movement at once and refuses split and eject; letting go early does nothing', () => {
  const w = world();
  const { r, clock, calls } = w;
  const a = join(w, 'a');
  join(w, 'b');
  const c = cellsOf(r, a.pid)[0];
  c.size = 120;
  r.target(a.s.id, c.x + 2000, c.y);
  r.tickOnce();
  r.hold(a.s.id, true);
  r.tickOnce();
  const x = cellsOf(r, a.pid)[0].x;
  assert.strictEqual(r.split(a.s.id), false, 'split refused while holding');
  assert.strictEqual(r.eject(a.s.id), false, 'eject refused while holding');
  for (let i = 0; i < 20; i++) r.tickOnce();
  assert.strictEqual(cellsOf(r, a.pid)[0].x, x, 'not one unit of steering');
  assert.strictEqual(cellsOf(r, a.pid).length, 1);
  r.hold(a.s.id, false);              // let go at 22 ticks
  r.tickOnce();
  assert.strictEqual(a.acct.holding, false);
  assert.strictEqual(a.acct.holdTicks, 0);
  assert.deepStrictEqual(a.s.of('ag:holding').pop(), { on: 0 });
  r.tickOnce();
  assert.ok(cellsOf(r, a.pid)[0].x > x, 'moves again');
  assert.strictEqual(calls.cashout.length, 0, 'nothing happened');
  // a stale hold (no message for more than 500 ms) also ends with nothing
  r.hold(a.s.id, true);
  for (let i = 0; i < 10; i++) r.tickOnce();
  clock.t += AG_MONEY.HOLD_INPUT_STALE_MS.value + 1;
  r.tickOnce();
  assert.strictEqual(a.acct.holding, false, 'stale hold reset');
  // a hold through a disconnect resets too
  r.hold(a.s.id, true);
  for (let i = 0; i < 10; i++) r.tickOnce();
  r.removeSocket(a.s.id);
  assert.strictEqual(a.acct.holding, false);
  for (let i = 0; i < HOLD; i++) r.tickOnce();
  assert.strictEqual(calls.cashout.length, 0, 'a disconnected player cannot cash out');
});

test('hold refused for an unconfirmed seat, a dead seat and a frozen account', () => {
  const w = world();
  const { r, calls } = w;
  const u = join(w, 'u', { ready: false });
  r.tickOnce();
  r.hold(u.s.id, true);
  for (let i = 0; i < HOLD + 2; i++) {
    if (i === 60) break;              // the ready timeout (5 s = 125 ticks) is not reached here
    r.tickOnce();
  }
  assert.strictEqual(u.acct.holding, false, 'unconfirmed: no hold');
  const f = join(w, 'f');
  r.sim.clearCells(f.pid);            // a code bug: an account with no cells
  r.tickOnce();
  assert.strictEqual(f.acct.state, 'frozen');
  assert.strictEqual(r.hold(f.s.id, true), true, 'the message is taken');
  for (let i = 0; i < HOLD + 1; i++) r.tickOnce();
  assert.strictEqual(calls.cashout.length, 0, 'frozen: never cashed out');
  assert.strictEqual(r.hold('nobody', true), false);
});

test('death wins a same-tick tie: the last cell eaten in the completing tick is eaten, not cashed out', () => {
  const w = world();
  const { r, calls } = w;
  const a = join(w, 'a');
  const b = join(w, 'b');
  r.hold(a.s.id, true);
  for (let i = 0; i < HOLD - 1; i++) r.tickOnce();
  assert.strictEqual(a.acct.holdTicks, HOLD - 1);
  smother(r, b.pid, a.pid, 400);
  r.tickOnce();                        // the 75th held tick: b eats a in the step, before the hold completes
  assert.strictEqual(calls.cashout.length, 0);
  assert.strictEqual(r.money.account(a.pid), null);
  assert.strictEqual(r.money.balance(b.pid), 200000, 'the eater has both stakes');
  assert.deepStrictEqual(a.s.of('ag:dead')[0], { lostMicro: 100000, by: 'b' });
  assert.strictEqual(calls.closed.find((x) => x.pid === a.pid).outcome, 'eaten');
  assert.ok(conserved(r));
});

test('share-at-eat on split cells: one piece moves its size share, the last piece the remainder', () => {
  const w = world();
  const { r } = w;
  const a = join(w, 'a', { micro: 1000000 });
  const b = join(w, 'b', { micro: 1000000 });
  // b in two pieces of size 30 and 40 far apart; a eats the 30 first
  const b1 = cellsOf(r, b.pid)[0];
  b1.size = 30;
  r.sim.debugPlace({ kind: 'player', owner: b.pid, x: b1.x + 1200, y: b1.y, size: 40 });
  r.sim.setInput(b.pid, { x: b1.x, y: b1.y });
  smother(r, a.pid, b.pid, 200);
  r.tickOnce();
  const moved = 1000000 - r.money.balance(b.pid);
  assert.ok(moved > 0);
  // the eaten piece's share at the instant of the eat (its size after this tick's decay, within a micro or two)
  assert.ok(Math.abs(moved - Math.floor((1000000 * 900) / (900 + 1600))) <= 2000, 'about 36% moved, got ' + moved);
  assert.strictEqual(r.money.balance(a.pid), 1000000 + moved);
  // a ejects mass: money stays on a (W leaves the money on you, Owen Q4)
  const before = r.money.balance(a.pid);
  const ca = cellsOf(r, a.pid)[0];
  ca.size = 300;
  r.eject(a.s.id);
  r.tickOnce();
  assert.strictEqual(r.money.balance(a.pid), before);
  // the last piece takes the rest
  smother(r, a.pid, b.pid, 300);
  r.tickOnce();
  assert.strictEqual(r.money.account(b.pid), null);
  assert.strictEqual(r.money.balance(a.pid), 2000000);
  assert.ok(conserved(r));
});

test('disconnect: 5 s grace still steering, then dormant (still, edible), auto cash-out 90/10 at 3 min with no socket', () => {
  const w = world();
  const { r, clock, calls } = w;
  const a = join(w, 'a');
  join(w, 'b');
  r.target(a.s.id, 4000, 4000);
  r.tickOnce();
  r.removeSocket(a.s.id);
  assert.strictEqual(a.acct.state, 'grace');
  const g0 = cellsOf(r, a.pid)[0].x;
  r.tickOnce();
  assert.notStrictEqual(cellsOf(r, a.pid)[0].x, g0, 'grace: cells keep heading for the last mouse point');
  clock.t += AG_MONEY.DISCONNECT_GRACE_MS.value;
  r.tickOnce();
  assert.strictEqual(a.acct.state, 'dormant');
  assert.ok(r.still.has(a.pid));
  const d0 = cellsOf(r, a.pid)[0].x;
  r.tickOnce();
  assert.strictEqual(cellsOf(r, a.pid)[0].x, d0, 'dormant: frozen in place');
  assert.strictEqual(r.liveHumans, 2, 'still counted');
  clock.t += AG_MONEY.DORMANT_SETTLE_MS.value - 1000;    // 179 s
  r.tickOnce();
  assert.ok(r.money.account(a.pid), 'kept at 179 s');
  clock.t += 2000;                                     // 181 s
  r.tickOnce();
  assert.strictEqual(r.money.account(a.pid), null, 'cashed out at 3 min');
  assert.strictEqual(calls.cashout.length, 1);
  assert.strictEqual(calls.cashout[0].socketId, null, 'no socket: paid to the wallet, nothing emitted');
  assert.strictEqual(calls.cashout[0].wallet, 'W-a');
  assert.strictEqual(calls.closed.find((x) => x.pid === a.pid).outcome, 'settled');
});

test('a dormant player is edible and its money moves to the eater', () => {
  const w = world();
  const { r, clock } = w;
  const a = join(w, 'a');
  const b = join(w, 'b');
  r.removeSocket(a.s.id);
  clock.t += AG_MONEY.DISCONNECT_GRACE_MS.value;
  r.tickOnce();
  assert.strictEqual(a.acct.state, 'dormant');
  smother(r, b.pid, a.pid, 300);
  r.tickOnce();
  assert.strictEqual(r.money.account(a.pid), null);
  assert.strictEqual(r.money.balance(b.pid), 200000);
});

test('resume from grace, from dormant and from live: the old socket is replaced and the seat is the same', () => {
  const w = world();
  const { r, clock } = w;
  const a = join(w, 'a');
  r.removeSocket(a.s.id);
  const s2 = sock('a2');
  assert.ok(r.resumePaid(s2, a.pid));
  assert.strictEqual(a.acct.state, 'live');
  assert.strictEqual(a.acct.socketId, 'a2');
  assert.deepStrictEqual(s2.of('ag:joined')[0].resumed, true);
  assert.strictEqual(s2.of('ag:joined')[0].resumeKey, a.acct.resumeKey);
  r.removeSocket('a2');
  clock.t += AG_MONEY.DISCONNECT_GRACE_MS.value;
  r.tickOnce();
  assert.strictEqual(a.acct.state, 'dormant');
  const s3 = sock('a3');
  assert.ok(r.resumePaid(s3, a.pid));
  assert.strictEqual(a.acct.state, 'live');
  assert.ok(!r.still.has(a.pid), 'back from dormant: moves again');
  const s4 = sock('a4');
  assert.ok(r.resumePaid(s4, a.pid), 'a live seat taken by another socket');
  assert.deepStrictEqual(s3.of('ag:replaced'), [{}]);
  assert.strictEqual(r.seatOf('a3'), null);
  assert.strictEqual(r.target('a3', 1, 1), false, 'the replaced socket steers nothing');
  assert.strictEqual(r.hold('a3', true), false, 'and cannot hold');
  assert.strictEqual(r.target('a4', 1, 1), true);
  assert.strictEqual(r.liveHumans, 1);
});

test('an unconfirmed seat: its socket going refunds at once; no ready in 5 s refunds too (full deposit, bounded by paid)', () => {
  const w = world();
  const { r, clock, calls } = w;
  const a = join(w, 'a', { ready: false });
  r.removeSocket(a.s.id);
  assert.strictEqual(r.money.account(a.pid), null);
  assert.deepStrictEqual(calls.refund[0], { wallet: 'W-a', name: 'a', micro: 100000, paid: 0.1, why: 'join-lost' });
  const b = join(w, 'b', { ready: false });
  r.tickOnce();
  clock.t += AG_MONEY.JOIN_CONFIRM_MS.value;
  r.tickOnce();
  assert.strictEqual(r.money.account(b.pid), null);
  assert.strictEqual(calls.refund[1].why, 'join-timeout');
  assert.deepStrictEqual(b.s.of('ag:refused')[0], { why: 'join-timeout', refunded: true });
  assert.ok(conserved(r));
  assert.strictEqual(r.money.bank.totalMicro(), 0);
});

test('zombie backstop: an account with no live cell is frozen (one breach) and goes to the house as agar_breach after 60 s', () => {
  const w = world();
  const { r, clock, calls } = w;
  const a = join(w, 'a');
  join(w, 'b');
  r.sim.clearCells(a.pid);            // only a code bug can do this
  r.tickOnce();
  assert.strictEqual(a.acct.state, 'frozen');
  assert.strictEqual(calls.breach.filter((x) => x.kind === 'zombie').length, 1);
  assert.strictEqual(r.liveHumans, 2, 'frozen money stays counted');
  assert.strictEqual(r.liveStakeTotal(), 0.2);
  r.tickOnce();
  assert.strictEqual(calls.breach.filter((x) => x.kind === 'zombie').length, 1, 'once');
  clock.t += AG_MONEY.ZOMBIE_SETTLE_MS.value;
  r.tickOnce();
  assert.strictEqual(r.money.account(a.pid), null);
  assert.strictEqual(calls.house.length, 1);
  assert.deepStrictEqual([calls.house[0].micro, calls.house[0].wallet, calls.house[0].why], [100000, 'W-a', 'zombie']);
  assert.strictEqual(calls.closed.find((x) => x.pid === a.pid).outcome, 'frozen-settled');
  assert.strictEqual(calls.cashout.length, 0);
});

test('emergency close refunds 100% of every open balance (Owen Q6), tells each page, and a throwing account stays open', () => {
  const w = world();
  const { r, calls } = w;
  const a = join(w, 'a');
  const b = join(w, 'b');
  const c = join(w, 'c', { ready: false });
  smother(r, a.pid, b.pid, 300);
  r.tickOnce();                        // a now holds 200000
  assert.strictEqual(r.money.balance(a.pid), 200000);
  const d = join(w, 'd');
  const orig = r.money.bank.withdraw.bind(r.money.bank);
  r.money.bank.withdraw = (id) => { if (id === d.pid) throw new Error('stuck'); return orig(id); };
  let replaced = null;
  r.onClosed = (room) => { replaced = room; };
  r.emergencyClose();
  assert.strictEqual(replaced, r);
  const byWallet = Object.fromEntries(calls.refund.map((x) => [x.wallet, x]));
  assert.strictEqual(byWallet['W-a'].micro, 200000, 'winnings included: 100% of the balance');
  assert.strictEqual(byWallet['W-a'].paid, undefined, 'a confirmed balance is not capped at the deposit');
  assert.strictEqual(byWallet['W-c'].micro, 100000);
  assert.strictEqual(byWallet['W-c'].paid, 0.1, 'an unconfirmed one is bounded by what landed');
  assert.ok(Object.values(byWallet).every((x) => x.why === 'emergency'));
  assert.strictEqual(calls.cashout.length, 0, 'no 90/10 on a crash');
  assert.deepStrictEqual(a.s.of('ag:closed')[0], { refundedMicro: 200000, why: 'emergency' });
  assert.ok(r.money.account(d.pid), 'the account whose settle threw stays open');
  assert.strictEqual(r.money.bank.totalMicro(), 100000, 'and its money stays in the bank');
  assert.ok(calls.breach.some((x) => x.kind === 'emergency'));
  assert.strictEqual(r.stopped, true);
  void c;
});

test('closeAccount is the only exit, and onAccountClosed fires on every path', () => {
  const w = world();
  const { r, clock, calls } = w;
  const deletes = [];
  const del = r.money.accounts.delete.bind(r.money.accounts);
  r.money.accounts.delete = (k) => { deletes.push(new Error().stack); return del(k); };
  const eaten = join(w, 'e');
  const eater = join(w, 'x');
  smother(r, eater.pid, eaten.pid, 300);
  r.tickOnce();
  const hold = join(w, 'h');
  r.hold(hold.s.id, true);
  for (let i = 0; i < HOLD; i++) r.tickOnce();
  const lost = join(w, 'l', { ready: false });
  r.removeSocket(lost.s.id);
  const away = join(w, 'd');
  r.removeSocket(away.s.id);
  clock.t += AG_MONEY.DISCONNECT_GRACE_MS.value;
  r.tickOnce();
  clock.t += AG_MONEY.DORMANT_SETTLE_MS.value;
  r.tickOnce();
  const outcomes = calls.closed.map((x) => x.outcome).sort();
  assert.deepStrictEqual(outcomes, ['cashedout', 'eaten', 'released', 'settled']);
  assert.strictEqual(deletes.length, 4);
  for (const st of deletes) assert.match(st, /_close/, 'every delete is inside _close');
});

test('collusion: one record per victim life (a 3-piece kill is one event); eject-feeds never reach it', () => {
  const w = world();
  const { r, calls } = w;
  const a = join(w, 'a', { micro: 900000 });
  const b = join(w, 'b', { micro: 900000 });
  const b1 = cellsOf(r, b.pid)[0];
  b1.size = 40;
  r.sim.debugPlace({ kind: 'player', owner: b.pid, x: b1.x + 1500, y: b1.y, size: 40 });
  r.sim.debugPlace({ kind: 'player', owner: b.pid, x: b1.x - 1500, y: b1.y, size: 40 });
  r.sim.setInput(b.pid, { x: b1.x, y: b1.y });
  for (let k = 0; k < 3; k++) {
    smother(r, a.pid, b.pid, 300);
    r.tickOnce();
  }
  assert.strictEqual(r.money.account(b.pid), null);
  assert.strictEqual(calls.transfer.length, 1, 'one record for the whole life');
  assert.deepStrictEqual([calls.transfer[0].srcWallet, calls.transfer[0].dstWallet, calls.transfer[0].micro],
    ['W-b', 'W-a', 900000]);
  // feeds: a blob c ejected is eaten by a (the sim's feed fact is covered in agSimPaid.test.js)
  const c = join(w, 'c', { ip: '1.2.3.4' });
  const ac = cellsOf(r, a.pid)[0];
  r.sim.setInput(a.pid, { x: ac.x, y: ac.y });
  r.sim.debugPlace({ kind: 'ejected', x: ac.x + 10, y: ac.y, size: 38, ejectedBy: c.pid });
  r.tickOnce();
  assert.strictEqual(calls.feed.length, 1, 'a feed was tallied');
  assert.ok(calls.feed[0].micro > 0 && calls.feed[0].micro <= 100000, 'valued at a share of the feeder balance');
  assert.strictEqual(calls.feed[0].feeder, 'W-c');
  assert.strictEqual(calls.feed[0].eater, 'W-a');
  assert.strictEqual(calls.transfer.length, 1, 'feeds never reach CollusionMonitor');
  assert.strictEqual(r.money.balance(c.pid) + r.money.balance(a.pid), 1800000 + 100000, 'and move no money');
  assert.ok(r.money.feedFlags().length >= 1);
});

test('collusion buckets that stay open 60 s are flushed without waiting for the victim to die', () => {
  const w = world();
  const { r, clock, calls } = w;
  const a = join(w, 'a', { micro: 1000000 });
  const b = join(w, 'b', { micro: 1000000 });
  const b1 = cellsOf(r, b.pid)[0];
  b1.size = 40;
  r.sim.debugPlace({ kind: 'player', owner: b.pid, x: b1.x + 1500, y: b1.y, size: 40 });
  r.sim.setInput(b.pid, { x: b1.x, y: b1.y });
  smother(r, a.pid, b.pid, 300);
  r.tickOnce();
  assert.ok(r.money.account(b.pid), 'b lives on with its other piece');
  assert.strictEqual(calls.transfer.length, 0);
  clock.t += AG_MONEY.COLLUSION_FLUSH_MS.value;
  r.tickOnce();
  assert.strictEqual(calls.transfer.length, 1);
});

test('addPaidHuman: no clear spot opens nothing; full counts dormant accounts; a stopped room refuses', () => {
  const w = world();
  const { r } = w;
  const a = join(w, 'a');
  const c = cellsOf(r, a.pid)[0];
  const b = r.sim.border();
  c.x = (b.minX + b.maxX) / 2;
  c.y = (b.minY + b.maxY) / 2;
  c.size = (b.maxX - b.minX) * 2;      // a giant that could eat a newcomer anywhere
  const s = sock();
  const before = r.money.openCount();
  assert.strictEqual(r.addPaidHuman(s, { name: 'n', micro: 100000, wallet: 'W-n' }), 'no-room');
  assert.strictEqual(r.money.openCount(), before);
  assert.strictEqual(r.seatOf(s.id), null);
  assert.strictEqual(r.money.bank.ledger.inMicro, 100000, 'nothing deposited');
  const small = world({ laws: Object.assign({}, FIXTURE, { L39: Object.assign({}, FIXTURE.L39, { value: 2 }) }) });
  const p1 = join(small, 'p1');
  join(small, 'p2');
  small.r.removeSocket(p1.s.id);
  small.clock.t += AG_MONEY.DISCONNECT_GRACE_MS.value;
  small.r.tickOnce();
  assert.strictEqual(p1.acct.state, 'dormant');
  assert.strictEqual(small.r.addPaidHuman(sock(), { name: 'p3', micro: 100000, wallet: 'W-p3' }), 'full',
    'the cap counts the dormant account');
  small.r.stop();
  assert.strictEqual(small.r.addPaidHuman(sock(), { name: 'p4', micro: 100000, wallet: 'W-p4' }), 'stopped');
  const fresh = world();
  assert.throws(() => fresh.r.addPaidHuman(sock(), { name: 'bad', micro: 1.5, wallet: 'W' }), /whole number/);
  assert.strictEqual(fresh.r.money.openCount(), 0);
});

test('a seat that throws while opening leaves nothing behind (no seat, no player, no account)', () => {
  const w = world();
  const { r } = w;
  const s = sock();
  const players = r.sim.counts().players;
  assert.throws(() => r.addPaidHuman(s, { name: 'x', micro: 100000, wallet: '' }), /wallet/);
  assert.strictEqual(r.seatOf(s.id), null);
  assert.strictEqual(r.sim.counts().players, players);
  assert.strictEqual(r.money.openCount(), 0);
  assert.strictEqual(r.money.bank.totalMicro(), 0);
});

test('ag:money: sent right after the seat\'s bundle on the board cadence, by money; a backed-up seat skips both', () => {
  const w = world();
  const { r } = w;
  const a = join(w, 'a', { micro: 100000 });
  const b = join(w, 'b', { micro: 1000000 });
  b.s.conn.writeBuffer = new Array(1000);
  const bBundles = b.s.of('ag:f').length;
  for (let i = 0; i < 60; i++) r.tickOnce();
  const evs = a.s.events.map((e) => e[0]);
  const firstMoney = evs.indexOf('ag:money');
  assert.ok(firstMoney > 0 && evs[firstMoney - 1] === 'ag:f', 'right after a bundle');
  const m = a.s.of('ag:money').pop();
  assert.strictEqual(m.me, 100000);
  assert.strictEqual(m.rank, 2, 'b has more money');
  assert.deepStrictEqual(m.board.map((row) => row[1]), [1000000, 100000]);
  const myCell = r.sim.playerInfo(a.pid).cells[0];
  const at = m.cells.indexOf(myCell);
  assert.ok(at >= 0 && at % 2 === 0 && m.cells[at + 1] === 100000, 'own cell carries its share');
  assert.strictEqual(b.s.of('ag:money').length, 0, 'the backed-up seat got no money');
  assert.strictEqual(b.s.of('ag:f').length, bBundles, 'and no bundle');
});

test('cell shares add up to the balance (floor shares, last piece the remainder)', () => {
  const w = world();
  const { r } = w;
  const a = join(w, 'a', { micro: 100001 });
  const c0 = cellsOf(r, a.pid)[0];
  r.sim.debugPlace({ kind: 'player', owner: a.pid, x: c0.x + 900, y: c0.y, size: 50 });
  r.sim.debugPlace({ kind: 'player', owner: a.pid, x: c0.x - 900, y: c0.y, size: 70 });
  const shares = r._cellShares();
  let sum = 0;
  for (const id of r.sim.playerInfo(a.pid).cells) sum += shares.get(id);
  assert.strictEqual(sum, 100001);
});

test('a room with only away accounts keeps its clock: removeSocket does not idle it while money is seated', () => {
  const w = world();
  const { r, clock, calls } = w;
  const a = join(w, 'a');
  let idled = 0;
  const goIdle = r._goIdle.bind(r);
  r._goIdle = () => { idled++; goIdle(); };
  r.removeSocket(a.s.id);
  assert.strictEqual(idled, 0, 'not idled with an open account');
  let armed = 0;
  r._arm = () => { armed++; };
  r.timer = null;
  r._timerWake();
  assert.strictEqual(armed, 1, 're-armed with no seat but an open account');
  clock.t += AG_MONEY.DISCONNECT_GRACE_MS.value;
  r.tickOnce();
  clock.t += AG_MONEY.DORMANT_SETTLE_MS.value;
  r.tickOnce();
  assert.strictEqual(calls.cashout.length, 1, 'the away account settled');
});
