'use strict';
// SlBank (PAID-SL-DESIGN.md 8, 11.1 slBank; task T1): every operation is all-or-nothing; NaN, -1, 1.5 and 2^53 are
// refused before anything changes; accounts and pellets are frozen; every out move is refused at the ceiling while
// the room holds more than the ledger says, so an inflated account is never paid another player's money; and
//     acc + floor + outCash + outRefund + outHouse == in       (I1)
// holds after every operation, valid or refused, across a long seeded run.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { SlBank, HOUSE_KINDS } = require('../server/slPaid/slBank');
const { planSplit } = require('../server/slPaid/slSplit');

const BAD = [NaN, -1, 1.5, 2 ** 53, Infinity, -Infinity, '500000', null, undefined, {}, [5]];

function rig() {
  const breaches = [];
  const transfers = [];
  const b = new SlBank({ onBreach: (x) => breaches.push(x), onTransfer: (t) => transfers.push(t) });
  return { b, breaches, transfers };
}

// I1 and I2 straight from the bank's own fields (the checker's versions are tested in slCheck.test.js).
function assertBooks(b, what) {
  const l = b.ledger;
  for (const k of ['in', 'outCash', 'outRefund', 'outHouse']) assert.ok(Number.isSafeInteger(l[k]) && l[k] >= 0, what + ' ' + k);
  assert.strictEqual(b.sums.acc + b.sums.floor + l.outCash + l.outRefund + l.outHouse, l.in, (what || '') + ' I1');
  const re = b.recount();
  assert.deepStrictEqual(re, { acc: b.sums.acc, floor: b.sums.floor }, (what || '') + ' I2');
  assert.strictEqual(b.house.swept + b.house.abandoned + b.house.breach, l.outHouse, (what || '') + ' house');
}

// Everything a refused operation must leave untouched.
function state(b) {
  return JSON.stringify({
    acc: Array.from(b.accounts.entries()),
    floor: Array.from(b.floor.entries()),
    ledger: b.ledger,
    house: b.house,
    sums: b.sums,
    step: b.step,
  });
}

function food(id, b = 70) {
  return { id, x: 0, y: 0, b, nat: false };
}

// A corrupted account or pellet, written straight into the bank's maps past the freeze (what a bug inside the bank, or
// code reaching into its maps, would leave).
function setAcct(b, id, patch) {
  b.accounts.set(id, Object.assign({}, b.accounts.get(id), patch));
}

function setPellet(b, f, patch) {
  b.floor.set(f, Object.assign({}, b.floor.get(f), patch));
}

test('deposit opens one account per snake id with the deposit kept, and the books close', () => {
  const { b } = rig();
  const a = b.deposit(7, 500000, { wallet: 'W7', name: 'seven', jid: 'j7', micro: 999, snakeId: 99, deposit: 1 });
  assert.deepStrictEqual(a, { wallet: 'W7', name: 'seven', jid: 'j7', snakeId: 7, micro: 500000, deposit: 500000 });
  assert.strictEqual(b.account(7), a);
  assert.ok(b.isOpen(7) && !b.isOpen(8));
  assert.strictEqual(b.balance(7), 500000);
  assert.strictEqual(b.balance(8), 0);
  assert.deepStrictEqual(b.ledger, { in: 500000, outCash: 0, outRefund: 0, outHouse: 0 });
  assert.strictEqual(b.totalMicro(), 500000);
  assert.strictEqual(b.roomMicro(), 500000);
  assertBooks(b, 'deposit');
});

test('deposit refuses NaN, -1, 1.5, 0, 2^53 and every non-number before anything changes; bad ids and a second open too', () => {
  const { b } = rig();
  b.deposit(1, 500000, { wallet: 'A' });
  const before = state(b);
  for (const m of BAD.concat([0])) {
    assert.throws(() => b.deposit(2, m, { wallet: 'B' }), /slBank\.deposit: micro/, String(m));
    assert.strictEqual(state(b), before, 'nothing changed for ' + String(m));
  }
  for (const id of [0, -1, 1.5, NaN, '2', null, undefined, 2 ** 53]) {
    assert.throws(() => b.deposit(id, 500000), /bad snake id/, String(id));
  }
  assert.throws(() => b.deposit(1, 500000), /already open/);
  assert.throws(() => b.deposit(3, 500000, 'wallet'), /info must be an object/);
  assert.throws(() => b.deposit(3, 500000, ['w']), /info must be an object/);
  assert.strictEqual(state(b), before);
  // the room total itself may not leave the safe integers
  const big = new SlBank();
  big.deposit(1, Number.MAX_SAFE_INTEGER - 5);
  assert.throws(() => big.deposit(2, 10), /safe integers/);
  assert.strictEqual(big.openCount(), 1);
  assertBooks(b, 'refusals');
});

