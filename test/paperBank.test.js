'use strict';
// PaperBank (T2, design 5.1): every op, idempotence, the withdraw ceiling, the hour sweep and a
// 10,000-op random run with the conservation invariant checked after every op.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const PaperBank = require('../server/paper/PaperBank');

function bankWithLog() {
  const transfers = [];
  const breaches = [];
  const bank = new PaperBank({ onTransfer: (t) => transfers.push(t), onBreach: (b) => breaches.push(b) });
  return { bank, transfers, breaches };
}

function conserved(bank) {
  return bank.totalMicro() === bank.ledger.inMicro - bank.ledger.outMicro;
}

test('the file has zero require calls', () => {
  const src = fs.readFileSync(path.join(__dirname, '../server/paper/PaperBank.js'), 'utf8');
  assert.strictEqual(/\brequire\s*\(/.test(src), false);
});

test('deposit opens an account; integers only; an open id cannot deposit twice', () => {
  const { bank } = bankWithLog();
  assert.strictEqual(bank.deposit(1, 100000, 'W1', 'amy'), 100000);
  assert.strictEqual(bank.isOpen(1), true);
  assert.strictEqual(bank.balance(1), 100000);
  assert.throws(() => bank.deposit(1, 5, 'W1', 'amy'), /already open/);
  for (const bad of [-1, 1.5, NaN, '100', null, undefined, Infinity, 2 ** 60]) {
    assert.throws(() => bank.deposit(2, bad, 'W2', 'bo'), /non-negative integer/, String(bad));
  }
  assert.throws(() => bank.deposit(0, 5, 'W', 'x'), /bad unit id/);
  assert.strictEqual(bank.isOpen(2), false);
  assert.strictEqual(bank.balance(99), 0);
  assert.ok(conserved(bank));
  bank.deposit(3, 0, 'W3', 'free');
  assert.strictEqual(bank.isOpen(3), true);
  assert.strictEqual(bank.balance(3), 0);
});

test('transferAll: killer takes all, one onTransfer object, closed account deleted', () => {
  const { bank, transfers } = bankWithLog();
  bank.deposit(1, 100000, 'WA', 'a');
  bank.deposit(2, 100000, 'WB', 'b');
  assert.strictEqual(bank.transferAll(2, 1), 100000);
  assert.strictEqual(bank.balance(1), 200000);
  assert.strictEqual(bank.isOpen(2), false);
  assert.strictEqual(bank.balance(2), 0);
  assert.deepStrictEqual(transfers, [{ srcWallet: 'WB', dstWallet: 'WA', micro: 100000, kind: 'kill' }]);
  assert.strictEqual(bank.transferAll(2, 1), 0, 'closed source moves nothing');
  assert.strictEqual(transfers.length, 1);
  bank.deposit(3, 100000, 'WC', 'c');
  assert.strictEqual(bank.transferAll(1, 3), 200000, 'chain kill carries 300000');
  assert.strictEqual(bank.balance(3), 300000);
  assert.ok(conserved(bank));
});

test('transfer to a closed or missing account moves nothing', () => {
  const { bank, transfers } = bankWithLog();
  bank.deposit(1, 100000, 'WA', 'a');
  bank.deposit(2, 50000, 'WB', 'b');
  bank.withdraw(2);
  assert.strictEqual(bank.transferAll(1, 2), -1);
  assert.strictEqual(bank.transferAll(1, 77), -1);
  assert.strictEqual(bank.transferAll(1, 1), -1, 'no transfer to self');
  assert.strictEqual(bank.balance(1), 100000);
  assert.strictEqual(transfers.length, 0);
  assert.ok(conserved(bank));
});

test('drop makes a coin; zero balance closes with no coin; collect credits once', () => {
  const { bank, transfers } = bankWithLog();
  bank.deposit(1, 100000, 'WA', 'a');
  bank.deposit(2, 0, 'WB', 'b');
  bank.deposit(3, 1000, 'WC', 'c');
  assert.strictEqual(bank.drop(2, 5, 5, 1000), null);
  assert.strictEqual(bank.isOpen(2), false);
  const p = bank.drop(1, 400.5, 600.25, 1234);
  assert.deepStrictEqual(p, { pid: p.pid, x: 400.5, y: 600.25, micro: 100000, srcWallet: 'WA', srcName: 'a', droppedAt: 1234 });
  assert.ok(p.pid >= 1);
  assert.strictEqual(bank.isOpen(1), false);
  assert.strictEqual(bank.floorMicro(), 100000);
  assert.strictEqual(bank.totalMicro(), 101000);
  assert.ok(conserved(bank));
  assert.strictEqual(bank.drop(1, 0, 0, 0), null, 'second drop of the same id is a no-op');
  assert.strictEqual(bank.collect(p.pid, 3), 100000);
  assert.strictEqual(bank.balance(3), 101000);
  assert.deepStrictEqual(transfers, [{ srcWallet: 'WA', dstWallet: 'WC', micro: 100000, kind: 'pickup' }]);
  assert.strictEqual(bank.collect(p.pid, 3), 0, 'a coin is collected once');
  assert.strictEqual(bank.balance(3), 101000);
  assert.strictEqual(transfers.length, 1);
  assert.ok(conserved(bank));
});

test('collect by a closed account leaves the coin', () => {
  const { bank } = bankWithLog();
  bank.deposit(1, 100000, 'WA', 'a');
  const p = bank.drop(1, 1, 1, 0);
  assert.strictEqual(bank.collect(p.pid, 1), -1);
  assert.strictEqual(bank.pickups().length, 1);
});

test('deposit after withdraw or drop of the same id succeeds (closed accounts are deleted)', () => {
  const { bank } = bankWithLog();
  bank.deposit(5, 100000, 'W', 'a');
  assert.deepStrictEqual(bank.withdraw(5), { micro: 100000, wallet: 'W', name: 'a' });
  assert.strictEqual(bank.withdraw(5), null, 'withdraw twice pays once');
  bank.deposit(5, 1000000, 'W2', 'b');
  assert.strictEqual(bank.balance(5), 1000000);
  bank.drop(5, 0, 0, 0);
  bank.deposit(5, 7, 'W3', 'c');
  assert.strictEqual(bank.balance(5), 7);
  assert.strictEqual(bank.accounts.size, 1);
  assert.ok(conserved(bank));
  assert.deepStrictEqual(bank.ledger, { inMicro: 1100007, outMicro: 100000 });
});

test('withdraw ceiling: never more than inMicro - outMicro, breach reported once', () => {
  const { bank, breaches } = bankWithLog();
  bank.deposit(1, 100000, 'W', 'a');
  bank.deposit(2, 100000, 'W2', 'b');
  // Simulate a bug elsewhere that inflated a balance behind the bank's back.
  bank.accounts.get(1).micro = 900000;
  assert.strictEqual(bank.assertConserved(), false);
  assert.strictEqual(breaches.length, 1);
  const out = bank.withdraw(1);
  assert.strictEqual(out.micro, 200000, 'capped at what the arena took in');
  assert.strictEqual(bank.ledger.outMicro, 200000);
  assert.strictEqual(breaches.length, 1, 'onBreach fires once');
  const second = bank.withdraw(2);
  assert.strictEqual(second.micro, 0, 'nothing left to pay');
  assert.ok(bank.ledger.outMicro <= bank.ledger.inMicro);
});

test('sweepPickup: deletes the coin, adds to outMicro, returns its source; no-op when gone', () => {
  const { bank, transfers } = bankWithLog();
  bank.deposit(1, 250000, 'WA', 'amy');
  const p = bank.drop(1, 10, 10, 0);
  assert.deepStrictEqual(bank.sweepPickup(p.pid), { micro: 250000, srcWallet: 'WA', srcName: 'amy' });
  assert.strictEqual(bank.ledger.outMicro, 250000);
  assert.strictEqual(bank.totalMicro(), 0);
  assert.strictEqual(bank.sweepPickup(p.pid), null);
  assert.strictEqual(bank.collect(p.pid, 1), 0);
  assert.strictEqual(transfers.length, 0, 'a sweep is not a player transfer');
  assert.ok(conserved(bank));
});

test('movePickup never deletes; pickups keep creation order; pid wraps and skips live ids', () => {
  const { bank } = bankWithLog();
  for (let i = 1; i <= 3; i++) bank.deposit(i, i * 10, 'W' + i, 'n' + i);
  const a = bank.drop(1, 0, 0, 0);
  const b = bank.drop(2, 0, 0, 0);
  const c = bank.drop(3, 0, 0, 0);
  assert.strictEqual(bank.movePickup(b.pid, 50, 60), true);
  assert.strictEqual(bank.movePickup(999, 1, 1), false);
  assert.deepStrictEqual(bank.pickups().map(p => p.pid), [a.pid, b.pid, c.pid]);
  assert.strictEqual(bank.getPickup(b.pid).x, 50);
  assert.strictEqual(bank.pickups().length, 3);
  bank.nextPid = PaperBank.PICKUP_ID_MAX;
  bank.deposit(9, 5, 'W9', 'x');
  const d = bank.drop(9, 0, 0, 0);
  assert.strictEqual(d.pid, PaperBank.PICKUP_ID_MAX);
  bank.deposit(9, 5, 'W9', 'x');
  const e = bank.drop(9, 0, 0, 0);
  assert.ok(e.pid !== a.pid && e.pid !== b.pid && e.pid !== c.pid && e.pid >= 1, 'wrapped past live ids to ' + e.pid);
});

test('assertConserved never throws and reports once', () => {
  const { bank, breaches } = bankWithLog();
  bank.deposit(1, 10, 'W', 'a');
  assert.strictEqual(bank.assertConserved(), true);
  bank.ledger.inMicro += 1;
  assert.strictEqual(bank.assertConserved(), false);
  assert.strictEqual(bank.assertConserved(), false);
  assert.strictEqual(breaches.length, 1);
  assert.deepStrictEqual(breaches[0], { totalMicro: 10, inMicro: 11, outMicro: 0 });
  const quiet = new PaperBank();
  quiet.deposit(1, 1, 'W', 'a');
  quiet.ledger.outMicro = 5;
  assert.strictEqual(quiet.assertConserved(), false, 'no hooks given still never throws');
});

test('10,000 random ops (incl. sweeps) keep totalMicro() === inMicro - outMicro after every one', () => {
  let s = 12345;
  const rand = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const { bank, transfers, breaches } = bankWithLog();
  let paidOut = 0;
  let swept = 0;
  let deposited = 0;
  const ops = { deposit: 0, transfer: 0, drop: 0, collect: 0, withdraw: 0, sweep: 0, move: 0 };
  for (let i = 0; i < 10000; i++) {
    const open = bank.openIds();
    const coins = bank.pickups().map(p => p.pid);
    const r = rand();
    if (r < 0.28 || open.length < 2) {
      const id = 1 + Math.floor(rand() * 40);
      if (!bank.isOpen(id)) {
        const micro = pick([0, 100000, 1000000, 99000, 1]);
        bank.deposit(id, micro, 'W' + id, 'p' + id);
        deposited += micro;
        ops.deposit++;
      }
    } else if (r < 0.45) {
      if (bank.transferAll(pick(open), pick(open)) >= 0) ops.transfer++;
    } else if (r < 0.6) {
      bank.drop(pick(open), rand() * 1900, rand() * 1900, i);
      ops.drop++;
    } else if (r < 0.72 && coins.length) {
      if (bank.collect(pick(coins), pick(open)) > 0) ops.collect++;
    } else if (r < 0.82) {
      const w = bank.withdraw(pick(open));
      if (w) { paidOut += w.micro; ops.withdraw++; }
    } else if (r < 0.9 && coins.length) {
      const sw = bank.sweepPickup(pick(coins));
      if (sw) { swept += sw.micro; ops.sweep++; }
    } else if (coins.length) {
      bank.movePickup(pick(coins), rand() * 1900, rand() * 1900);
      ops.move++;
    }
    assert.ok(conserved(bank), 'op ' + i);
    assert.ok(bank.assertConserved());
    for (const id of bank.openIds()) assert.ok(Number.isSafeInteger(bank.balance(id)) && bank.balance(id) >= 0);
  }
  assert.strictEqual(breaches.length, 0);
  assert.strictEqual(bank.ledger.inMicro, deposited);
  assert.strictEqual(bank.ledger.outMicro, paidOut + swept);
  assert.ok(transfers.every(t => (t.kind === 'kill' || t.kind === 'pickup') && t.micro > 0));
  for (const [k, n] of Object.entries(ops)) assert.ok(n > 100, k + ' ran ' + n + ' times');
});