test('split: the whole account becomes pellets keyed by the food objects, sum exact, all or nothing', () => {
  const { b } = rig();
  b.deposit(5, 1000003, { wallet: 'W5', name: 'five', jid: 'j5' });
  const foods = [food(11), food(12), food(13), food(14)];
  const plan = planSplit(1000003, foods.map((f) => ({ food: f })));
  b.beginStep();
  const r = b.split(5, plan.foods, plan.shares);
  assert.strictEqual(r.micro, 1000003);
  assert.strictEqual(r.placed, 1000003);
  assert.strictEqual(r.unplaced, 0);
  assert.strictEqual(r.pellets, 4);
  assert.strictEqual(r.acct.wallet, 'W5');
  assert.ok(!b.isOpen(5));
  assert.strictEqual(b.pelletCount(), 4);
  assert.deepStrictEqual(b.pellet(foods[0]), { micro: 250001, srcWallet: 'W5', srcName: 'five', srcJid: 'j5', viaBot: false });
  assert.deepStrictEqual(b.pellet(foods[3]).micro, 250000);
  assert.strictEqual(b.pellet({ id: 11 }), null, 'keyed by the object, not the id');
  assert.strictEqual(b.floorMicro(), 1000003);
  assert.strictEqual(b.accountsMicro(), 0);
  assert.deepStrictEqual(b.step, { taken: 0, credited: 0, suspended: 0, dead: 1000003, splitIn: 1000003, unplaced: 0 });
  assertBooks(b, 'split');
  assert.strictEqual(b.split(5, [], []), null, 'a second death record for the id finds no account');
});

test('split refuses a bad plan before anything changes', () => {
  const { b } = rig();
  b.deposit(1, 1000, { wallet: 'A' });
  const f = [food(1), food(2)];
  const before = state(b);
  const cases = [
    [f, [500, 499], /shares sum to 999/],
    [f, [500, 501], /shares sum to 1001/],
    [f, [1000, 0], /share 1 must be/],
    [f, [1000.5, -0.5], /share 0 must be/],
    [f, [NaN, 1000], /share 0 must be/],
    [f, [2 ** 53, 1], /share 0 must be/],
    [f, ['500', 500], /share 0 must be/],
    [[f[0], f[0]], [500, 500], /food 1 already holds cash/],
    [[f[0], null], [500, 500], /food 1 is not a food object/],
    [[f[0], 7], [500, 500], /food 1 is not a food object/],
    [f, [1000], /one length/],
    ['x', [1000], /one length/],
    [f, null, /one length/],
  ];
  for (const [foods, shares, re] of cases) {
    assert.throws(() => b.split(1, foods, shares), re);
    assert.strictEqual(state(b), before, String(re));
  }
  // a food that is already somebody's pellet is refused too
  b.deposit(2, 10, { wallet: 'B' });
  b.split(2, [f[1]], [10]);
  const mid = state(b);
  assert.throws(() => b.split(1, [f[0], f[1]], [500, 500]), /food 1 already holds cash/);
  assert.strictEqual(state(b), mid);
  assert.ok(b.isOpen(1));
  assertBooks(b, 'split refusals');
});

test('split with no food at all: the account closes and its micro goes to the house as a breach (unplaced)', () => {
  const { b } = rig();
  b.deposit(3, 500000, { wallet: 'C' });
  b.beginStep();
  const r = b.split(3, [], []);
  assert.deepStrictEqual([r.micro, r.placed, r.unplaced, r.pellets], [500000, 0, 500000, 0]);
  assert.ok(!b.isOpen(3));
  assert.strictEqual(b.ledger.outHouse, 500000);
  assert.deepStrictEqual(b.house, { swept: 0, abandoned: 0, breach: 500000 });
  assert.deepStrictEqual(b.step, { taken: 0, credited: 0, suspended: 0, dead: 500000, splitIn: 0, unplaced: 500000 });
  assertBooks(b, 'unplaced');
});

test('credit: a pellet moves to its eater once; a replay, a non-pellet and an eater with no account move nothing', () => {
  const { b, transfers } = rig();
  b.deposit(1, 500000, { wallet: 'A', jid: 'ja' });
  b.deposit(2, 500000, { wallet: 'B', jid: 'jb' });
  const f = [food(1), food(2)];
  b.split(1, f, [250000, 250000]);
  b.beginStep();
  assert.strictEqual(b.credit(f[0], 2), 250000);
  assert.strictEqual(b.balance(2), 750000);
  assert.ok(!b.isPellet(f[0]));
  assert.deepStrictEqual(transfers, [{ srcWallet: 'A', dstWallet: 'B', micro: 250000, srcJid: 'ja', eater: 2, kind: 'eat' }]);
  const before = state(b);
  assert.strictEqual(b.credit(f[0], 2), 0, 'a replayed eat finds nothing');
  assert.strictEqual(b.credit(food(99), 2), 0, 'natural food or a crumb carries nothing');
  assert.strictEqual(b.credit(f[1], 9), -1, 'no account for the eater: nothing moves');
  assert.strictEqual(b.credit(f[1], 'x'), -1);
  assert.strictEqual(state(b), before);
  assert.deepStrictEqual(b.step, { taken: 250000, credited: 250000, suspended: 0, dead: 0, splitIn: 0, unplaced: 0 });
  assertBooks(b, 'credit');
});

test('a throwing onTransfer never undoes a credit', () => {
  const b = new SlBank({ onTransfer: () => { throw new Error('collusion store down'); } });
  b.deposit(1, 100, { wallet: 'A' });
  b.deposit(2, 100, { wallet: 'B' });
  const f = food(1);
  b.split(1, [f], [100]);
  assert.strictEqual(b.credit(f, 2), 100);
  assert.strictEqual(b.balance(2), 200);
  assertBooks(b, 'hook throw');
});

test('credit refuses a corrupted pellet or eater before anything changes', () => {
  const { b } = rig();
  b.deposit(1, 100, { wallet: 'A' });
  b.deposit(2, 100, { wallet: 'B' });
  const f = food(1);
  b.split(1, [f], [100]);
  for (const bad of [NaN, 1.5, -1, 0]) {
    setPellet(b, f, { micro: bad });
    const before = state(b);
    assert.throws(() => b.credit(f, 2), /the pellet holds/);
    assert.strictEqual(state(b), before);
  }
  setPellet(b, f, { micro: 100 });
  setAcct(b, 2, { micro: NaN });
  const before = state(b);
  assert.throws(() => b.credit(f, 2), /account 2 holds NaN/);
  assert.strictEqual(state(b), before);
});

test('withdraw: cash or refund, the account closes, the counter of its kind moves; any other kind is refused first', () => {
  const { b } = rig();
  b.deposit(1, 500000, { wallet: 'A', jid: 'j1' });
  b.deposit(2, 1000000, { wallet: 'B', jid: 'j2' });
  const before = state(b);
  for (const k of [undefined, 'house', 'swept', '__proto__', 'constructor', 'CASH', 1]) {
    assert.throws(() => b.withdraw(1, k), /kind must be cash or refund/, String(k));
    assert.strictEqual(state(b), before);
  }
  const c = b.withdraw(1, 'cash');
  assert.strictEqual(c.micro, 500000);
  assert.strictEqual(c.acct.jid, 'j1');
  assert.ok(!b.isOpen(1));
  assert.strictEqual(b.withdraw(1, 'cash'), null, 'twice: the account is gone');
  assert.strictEqual(b.withdraw(77, 'refund'), null);
  const r = b.withdraw(2, 'refund');
  assert.strictEqual(r.micro, 1000000);
  assert.deepStrictEqual(b.ledger, { in: 1500000, outCash: 500000, outRefund: 1000000, outHouse: 0 });
  assert.strictEqual(b.roomMicro(), 0);
  assertBooks(b, 'withdraw');
});

test('accounts and pellets are frozen: nothing the bank hands out can change the money; a credit swaps the eater', () => {
  const { b } = rig();
  const a = b.deposit(1, 500000, { wallet: 'A', jid: 'j1' });
  b.deposit(2, 500000, { wallet: 'B', jid: 'j2' });
  const f = [food(1), food(2)];
  const r = b.split(2, f, [250000, 250000]);
  const before = state(b);
  assert.throws(() => { a.micro = 5000000; }, TypeError);
  assert.throws(() => { b.account(1).micro = 5000000; }, TypeError);
  assert.throws(() => { b.account(1).deposit = 1; }, TypeError);
  assert.throws(() => { r.acct.micro = 1; }, TypeError);
  assert.throws(() => { b.pellet(f[0]).micro = 5000000; }, TypeError);
  assert.throws(() => { b.floor.get(f[1]).srcWallet = 'X'; }, TypeError);
  assert.strictEqual(state(b), before);
  assert.strictEqual(b.credit(f[0], 1), 250000);
  const now = b.account(1);
  assert.notStrictEqual(now, a, 'a new account in the eater\'s place');
  assert.ok(Object.isFrozen(now));
  assert.deepStrictEqual(now, { wallet: 'A', jid: 'j1', snakeId: 1, micro: 750000, deposit: 500000 });
  assert.strictEqual(a.micro, 500000, 'a kept object is a stale copy, never the money');
  assertBooks(b, 'frozen');
});

test('the ceiling: while an account is inflated every out move is refused, so B keeps its 500000; told every time', () => {
  const { b, breaches } = rig();
  b.deposit(1, 500000, { wallet: 'A' });
  b.deposit(2, 500000, { wallet: 'B' });
  b.deposit(3, 100, { wallet: 'C' });
  const f = food(1);
  b.split(3, [f], [100]);
  setAcct(b, 1, { micro: 5000000 }); // a bug inflated A
  b.sums.acc += 4500000; // and the running sum followed it
  const before = state(b);
  assert.throws(() => b.withdraw(1, 'cash'), /slBank\.withdraw: the ceiling/);
  assert.strictEqual(state(b), before, 'A is not paid: nothing changed, nothing booked');
  assert.deepStrictEqual(breaches[0], { kind: 'bank', inMicro: 1000100, outMicro: 0, why: 'ceiling', op: 'withdraw', id: 1,
    micro: 5000000, held: 5500100, ceiling: 1000100 });
  // B's own 500000 fits, but the room cannot tell which account is wrong: nothing leaves while it holds too much
  assert.throws(() => b.withdraw(2, 'refund'), /slBank\.withdraw: the ceiling/);
  assert.throws(() => b.takeFloor('swept'), /slBank\.takeFloor: the ceiling/);
  assert.throws(() => b.toSuspense(f), /slBank\.toSuspense: the ceiling/);
  assert.throws(() => b.split(2, [], []), /slBank\.split: the ceiling/);
  assert.strictEqual(state(b), before);
  assert.deepStrictEqual(breaches.map((x) => x.op), ['withdraw', 'withdraw', 'takeFloor', 'toSuspense', 'split'],
    'every refusal is told, not once per bank');
  assert.strictEqual(b.balance(2), 500000);
  // the running sum need not follow: the walk is what the ceiling reads
  b.sums.acc -= 4500000;
  assert.throws(() => b.withdraw(2, 'cash'), /the ceiling/);
  // a pellet or an account that is not a whole number blocks every out move the same way
  setAcct(b, 1, { micro: 500000 });
  setPellet(b, f, { micro: NaN });
  assert.throws(() => b.withdraw(2, 'cash'), /the ceiling/);
  setPellet(b, f, { micro: 100 });
  // put right, every account and the pellet leave at exactly what they hold
  assertBooks(b, 'restored');
  assert.strictEqual(b.withdraw(1, 'cash').micro, 500000);
  assert.strictEqual(b.withdraw(2, 'refund').micro, 500000);
  assert.strictEqual(b.takeFloor('swept').micro, 100);
  assert.deepStrictEqual(b.ledger, { in: 1000100, outCash: 500000, outRefund: 500000, outHouse: 100 });
  assert.strictEqual(breaches.length, 7);
  assertBooks(b, 'paid out');
});

test('the ceiling binds on too much, never on too little: an account short of its micro still pays what it holds', () => {
  const { b, breaches } = rig();
  b.deposit(1, 500000, { wallet: 'A' });
  b.deposit(2, 500000, { wallet: 'B' });
  setAcct(b, 1, { micro: 400000 }); // 100000 went missing: nobody can be paid another's money by paying A less
  assert.strictEqual(b.withdraw(2, 'cash').micro, 500000);
  assert.strictEqual(b.withdraw(1, 'cash').micro, 400000);
  assert.strictEqual(b.roomMicro(), 100000, 'the missing micro stays on the ledger for the checker (I1, I2)');
  assert.strictEqual(breaches.length, 0);
});

test('withdraw refuses an account that is not a whole number of micro (NaN never pays a room out)', () => {
  const { b } = rig();
  b.deposit(1, 500000, { wallet: 'A' });
  b.deposit(2, 500000, { wallet: 'B' });
  for (const bad of [NaN, Infinity, -1, 1.5, 2 ** 53]) {
    setAcct(b, 1, { micro: bad });
    const before = state(b);
    assert.throws(() => b.withdraw(1, 'cash'), /account 1 holds/);
    assert.strictEqual(state(b), before, 'nothing changed for ' + String(bad));
    assert.ok(b.isOpen(1));
  }
  assert.strictEqual(b.ledger.outCash, 0);
});

test('takeFloor: every pellet to the house, grouped by source wallet with each exact micro; a second take books nothing', () => {
  const { b } = rig();
  b.deposit(1, 1000, { wallet: 'A', name: 'a' });
  b.deposit(2, 600, { wallet: 'B', name: 'b' });
  b.deposit(3, 50, { wallet: 'C', name: 'c' });
  const fa = [food(1), food(2), food(3)];
  const fb = [food(4), food(5)];
  b.split(1, fa, [334, 333, 333]);
  b.split(2, fb, [300, 300]);
  const before = state(b);
  for (const k of ['house', 'breach', undefined, 'cash']) {
    assert.throws(() => b.takeFloor(k), /kind must be swept, abandoned or returned/);
    assert.strictEqual(state(b), before);
  }
  const t = b.takeFloor('swept');
  assert.strictEqual(t.micro, 1600);
  assert.strictEqual(t.count, 5);
  assert.deepStrictEqual(t.bySource, [{ srcWallet: 'A', srcName: 'a', micro: 1000, count: 3 },
    { srcWallet: 'B', srcName: 'b', micro: 600, count: 2 }]);
  assert.strictEqual(b.pelletCount(), 0);
  assert.deepStrictEqual(b.house, { swept: 1600, abandoned: 0, breach: 0 });
  assert.ok(b.isOpen(3), 'accounts are not the floor');
  assertBooks(b, 'swept');
  assert.deepStrictEqual(b.takeFloor('swept'), { micro: 0, count: 0, bySource: [] });
  b.split(3, [food(6)], [50]);
  assert.strictEqual(b.takeFloor('abandoned').micro, 50);
  assert.deepStrictEqual(b.house, { swept: 1600, abandoned: 50, breach: 0 });
  assertBooks(b, 'abandoned');
});

test('takeFloor refuses a corrupted pellet before taking any', () => {
  const { b } = rig();
  b.deposit(1, 100, { wallet: 'A' });
  const f = [food(1), food(2)];
  b.split(1, f, [50, 50]);
  setPellet(b, f[1], { micro: NaN });
  const before = state(b);
  assert.throws(() => b.takeFloor('swept'), /a pellet holds NaN/);
  assert.strictEqual(state(b), before);
  assert.strictEqual(b.pelletCount(), 2);
});

test('toSuspense: a pellet eaten by a snake with no account goes to the house as a breach, once', () => {
  const { b } = rig();
  b.deposit(1, 900, { wallet: 'A' });
  const f = [food(1), food(2)];
  b.split(1, f, [450, 450]);
  b.beginStep();
  assert.strictEqual(b.credit(f[0], 42), -1);
  assert.strictEqual(b.toSuspense(f[0]), 450);
  assert.strictEqual(b.toSuspense(f[0]), 0);
  assert.strictEqual(b.toSuspense(food(9)), 0);
  assert.deepStrictEqual(b.house, { swept: 0, abandoned: 0, breach: 450 });
  assert.deepStrictEqual(b.step, { taken: 450, credited: 0, suspended: 450, dead: 0, splitIn: 0, unplaced: 0 });
  assertBooks(b, 'suspense');
});

test('beginStep resets the step tallies; totals() is a plain copy', () => {
  const { b } = rig();
  b.deposit(1, 10, { wallet: 'A' });
  b.split(1, [food(1)], [10]);
  assert.strictEqual(b.step.dead, 10);
  b.beginStep();
  assert.deepStrictEqual(b.step, { taken: 0, credited: 0, suspended: 0, dead: 0, splitIn: 0, unplaced: 0 });
  const t = b.totals();
  assert.deepStrictEqual(t, { in: 10, outCash: 0, outRefund: 0, outHouse: 0, acc: 0, floor: 10,
    house: { swept: 0, abandoned: 0, breach: 0 }, accounts: 0, pellets: 1 });
  t.house.swept = 99;
  assert.strictEqual(b.house.swept, 0);
  assert.deepStrictEqual(HOUSE_KINDS, ['swept', 'abandoned', 'breach']);
});

// A seeded run of every operation, valid and refused, in random order: the books close after each one.
test('I1 and I2 hold after every one of 20000 random operations, valid or refused, and money only leaves by booking', () => {
  let seed = 12345;
  const rnd = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 4294967296;
  };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const { b } = rig();
  let nextId = 1;
  let nextFood = 1;
  let deposited = 0;
  let refused = 0;
  const live = new Set();
  for (let i = 0; i < 20000; i++) {
    const op = Math.floor(rnd() * 9);
    try {
      if (op === 0 || live.size === 0) {
        const m = rnd() < 0.9 ? pick([500000, 1000000]) : pick(BAD);
        const id = nextId++;
        b.deposit(id, m, { wallet: 'W' + (id % 7), jid: 'j' + id });
        live.add(id);
        deposited += m;
      } else if (op === 1 || op === 2) {
        const id = pick(Array.from(live));
        const k = Math.floor(rnd() * 40);
        const drops = [];
        for (let d = 0; d < k; d++) drops.push({ food: rnd() < 0.05 ? null : food(nextFood++, 68 + (d % 14)) });
        const plan = planSplit(b.balance(id), drops);
        if (rnd() < 0.05 && plan.shares.length > 1) plan.shares[0] += 1; // a bad plan: refused whole
        b.split(id, plan.foods, plan.shares);
        live.delete(id);
      } else if (op === 3 || op === 4 || op === 5) {
        const pellets = Array.from(b.floor.keys());
        if (pellets.length === 0) continue;
        const f = pick(pellets);
        const eater = rnd() < 0.9 ? pick(Array.from(live)) : 65000;
        if (b.credit(f, eater) === -1) b.toSuspense(f);
      } else if (op === 6) {
        const id = pick(Array.from(live));
        b.withdraw(id, rnd() < 0.7 ? 'cash' : (rnd() < 0.9 ? 'refund' : 'nope'));
        if (!b.isOpen(id)) live.delete(id);
      } else if (op === 7) {
        if (rnd() < 0.1) b.takeFloor(rnd() < 0.5 ? 'swept' : 'abandoned');
      } else {
        b.credit(food(-1), pick(Array.from(live)));
      }
    } catch (e) {
      assert.match(e.message, /^slBank\./, 'only the bank refuses, and only by name');
      refused++;
    }
    const l = b.ledger;
    if (b.sums.acc + b.sums.floor + l.outCash + l.outRefund + l.outHouse !== l.in) assert.fail('I1 broken at op ' + i);
    if (i % 500 === 0) assertBooks(b, 'op ' + i);
  }
  assertBooks(b, 'end');
  assert.strictEqual(b.ledger.in, deposited, 'in counts exactly the accepted deposits');
  assert.ok(refused > 100, 'the run exercised the refusals (' + refused + ')');
  assert.ok(b.ledger.outCash > 0 && b.ledger.outRefund > 0 && b.house.swept + b.house.abandoned > 0 && b.house.breach > 0);
});

test('slBank is pure: no require, no clock, no randomness, no float money', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'slPaid', 'slBank.js'), 'utf8');
  const code = src.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.doesNotMatch(code, /require\(|Math\.random|Date\.now|new Date|performance\.now|toFixed|Math\.round|\/ 1e6|\* 1e6/);
});
